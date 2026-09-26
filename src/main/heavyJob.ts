/**
 * HEAVY-JOB-SERIALIZE (1.1.55; god andyheavy/andyheavycfg). On 2026-09-26 the Human's PC went
 * unresponsive with several CPU/antivirus-heavy jobs running at once from different agents (an
 * npm ci + electron-rebuild, a parity replay spawning a Python process per query, full test
 * suites, mutation runs). The floor rule "one heavy job at a time" was prose only, and it was
 * broken twice. This makes it a machine lock the app enforces at the PreToolUse boundary.
 *
 *  - classifyHeavy: a pure, table-driven classifier of a tool call's command (no model).
 *  - HeavyJobLock: a counting semaphore of `limit` slots (the Settings value "Heavy jobs at once":
 *    'off' or N, default 1), held per AGENT; released by the PostToolUse of a foreground call, by
 *    the job's processes exiting (a background job; checked only while held), by the holder's PTY
 *    exiting, or by a TTL.
 * No Electron dependency: every piece is injectable, so the tests never inspect the real machine.
 */
import { execFile } from 'node:child_process';

export type HeavyKind = 'install' | 'build' | 'suite' | 'bench';
export interface HeavyClass { heavy: boolean; kind?: HeavyKind; why?: string }

/** Command-shaped tool input (the same reading as DESKTOP-LAUNCH-GUARD's). */
export function commandFromToolInput(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const v = r.command ?? r.cmd ?? r.script;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ');
  return typeof v === 'string' ? v : null;
}

/** Split a command line into words, honouring simple quotes (not a full shell parser). */
function words(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The segments a shell would run: split on ; && || | and newlines, OUTSIDE quotes. */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = ''; let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q && cmd[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && cmd[i + 1] !== '&' && cmd[i - 1] !== '&') { cur += ' &'; out.push(cur); cur = ''; continue; } // a lone & = background
      out.push(cur); cur = '';
      if ((c === '&' || c === '|') && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash.exe']);
const BENCH_SCRIPT = /(mutant|mutation|replay|bench|backfill|parity|speed|stress|soak)[^\\/]*\.(c?m?js|ts)$/i;
export const SUITE_MANY_FILES = 20;
/** A whole-suite runner script (heavy when run with no filter). */
const SUITE_RUNNER = /(^|[\\/])(run-?tests?|test-?runner|run-?all(-?tests)?)\.[cm]?[jt]s$/i;
/** Jim MF2: an opt-in scale/bench gate in the env prefix (THREAD_VIEW_SCALE=1 node --test x) makes
 *  even a single test file a bench. */
const BENCH_ENV = /^[A-Z0-9_]*(SCALE|BENCH|STRESS|SOAK)[A-Z0-9_]*=(1|true|yes|on)$/i;
/** node flags that take their value as the NEXT argument (so that value is not a test file). */
const NODE_VALUE_FLAGS = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout', '--test-shard', '--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C', '--input-type']);

/** Strip the prefixes that do not change what runs: VAR=x, env [-u X]..., timeout N, nice, cd x. */
function leading(ws: string[]): string[] {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (w === 'env') { i++; while (i < ws.length && (ws[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]))) { if (ws[i] === '-u') i++; i++; } continue; }
    if (w === 'timeout' || w === 'nice') { i++; while (i < ws.length && (/^-/.test(ws[i]) || /^\d+[smhd]?$/.test(ws[i]))) i++; continue; }
    if (w === 'cd' || w === 'pushd') return []; // `cd x` alone is its own segment
    break;
  }
  return ws.slice(i);
}

