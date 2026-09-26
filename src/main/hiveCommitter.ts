/**
 * MESSAGE-LAG-152 cause 1 (Jim, proven; god's fix): the hive's state commit, off the main
 * thread's critical path.
 *
 * Every routed message ended in Hive.commit(), which ran `git add -A` and `git commit` with
 * spawnSync ON ELECTRON MAIN (8 s timeout, up to 5 lock retries with a busy-wait sleep).
 * Measured on a copy of the live hive: 1.7 s median, 3.1 s busy, 6.3 s cold, 57 commits an
 * hour. While main blocked, ALL IPC stalled: pty output, keystrokes (pty:write), hooks.
 *
 * Now a commit is a REQUEST, which costs a push onto an array and a timer:
 *   - COALESCED: requests within an idle window (IDLE_MS) become one commit whose message
 *     lists them; a steady stream still commits at least every MAX_WAIT_MS.
 *   - ASYNC: git runs as a child process the main thread does not wait on.
 *   - SINGLE-FLIGHT: one git operation at a time. A request during a commit is picked up by
 *     the next one; commits never overlap each other or a gc.
 *   - Lock retries back off with a timer, not a busy-wait.
 *   - FAILURES are logged once per distinct failure (again after a success), and never
 *     reach the caller: message delivery does not wait for, or depend on, the commit.
 *   - FLUSH on quit: flush() commits whatever is pending (after any commit in flight).
 *
 * Unchanged on purpose (god, (b)): no --no-verify, and the repo's own hooks (the Human's
 * identity guard) still run on every commit. What changed is only where they run.
 *
 * REPO HEALTH ((c)): a commit runs with git's automatic maintenance switched off
 * (`gc.auto=0`, `maintenance.auto=false`), because git would otherwise start `gc --auto`
 * INSIDE the commit, under the commit's timeout. With 6,969 loose objects and no packs it
 * was due on every commit and never got to finish. The committer runs `git gc --auto`
 * itself instead, in its own single-flight slot (never beside a commit), a few minutes after
 * launch and then at most once per GC_INTERVAL_MS, with a long timeout.
 */
import { execFile } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface GitResult { ok: boolean; out: string; err: string }
/** Runs git in `cwd`. MUST NOT block the calling thread (the default is an async child). */
export type GitRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<GitResult>;

/** The identity every hive commit is made under (unchanged from the sync committer). */
export const HIVE_GIT_IDENTITY = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local'];
/** Switches off the maintenance git would otherwise run inside a commit (see the header). */
export const NO_AUTO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

/** 1.1.53 AV R2 (Jim, AV-152): each commit costs ~59 process starts (git plus the Human's
 *  identity-guard hooks, which fork a shell per substitution and must keep running on every
 *  commit), each one an antivirus scan. Commits are the hive's audit trail, not its delivery
 *  path (a message is on disk and delivered before any commit), so they are batched harder:
 *  a quiet 30 s, and at most every 2 min under a steady stream. Flush on quit is unchanged,
 *  and a crash loses no file, only the grouping of the history. */
export const COMMIT_IDLE_MS = 30_000;
export const COMMIT_MAX_WAIT_MS = 120_000;
export const COMMIT_TIMEOUT_MS = 60_000;
export const LOCK_RETRIES = 5;
export const STALE_LOCK_MS = 10_000;
export const GC_FIRST_DELAY_MS = 3 * 60_000;
export const GC_INTERVAL_MS = 6 * 60 * 60_000;
export const GC_TIMEOUT_MS = 20 * 60_000;
/** How many coalesced request lines a commit message lists before summarising the rest. */
export const MESSAGE_LINES = 40;

export const execFileGit: GitRunner = (args, cwd, timeoutMs) => new Promise((resolve) => {
  execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ ok: !error, out: stdout ?? '', err: stderr || (error ? String(error) : '') }));
});

/** The message for one coalesced commit: the request itself when there was one, else a
 *  count with the requests listed (capped) in the body. */
export function coalescedMessage(requests: readonly string[]): string {
  if (requests.length === 1) return requests[0];
  const shown = requests.slice(0, MESSAGE_LINES).map((m) => `- ${m}`);
  if (requests.length > MESSAGE_LINES) shown.push(`- …and ${requests.length - MESSAGE_LINES} more`);
  return `hive: ${requests.length} changes\n\n${shown.join('\n')}`;
}

export interface HiveCommitterDeps {
  /** The hive root, or null when there is no hive (nothing to commit). */
  root: () => string | null;
  git?: GitRunner;
  /** One-time repo tidying, run inside the single flight before the first commit. */
  prepare?: (root: string, git: (args: string[]) => Promise<GitResult>) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  idleMs?: number;
  maxWaitMs?: number;
  gcFirstDelayMs?: number;
  gcIntervalMs?: number;
}

export class HiveCommitter {
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idleMs: number;
  private readonly maxWaitMs: number;
  private readonly gcIntervalMs: number;

  private pending: string[] = [];
  /** When the oldest pending request arrived (bounds the debounce), 0 = none pending. */
  private firstPendingAt = 0;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private prepared = false;
  /** When this process's committer started (wall clock): a lock older than this cannot be
   *  from a git this process ran. */
  private readonly startedAt = Date.now();
  private nextGcAt: number;
  private lastFailure: string | null = null;
  /** Counters for tests and diagnostics. */
  readonly stats = { requests: 0, commits: 0, gcRuns: 0, failures: 0, maxConcurrent: 0 };
  private concurrent = 0;

