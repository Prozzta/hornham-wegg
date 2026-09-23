/**
 * MemoryReflector — the missing CONDENSE half of the janitor.
 *
 * The janitor flags an oversized `agents/<id>/memory.md` ("Needs condensing.")
 * but never shrinks it. This service finishes that job: on an in-process timer it
 * finds memory files that crossed a size/section threshold and rewrites them into
 * a bounded 3-region shape — pinned durable facts (never touched), one rolling
 * recursive summary, and the newest K verbatim sections — using a cheap headless
 * `claude -p` (Haiku) summarization of the evicted tail.
 *
 * Why in-process (Electron main), NOT launchd: launchd-spawned shells are blocked
 * by macOS TCC from `~/Documents`; only this process has the folder grant. So the
 * loop lives alongside `memory.start()` — never a cron.
 *
 * Safety is layered so a bad LLM pass can NEVER lose data:
 *   backup-first (lossless cold copy) → verify-don't-trust gate → atomic swap.
 * If any check fails the original file is left byte-for-byte untouched and the
 * only side effect is a `condense-abort` log line. The miner re-indexes the new
 * file automatically on the next tick because its mtime changed (memory.ts).
 *
 * Runs in the Electron main process.
 */
import {
  existsSync, statSync, readdirSync, readFileSync, writeFileSync,
  mkdirSync, copyFileSync, renameSync, openSync, fsyncSync, closeSync
} from 'node:fs';
import { join, dirname } from 'node:path';
import { runHiddenClaude, type HiddenClaudeDiag } from './hiddenClaude';

/** Total memory.md budget — mirrors the janitor's CONTEXT_BUDGET_BYTES (128 KB). */
const BUDGET_BYTES = 131_072;
/** Cheap tail-summarizer (DECIDED by god). The verify gate covers quality. */
const CONDENSE_MODEL = 'claude-haiku-4-5';
/**
 * Hard cap so a wedged headless run can't stall the reflect loop.
 *
 * DELIBERATELY UNCHANGED while MAX_PROMPT_BYTES was introduced (god, 2026-09-23).
 * One packaged failure was a 180 s timeout on a ~600 KB file, and raising this was the
 * obvious-looking fix. It is the wrong one to reach for first: bounding the prompt
 * shrinks every call, which is the likelier cure, and a bigger budget would have HIDDEN
 * the remaining possibility — contention with the floor's other live agents — rather
 * than answered it. Raise this only when a `condense-diag` breadcrumb shows a prompt
 * that was INSIDE the byte budget and still ran long.
 */
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Hard ceiling on ONE condense prompt.
 *
 * WHAT THIS IS DEFENDING (packaged 1.1.47, 2026-09-23). A condense prompt is the
 * evicted sections, and nothing bounded them but their COUNT — so their weight was
 * whatever those sections happened to be. god's 944 KB memory produced a prompt the
 * model refused outright: `terminal_reason: 'prompt_too_long'`, `api_error_status: 400`,
 * "~313578 tokens (limit 200000)". Measured against the real CLI, the usable share of
 * the 200K window is ~126K tokens - about 500 KB of text - because roughly 74K tokens
 * go to the CLI's own system prompt and tool definitions before our first byte.
 *
 * 300 KB leaves a wide margin under that ~500 KB cliff, because the margin is paying
 * for things we cannot measure from here: tokens-per-byte varies with content, and the
 * CLI's own overhead is its business and may grow. A condense that is one release away
 * from refusing everything is not a condense.
 */
const MAX_PROMPT_BYTES = 300_000;

/**
 * How many condense passes one scan will spend on a single file.
 *
 * A file far over budget cannot be fixed in one call any more - it digs out a chunk at
 * a time. Bounded because the scan is serial: every pass one agent spends is a pass the
 * others in the same sweep are waiting through. When the cap is hit the file is left
 * smaller than it was and the next interval tick continues, so the dig-out completes
 * across scans instead of monopolising one.
 *
 * SIX, not four. The worst real backlog measured was 944 KB (god's, 2026-09-23), and at
 * MAX_PROMPT_BYTES a file that size needs four passes to reach budget - so four would
 * clear it only if the arithmetic were perfect, and would leave the actual motivating
 * case straddling a scan boundary. Six clears it with room and still terminates: the
 * no-progress guard, not this number, is what makes the loop safe.
 */