function classifyWords(ws0: string[], depth: number): HeavyClass {
  const ws = leading(ws0);
  if (!ws.length) return { heavy: false };
  // An opt-in scale/bench env gate before the command (Jim MF2).
  const prefix = ws0.slice(0, ws0.length - ws.length);
  const gate = prefix.find((w) => BENCH_ENV.test(w));
  if (gate) return { heavy: true, kind: 'bench', why: `${gate.split('=')[0]} (an opt-in bench gate)` };
  const bin = ws[0].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd)$/, '');
  const args = ws.slice(1);
  // One level of a shell wrapper: bash -c "...", cmd /c ..., powershell -Command ...
  if (WRAPPERS.has(bin) && depth === 0) {
    // -c (sh), /c /k (cmd; Git Bash spells it //c), -Command (PowerShell)
    const k = args.findIndex((a) => /^(-c|\/\/?c|\/\/?k|-command)$/i.test(a));
    if (k >= 0) return classifyCommand(args.slice(k + 1).join(' '), depth + 1);
    return { heavy: false };
  }
  const has = (...xs: string[]): boolean => xs.some((x) => args.includes(x));
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
    const sub = args.find((a) => !a.startsWith('-')) ?? (bin === 'yarn' ? 'install' : '');
    if (sub === 'ci' || sub === 'rebuild') return { heavy: true, kind: 'install', why: `${bin} ${sub}` };
    if (sub === 'install' || sub === 'i' || sub === 'add') {
      // `npm install` with no package = a full install; with packages it is still an install
      return { heavy: true, kind: 'install', why: `${bin} ${sub}` };
    }
    // Jim MF2: a test run with a FILTER after `--` (npm run test:focused -- wake) is a focused run:
    // light. Without one it is the suite: heavy.
    const filtered = args.includes('--') && args.indexOf('--') < args.length - 1;
    if (sub === 'test' || sub === 't') return filtered ? { heavy: false } : { heavy: true, kind: 'suite', why: `${bin} test` };
    if (sub === 'run' || sub === 'run-script') {
      const script = args.slice(args.indexOf(sub) + 1).find((a) => !a.startsWith('-')) ?? '';
      if (/^(build|dist)(:.*)?$/.test(script)) return { heavy: true, kind: 'build', why: `${bin} run ${script}` };
      if (/^test(:.*)?$/.test(script)) return filtered ? { heavy: false } : { heavy: true, kind: 'suite', why: `${bin} run ${script}` };
    }
    return { heavy: false };
  }
  if (bin === 'npx') return classifyWords(args.filter((a) => !a.startsWith('-')), depth);
  if (bin === 'electron-rebuild' || bin === 'node-gyp') return { heavy: true, kind: 'install', why: bin };
  if (bin === 'electron-builder') return { heavy: true, kind: 'build', why: bin };
  if (bin === 'electron-vite' && has('build')) return { heavy: true, kind: 'build', why: 'electron-vite build' };
  if (bin === 'vitest') {
    const files = args.filter((a) => !a.startsWith('-') && a !== 'run');
    if (!files.length) return { heavy: true, kind: 'suite', why: 'vitest (all)' };
    return { heavy: false };
  }
  if (bin === 'node' || bin === 'electron' || bin === 'munder difflin') {
    if (args.some((a) => a.startsWith('--native-memory-bench'))) return { heavy: true, kind: 'bench', why: 'native-memory bench' };
    if (args.includes('--test')) {
      // Positional args only: the value of a flag that takes one is not a test file.
      const files: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('-')) { if (NODE_VALUE_FLAGS.has(a)) i++; continue; }
        files.push(a);
      }
      if (!files.length) return { heavy: true, kind: 'suite', why: 'node --test (all)' };
      if (files.some((f) => /[*?]/.test(f) || !/\.[cm]?[jt]s$/.test(f))) return { heavy: true, kind: 'suite', why: 'node --test (a glob or a directory)' };
      if (files.length >= SUITE_MANY_FILES) return { heavy: true, kind: 'suite', why: `node --test (${files.length} files)` };
      return { heavy: false };
    }
    const script = args.find((a) => !a.startsWith('-'));
    if (script && BENCH_SCRIPT.test(script)) return { heavy: true, kind: 'bench', why: `node ${script.replace(/\\/g, '/').split('/').pop()}` };
    // Jim MF2: a whole-suite runner script with no filter argument is the suite.
    if (script && SUITE_RUNNER.test(script)) {
      const rest = args.slice(args.indexOf(script) + 1).filter((a) => !a.startsWith('-'));
      if (!rest.length) return { heavy: true, kind: 'suite', why: `node ${script.replace(/\\/g, '/').split('/').pop()} (no filter)` };
    }
    return { heavy: false };
  }
  return { heavy: false };
}

