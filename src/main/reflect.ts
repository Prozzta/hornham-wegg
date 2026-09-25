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

/** A pass must shrink the file by at least this fraction of the history it summarised. */
const NOT_SMALLER_TAKE_RATIO = 0.25;

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
  // Belt and braces only. The sanitizer is the guarantee; this just saves the demotion
  // on most calls, and it costs nothing because the prefix is still byte-identical
  // across calls and still prompt-caches.
  '- Never start a line with "## " — that is the file\'s own section delimiter. Use',
  '  "### " for any structure inside "condensed".',
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
  /** Bytes of history this pass sends - what the per-pass not-smaller rule is measured against. */
  takeBytes: number;
  /** Why nothing can be sent, when `fits` is false: the fixed overhead alone is too big, or
   *  every evictable unit is a single line larger than a unit. Null when it fits. */
  refusal: 'overhead' | 'all-unfittable' | null;
  /** Single lines passed over in place because no pass could ever carry them. */
  oversizeKept: Array<{ bytes: number; heading: string }>;
  /** How many evict sections had to be split into units - the guard that proves the
   *  splitter actually ran on an oversized input. */
  splitSections: number;
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
    let anyCondensed = false;

    while (passes < MAX_PASSES_PER_SCAN) {
      const before = Buffer.byteLength(current, 'utf8');
      const r = await this.condense(home, id, mem, current, s, passes + 1);
      passes++;
      if (r.reason === 'prompt-too-large' && anyCondensed) {
        // Earlier passes this scan made progress, and nothing takeable is left: what
        // remains over budget is content no pass can carry. A NAMED end, not a spin;
        // every later scan is a free prompt-too-large refusal with no call.
        this.logAbort(id, 'budget-unreachable', `${Buffer.byteLength(current, 'utf8')} B remain over the ` +
          `${BUDGET_BYTES} B budget and no pass can carry any of it`);
        last = { ...(last as ReflectResult), reason: 'budget-unreachable' };
        break;
      }
      if (!r.condensed) {
        // A pass that changed nothing ends the scan - but it must not REPLACE the result
        // of a pass that did. 'nothing-to-evict' after a successful pass is the normal end
        // of a dig-out, and reporting it as the scan's outcome said condensed:false about a
        // file that had just been rewritten.
        if (!anyCondensed) last = r;
        break;
      }
      last = r;
      anyCondensed = true;
      const after = r.newBytes ?? before;
      if (after >= before) break;                      // no progress — never loop on it
      if (after <= BUDGET_BYTES) break;                // done
      try { current = readFileSync(mem, 'utf8'); } catch { break; }
    }

    const final = last ?? { id, condensed: false, reason: 'no-pass-ran' };
    return { ...final, oldBytes: firstBytes, passes };
  }

  private async condense(
    home: string, id: string, mem: string, text: string, s: ReflectSettings, pass = 1
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
      // EVERY evict unit is checked, not only the oldest - the defect was an oversized
      // section further back that the old oldest-only pre-flight never saw.
      const biggest = plan.oversizeKept.reduce((m, u) => Math.max(m, u.bytes), 0);
      const why = plan.refusal === 'all-unfittable'
        ? `every evictable unit is a single line over ${UNIT_MAX_BYTES} B (largest ${biggest} B); ` +
          `no pass can carry any of it within the ${MAX_PROMPT_BYTES} B cap`
        : `overhead ${plan.overheadBytes} B leaves no room for history within the ${MAX_PROMPT_BYTES} B cap`;
      this.logAbort(id, 'prompt-too-large', why, {
        oldBytes, overheadBytes: plan.overheadBytes, maxPromptBytes: MAX_PROMPT_BYTES
      });
      return { id, condensed: false, reason: 'prompt-too-large', oldBytes };
    }

    // THE PLAN MUST PARTITION THE BACKLOG. Every line of the evict sections goes either to
    // the summary (take) or back into the file (defer) - never neither. verify() cannot see
    // a planner that silently drops a split section's untaken units, because the survivors
    // it compares against would be missing them too; this check does not trust the planner.
    if (!partitionsExactly(evict, plan.take, plan.defer)) {
      this.logAbort(id, 'plan-lost-content', 'take + defer do not reproduce the evicted lines', { oldBytes });
      return { id, condensed: false, reason: 'plan-lost-content', oldBytes };
    }

    // A single line no pass could ever carry stays exactly where it is. Named, once per
    // pass, because it is the one place the file's order is not strictly oldest-first.
    if (plan.oversizeKept.length) {
      try {
        this.appendLog({
          kind: 'condense-oversize-kept', agentId: id, units: plan.oversizeKept.length,
          bytes: plan.oversizeKept.reduce((n, u) => n + u.bytes, 0),
          heading: plan.oversizeKept[0].heading.slice(0, 120)
        });
      } catch { /* logging is best-effort */ }
    }

    // 1) BACK UP first — a lossless cold copy makes every later step recoverable.
    // Millisecond stamp AND the pass number: at one-second resolution, passes finishing
    // inside the same second overwrote each other's backup - including the ORIGINAL.
    const stamp = `${utcStamp()}-p${pass}`;
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
    // 2b) SANITIZE, before the summary is allowed to influence anything. Applied HERE and
    // exactly once, so mergePinned, rebuild and verify all see the same values and verify
    // itself stays exact and untouched — it is the gate in front of memory.md, and a gate
    // that compares different text from the thing it admitted is no gate.
    summary = {
      condensed: demoteHeadings(summary.condensed),
      hoist: summary.hoist.map(demoteHeadings)
    };

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
      condensed: summary.condensed, keep: survivors, takeBytes: plan.takeBytes
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
        promptBytes: plan.promptBytes, takeBytes: plan.takeBytes, split: plan.splitSections,
        hoisted: summary.hoist.length, backup
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