const MAX_PASSES_PER_SCAN = 6;

/** The fixed region headings of the bounded memory shape (the stable contract). */
const PINNED_HEADING = '## 📌 Durable facts (pinned — never condensed)';
const CONDENSED_HEADING = '## 🗜 Condensed history';
const RECENT_HEADING = '## Recent';

/** Instruction prefix — kept byte-identical across calls (no dates/ids spliced
 *  in) so Claude Code prompt-caches it; the dynamic content goes in the tail. */
const CONDENSE_SYSTEM = [
  "You are compacting one AI agent's long-term memory file. You will receive:",
  '(A) the current CONDENSED summary, (B) older RECENT sections being evicted,',
  '(C) the PINNED durable-facts block (for context only — do not rewrite it).',
  'Produce STRICT JSON: {"condensed": "<text>", "hoist": ["<line>", ...]}.',
  'RULES:',
  '- "condensed" = a single bounded summary of (A)+(B). Re-summarize (A) together',
  '  with (B) so the result does not grow unbounded. Target <= 1500 words. Preserve',
  '  every decision, root cause, protocol, file path, commit SHA, and numeric result.',
  '  Drop routine standup chatter, resolved blockers, and superseded plans.',
  '- "hoist" = any NEW high-importance durable fact found in (B) that belongs in the',
  '  pinned block and is not already in (C). Lines only; may be empty.',
  '- Output ONLY the JSON object. No prose, no code fence.'
].join('\n');

/** The exact shape the model must return: handed to the CLI as `--json-schema` and
 *  validated again locally. Two gates deliberately — the CLI's validation is another
 *  program's promise, and this one is the gate that stands in front of memory.md. */
const CONDENSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['condensed', 'hoist'],
  properties: {
    condensed: { type: 'string', minLength: 1 },
    hoist: { type: 'array', items: { type: 'string' } }
  }
} as const;

export interface ReflectSettings {
  enabled: boolean;
  /** How often to scan for oversized memory files. */
  intervalMs: number;
  /** Condense when bytes exceed this percent of BUDGET_BYTES. */
  byteTriggerPct: number;
  /** ...OR when `## ` section count exceeds this (AND bytes > minBytes). */
  sectionTrigger: number;
  /** Newest K verbatim `## ` sections always kept untouched. */
  recentKeep: number;
  /** Never condense a file smaller than this — both a "don't waste an LLM call"
   *  guard and the byte floor for the section-count trigger. */
  minBytes: number;
}

/** A `## ` section: its heading line and the body text beneath it. */
interface Section { heading: string; body: string }

/** A parsed memory.md split into the three regions. `pinned`/`condensed` are null
 *  for legacy (un-structured) files — they're created on first condense. */
interface Parsed {
  header: string;            // the `# Memory …` H1 + any preamble before the first `##`
  pinned: string | null;     // body under the pinned heading (no heading line)
  condensed: string | null;  // body under the condensed heading
  recent: Section[];         // every other `## ` section, in file order (oldest→newest)
}

/** Outcome of one agent's reflect attempt — surfaced to the manual IPC + tests. */
export interface ReflectResult {
  id: string;
  condensed: boolean;        // did we actually rewrite the file?
  reason: string;            // why (skipped/aborted/done), for logging + UI
  oldBytes?: number;
  newBytes?: number;
  /** How many condense passes this scan spent here. >1 means a backlog was dug out;
   *  `oldBytes` is the size before the FIRST pass, `newBytes` after the last. */
  passes?: number;
}

/** What one pass will actually send, decided before the call is spent. */
export interface EvictionPlan {
  /** The oldest sections that fit in this call, in file order. */
  take: Section[];
  /** The rest — kept VERBATIM in the rewritten file for a later pass to eat. */
  defer: Section[];
  /** False when not even the single oldest section fits: refuse, don't spend a call. */
  fits: boolean;
  /** The fixed cost (instructions + current summary + pinned) before any section. */
  overheadBytes: number;
  /** The measured size of the prompt this plan produces. */
  promptBytes: number;
}

export class MemoryReflector {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  /** True while a reflectNow() pass is in flight — serializes the loop (a slow
   *  LLM pass must not overlap the next interval tick), mirroring MemoryManager. */
  private reflecting = false;