/** Classify a command line: heavy if ANY segment it runs is heavy. */
export function classifyCommand(cmd: string, depth = 0): HeavyClass {
  for (const seg of segments(cmd)) {
    const c = classifyWords(words(seg.replace(/\s&$/, '')), depth);
    if (c.heavy) return c;
  }
  return { heavy: false };
}

/** Classify a tool call (any provider: the command-shaped input only). */
export function classifyHeavy(_toolName: string | undefined, input: unknown): HeavyClass {
  const cmd = commandFromToolInput(input);
  return cmd ? classifyCommand(cmd) : { heavy: false };
}

/** Does this tool call leave the job running after the call returns? */
export function isBackground(input: unknown): boolean {
  if (input && typeof input === 'object' && (input as Record<string, unknown>).run_in_background === true) return true;
  const cmd = commandFromToolInput(input) ?? '';
  return /(^|[^&])&\s*$/.test(cmd.trim()) || /\bnohup\b|\bStart-Job\b|\bsetsid\b/.test(cmd);
}

// — the lock —

export type HeavyLimit = number | 'off';
/** The Settings value, normalised: 'off', or an integer 1..16 (default 1). */
export function heavyLimit(v: unknown): HeavyLimit {
  if (v === 'off' || v === false || v === 0) return 'off';
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(16, n) : 1;
}

export interface HeavyHolder {
  agentId: string;
  kind: HeavyKind;
  command: string;
  since: number;
  /** Last acquire or re-entry: the TTL runs from here. */
  touched: number;
  /** Foreground heavy calls still running (their PostToolUse releases them). */
  calls: Set<string>;
  /** A backgrounded job: released by its processes exiting (the watcher), the PTY, or the TTL. */
  background: boolean;
  /** Consecutive watcher scans that found no heavy process of this holder. */
  misses: number;
  /** The last watcher scan saw a heavy process of this holder (for a TTL expiry's log). */
  seenRunning: boolean;
  /** pid -> createdMs of this holder's job processes seen on earlier scans (Jim: orphans stay attributed). */
  attributed: Map<number, number>;
}

/** One process of the listing. `createdMs` (epoch ms) is what the watcher judges by (Jim MF3). */
export interface ProcRow { pid: number; parentPid: number; commandLine: string; createdMs?: number }
/** Clock skew allowed between the app's clock and a process CreationDate. */
export const HEAVY_CREATED_SKEW_MS = 2_000;
export interface HeavyLockDeps {
  limit: () => HeavyLimit;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** The PTY root pid of each agent (main's pty manager). */
  roots?: () => Array<{ agentId: string; pid: number }>;
  /** A process listing (hidden; only ever called while a slot is held). null = the listing FAILED. */
  probe?: () => Promise<ProcRow[] | null>;
  log?: (row: Record<string, unknown>) => void;
}

export const HEAVY_TTL_MS = 60 * 60_000;
export const HEAVY_SCAN_MS = 20_000;
export const HEAVY_SCAN_MISSES = 2;

export type HeavyDecision = { allow: true; acquired: boolean } | { allow: false; reason: string; holders: HeavyHolder[] };

export class HeavyJobLock {
  private readonly holders = new Map<string, HeavyHolder>();
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: HeavyLockDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** The current holders (fleet.json, the deny text, tests). Expired ones are released first. */
  snapshot(): Array<{ agentId: string; kind: HeavyKind; command: string; since: string; background: boolean }> {
    this.expire();
    return [...this.holders.values()].map((h) => ({ agentId: h.agentId, kind: h.kind, command: h.command, since: new Date(h.since).toISOString(), background: h.background }));
  }

