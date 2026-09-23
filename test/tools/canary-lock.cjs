'use strict';

/**
 * THE PACKAGED-CANARY LOCK.
 *
 * GATE-1 borrows a FIXED directory — the dev root at C:\Dunder\MunderDevData — because
 * Electron will not resolve userData anywhere else on Windows and the dev-isolation
 * contract deliberately removed the env override. A fixed directory makes the canary
 * mutually exclusive across the whole floor, and nothing enforced that: two agents
 * running it at once would each stash the other's stash, and both restores would then put
 * back the wrong thing. Jim found it; this makes it impossible rather than documented.
 *
 * It also closes the sharper half of the same hazard, which a warning could not. A FAILED
 * canary deliberately leaves the dev root unrestored so the evidence can be read — and a
 * later run would happily stash THAT, burying the real contents one level deeper. So a
 * failed run leaves the lock behind, marked dirty and naming exactly what must be put
 * back, and the next run refuses until someone does.
 *
 * Pure decision + thin fs wrappers, so every branch is testable without a dev root, a
 * second process, or a clock. Test-only: nothing here is imported by src/ and none of it
 * reaches the shipped asar.
 */
const { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

/** A lock older than this whose owner is gone is debris from a crash, not a live run. */
const STALE_AFTER_MS = 60 * 60_000;

const lockPath = (devRoot) => join(devRoot, '.canary-lock.json');

/** Is that process still running? Signal 0 tests liveness without touching the process. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const mins = (ms) => Math.max(0, Math.round(ms / 60000));

/**
 * What to do about the lock we found. Pure.
 *
 * `existing` is the parsed lock or null; `alive` says whether its owner still runs.
 * Returns { action: 'take' } or { action: 'steal', why } or { action: 'refuse', message }.
 */
function lockDecision(existing, { now, alive, force = false, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!existing) return { action: 'take' };

  const age = now - (Number(existing.startedAt) || 0);
  const who = `${existing.agent || 'someone'} (pid ${existing.pid}, ${mins(age)}m ago)`;

  // A dirty lock outranks everything except an explicit override, INCLUDING staleness and
  // a dead owner — the owner being gone is exactly how the dev root got left dirty. Age
  // never makes an unrestored stash safe to bury.
  if (existing.dirty) {
    if (force) return { action: 'steal', why: `override: discarding the dirty lock from ${who}` };
    const paths = Array.isArray(existing.stashed) ? existing.stashed : [];
    return {
      action: 'refuse',
      message: [
        `A previous canary run FAILED and left the dev root unrestored (${who}).`,
        'Its originals are still on disk under a .canary-bak suffix. Put them back before running again,',
        'or this run would stash the stash and bury them one level deeper:',
        ...paths.map((p) => `  ${p}`),
        `Then delete ${lockPath(existing.devRoot || '<dev root>')}, or re-run with CANARY_FORCE=1 to discard them.`
      ].join('\n')
    };
  }

  if (force) return { action: 'steal', why: `override: discarding the lock held by ${who}` };
  if (alive) {
    return {
      action: 'refuse',
      message: [
        `The packaged canary is already running: ${who}.`,
        'It borrows the shared dev root, so only ONE may run at a time floor-wide —',
        'a second run would stash the first run\'s stash and both restores would put back the wrong thing.',
        'Wait for it to finish, or re-run with CANARY_FORCE=1 if you are certain it is dead.'
      ].join('\n')
    };
  }
  if (age >= staleAfterMs) return { action: 'steal', why: `stale lock from ${who}; its process is gone` };

  // Recent, but the owner has vanished: a crash or a killed run. Say so rather than
  // silently taking it — the dev root may be mid-stash even though nothing holds the lock.
  return {
    action: 'refuse',
    message: [
      `A canary lock from ${who} has no live process — it probably crashed or was killed.`,
      'The dev root may be mid-stash. Check for .canary-bak paths under the dev root, put back anything you find,',
      `then delete ${lockPath(existing.devRoot || '<dev root>')} or re-run with CANARY_FORCE=1.`
    ].join('\n')
  };
}

function readLock(devRoot) {
  try { return JSON.parse(readFileSync(lockPath(devRoot), 'utf8')); } catch { return null; }
}

/**
 * Take the lock, or throw with the reason. `wx` makes the create atomic, so two canaries
 * racing from cold cannot both believe they won.
 */
function acquire(devRoot, { agent = process.env.AGENT_NAME || 'unknown', force = !!process.env.CANARY_FORCE, now = Date.now() } = {}) {
  mkdirSync(devRoot, { recursive: true });
  const existing = readLock(devRoot);
  const decision = lockDecision(existing, { now, alive: existing ? pidAlive(existing.pid) : false, force });
  if (decision.action === 'refuse') {
    const err = new Error(decision.message);
    err.canaryLocked = true;
    throw err;
  }
  if (decision.action === 'steal') console.warn(`[canary-lock] ${decision.why}`);
  const rec = { pid: process.pid, agent, startedAt: now, devRoot, dirty: false, stashed: [] };
  try {
    writeFileSync(lockPath(devRoot), JSON.stringify(rec, null, 2), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // We decided to take it and someone else got there first (a real race) — or we are
    // replacing a lock we already judged. Only the steal path may overwrite.
    if (decision.action !== 'steal') {
      const err = new Error('Another canary took the lock a moment ago; not racing it.');
      err.canaryLocked = true;
      throw err;
    }
    writeFileSync(lockPath(devRoot), JSON.stringify(rec, null, 2));
  }
  return rec;
}

/** Record what this run moved aside, so a failure can name it precisely. */
function noteStash(devRoot, stashedPaths) {
  const rec = readLock(devRoot);
  if (!rec || rec.pid !== process.pid) return;
  rec.stashed = stashedPaths;
  writeFileSync(lockPath(devRoot), JSON.stringify(rec, null, 2));
}

/**
 * Release on success. On failure, keep the lock and mark it dirty: the dev root is
 * deliberately left unrestored, and the next run must refuse rather than bury it.
 */
function release(devRoot, { dirty = false, stashed = [] } = {}) {
  const rec = readLock(devRoot);
  if (!rec || rec.pid !== process.pid) return;
  if (!dirty) {
    try { unlinkSync(lockPath(devRoot)); } catch { /* already gone */ }
    return;
  }
  writeFileSync(lockPath(devRoot), JSON.stringify({ ...rec, dirty: true, stashed }, null, 2));
}

module.exports = { lockDecision, acquire, release, noteStash, readLock, lockPath, pidAlive, STALE_AFTER_MS };