  /**
   * @param getHome      Lazily resolve harnessHome so reflection follows config.
   * @param getCommand   The base `claude` command (only its binary name is used).
   * @param getMemoryEnv Extra env (the shared MemPalace path) merged into the call.
   * @param getSettings  Reflect tunables (interval + thresholds), read each tick.
   * @param appendLog    Sink for `condense`/`condense-abort` events (hive log.jsonl).
   */
  constructor(
    private getHome: () => string | null,
    private getCommand: () => string,
    private getMemoryEnv: () => Record<string, string>,
    private getSettings: () => ReflectSettings,
    private appendLog: (event: Record<string, unknown>) => void,
    /** The hidden model call. Injectable ONLY so the summarize path can be driven
     *  deterministically in tests; production always uses the real print process. */
    private runHidden: typeof runHiddenClaude = runHiddenClaude
  ) {}

  // — lifecycle (mirrors MemoryManager) —

  start(): void {
    if (this.started) return;
    if (!this.getSettings().enabled) return;
    if (!this.getHome()) return;
    this.started = true;
    // First scan one interval out, not on boot, so launch isn't competing with an
    // LLM call (and a freshly-restored home isn't condensed before it's mined).
    const ms = Math.max(60_000, this.getSettings().intervalMs);
    this.timer = setInterval(() => { void this.reflectNow(); }, ms);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.started = false;
  }

  // — scan —

  /** Reflect every agent whose memory crossed a threshold (or just `onlyId`),
   *  one at a time. Serialized via `reflecting` so a slow pass can't overlap the
   *  next tick. Returns the per-agent outcomes (used by the manual IPC + tests). */
  async reflectNow(onlyId?: string): Promise<ReflectResult[]> {
    const home = this.getHome();
    if (!home) return [];
    if (this.reflecting) return [];
    const agentsDir = join(home, 'hive', 'agents');
    if (!existsSync(agentsDir)) return [];
    const settings = this.getSettings();
    let ids: string[];
    try { ids = readdirSync(agentsDir); } catch { return []; }
    if (onlyId) ids = ids.filter((id) => id === onlyId);

    this.reflecting = true;
    const results: ReflectResult[] = [];
    try {
      for (const id of ids) {
        const mem = join(agentsDir, id, 'memory.md');
        if (!existsSync(mem)) continue;
        let bytes = 0;
        let text = '';
        try {
          bytes = statSync(mem).size;
          // A manual single-agent call condenses on demand (skips the trigger);
          // the autonomous loop honors the threshold.
          if (!onlyId && !this.shouldCondense(bytes, mem, settings)) continue;
          text = readFileSync(mem, 'utf8');
        } catch { continue; }
        results.push(await this.condenseToBudget(home, id, mem, text, settings));
      }
    } finally {
      this.reflecting = false;
    }
    return results;
  }

  /** The dual trigger (DECIDED): bytes > pct% of budget, OR many-section sprawl
   *  above the byte floor. The floor doubles as the "never burn an LLM call on a
   *  tiny file" guard, so it gates BOTH paths. */
  private shouldCondense(bytes: number, mem: string, s: ReflectSettings): boolean {
    if (bytes < s.minBytes) return false;
    if (bytes > (BUDGET_BYTES * s.byteTriggerPct) / 100) return true;
    let sections = 0;
    try { sections = countSections(readFileSync(mem, 'utf8')); } catch { return false; }
    return sections > s.sectionTrigger;
  }

  // — condense one file, as many passes as it takes —