  /** PreToolUse: a heavy call from `agentId`. Take a slot, share the agent's own, or deny. */
  acquire(agentId: string, cls: HeavyClass, command: string, callId: string, background: boolean): HeavyDecision {
    const limit = this.d.limit();
    if (!cls.heavy || !cls.kind) return { allow: true, acquired: false };
    // Off: no limit, but the heavy call is still visible (god: log 'heavy (unlimited)').
    if (limit === 'off') { this.log({ kind: 'heavy-lock', action: 'unlimited', agentId, heavyKind: cls.kind, why: cls.why ?? null }); return { allow: true, acquired: false }; }
    this.expire();
    const mine = this.holders.get(agentId);
    if (mine) {
      // Re-entrant: an agent's heavy calls share its one slot (and refresh its TTL).
      mine.calls.add(callId); mine.background = mine.background || background; mine.touched = this.now(); mine.misses = 0;
      this.log({ kind: 'heavy-lock', action: 'reenter', agentId, heavyKind: cls.kind, command: command.slice(0, 200) });
      this.arm();
      return { allow: true, acquired: false };
    }
    if (this.holders.size >= limit) {
      const holders = [...this.holders.values()];
      const who = holders.map((h) => `${h.agentId} (${h.kind}: ${h.command.slice(0, 80)}, since ${new Date(h.since).toISOString().slice(11, 19)}Z)`).join('; ');
      const reason = `Denied by HEAVY-JOB-LOCK: the machine allows ${limit} heavy job${limit === 1 ? '' : 's'} at once and ${holders.length === 1 ? 'it is' : 'they are'} held by ${who}. Do not retry this or a variant of it now: carry on with light work (single test files, reads, edits are not limited) and run it later, once a slot is free (when that job finishes, or after ${Math.round(HEAVY_TTL_MS / 60_000)} min at most), or ask god to schedule it.`;
      // Jim N3: the denied command's CLASS is logged, not the command itself.
      this.log({ kind: 'heavy-lock', action: 'deny', agentId, heavyKind: cls.kind, why: cls.why ?? null, holders: holders.map((h) => ({ agentId: h.agentId, kind: h.kind, since: new Date(h.since).toISOString() })), limit });
      return { allow: false, reason, holders };
    }
    this.holders.set(agentId, { agentId, kind: cls.kind, command: command.slice(0, 200), since: this.now(), touched: this.now(), calls: new Set([callId]), background, misses: 0, seenRunning: false, attributed: new Map() });
    this.log({ kind: 'heavy-lock', action: 'acquire', agentId, heavyKind: cls.kind, command: command.slice(0, 200), background, limit });
    this.arm();
    return { allow: true, acquired: true };
  }

  /** PostToolUse of a heavy call: a FOREGROUND call's job is done. The slot is freed when the
   *  agent has no foreground call left and no background job. */
  callDone(agentId: string, callId: string): void {
    const h = this.holders.get(agentId);
    if (!h || !h.calls.delete(callId)) return;
    if (h.calls.size || h.background) return;
    // Jim N2: a foreground call can return (a timeout, a detached child) while its heavy job
    // lives on. ONE quick descendant check before releasing: a heavy child keeps the slot and
    // turns the holder into a background one (the watcher then frees it when the child exits).
    if (this.d.probe && this.d.roots) {
      void this.heavyAgents().then((busy) => {
        const cur = this.holders.get(agentId);
        if (!cur || cur.calls.size || cur.background) return;
        if (busy?.busy.has(agentId)) { cur.background = true; cur.seenRunning = true; this.log({ kind: 'heavy-lock', action: 'orphan-kept', agentId, heavyKind: cur.kind }); this.arm(); return; }
        this.release(agentId, 'posttool');
      });
      return;
    }
    this.release(agentId, 'posttool');
  }