/**
 * Demote model-authored level-2 headings to level 3. Pure, idempotent, content-preserving.
 *
 * `## ` is not decoration in this file, it is the STRUCTURE: parseMemory carves regions
 * and sections on it. So a summary line beginning `## ` does not render a heading inside
 * the condensed region - it ENDS that region and starts a new section, and the re-parse
 * then counts more sections than the rewrite kept. That is the 1.1.47 release blocker:
 * `recent-count-mismatch`, near-deterministic for a heading-rich take like god's, and a
 * matter of luck for everyone else. `## 📌` was worse still - it shadowed the pinned block
 * with the model's own fragment, and the file was ACCEPTED.
 *
 * Demoting rather than REFUSING is the whole point. A refusal is re-emitted by the model
 * on the next attempt and the file stalls exactly as it does today; a demotion makes the
 * round-trip structurally true for ANY schema-valid summary. `### ` is ignored by
 * parseMemory and is already a block boundary, so the text reads the same, one level
 * smaller. The lookahead keeps `#### ` and bare `##text` untouched.
 */
export const demoteHeadings = (s: string): string => s.replace(/^##(?=\s)/gm, '###');

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
 * Units. The largest piece of one section a single pass will send.
 *
 * WHY SECTIONS ARE NO LONGER ATOMIC (1.1.47 re-cut, god's canary). A `## ` section used to
 * be taken whole or not at all, so one section larger than a pass could carry could never
 * be condensed - and because the planner took the oldest sections IN ORDER, it also
 * blocked every section behind it. god's memory had exactly that: a 355,645-byte section
 * of 312 bullets at the third-oldest position. Two sections fit ahead of it, the pass
 * shrank the file by ~11 KB, the whole-file not-smaller rule rejected it, and the file
 * could never move again (Jim, agents/jim-mtujpe28/god-notsmaller-DIAG.md).
 *
 * So an oversized section is split, IN MEMORY, at bullet or line boundaries into units
 * no larger than `UNIT_MAX_BYTES`. Nothing is lost and nothing is reordered: the units
 * a pass takes go to the summary, and every unit it does not take is written back in
 * place as an ordinary section - the first keeps the original heading, later ones get
 * `<heading> (continued k/n)`, which is the only text this adds to a file.
 */
export const UNIT_MAX_BYTES = 40_000;
/** Room a unit's heading and the prompt's joins may need beyond its body. */
const UNIT_HEADROOM_BYTES = 1_024;
/** Worst case "(continued k/n)" suffix, reserved while packing before n is known. */
const CONTINUED_SUFFIX_RESERVE = 32;

/** A line that starts a new block: a bullet, a numbered item, or a sub-heading. A line
 *  that does not is a continuation and stays with the block above it. */
const BLOCK_START = /^(?:[-*] |#{3,} |\d+[.)] )/;

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

/** One piece the planner may send, with where it came from. */
interface Unit {
  section: Section;
  /** Index of the evict section it belongs to. */
  origin: number;
  /** A single line too large to fit even alone: passed over, never sent, never blocking. */
  fittable: boolean;
}

/**
 * Split one section into units of at most `maxUnit` bytes (heading included).
 *
 * Blocks first: a bullet keeps its continuation lines. A block that is itself too big
 * falls back to single lines. A single line too big even alone becomes its own unit,
 * marked unfittable. Joining every unit's body with '\n' gives back the original body
 * exactly - the split only chooses where the seams go.
 */
export function splitSection(s: Section, maxUnit: number): Array<{ section: Section; fittable: boolean }> {
  if (utf8(sectionText(s)) <= maxUnit) return [{ section: s, fittable: true }];
  const budget = maxUnit - utf8(s.heading) - CONTINUED_SUFFIX_RESERVE - 1;
  const lines = s.body.split('\n');

  const blocks: string[][] = [];
  for (const line of lines) {
    if (!blocks.length || BLOCK_START.test(line)) blocks.push([line]);
    else blocks[blocks.length - 1].push(line);
  }
  // A block that cannot fit whole is broken into its lines - but a BLANK line never stands
  // alone: it stays with the line above it. Otherwise a section body's trailing newline
  // became a whitespace-only unit of its own, which is "fittable", got taken, and spent a
  // call summarising nothing while counting as progress.
  const pieces: string[][] = [];
  for (const b of blocks) {
    if (utf8(b.join('\n')) <= budget) { pieces.push(b); continue; }
    for (const line of b) {
      if (!line.trim() && pieces.length) pieces[pieces.length - 1].push(line);
      else pieces.push([line]);
    }
  }

  const bodies: string[][] = [];
  let cur: string[] = [];
  for (const p of pieces) {
    const next = cur.concat(p);
    if (cur.length && utf8(next.join('\n')) > budget) {
      bodies.push(cur);
      cur = p.slice();
    } else {
      cur = next;
    }
  }
  if (cur.length) bodies.push(cur);
  // Belt and braces: no unit may be whitespace only. Fold one into its neighbour.
  for (let i = bodies.length - 1; i >= 0 && bodies.length > 1; i--) {
    if (bodies[i].join('\n').trim()) continue;
    if (i > 0) bodies[i - 1].push(...bodies[i]);
    else bodies[1].unshift(...bodies[i]);
    bodies.splice(i, 1);
  }

  const n = bodies.length;
  return bodies.map((b, i) => {
    const heading = i === 0 ? s.heading : `${s.heading} (continued ${i + 1}/${n})`;
    const section = { heading, body: b.join('\n') };
    return { section, fittable: utf8(sectionText(section)) <= maxUnit };
  });
}

/**
 * Decide what ONE pass sends, measured with the same builder the call uses.
 *
 * Oldest first, in order, until the first unit that does not fit - everything after it
 * waits for a later pass, because summarising newer history ahead of older history that
 * is still verbatim would scramble the file for no reason. The ONE exception is an
 * unfittable unit (a single line bigger than a unit): it is PASSED OVER in place, logged,
 * and never blocks what is behind it, because no pass could ever take it.
 *
 * A section whose units were ALL deferred is written back in its ORIGINAL form, not as
 * fragments: splitting is how a pass takes part of a section, not something done to a
 * section nobody touched. `(continued k/n)` headings therefore appear only where part of
 * a section really was summarised.
 */
export function planEviction(
  condensed: string | null, pinned: string | null, evict: Section[], maxBytes = MAX_PROMPT_BYTES
): EvictionPlan {
  const overheadBytes = utf8(buildCondensePrompt(condensed, [], pinned));
  const maxUnit = Math.min(UNIT_MAX_BYTES, maxBytes - overheadBytes - UNIT_HEADROOM_BYTES);
  if (maxUnit <= 0) {
    return {
      take: [], defer: evict.slice(), fits: false, overheadBytes,
      promptBytes: overheadBytes, takeBytes: 0, refusal: 'overhead', oversizeKept: [], splitSections: 0
    };
  }

  const units: Unit[] = [];
  let splitSections = 0;
  evict.forEach((s, origin) => {
    const parts = splitSection(s, maxUnit);
    if (parts.length > 1 || !parts[0].fittable) splitSections++;
    for (const p of parts) units.push({ section: p.section, origin, fittable: p.fittable });
  });

  const taken = new Set<Unit>();
  const oversizeKept: Array<{ bytes: number; heading: string }> = [];
  let total = overheadBytes;
  let stopped = false;
  for (const u of units) {
    if (!u.fittable) {
      oversizeKept.push({ bytes: utf8(sectionText(u.section)), heading: u.section.heading });
      continue;
    }
    // +2 for the '\n\n' this unit is joined with. Over-counting the first by two bytes
    // is the safe direction to be wrong in.
    const cost = utf8(sectionText(u.section)) + 2;
    if (!stopped && total + cost <= maxBytes) {
      taken.add(u);
      total += cost;
    } else {
      stopped = true;
    }
  }

  const take = units.filter((u) => taken.has(u)).map((u) => u.section);
  const defer: Section[] = [];
  evict.forEach((s, origin) => {
    const mine = units.filter((u) => u.origin === origin);
    if (!mine.some((u) => taken.has(u))) defer.push(s);          // untouched: original form
    else for (const u of mine) if (!taken.has(u)) defer.push(u.section);
  });

  const promptBytes = utf8(buildCondensePrompt(condensed, take, pinned));
  const takeBytes = take.reduce((n, s) => n + utf8(sectionText(s)), 0);
  const fits = take.length > 0 && promptBytes <= maxBytes;
  return {
    take, defer, fits, overheadBytes, promptBytes, takeBytes,
    refusal: fits ? null : (units.length && units.every((u) => !u.fittable) ? 'all-unfittable' : 'overhead'),
    oversizeKept, splitSections
  };
}

/** The content lines of some sections, for the partition check: non-blank, trailing space
 *  dropped (rebuild() trims section ends), and the derived `(continued k/n)` headings left
 *  out - they are the one thing a split adds, and they carry no history of their own. */
function contentLines(sections: Section[]): string[] {
  const out: string[] = [];
  for (const sec of sections) {
    if (!/ \(continued \d+\/\d+\)$/.test(sec.heading)) out.push(sec.heading.trimEnd());
    for (const line of sec.body.split('\n')) if (line.trim()) out.push(line.trimEnd());
  }
  return out.sort();
}

/** Do take + defer hold exactly the lines of evict - nothing lost, nothing invented? */
export function partitionsExactly(evict: Section[], take: Section[], defer: Section[]): boolean {
  const a = contentLines(evict);
  const b = contentLines([...take, ...defer]);
  return a.length === b.length && a.every((line, i) => line === b[i]);
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
  /** Bytes of history this pass summarised. */
  takeBytes: number;
}): { ok: true } | { ok: false; reason: string } {
  const { rebuilt, newBytes, oldBytes, oldPinnedLines, mergedPinned, condensed, keep, takeBytes } = args;
  // 6) Valid summary JSON already enforced upstream (validateSummary). Here: structure.
  // 1) Parses back into the 3-region structure.
  const re = parseMemory(rebuilt);
  if (re.pinned === null || re.condensed === null) return { ok: false, reason: 'structure-missing-region' };
  // 4) Non-empty + sane.
  if (newBytes <= 200) return { ok: false, reason: 'too-small' };
  if (!condensed.trim()) return { ok: false, reason: 'empty-condensed' };
  // 3) Actually smaller - PER PASS, not per file. The old rule (newBytes < 0.95 x oldBytes)
  // dates from the single-pass era: under partial eviction one pass may only carry a few
  // percent of a large file, and it rejected god's real pass (14.6 KB summarised to ~4.9 KB,
  // an ~11 KB real shrink on a 959 KB file) as not-smaller - permanently. What matters is
  // that THIS pass made real progress on what it took: the file shrank, by at least a
  // quarter of the history summarised. A summary that grows or barely shrinks still fails.
  // (No whole-file floor is kept even when nothing is deferred: a final pass over a small
  // tail cannot shrink a large file by 5%, and would stall just above budget forever.)
  if (!(newBytes < oldBytes && oldBytes - newBytes >= NOT_SMALLER_TAKE_RATIO * takeBytes)) {
    return { ok: false, reason: 'not-smaller' };
  }
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
  // e.g. 20260923T175826123Z - milliseconds kept (see the per-pass backup note).
  return new Date().toISOString().replace(/[-:.]/g, '');
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
