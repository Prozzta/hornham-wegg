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
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync,
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
  'restore-cas-failed',  // could not restore safely: journal left for the next run
  'agy-auto-disabled',   // AGY disabled OUR command (enabled:false): capture off, prior still owed
  'orphan-restored',     // startup gave back a value a crashed run left installed
  'lease-stale-pruned',  // a lease unseen for LEASE_STALE_MS, whatever its pid says
  'lock-abandoned-recovered', // an empty/unreadable lock past LOCK_ABANDONED_MS
  'unsafe-command-path'  // a path in the command has whitespace or quotes: never leased
] as const;
export type StatuslineDiagnostic = (typeof STATUSLINE_DIAGNOSTICS)[number];

/** One running Munder instance's claim on the installed value. */
export interface StatuslineLease {
  id: string;
  pid: number;
  /** Identifies THIS start of that pid, so a recycled pid is never mistaken for it. */
  processStartedAt: number;
  /** Last heartbeat. Missing on a lease written before heartbeats: the journal's createdAt stands in. */
  lastSeen?: number;
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
  /** HOOK-BROKER P4: the one-way command prints nothing, so AGY's own default statusline
   *  stays visible beside it (`stack_with_default`). */
  stackWithDefault?: boolean;
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
  | 'after-lock-open'
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
export function installedValueFor(command: string, stackWithDefault = false): Record<string, unknown> {
  const value: Record<string, unknown> = { type: 'command', command, enabled: true };
  if (stackWithDefault) value.stack_with_default = true;
  return value;
}

/**
 * The installed command, UNQUOTED - or null when it cannot be expressed safely.
 *
 * AGY PASSES QUOTE CHARACTERS LITERALLY. It splits the command on whitespace and hands the
 * pieces over as-is, so a double-quoted path arrives with the quotes still on it. From
 * AGY 1.2.9's own log, for a measurement probe whose command quoted its script path:
 *   statusline: command failed ... Processing -File '"C:/.../status-capture.ps1"'
 *   failed: Illegal characters in path. (failure 1/30)
 * and after 30 such failures AGY auto-disables the statusline. The design's quoted form
 * would have failed identically on every render. This is why the existing AGY hook
 * commands are unquoted too - and it means no path in the command may contain
 * whitespace or a quote at all. Such a path returns null and the lease is never taken
 * (named `unsafe-command-path`): a command guaranteed to fail is worse than none.
 */
export function buildStatuslineCommand(launcher: string, shim: string, token: string, locator: string): string | null {
  const parts = [launcher, shim, '--owner', token, '--locator', locator];
  if (parts.some((part) => !part || /[\s"']/.test(part))) return null;
  return parts.join(' ');
}

/**
 * Is this value OUR installed statusline - whatever AGY has since done to its `enabled`?
 * The command carries this lease generation's owner token, so no other tool, no user and
 * no earlier lease can produce the same command.
 */
export function isOurs(current: unknown, installed: unknown): boolean {
  if (sameValue(current, installed)) return true;
  return isDict(current) && isDict(installed) && typeof installed.command === 'string'
    && current.command === installed.command;
}

/** OUR command, switched off - AGY's own auto-disable after repeated failures. */
export function isAutoDisabled(current: unknown, installed: unknown): boolean {
  return isOurs(current, installed) && !sameValue(current, installed)
    && isDict(current) && current.enabled === false;
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
    && Number.isInteger(l.pid) && typeof l.processStartedAt === 'number'
    && (l.lastSeen === undefined || typeof l.lastSeen === 'number'));
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
 * How old an EMPTY or UNPARSEABLE lock must be before it counts as abandoned. The locked
 * section is milliseconds long, so a minute is generous. Only an unreadable lock ages out:
 * a PARSEABLE holder that is live or ambiguous is never broken, whatever its age.
 */
export const LOCK_ABANDONED_MS = 60_000;

/**
 * Hold the adjacent exclusive lock for `fn`. BOUNDED: after `LOCK_ATTEMPTS` the answer
 * is 'lock-busy'. A holder that is provably dead is pruned; a holder we cannot prove dead
 * is NEVER broken: this run gives up instead.
 *
 * THE WEDGE THIS CLOSES (Jim, c2 audit fix 2). The lock file is created, THEN its holder
 * record written. A throw between the two - disk full, an antivirus lock - or a crash in
 * that gap left an EMPTY lock, which read as an unparseable (ambiguous) holder and was
 * never broken: every later start refused, and no release could ever restore the user's
 * value. So a failed holder write now removes the lock before rethrowing, and an empty or
 * unreadable lock older than `LOCK_ABANDONED_MS` is recovered as abandoned.
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
        let age = 0;
        try { age = env.now() - statSync(lock).mtimeMs; } catch { continue; } // gone: retry
        if (age > LOCK_ABANDONED_MS) {
          unlinkQuiet(lock);
          env.report('lock-abandoned-recovered');
          continue;
        }
        return 'lock-ambiguous';
      }
      const alive = env.liveness(holder.pid as number, holder.processStartedAt as number);
      if (alive === 'dead') { unlinkQuiet(lock); continue; }
      if (alive === 'ambiguous') return 'lock-ambiguous';
      env.sleep(LOCK_BACKOFF_MS);
      continue;
    }
    try {
      try {
        env.crashAt?.('after-lock-open');
        writeSync(fd, mine);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      // Never leave an empty lock behind: that is the wedge.
      unlinkQuiet(lock);
      throw e;
    }
    try {
      return fn();
    } finally {
      unlinkQuiet(lock);
    }
  }
  return 'lock-busy';
}

// ─── leases ──────────────────────────────────────────────────────────────────

/**
 * How long a lease may go without a heartbeat before it is presumed dead even though its
 * pid answers.
 *
 * WHY (Jim, c2 audit): liveness for ANOTHER process is `kill(pid, 0)`, which cannot tell a
 * crashed Munder from an unrelated process Windows later gave the same pid. Such a lease
 * reads as live for as long as that process lives - days - and the user's statusline stays
 * Munder's the whole time. A live instance refreshes `lastSeen` hourly and on every AGY
 * spawn, so 24 hours without one means the owner is gone, whatever the pid says.
 */
export const LEASE_STALE_MS = 24 * 60 * 60 * 1000;

/** Keep leases that are not provably dead AND have been seen recently. Ambiguous is KEPT. */
function liveLeases(env: StatuslineEnv, j: StatuslineJournal): StatuslineLease[] {
  const now = env.now();
  return j.leases.filter((l) => {
    if (env.liveness(l.pid, l.processStartedAt) === 'dead') return false;
    if (now - (l.lastSeen ?? j.createdAt) > LEASE_STALE_MS) {
      env.report('lease-stale-pruned');
      return false;
    }
    return true;
  });
}

const hasKey = (o: Dict): boolean => Object.prototype.hasOwnProperty.call(o, STATUSLINE_KEY);

/** Does the current value still hold what the user had before Munder? */
const isPrior = (j: StatuslineJournal, present: boolean, current: unknown): boolean =>
  j.prior.present ? present && sameValue(current, j.prior.value) : !present;

/** Put the user's prior value back, under CAS. False (and nothing written) if settings moved. */
function restorePrior(env: StatuslineEnv, paths: StatuslinePaths, j: StatuslineJournal,
  settings: { bytes: Buffer | null; obj: Dict }): boolean {
  const next: Dict = { ...settings.obj };
  if (j.prior.present) next[STATUSLINE_KEY] = j.prior.value;
  else delete next[STATUSLINE_KEY];
  if (!casWriteSettings(paths.settings, sha(settings.bytes), next)) return false;
  env.crashAt?.('after-restore-write');
  const verify = readSettings(paths.settings);
  return verify !== 'malformed' && isPrior(j, hasKey(verify.obj), verify.obj[STATUSLINE_KEY]);
}

// ─── the state machine ───────────────────────────────────────────────────────

export type AcquireResult =
  | { captureEnabled: true; token: string; leaseId: string; code: StatuslineDiagnostic }
  | { captureEnabled: false; code: StatuslineDiagnostic };

/**
 * Install or join the lease. Called just before an interactive AGY spawn, through
 * `AgyStatuslineOwner`, which remembers a disable for the run. Never at a bare startup:
 * a Munder start with no AGY agent does not touch the user's global settings (god, on
 * Jim's consent note) - see `recoverStatuslineLeftovers` for what startup does instead.
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
    const lease: StatuslineLease = {
      id: env.randomToken(), pid: env.pid, processStartedAt: env.processStartedAt, lastSeen: env.now()
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const settings = readSettings(paths.settings);
      if (settings === 'malformed') return { captureEnabled: false, code: 'malformed-settings' };
      const current = settings.obj[STATUSLINE_KEY];
      const present = hasKey(settings.obj);
      let j = attempt === 0 ? journal : readJournal(paths.journal);
      if (j === 'corrupt') { quarantine(paths.journal, env.now()); return { captureEnabled: false, code: 'corrupt-journal' }; }

      // A RESTORE THAT FINISHED BUT NEVER CLEANED UP. The last owner put the prior value
      // back and died before deleting the journal: no live lease remains, and the setting
      // is exactly what the journal says the user had. That is not an override - it is
      // the state a clean shutdown leaves, plus a leftover file - so the leftover goes and
      // this run starts fresh. (Without this, a crash inside the restore would disable
      // capture for the NEXT run as an "external override" of a value nobody changed.)
      if (j && j.phase === 'owned' && liveLeases(env, j).length === 0 && isPrior(j, present, current)) {
        unlinkQuiet(paths.journal);
        j = null;
      }

      // AGY AUTO-DISABLED A PREVIOUS GENERATION, and no live instance holds it. Give the
      // user their value back first; then this run may try again with a fresh lease. If
      // AGY gives up on it again, the next release restores again - the prior is never lost.
      if (j && present && isAutoDisabled(current, j.installedValue) && liveLeases(env, j).length === 0) {
        env.report('agy-auto-disabled');
        if (!restorePrior(env, paths, j, settings)) return { captureEnabled: false, code: 'restore-cas-failed' };
        unlinkQuiet(paths.journal);
        continue; // the next attempt reads the restored settings and starts fresh
      }

      if (j) {
        if (present && sameValue(current, j.installedValue)) {
          // Crash leftover or another live instance. Either way the ORIGINAL prior value
          // is retained - adopting a lease must never re-record "prior" as our own value.
          const next: StatuslineJournal = { ...j, phase: 'owned', leases: [...liveLeases(env, j), lease] };
          writeJournal(paths.journal, next);
          return { captureEnabled: true, token: j.token, leaseId: lease.id, code: 'adopted' };
        }
        if (present && isAutoDisabled(current, j.installedValue)) {
          // Auto-disabled while ANOTHER live instance holds it: that instance's release
          // restores the prior. Nothing to capture here.
          return { captureEnabled: false, code: 'agy-auto-disabled' };
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
        installedValue: installedValueFor(env.commandFor(token), env.stackWithDefault === true),
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
  writeJournal(paths.journal, { ...j, phase: 'owned', leases: [...liveLeases(env, j), lease] });
  env.crashAt?.('after-journal-owned');
  return { captureEnabled: true, token: j.token, leaseId: lease.id, code: 'owned' };
}

/**
 * Just before an interactive AGY spawn: is Munder's value still installed?
 *
 * Three answers. INTACT: capture on. A DIFFERENT value: a user (or another tool) chose a
 * different statusline while we held the lease - RELINQUISHED on the spot, our lease
 * removed, the setting left byte-for-byte alone, capture off for the run. OUR command with
 * `enabled:false`: AGY auto-disabled it - capture off for the run, but the lease and the
 * journal are KEPT, because the release still owes the user their prior value.
 */
export function reconcileStatuslineLease(env: StatuslineEnv, leaseId: string): 'intact' | StatuslineDiagnostic {
  const paths = statuslinePaths(env.geminiHome);
  const r = withLock(env, paths.lock, (): 'intact' | StatuslineDiagnostic => {
    const j = readJournal(paths.journal);
    if (j === 'corrupt') { quarantine(paths.journal, env.now()); return 'corrupt-journal'; }
    if (!j || !j.leases.some((l) => l.id === leaseId)) return 'external-override';
    const settings = readSettings(paths.settings);
    if (settings === 'malformed') return 'malformed-settings';
    const current = settings.obj[STATUSLINE_KEY];
    const present = hasKey(settings.obj);
    // Every reconcile is also a heartbeat for this lease.
    const beat = j.leases.map((l) => (l.id === leaseId ? { ...l, lastSeen: env.now() } : l));
    if (present && sameValue(current, j.installedValue)) {
      writeJournal(paths.journal, { ...j, leases: beat });
      return 'intact';
    }
    if (present && isAutoDisabled(current, j.installedValue)) {
      writeJournal(paths.journal, { ...j, leases: beat });
      return 'agy-auto-disabled';
    }
    const rest = liveLeases(env, j).filter((l) => l.id !== leaseId);
    if (rest.length) writeJournal(paths.journal, { ...j, leases: rest });
    else unlinkQuiet(paths.journal);
    return 'external-override';
  });
  if (r !== 'intact') env.report(r);
  return r;
}

/** Refresh this lease's `lastSeen`. Cheap; called hourly by a live instance. */
export function heartbeatStatuslineLease(env: StatuslineEnv, leaseId: string): void {
  const paths = statuslinePaths(env.geminiHome);
  withLock(env, paths.lock, () => {
    const j = readJournal(paths.journal);
    if (!j || j === 'corrupt' || !j.leases.some((l) => l.id === leaseId)) return;
    writeJournal(paths.journal, {
      ...j, leases: j.leases.map((l) => (l.id === leaseId ? { ...l, lastSeen: env.now() } : l))
    });
  });
}

/**
 * Drop this instance's lease; if it was the LAST live one, restore the exact prior value -
 * when the setting still holds OUR command, whether or not AGY has since disabled it.
 *
 * THE LOSS THIS CLOSES (Jim, c2 audit fix 1, blocking). AGY rewrites a statusline it gives
 * up on as our own object with `enabled:false`. That used to read as a user edit: the
 * journal - the only copy of the user's prior value - was deleted, and their settings were
 * left pointing at a disabled Munder command, permanently. The command carries this lease
 * generation's owner token, so it is provably ours whatever its `enabled` flag says.
 */
export function releaseStatuslineLease(env: StatuslineEnv, leaseId: string): StatuslineDiagnostic {
  const paths = statuslinePaths(env.geminiHome);
  const r = withLock(env, paths.lock, (): StatuslineDiagnostic => {
    const j = readJournal(paths.journal);
    if (j === 'corrupt') { quarantine(paths.journal, env.now()); return 'corrupt-journal'; }
    if (!j) return 'external-override';
    const rest = liveLeases(env, j).filter((l) => l.id !== leaseId);
    if (rest.length) {
      writeJournal(paths.journal, { ...j, leases: rest });
      return 'released';
    }
    return restoreOrAdopt(env, paths, j);
  });
  env.report(r);
  return r;
}

/** The last owner is gone: give the prior back if the value is ours, or adopt a real edit. */
function restoreOrAdopt(env: StatuslineEnv, paths: StatuslinePaths, j: StatuslineJournal): StatuslineDiagnostic {
  const settings = readSettings(paths.settings);
  if (settings === 'malformed') return 'restore-cas-failed';
  const current = settings.obj[STATUSLINE_KEY];
  const present = hasKey(settings.obj);
  if (isPrior(j, present, current)) {
    unlinkQuiet(paths.journal); // already the user's value: only a leftover journal
    return 'restored';
  }
  if (!present || !isOurs(current, j.installedValue)) {
    // The user changed it to something else while we held it. Their value stands.
    unlinkQuiet(paths.journal);
    return 'adopted-user-edit';
  }
  if (!sameValue(current, j.installedValue)) env.report('agy-auto-disabled');
  if (!restorePrior(env, paths, j, settings)) {
    // Leave the journal: the next reconciliation decides with fresh evidence. Never guess.
    writeJournal(paths.journal, { ...j, leases: [] });
    return 'restore-cas-failed';
  }
  unlinkQuiet(paths.journal);
  return 'restored';
}

/**
 * STARTUP. Take nothing; give back anything left behind.
 *
 * A Munder start with no AGY agent must not TOUCH the user's global AGY settings (god's
 * ruling on Jim's consent note) - the lease is taken only when an AGY agent actually
 * spawns. But a previous run that crashed, or was killed, may have left Munder's value
 * installed with nobody alive to restore it. Returning the user's own value is not taking
 * anything, so it happens here: if no live lease remains, restore (or adopt a real edit)
 * exactly as the last release would have. A live lease belongs to a running instance and
 * is left alone.
 */
export function recoverStatuslineLeftovers(env: StatuslineEnv): StatuslineDiagnostic | 'nothing-to-recover' {
  const paths = statuslinePaths(env.geminiHome);
  if (!existsSync(paths.journal)) return 'nothing-to-recover';
  const r = withLock(env, paths.lock, (): StatuslineDiagnostic | 'nothing-to-recover' => {
    const j = readJournal(paths.journal);
    if (!j) return 'nothing-to-recover';
    if (j === 'corrupt') { quarantine(paths.journal, env.now()); return 'corrupt-journal'; }
    if (liveLeases(env, j).length) return 'nothing-to-recover';
    if (j.phase === 'prepared') {
      // Never installed (settings still hash to the preimage) or never promoted: either
      // way, what is there now is decided by the same rules as a release.
      const settings = readSettings(paths.settings);
      if (settings !== 'malformed' && sha(settings.bytes) === j.settingsHashBefore) {
        unlinkQuiet(paths.journal);
        return 'orphan-restored';
      }
    }
    const out = restoreOrAdopt(env, paths, j);
    return out === 'restored' ? 'orphan-restored' : out;
  });
  if (r !== 'nothing-to-recover') env.report(r);
  return r;
}

function done<T extends { code: StatuslineDiagnostic }>(env: StatuslineEnv, r: T): T {
  env.report(r.code);
  return r;
}

// ─── the per-run owner ───────────────────────────────────────────────────────

/**
 * One app run's relationship with the lease. Holds what the stateless functions above
 * cannot: the lease id, and whether capture is off - which is STICKY for the run. Once
 * Munder's value has been overridden (or auto-disabled) it never reinstalls until a clean
 * restart, because "self-heal" that repeatedly reinstalls over a choice is not healing.
 *
 * Capture off is not the same as holding no lease: after an auto-disable the lease is KEPT
 * so that `release()` can still restore the user's prior value.
 */
export class AgyStatuslineOwner {
  private leaseId: string | null = null;
  private token: string | null = null;
  private disabled = false;

  constructor(private env: StatuslineEnv) {}

  /** Just before an interactive AGY spawn. Returns whether capture is on. */
  ensure(): boolean {
    if (this.disabled) return false;
    if (this.leaseId) {
      const r = reconcileStatuslineLease(this.env, this.leaseId);
      if (r === 'intact') return true;
      if (r === 'agy-auto-disabled') {
        // Keep the lease: release() owes the user their prior value.
        this.token = null;
        this.disabled = true;
        return false;
      }
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

  /** The current lease generation's owner token, for the endpoint locator. Null when off. */
  ownerToken(): string | null {
    return this.token;
  }

  /** Whether this run currently holds a lease (capture may still be off). */
  holdsLease(): boolean {
    return this.leaseId !== null;
  }

  /** Refresh the lease's lastSeen. A no-op when no lease is held. */
  heartbeat(): void {
    if (this.leaseId) heartbeatStatuslineLease(this.env, this.leaseId);
  }

  /** Release - on quit, or when the last AGY agent leaves the floor. Idempotent. A later
   *  AGY spawn may lease again (unless capture was overridden this run). */
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