  /**
   * Run condense passes until the file is under budget.
   *
   * WHY THIS LOOP EXISTS. One pass carries at most MAX_PROMPT_BYTES of backlog, so a
   * file several times over budget cannot be fixed by a single call — and before the
   * byte bound it was not fixed by ANY number of calls, because every one of them was
   * refused for the same reason. god's memory reached 944 KB (7.2x budget) exactly this
   * way. Each pass eats the oldest chunk it can carry and writes the rest back
   * verbatim, so the file walks down instead of failing in place.
   *
   * Four stop conditions, and each one matters:
   *   - under budget — done;
   *   - a pass that did not condense (abort, nothing-to-evict, a refused rewrite) —
   *     retrying it would repeat the same call with the same input;
   *   - no progress — a pass that did not actually shrink the file cannot be the first
   *     of a series that does, and this is the guard that makes the loop terminate
   *     even if some future change breaks the arithmetic above;
   *   - MAX_PASSES_PER_SCAN — the scan is serial, and the next tick resumes the dig-out.
   *
   * The result reports the ORIGINAL size and the FINAL one, so a caller sees the whole
   * descent rather than the last step of it.
   */
  private async condenseToBudget(
    home: string, id: string, mem: string, text: string, s: ReflectSettings
  ): Promise<ReflectResult> {
    const firstBytes = Buffer.byteLength(text, 'utf8');
    let current = text;
    let last: ReflectResult | null = null;
    let passes = 0;

    while (passes < MAX_PASSES_PER_SCAN) {
      const before = Buffer.byteLength(current, 'utf8');
      const r = await this.condense(home, id, mem, current, s);
      passes++;
      last = r;
      if (!r.condensed) break;
      const after = r.newBytes ?? before;
      if (after >= before) break;                      // no progress — never loop on it
      if (after <= BUDGET_BYTES) break;                // done
      try { current = readFileSync(mem, 'utf8'); } catch { break; }
    }

    const final = last ?? { id, condensed: false, reason: 'no-pass-ran' };
    return { ...final, oldBytes: firstBytes, passes };
  }

  private async condense(
    home: string, id: string, mem: string, text: string, s: ReflectSettings
  ): Promise<ReflectResult> {
    const oldBytes = Buffer.byteLength(text, 'utf8');
    const parsed = parseMemory(text);
    // Split recent into KEEP (newest K, verbatim) and EVICT (older — summarized).
    const keepCount = Math.max(1, s.recentKeep);
    const keep = parsed.recent.slice(-keepCount);
    const evict = parsed.recent.slice(0, Math.max(0, parsed.recent.length - keepCount));
    if (evict.length === 0) {
      return { id, condensed: false, reason: 'nothing-to-evict', oldBytes };
    }

    // How much of that backlog fits in ONE call. The rest is DEFERRED — rewritten
    // verbatim into the new file, not dropped — and a later pass takes the next chunk.
    const plan = planEviction(parsed.condensed, parsed.pinned, evict);
    if (!plan.fits) {
      // PRE-FLIGHT REFUSAL. Named, and free: an unfittable input used to be discovered
      // by spending the call and reading back `claude exited 1`.
      const why = plan.take.length === 0 && evict.length > 0
        ? `oldest section ${Buffer.byteLength(sectionText(evict[0]), 'utf8')} B + overhead ` +
          `${plan.overheadBytes} B exceeds the ${MAX_PROMPT_BYTES} B cap`
        : `prompt ${plan.promptBytes} B exceeds the ${MAX_PROMPT_BYTES} B cap`;
      this.logAbort(id, 'prompt-too-large', why, {
        oldBytes, overheadBytes: plan.overheadBytes, maxPromptBytes: MAX_PROMPT_BYTES
      });
      return { id, condensed: false, reason: 'prompt-too-large', oldBytes };
    }

    // 1) BACK UP first — a lossless cold copy makes every later step recoverable.
    const stamp = utcStamp();
    const backup = join(home, 'hive', 'backups', stamp, id, 'memory.md');
    try {
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(mem, backup);
    } catch (e) {
      this.logAbort(id, 'backup-failed', String(e));
      return { id, condensed: false, reason: 'backup-failed', oldBytes };
    }

    // 2) SUMMARIZE the (condensed + evicted) tail via headless Haiku.
    let summary: { condensed: string; hoist: string[] };
    try {
      summary = await this.summarize(home, parsed.condensed, plan.take, parsed.pinned);
    } catch (e) {
      this.logAbort(id, 'summarize-failed', String(e));
      this.logDiag(id, (e as { diag?: HiddenClaudeDiag }).diag, oldBytes);
      return { id, condensed: false, reason: 'summarize-failed', oldBytes };
    }

    // 3) REBUILD into the 3-region shape.
    const oldPinnedLines = pinnedLines(parsed.pinned);
    const mergedPinned = mergePinned(oldPinnedLines, summary.hoist);
    // The DEFERRED sections lead the kept ones, preserving file order. They are not in
    // the summary, so if they were not written back they would simply be lost — and
    // verify() round-trips every one of them byte-for-byte, deferred and kept alike.
    const survivors = [...plan.defer, ...keep];
    const rebuilt = rebuild(parsed.header, mergedPinned, summary.condensed, survivors);
    const newBytes = Buffer.byteLength(rebuilt, 'utf8');

    // 4) VERIFY-DON'T-TRUST — reject the rewrite unless every check holds.
    const verdict = verify({
      rebuilt, newBytes, oldBytes, oldPinnedLines, mergedPinned,
      condensed: summary.condensed, keep: survivors
    });
    if (!verdict.ok) {
      this.logAbort(id, verdict.reason, undefined, { oldBytes, newBytes });
      return { id, condensed: false, reason: verdict.reason, oldBytes, newBytes };
    }

    // 5) ATOMIC SWAP — write a temp sibling, fsync, rename over the original.
    try {
      atomicWrite(mem, rebuilt);
    } catch (e) {
      this.logAbort(id, 'swap-failed', String(e), { oldBytes, newBytes });
      return { id, condensed: false, reason: 'swap-failed', oldBytes, newBytes };
    }

    try {
      this.appendLog({
        kind: 'condense', agentId: id, oldBytes, newBytes,
        // `evicted` is what THIS pass summarized; `deferred` is the backlog still to go,
        // which is what tells a reader another pass is coming.
        evicted: plan.take.length, deferred: plan.defer.length, kept: keep.length,
        promptBytes: plan.promptBytes, hoisted: summary.hoist.length, backup
      });
    } catch { /* logging is best-effort */ }
    // The miner re-indexes within its next cycle — mtime changed, no extra wiring.
    return { id, condensed: true, reason: 'condensed', oldBytes, newBytes };
  }

