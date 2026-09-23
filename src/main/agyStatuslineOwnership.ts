/**
 * Ownership of Antigravity's GLOBAL statusline setting (AGY 1.1.48, commit 2).
 *
 * WHAT THIS IS FOR. Antigravity reports its quota and lifecycle only to a statusline
 * command, and there is exactly one statusline per Gemini home - the user's own. To
 * see an AGY session's capacity Munder has to install its own command there. That is a
 * change to a file the user owns, so it is LEASED, never simply overwritten: the exact
 * prior value is recorded before the first write, restored on the way out only if the
 * setting still holds Munder's value, and a user's edit made while Munder was running is
 * adopted rather than clobbered.
 *
 * THE SETTING'S SHAPE IS THE PROVIDER'S, AND IT IS AN OBJECT. The design of record
 * described a scalar `statusline` string. The agy 1.2.8 binary and the only working
 * configuration we have both say otherwise: the key is camelCase `statusLine` and the
 * value is `{ type: 'command', command, enabled }` (settings struct field `StatusLine`,
 * `json:"statusLine"`, type `StatusLineConfig`). Nothing below depends on the shape
 * beyond `installedValueFor`: the prior value is kept as an arbitrary JSON value, and
 * "still ours" is key-order-insensitive deep equality with what was installed.
 *
 * FAIL CLOSED, EVERYWHERE. Every ambiguity - a lock held by a process we cannot prove
 * dead, a journal we cannot parse, settings that are not a plain JSON object, a race we
 * lose twice - ends in "no mutation, capture disabled for this run, one diagnostic".
 * Losing telemetry is cheap. Writing over a user's configuration is not.
 *
 * Everything here is synchronous: it runs at startup, just before an interactive AGY
 * spawn, and in the quit path, where an await is a chance for the process to be gone.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';

/** The settings property Antigravity reads its statusline from. */
export const STATUSLINE_KEY = 'statusLine';

/** Every outcome and failure this module reports. A closed set of fixed strings. */
export const STATUSLINE_DIAGNOSTICS = [
  'owned',               // a new lease: Munder's value installed
  'adopted',             // joined an existing lease (another instance, or a crash leftover)
  'self-healed',         // finished a write a crash interrupted before settings changed
  'skipped-no-agy',      // no Antigravity config directory: nothing to own, nothing created
  'dev-isolation',       // MUNDER_DEV=1 never touches the real Gemini home
  'external-override',   // the setting holds something else: relinquished, left alone
  'corrupt-journal',     // a journal we cannot trust: quarantined, settings untouched
  'malformed-settings',  // settings are not a plain JSON object: no mutation
  'cas-conflict',        // settings changed under us twice in a row: no mutation
  'lock-busy',           // a live holder kept the lock past the bound
  'lock-ambiguous',      // a holder we cannot prove dead: never break it
  'released',            // this instance's lease removed; others remain
  'restored',            // the last lease: the exact prior value put back
  'adopted-user-edit',   // the last lease, but the user changed it: left exactly as is
  'restore-cas-failed'   // could not restore safely: journal left for the next run
] as const;
export type StatuslineDiagnostic = (typeof STATUSLINE_DIAGNOSTICS)[number];

/** One running Munder instance's claim on the installed value. */
export interface StatuslineLease {
  id: string;
  pid: number;
  /** Identifies THIS start of that pid, so a recycled pid is never mistaken for it. */
  processStartedAt: number;
}

/** Journal schema 1. Local control data only - never the whole settings document. */
export interface StatuslineJournal {
  schema: 1;
  phase: 'prepared' | 'owned';
  token: string;
  installedValue: unknown;
  prior: { present: false } | { present: true; value: unknown };
  settingsHashBefore: string;
  leases: StatuslineLease[];
  createdAt: number;
}

/** What a process-liveness question can honestly answer. */
export type Liveness = 'dead' | 'live' | 'ambiguous';