  /** The holders that are still BUSY now (one probe), or null.
   *  Jim MF3: NOT by classifying command lines. Real heavy jobs hide behind wrappers (Claude's
   *  `bash -c "... eval '...'"`, `node ...npm-cli.js ci`, `cmd /s /c ""npm.cmd" ci"`, electron-builder's
   *  cli.js, Claude's PowerShell launcher that never shows the command at all). A holder is busy
   *  while its agent's PTY tree has ANY descendant CREATED at or after its acquire: exact for every
   *  wrapper, shim and tool, and conservative (the agent's other calls only extend the hold). The
   *  PTY root itself and its long-lived children (created earlier) never count. */
  private async heavyAgents(): Promise<{ busy: Set<string>; seen: Set<string> } | null> {
    if (!this.d.probe || !this.d.roots) return null;
    let procs: ProcRow[] | null;
    try { procs = await this.d.probe(); } catch { procs = null; }
    // Jim MF4: a failed, empty or createdMs-less listing (most likely a TIMEOUT while heavy jobs load
    // the machine) is UNKNOWN, never "nothing running": the caller counts no miss.
    if (!procs || !procs.length || !procs.some((p) => typeof p.createdMs === 'number')) {
      this.log({ kind: 'heavy-lock', action: 'probe-failed', rows: procs ? procs.length : null });
      return null;
    }
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const rootOf = new Map(this.d.roots().map((r) => [r.pid, r.agentId]));
    const ownerOf = (pid: number): string | null => {
      const seen = new Set<number>([pid]); let child = byPid.get(pid); // start ABOVE the process: a root is not its own descendant
      while (child && !seen.has(child.parentPid)) {
        const up = byPid.get(child.parentPid);
        // Jim (PID reuse): a "parent" created AFTER its child is a reused PID, not the real parent.
        if (up && typeof up.createdMs === 'number' && typeof child.createdMs === 'number' && up.createdMs > child.createdMs) return null;
        const a = rootOf.get(child.parentPid);
        if (a) return a;
        seen.add(child.parentPid); child = up;
      }
      return null;
    };
    const busy = new Set<string>();
    // The holders whose PTY root IS in this listing: only for them may an absence count as a miss.
    const rootsSeen = new Set<string>(procs.flatMap((p) => { const a = rootOf.get(p.pid); return a ? [a] : []; }));
    for (const p of procs) {
      if (typeof p.createdMs !== 'number') continue;
      const a = ownerOf(p.pid);
      const h = a ? this.holders.get(a) : undefined;
      if (h && p.createdMs >= h.since - HEAVY_CREATED_SKEW_MS) { busy.add(h.agentId); h.attributed.set(p.pid, p.createdMs); }
    }
    // Jim (orphans): a job detached with & / nohup whose shell has exited loses its parent chain.
    // A pid attributed to a holder on an earlier scan still counts while it persists with the SAME
    // creation time (a reused pid has another); pids no longer listed are forgotten.
    for (const h of this.holders.values()) {
      for (const [pid, created] of h.attributed) {
        const p = byPid.get(pid);
        if (p && p.createdMs === created) busy.add(h.agentId); else h.attributed.delete(pid);
      }
    }
    return { busy, seen: rootsSeen };
  }

  /** The holder's PTY exited: its jobs are gone with it. */
  agentGone(agentId: string): void {
    if (this.holders.has(agentId)) this.release(agentId, 'pty-exit');
  }