  constructor(private readonly deps: HiveCommitterDeps) {
    this.git = deps.git ?? execFileGit;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.idleMs = deps.idleMs ?? COMMIT_IDLE_MS;
    this.maxWaitMs = deps.maxWaitMs ?? COMMIT_MAX_WAIT_MS;
    this.gcIntervalMs = deps.gcIntervalMs ?? GC_INTERVAL_MS;
    this.nextGcAt = this.now() + (deps.gcFirstDelayMs ?? GC_FIRST_DELAY_MS);
  }

  /** Ask for the hive's state to be committed. Never touches git or the disk; returns at once. */
  request(message: string): void {
    this.stats.requests += 1;
    const now = this.now();
    if (this.pending.length === 0) this.firstPendingAt = now;
    this.pending.push(message);
    if (this.timer !== null) this.clearTimer(this.timer);
    // Debounced on the idle window, but never past MAX_WAIT from the oldest request.
    const wait = Math.max(0, Math.min(this.idleMs, this.firstPendingAt + this.maxWaitMs - now));
    this.timer = this.setTimer(() => { this.timer = null; void this.drain(); }, wait);
  }

  /** Commit everything requested so far, after any commit already in flight. Resolves once
   *  it is committed (or failed and was logged); never rejects. For quit. */
  async flush(): Promise<void> {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    // A drain in flight may have started before the latest requests: wait it out, then
    // drain again until nothing is pending.
    while (this.running || this.pending.length > 0) {
      if (this.running) await this.running;
      else await this.drain();
    }
  }

  /** Requests not yet committed (for diagnostics and tests). */
  pendingCount(): number { return this.pending.length; }

  private drain(): Promise<void> {
    if (this.running) return this.running;   // single flight: the running one re-checks pending
    this.running = (async () => {
      try {
        // Requests that arrive during a commit OR during a gc are picked up here: their own
        // timer found this flight running and left them to it.
        do {
          while (this.pending.length > 0) {
            const batch = this.pending;
            this.pending = [];
            this.firstPendingAt = 0;
            await this.commitBatch(batch);
          }
          await this.maybeGc();
        } while (this.pending.length > 0);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async run(args: string[], root: string, timeoutMs: number): Promise<GitResult> {
    this.concurrent += 1;
    this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.concurrent);
    try { return await this.git(args, root, timeoutMs); }
    catch (e) { return { ok: false, out: '', err: String(e) }; }
    finally { this.concurrent -= 1; }
  }

  private async commitBatch(batch: string[]): Promise<void> {
    const root = this.deps.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    if (!this.prepared) {
      this.prepared = true;
      // R1 (Jim): the 8 s quit bound can kill an in-flight git and leave index.lock behind.
      // Before this process's FIRST git, a lock older than the process itself is such a
      // leftover (no git of ours has run yet), so it is cleared even if it is under
      // STALE_LOCK_MS old: a quick relaunch would otherwise fail its first commit.
      clearStaleLock(root, this.startedAt);
      try { await this.deps.prepare?.(root, (args) => this.run([...HIVE_GIT_IDENTITY, ...args], root, COMMIT_TIMEOUT_MS)); }
      catch (e) { this.fail(`prepare: ${String(e)}`); }
    }
    const message = coalescedMessage(batch);
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      clearStaleLock(root);
      const add = await this.run([...HIVE_GIT_IDENTITY, ...NO_AUTO_MAINTENANCE, 'add', '-A'], root, COMMIT_TIMEOUT_MS);
      const commit = await this.run([...HIVE_GIT_IDENTITY, ...NO_AUTO_MAINTENANCE, 'commit', '-q', '-m', message], root, COMMIT_TIMEOUT_MS);
      if (commit.ok) { this.stats.commits += 1; this.lastFailure = null; return; }
      if (/nothing to commit/i.test(commit.out + commit.err)) { this.lastFailure = null; return; }
      if (!add.ok || /index\.lock/i.test(add.err + commit.err)) { await this.sleep(50 * (attempt + 1)); continue; }
      this.fail(`commit: ${firstLine(commit.err || commit.out)}`);
      return;   // a non-lock failure: the next request's commit picks the state up (add -A)
    }
    this.fail('commit: index.lock held through every retry');
  }

  private async maybeGc(): Promise<void> {
    const now = this.now();
    if (now < this.nextGcAt) return;
    this.nextGcAt = now + this.gcIntervalMs;
    const root = this.deps.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    this.stats.gcRuns += 1;
    // autoDetach off: a gc that forks itself into the background would escape the single flight.
    const res = await this.run(['-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet'], root, GC_TIMEOUT_MS);
    if (!res.ok) this.fail(`gc: ${firstLine(res.err || res.out)}`);
    else this.deps.log?.('[hive] git gc --auto finished');
  }

  private fail(what: string): void {
    this.stats.failures += 1;
    if (this.lastFailure === what) return;   // once per distinct failure, again after a success
    this.lastFailure = what;
    this.deps.log?.(`[hive] ${what}`);
  }
}

function firstLine(s: string): string {
  return (s.trim().split('\n')[0] ?? '').slice(0, 300);
}

/** A lock older than STALE_LOCK_MS belongs to a git that died; remove it (two small fs calls).
 *  With `olderThan`, a lock last touched before that moment is removed too (see R1). */
function clearStaleLock(root: string, olderThan?: number): void {
  const lock = join(root, '.git', 'index.lock');
  try {
    if (!existsSync(lock)) return;
    const mtime = statSync(lock).mtimeMs;
    if (Date.now() - mtime > STALE_LOCK_MS || (olderThan !== undefined && mtime < olderThan)) rmSync(lock);
  } catch { /* noop */ }
}