/** The effects this module performs, injectable so every crash boundary is testable. */
export interface StatuslineEnv {
  /** The Gemini home whose settings are leased. Tests pass a sandbox; production passes `geminiHome()`. */
  geminiHome: string;
  /** Builds the command string for a lease generation's owner token. */
  commandFor: (token: string) => string;
  pid: number;
  processStartedAt: number;
  now: () => number;
  randomToken: () => string;
  /** Is (pid, processStartedAt) still the process that took the lease? */
  liveness: (pid: number, processStartedAt: number) => Liveness;
  /** Bounded wait between lock attempts. */
  sleep: (ms: number) => void;
  /** Where each outcome is reported. Diagnostics carry a fixed code and nothing else. */
  report: (code: StatuslineDiagnostic) => void;
  /** Test seam: throw at a named step to simulate a crash there. Never set in production. */
  crashAt?: (step: CrashStep) => void;
}

/** Every step boundary a crash can fall between. */
export type CrashStep =
  | 'after-journal-prepared'
  | 'after-settings-replaced'
  | 'after-journal-owned'
  | 'after-restore-write';

export interface StatuslinePaths {
  settings: string;
  journal: string;
  lock: string;
}

export function statuslinePaths(geminiHome: string): StatuslinePaths {
  const dir = join(geminiHome, 'antigravity-cli');
  return {
    settings: join(dir, 'settings.json'),
    journal: join(dir, '.munder-statusline-owner.json'),
    lock: join(dir, '.munder-statusline-owner.lock')
  };
}

/**
 * The value Munder installs. The ONLY place the provider's shape lives.
 *
 * The owner token is inside `command`, which makes the whole object unique to one lease
 * generation: another tool's statusline, the user's own, or an older Munder lease can
 * never compare equal to it.
 */
export function installedValueFor(command: string): Record<string, unknown> {
  return { type: 'command', command, enabled: true };
}

// ─── primitives ──────────────────────────────────────────────────────────────

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Key-order-insensitive canonical JSON, so a rewrite that reorders keys is not an edit. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isDict(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}
export const sameValue = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

const sha = (bytes: Buffer | null): string =>
  createHash('sha256').update(bytes ?? Buffer.alloc(0)).digest('hex');