  private release(agentId: string, reason: 'posttool' | 'process-exit' | 'pty-exit' | 'ttl' | 'expired-still-running'): void {
    const h = this.holders.get(agentId);
    if (!h) return;
    this.holders.delete(agentId);
    this.log({ kind: 'heavy-lock', action: 'release', agentId, heavyKind: h.kind, reason, heldMs: this.now() - h.since });
    if (!this.holders.size && this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }

  private expire(): void {
    const t = this.now();
    // Jim N5: a TTL expiry while the watcher last SAW the job running is logged distinctly.
    for (const h of [...this.holders.values()]) if (t - h.touched >= HEAVY_TTL_MS) this.release(h.agentId, h.seenRunning ? 'expired-still-running' : 'ttl');
  }

  /** The watcher runs only while a slot is held: TTL expiry for everyone, and a process check
   *  for background holders (a hidden listing every HEAVY_SCAN_MS). */
  private arm(): void {
    if (this.timer || !this.holders.size) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.scan().finally(() => this.arm()); }, HEAVY_SCAN_MS);
  }

  /** One watcher tick (exported for tests). */
  async scan(): Promise<void> {
    this.expire();
    // Jim MF1 / god andyheavyfix: EVERY holder is checked, not only background ones: a foreground
    // call whose PostToolUse never comes (a gate, Esc, a timeout, a degraded Codex hook) must not
    // pin a slot for the whole TTL. The listing runs only while a slot is held. A miss counts only
    // once the holder is at least one scan interval old (its job has had time to start).
    const held = [...this.holders.values()];
    if (!held.length || !this.d.probe || !this.d.roots) return;
    const probed = await this.heavyAgents();
    if (!probed) return;   // Jim MF4: unknown, not a miss
    const { busy, seen } = probed;
    const t = this.now();
    for (const h of held) {
      if (!this.holders.has(h.agentId)) continue;
      if (busy.has(h.agentId)) { h.misses = 0; h.seenRunning = true; continue; }
      if (!seen.has(h.agentId)) continue;   // its PTY root is not in the listing: unknown, not a miss
      h.seenRunning = false;
      if (t - h.touched < HEAVY_SCAN_MS) continue;
      h.misses++;
      // No heavy process of the holder on HEAVY_SCAN_MISSES scans: its job is gone, whatever the
      // call bookkeeping says (an open call here is one whose PostToolUse never came).
      if (h.misses >= HEAVY_SCAN_MISSES) { h.calls.clear(); this.release(h.agentId, 'process-exit'); }
    }
  }

  private log(row: Record<string, unknown>): void { try { this.d.log?.(row); } catch { /* best effort */ } }
}

/** The listing script: one hidden, non-interactive PowerShell CIM query. CreationDate goes out as
 *  epoch ms under the `CreatedMs` alias (PowerShell 5.1 would serialise a DateTime as /Date(...)/). */
export const PROCESS_LISTING_SCRIPT = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{n='CreatedMs';e={ if ($_.CreationDate) { [int64](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds) } else { $null } }} | ConvertTo-Json -Compress";

/** Parse the listing's ConvertTo-Json output (an array, or one bare object). null = unusable
 *  (empty, unparseable, or no row carries a numeric CreatedMs): the watcher then counts no miss. */
export function parseProcessListing(stdout: string): ProcRow[] | null {
  if (!stdout || !stdout.trim()) return null;
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return null; }
  const rows = (Array.isArray(raw) ? raw : [raw]) as Array<{ ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown; CreatedMs?: unknown } | null>;
  const out = rows.filter((r) => r && Number.isInteger(r.ProcessId)).map((r) => ({ pid: r!.ProcessId as number, parentPid: Number(r!.ParentProcessId), commandLine: typeof r!.CommandLine === 'string' ? r!.CommandLine : '', ...(typeof r!.CreatedMs === 'number' ? { createdMs: r!.CreatedMs } : {}) }));
  return out.length && out.some((p) => typeof p.createdMs === 'number') ? out : null;
}

/** The default process listing (Windows only; null when it fails or times out). */
export function probeProcesses(): Promise<ProcRow[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_LISTING_SCRIPT], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    resolve(err ? null : parseProcessListing(String(stdout)));
  }));
}