  /** The failure breadcrumb: a SECOND line beside condense-abort, never folded into
   *  it. The abort row is the stable, parsed record other tools already read; this one
   *  is diagnostic detail that may grow or change shape, and it must not destabilise
   *  the row anybody depends on. Absent on success — nothing to explain. */
  private logDiag(id: string, diag: HiddenClaudeDiag | undefined, oldBytes: number): void {
    if (!diag) return;
    try { this.appendLog({ kind: 'condense-diag', agentId: id, oldBytes, ...diag }); }
    catch { /* best-effort */ }
  }

  private logAbort(id: string, reason: string, detail?: string, extra?: Record<string, unknown>): void {
    try { this.appendLog({ kind: 'condense-abort', agentId: id, reason, ...(detail ? { detail } : {}), ...extra }); }
    catch { /* best-effort */ }
  }

  // — the headless LLM call (the only non-deterministic step) —

  private async summarize(
    home: string, condensed: string | null, evict: Section[], pinned: string | null
  ): Promise<{ condensed: string; hoist: string[] }> {
    const prompt = buildCondensePrompt(condensed, evict, pinned);

    const result = await this.runHidden(prompt, {
      model: CONDENSE_MODEL,
      cwd: home,
      command: this.getCommand(),
      // Pure text transform — must never touch the repo or shell out.
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
      jsonSchema: CONDENSE_SCHEMA,
      env: this.getMemoryEnv(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    if (!result.ok) {
      // The breadcrumb rides ON the error, so the single catch that already logs
      // condense-abort can emit it without a second failure path to keep in step.
      const e = new Error(result.error ?? 'condense: hidden session failed') as Error & {
        diag?: HiddenClaudeDiag;
      };
      e.diag = result.diag;
      throw e;
    }
    const parsed = validateSummary(result.structuredOutput, result.result);
    if (!parsed) throw new Error('condense: response contained no parseable JSON');
    return parsed;
  }
}

// ─── pure helpers (the deterministic, unit-testable half) ────────────────────

/** One section as it appears in a prompt and in a rebuilt file — the SAME text in
 *  both, so planning measures exactly what gets sent and verify compares like for like. */
function sectionText(s: Section): string {
  return `${s.heading}\n${s.body}`.replace(/\s+$/, '');
}

/**
 * Build the condense prompt. Exported and used by BOTH the planner and the call, so the
 * byte budget is enforced against the artifact that is actually sent — never against an
 * estimate that can drift away from it.
 */
export function buildCondensePrompt(
  condensed: string | null, evict: Section[], pinned: string | null
): string {
  const evictText = evict.map(sectionText).join('\n\n').trim();
  return [
    CONDENSE_SYSTEM,
    '',
    '--- INPUT ---',
    '(A) CURRENT CONDENSED SUMMARY:',
    condensed?.trim() || '(none yet)',
    '',
    '(B) OLDER SECTIONS BEING EVICTED:',
    evictText || '(none)',
    '',
    '(C) PINNED DURABLE FACTS (context only — do not rewrite):',
    pinned?.trim() || '(none)'
  ].join('\n');
}

/**
 * Decide how much of the backlog ONE call may carry.
 *
 * Oldest-first, because the oldest material is what the rolling summary is for and
 * because taking it in file order keeps the deferred remainder contiguous with the kept
 * newest sections — the rewritten file stays in chronological order either way.
 *
 * `fits: false` is the case worth naming: the fixed overhead alone, or one indivisible
 * section, is already over the cap. A `## ` section is atomic — splitting one would put
 * half a thought in the summary and leave the other half orphaned — so there is nothing
 * to do but refuse, and refusing here costs no API call.
 */
export function planEviction(
  condensed: string | null, pinned: string | null, evict: Section[], maxBytes = MAX_PROMPT_BYTES
): EvictionPlan {
  const overheadBytes = Buffer.byteLength(buildCondensePrompt(condensed, [], pinned), 'utf8');
  const take: Section[] = [];
  let total = overheadBytes;
  for (const s of evict) {
    // +2 for the '\n\n' this section will be joined with. Over-counting the first
    // section by two bytes is the safe direction to be wrong in.
    const cost = Buffer.byteLength(sectionText(s), 'utf8') + 2;
    if (total + cost > maxBytes) break;
    total += cost;
    take.push(s);
  }
  // Measure the real thing once, rather than trusting the running total.
  const promptBytes = Buffer.byteLength(buildCondensePrompt(condensed, take, pinned), 'utf8');
  return {
    take,
    defer: evict.slice(take.length),
    fits: take.length > 0 && promptBytes <= maxBytes,
    overheadBytes,
    promptBytes
  };
}

/** Count level-2 (`## `) headings — `# ` H1 and `### ` deeper headings excluded. */
export function countSections(text: string): number {
  return (text.match(/^##\s/gm) ?? []).length;
}

/** Split a memory.md into header + the three regions. A legacy flat file (no
 *  pinned/condensed headings) parses with those null and every `## ` section in
 *  `recent`; the structured blocks are created on first condense. */
export function parseMemory(text: string): Parsed {
  const lines = text.split('\n');
  let firstSection = lines.findIndex((l) => /^##\s/.test(l));
  if (firstSection === -1) firstSection = lines.length;
  const header = lines.slice(0, firstSection).join('\n').replace(/\s+$/, '');

  // Carve the remaining lines into `## ` sections (heading + body until next `##`).
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (let i = firstSection; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line, body: '' };
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line;
    }
  }
  if (cur) sections.push(cur);

  let pinned: string | null = null;
  let condensed: string | null = null;
  const recent: Section[] = [];
  for (const s of sections) {
    const h = s.heading.trim();
    if (h.startsWith('## 📌')) pinned = s.body.replace(/\s+$/, '');
    else if (h.startsWith('## 🗜')) condensed = s.body.replace(/\s+$/, '');
    else if (h === RECENT_HEADING) { /* divider — its siblings ARE the recent list */ }
    else recent.push(s);
  }
  return { header, pinned, condensed, recent };
}

/** Non-empty, trimmed lines of the pinned block (the set we must never lose). */
export function pinnedLines(pinned: string | null): string[] {
  if (!pinned) return [];
  return pinned.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Append hoisted durable facts to the pinned set, skipping any already present. */
export function mergePinned(oldLines: string[], hoist: string[]): string[] {
  const have = new Set(oldLines);
  const out = [...oldLines];
  for (const raw of hoist) {
    const line = (raw ?? '').trim();
    if (line && !have.has(line)) { have.add(line); out.push(line); }
  }
  return out;
}

/** Reassemble the canonical 3-region file. */
export function rebuild(header: string, pinned: string[], condensed: string, keep: Section[]): string {
  const parts: string[] = [];
  if (header.trim()) parts.push(header.trim());
  parts.push(PINNED_HEADING);
  parts.push(pinned.length ? pinned.join('\n') : '_(none yet)_');
  parts.push(CONDENSED_HEADING);
  parts.push(condensed.trim());
  parts.push(RECENT_HEADING);
  for (const s of keep) parts.push(`${s.heading}\n${s.body}`.replace(/\s+$/, ''));
  return parts.join('\n\n') + '\n';
}

/** The verify-don't-trust gate. The rewrite is rejected — original kept verbatim
 *  — unless ALL checks pass. The lossless backup makes a rejection a pure no-op. */
export function verify(args: {
  rebuilt: string; newBytes: number; oldBytes: number;
  oldPinnedLines: string[]; mergedPinned: string[];
  condensed: string; keep: Section[];
}): { ok: true } | { ok: false; reason: string } {
  const { rebuilt, newBytes, oldBytes, oldPinnedLines, mergedPinned, condensed, keep } = args;
  // 6) Valid summary JSON already enforced upstream (validateSummary). Here: structure.
  // 1) Parses back into the 3-region structure.
  const re = parseMemory(rebuilt);
  if (re.pinned === null || re.condensed === null) return { ok: false, reason: 'structure-missing-region' };
  // 4) Non-empty + sane.
  if (newBytes <= 200) return { ok: false, reason: 'too-small' };
  if (!condensed.trim()) return { ok: false, reason: 'empty-condensed' };
  // 3) Actually smaller (a no-op condense is a failure).
  if (!(newBytes < oldBytes * 0.95)) return { ok: false, reason: 'not-smaller' };
  // 2) Pinned preserved: every old pinned line survives (hoist only adds).
  const newPinned = new Set(pinnedLines(re.pinned));
  for (const line of oldPinnedLines) if (!newPinned.has(line)) return { ok: false, reason: 'pinned-line-dropped' };
  for (const line of mergedPinned) if (!newPinned.has(line)) return { ok: false, reason: 'pinned-merge-mismatch' };
  // 5) Recent integrity: the kept newest sections round-trip byte-for-byte.
  if (re.recent.length !== keep.length) return { ok: false, reason: 'recent-count-mismatch' };
  for (let i = 0; i < keep.length; i++) {
    const a = `${keep[i].heading}\n${keep[i].body}`.replace(/\s+$/, '');
    const b = `${re.recent[i].heading}\n${re.recent[i].body}`.replace(/\s+$/, '');
    if (a !== b) return { ok: false, reason: 'recent-section-altered' };
  }
  return { ok: true };
}

/**
 * The ONLY way a model response becomes a summary.
 *
 * Preferred input is the CLI's `structured_output`, already validated against
 * CONDENSE_SCHEMA by the CLI itself. For a Claude build that honours `--json-schema`
 * but surfaces only `result`, exactly ONE fallback is allowed: the WHOLE `result`
 * string must parse as the object. No brace scanning, no fence stripping, no substring
 * rescue — the defect being fixed is plausible text from somewhere else being accepted
 * as this agent's memory, so anything short of an exact match is a refusal.
 */
export function validateSummary(structured: unknown, result?: string): { condensed: string; hoist: string[] } | null {
  const shaped = shapeSummary(structured);
  if (shaped) return shaped;
  if (typeof result !== 'string' || !result.trim()) return null;
  let whole: unknown;
  try { whole = JSON.parse(result.trim()); } catch { return null; }
  return shapeSummary(whole);
}

/** The local half of the two gates: the exact `{condensed, hoist}` shape, or nothing. */
function shapeSummary(value: unknown): { condensed: string; hoist: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as { condensed?: unknown; hoist?: unknown };
  if (typeof obj.condensed !== 'string' || !obj.condensed.trim()) return null;
  if (obj.hoist !== undefined && !Array.isArray(obj.hoist)) return null;
  const hoist = Array.isArray(obj.hoist) ? obj.hoist.filter((x): x is string => typeof x === 'string') : [];
  return { condensed: obj.condensed, hoist };
}

/** `20260606T110912Z` — matches the janitor's backup-dir stamp format. */
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Write `text` to `path` atomically: temp sibling → fsync → rename over target. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* fsync best-effort; rename is the durability guarantee */ }
  renameSync(tmp, path);
}