function readBytes(p: string): Buffer | null {
  try { return readFileSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Same-directory temp, flush, atomic replace. The reader sees the old file or the new one. */
function writeAtomic(p: string, text: string, mode?: number): void {
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { renameSync(tmp, p); } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

function unlinkQuiet(p: string): void {
  try { unlinkSync(p); } catch { /* already gone */ }
}

/** Settings as a parsed plain object, or 'malformed'. A missing file is an empty object. */
function readSettings(p: string): { bytes: Buffer | null; obj: Dict } | 'malformed' {
  const bytes = readBytes(p);
  if (bytes === null) return { bytes: null, obj: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { return 'malformed'; }
  return isDict(parsed) ? { bytes, obj: parsed } : 'malformed';
}

/**
 * Replace settings only if they still hash to `expected` IMMEDIATELY before the rename.
 * Returns false (nothing written) when they moved. The window between this compare and
 * the rename is a few syscalls wide; the journal records enough to recover from losing it.
 */
function casWriteSettings(p: string, expected: string, obj: Dict): boolean {
  if (sha(readBytes(p)) !== expected) return false;
  mkdirSync(dirname(p), { recursive: true });
  writeAtomic(p, `${JSON.stringify(obj, null, 2)}\n`);
  return true;
}

function validJournal(v: unknown): v is StatuslineJournal {
  if (!isDict(v) || v.schema !== 1) return false;
  if (v.phase !== 'prepared' && v.phase !== 'owned') return false;
  if (typeof v.token !== 'string' || !/^[0-9a-f]{32}$/.test(v.token)) return false;
  if (!('installedValue' in v)) return false;
  if (typeof v.settingsHashBefore !== 'string' || !/^[0-9a-f]{64}$/.test(v.settingsHashBefore)) return false;
  if (typeof v.createdAt !== 'number') return false;
  const prior = v.prior;
  if (!isDict(prior) || typeof prior.present !== 'boolean') return false;
  if (prior.present && !('value' in prior)) return false;
  if (!Array.isArray(v.leases)) return false;
  return v.leases.every((l) => isDict(l) && typeof l.id === 'string'
    && Number.isInteger(l.pid) && typeof l.processStartedAt === 'number');
}

function readJournal(p: string): StatuslineJournal | null | 'corrupt' {
  const bytes = readBytes(p);
  if (bytes === null) return null;
  try {
    const v = JSON.parse(bytes.toString('utf8'));
    return validJournal(v) ? v : 'corrupt';
  } catch { return 'corrupt'; }
}

function writeJournal(p: string, j: StatuslineJournal): void {
  // Owner-only where the platform honours a mode.
  writeAtomic(p, `${JSON.stringify(j, null, 2)}\n`, 0o600);
}

/** Move a journal we cannot trust aside, so the next run starts clean and the evidence survives. */
function quarantine(p: string, now: number): void {
  try { renameSync(p, `${p}.corrupt-${now}`); } catch { unlinkQuiet(p); }
}

// ─── the lock ────────────────────────────────────────────────────────────────

const LOCK_ATTEMPTS = 20;
const LOCK_BACKOFF_MS = 25;

/**
 * Hold the adjacent exclusive lock for `fn`. BOUNDED: after `LOCK_ATTEMPTS` the answer
 * is 'lock-busy'. A holder that is provably dead is pruned; a holder we cannot prove dead
 * - including a lock file we cannot parse - is NEVER broken: this run gives up instead.
 */
function withLock<T>(env: StatuslineEnv, lock: string, fn: () => T): T | 'lock-busy' | 'lock-ambiguous' {
  mkdirSync(dirname(lock), { recursive: true });
  const mine = JSON.stringify({ pid: env.pid, processStartedAt: env.processStartedAt, createdAt: env.now() });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder: unknown = null;
      try { holder = JSON.parse(readFileSync(lock, 'utf8')); } catch { holder = null; }
      if (!isDict(holder) || !Number.isInteger(holder.pid) || typeof holder.processStartedAt !== 'number') {
        return 'lock-ambiguous';
      }
      const alive = env.liveness(holder.pid as number, holder.processStartedAt as number);
      if (alive === 'dead') { unlinkQuiet(lock); continue; }
      if (alive === 'ambiguous') return 'lock-ambiguous';
      env.sleep(LOCK_BACKOFF_MS);
      continue;
    }
    try {
      writeSync(fd, mine);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      return fn();
    } finally {
      unlinkQuiet(lock);
    }
  }
  return 'lock-busy';
}

// ─── the state machine ───────────────────────────────────────────────────────

/** Keep only leases whose process is provably dead. Ambiguous is KEPT: never restore under it. */
function pruneDead(env: StatuslineEnv, leases: StatuslineLease[]): StatuslineLease[] {
  return leases.filter((l) => env.liveness(l.pid, l.processStartedAt) !== 'dead');
}

export type AcquireResult =
  | { captureEnabled: true; token: string; leaseId: string; code: StatuslineDiagnostic }
  | { captureEnabled: false; code: StatuslineDiagnostic };

/**
 * Install or join the lease. Called at startup and again just before an interactive
 * AGY spawn (both through `AgyStatuslineOwner`, which remembers a disable for the run).
 */
export function acquireStatuslineLease(env: StatuslineEnv): AcquireResult {
  const paths = statuslinePaths(env.geminiHome);
  // Never create the Antigravity directory: a user who has never run AGY has no
  // statusline to lease, and making one for them is a change nobody asked for.
  if (!existsSync(dirname(paths.settings))) return done(env, { captureEnabled: false, code: 'skipped-no-agy' });

  const r = withLock(env, paths.lock, (): AcquireResult => {
    const journal = readJournal(paths.journal);
    if (journal === 'corrupt') {
      quarantine(paths.journal, env.now());
      return { captureEnabled: false, code: 'corrupt-journal' };
    }
    const lease: StatuslineLease = { id: env.randomToken(), pid: env.pid, processStartedAt: env.processStartedAt };

    for (let attempt = 0; attempt < 2; attempt++) {
      const settings = readSettings(paths.settings);
      if (settings === 'malformed') return { captureEnabled: false, code: 'malformed-settings' };
      const current = settings.obj[STATUSLINE_KEY];
      const present = Object.prototype.hasOwnProperty.call(settings.obj, STATUSLINE_KEY);
      let j = attempt === 0 ? journal : readJournal(paths.journal);
      if (j === 'corrupt') { quarantine(paths.journal, env.now()); return { captureEnabled: false, code: 'corrupt-journal' }; }

      // A RESTORE THAT FINISHED BUT NEVER CLEANED UP. The last owner put the prior value
      // back and died before deleting the journal: no live lease remains, and the setting
      // is exactly what the journal says the user had. That is not an override - it is
      // the state a clean shutdown leaves, plus a leftover file - so the leftover goes and
      // this run starts fresh. (Without this, a crash inside the restore would disable
      // capture for the NEXT run as an "external override" of a value nobody changed.)
      if (j && j.phase === 'owned' && pruneDead(env, j.leases).length === 0
        && (j.prior.present ? present && sameValue(current, j.prior.value) : !present)) {
        unlinkQuiet(paths.journal);
        j = null;
      }

      if (j) {
        const ours = present && sameValue(current, j.installedValue);
        if (ours) {
          // Crash leftover or another live instance. Either way the ORIGINAL prior value
          // is retained - adopting a lease must never re-record "prior" as our own value.
          const next: StatuslineJournal = { ...j, phase: 'owned', leases: [...pruneDead(env, j.leases), lease] };
          writeJournal(paths.journal, next);
          return { captureEnabled: true, token: j.token, leaseId: lease.id, code: 'adopted' };
        }
        if (j.phase === 'prepared' && sha(settings.bytes) === j.settingsHashBefore) {
          // The crash fell between publishing the prepared journal and replacing
          // settings: the only safe incomplete write, so finish it.
          const out = finishInstall(env, paths, j, settings.obj, lease);
          return out.captureEnabled ? { ...out, code: 'self-healed' } : out;
        }
        // Neither ours nor the untouched preimage: somebody else's value. Relinquish.
        unlinkQuiet(paths.journal);
        return { captureEnabled: false, code: 'external-override' };
      }

      // NEW OWNERSHIP.
      const token = env.randomToken();
      const prepared: StatuslineJournal = {
        schema: 1,
        phase: 'prepared',
        token,
        installedValue: installedValueFor(env.commandFor(token)),
        prior: present ? { present: true, value: current } : { present: false },
        settingsHashBefore: sha(settings.bytes),
        leases: [],
        createdAt: env.now()
      };
      writeJournal(paths.journal, prepared);
      env.crashAt?.('after-journal-prepared');
      const out = finishInstall(env, paths, prepared, settings.obj, lease);
      if (out.captureEnabled || out.code !== 'cas-conflict') return out;
      // Settings moved between the read and the write: discard OUR prepared journal and
      // try once more from the new state. A second loss disables capture.
      unlinkQuiet(paths.journal);
    }
    return { captureEnabled: false, code: 'cas-conflict' };
  });
  return done(env, typeof r === 'string' ? { captureEnabled: false, code: r } : r);
}

/** Steps 4-5: install, verify, promote to owned. */
function finishInstall(
  env: StatuslineEnv, paths: StatuslinePaths, j: StatuslineJournal, obj: Dict, lease: StatuslineLease
): AcquireResult {
  const next = { ...obj, [STATUSLINE_KEY]: j.installedValue };
  if (!casWriteSettings(paths.settings, j.settingsHashBefore, next)) {
    return { captureEnabled: false, code: 'cas-conflict' };
  }
  env.crashAt?.('after-settings-replaced');
  const verify = readSettings(paths.settings);
  if (verify === 'malformed' || !sameValue(verify.obj[STATUSLINE_KEY], j.installedValue)) {
    // Something replaced settings between our write and our read. Not ours to fight.
    unlinkQuiet(paths.journal);
    return { captureEnabled: false, code: 'external-override' };
  }
  writeJournal(paths.journal, { ...j, phase: 'owned', leases: [...pruneDead(env, j.leases), lease] });
  env.crashAt?.('after-journal-owned');
  return { captureEnabled: true, token: j.token, leaseId: lease.id, code: 'owned' };
}

/**
 * Just before an interactive AGY spawn: is Munder's value still installed?
 *
 * If it is not, that is a user (or another tool) choosing a different statusline while we
 * held the lease. It is RELINQUISHED on the spot - our lease removed, the setting left
 * byte-for-byte alone - and the caller keeps capture disabled for the rest of the run. A
 * later clean app start may begin a new lease and will record that value as its prior.
 */
export function reconcileStatuslineLease(env: StatuslineEnv, leaseId: string): 'intact' | StatuslineDiagnostic {
  const paths = statuslinePaths(env.geminiHome);
  const r = withLock(env, paths.lock, (): 'intact' | StatuslineDiagnostic => {
    const j = readJournal(paths.journal);
    if (j === 'corrupt') { quarantine(paths.journal, env.now()); return 'corrupt-journal'; }
    if (!j || !j.leases.some((l) => l.id === leaseId)) return 'external-override';
    const settings = readSettings(paths.settings);
    if (settings === 'malformed') return 'malformed-settings';
    if (sameValue(settings.obj[STATUSLINE_KEY], j.installedValue)
      && Object.prototype.hasOwnProperty.call(settings.obj, STATUSLINE_KEY)) return 'intact';
    const rest = pruneDead(env, j.leases).filter((l) => l.id !== leaseId);
    if (rest.length) writeJournal(paths.journal, { ...j, leases: rest });
    else unlinkQuiet(paths.journal);
    return 'external-override';
  });
  if (r !== 'intact') env.report(r);
  return r;
}

/**
 * Clean shutdown: drop this instance's lease; if it was the LAST live one, restore the
 * exact prior value - but only if the setting still holds Munder's value.
 */
export function releaseStatuslineLease(env: StatuslineEnv, leaseId: string): StatuslineDiagnostic {
  const paths = statuslinePaths(env.geminiHome);
  const r = withLock(env, paths.lock, (): StatuslineDiagnostic => {
    const j = readJournal(paths.journal);
    if (j === 'corrupt') { quarantine(paths.journal, env.now()); return 'corrupt-journal'; }
    if (!j) return 'external-override';
    const rest = pruneDead(env, j.leases).filter((l) => l.id !== leaseId);
    if (rest.length) {
      writeJournal(paths.journal, { ...j, leases: rest });
      return 'released';
    }
    const settings = readSettings(paths.settings);
    if (settings === 'malformed') return 'restore-cas-failed';
    const present = Object.prototype.hasOwnProperty.call(settings.obj, STATUSLINE_KEY);
    if (!present || !sameValue(settings.obj[STATUSLINE_KEY], j.installedValue)) {
      // The user changed it while we held it. Their value stands; ours is simply gone.
      unlinkQuiet(paths.journal);
      return 'adopted-user-edit';
    }
    const next: Dict = { ...settings.obj };
    if (j.prior.present) next[STATUSLINE_KEY] = j.prior.value;
    else delete next[STATUSLINE_KEY];
    if (!casWriteSettings(paths.settings, sha(settings.bytes), next)) {
      // Leave the journal: the next reconciliation decides with fresh evidence. Never guess.
      writeJournal(paths.journal, { ...j, leases: [] });
      return 'restore-cas-failed';
    }
    env.crashAt?.('after-restore-write');
    const verify = readSettings(paths.settings);
    const restored = verify !== 'malformed' && (j.prior.present
      ? sameValue(verify.obj[STATUSLINE_KEY], j.prior.value)
      : !Object.prototype.hasOwnProperty.call(verify.obj, STATUSLINE_KEY));
    if (!restored) {
      writeJournal(paths.journal, { ...j, leases: [] });
      return 'restore-cas-failed';
    }
    unlinkQuiet(paths.journal);
    return 'restored';
  });
  env.report(r);
  return r;
}

function done<T extends { code: StatuslineDiagnostic }>(env: StatuslineEnv, r: T): T {
  env.report(r.code);
  return r;
}

// ─── the per-run owner ───────────────────────────────────────────────────────

/**
 * One app run's relationship with the lease. Holds what the stateless functions above
 * cannot: the lease id, and the fact that capture was disabled - which is STICKY for the
 * run. Once Munder's value has been overridden it never tries again until a clean restart,
 * because "self-heal" that repeatedly reinstalls over a user's choice is not healing.
 */
export class AgyStatuslineOwner {
  private leaseId: string | null = null;
  private token: string | null = null;
  private disabled = false;

  constructor(private env: StatuslineEnv) {}

  /** Startup, and just before an interactive AGY spawn. Returns whether capture is on. */
  ensure(): boolean {
    if (this.disabled) return false;
    if (this.leaseId) {
      const r = reconcileStatuslineLease(this.env, this.leaseId);
      if (r === 'intact') return true;
      this.leaseId = null;
      this.token = null;
      // A lock we could not take is a reason to skip THIS check, not evidence of an
      // override - but we cannot confirm the value either, so capture is off for now.
      if (r !== 'lock-busy' && r !== 'lock-ambiguous') this.disabled = true;
      return false;
    }
    const r = acquireStatuslineLease(this.env);
    if (r.captureEnabled) {
      this.leaseId = r.leaseId;
      this.token = r.token;
      return true;
    }
    // A missing AGY install is not a disable: an AGY spawn later in the run creates the
    // directory, and the next ensure() should be free to take the lease then.
    if (r.code !== 'skipped-no-agy') this.disabled = true;
    return false;
  }

  /** The current lease generation's owner token, for the endpoint locator. */
  ownerToken(): string | null {
    return this.token;
  }

  /** Clean shutdown. Idempotent. */
  release(): void {
    const id = this.leaseId;
    this.leaseId = null;
    this.token = null;
    if (id) releaseStatuslineLease(this.env, id);
  }
}

// ─── the endpoint locator ────────────────────────────────────────────────────

/**
 * Where a user's OWN interactive AGY finds this app's HookServer. A Munder-launched
 * worker is told directly through HIVE_SOCK; a personal session is not launched by us,
 * so the installed command names this file, and the file names the pipe - but only
 * while its token matches the lease the command was installed under.
 */
export interface StatuslineLocator {
  schema: 1;
  sock: string;
  pid: number;
  processStartedAt: number;
  token: string;
  createdAt: number;
}

export function writeStatuslineLocator(path: string, l: Omit<StatuslineLocator, 'schema'>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify({ schema: 1, ...l })}\n`, 0o600);
}

/** Remove the locator on clean stop - only if it is still the one this lease wrote. */
export function removeStatuslineLocator(path: string, token: string): void {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    if (isDict(v) && v.token === token) unlinkSync(path);
  } catch { /* absent or unreadable: nothing of ours to remove */ }
}

// ─── production defaults ─────────────────────────────────────────────────────

/** This process's start, as a stable token beside its pid. */
export const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

/**
 * Liveness from what the OS will tell us cheaply. `kill(pid, 0)`: ESRCH is provably
 * dead. This process's own (pid, start) pair is live. Any OTHER live pid is 'live' for a
 * lease - so a restore is withheld while it might be another Munder instance - and the
 * lock treats 'live' as "wait", never as "break". Nothing here can prove a pid was
 * recycled, so nothing here ever acts as if it had.
 */
export function osLiveness(pid: number, processStartedAt: number): Liveness {
  if (pid === process.pid) return processStartedAt === PROCESS_STARTED_AT ? 'live' : 'dead';
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'ambiguous';
  }
}

/** A short synchronous wait for the lock's bounded retry. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const newOwnerToken = (): string => randomBytes(16).toString('hex');
