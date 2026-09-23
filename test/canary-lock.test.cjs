'use strict';

/**
 * The packaged-canary lock. GATE-1 borrows a FIXED dev root, so it is mutually exclusive
 * across the whole floor — two runs at once each stash the other's stash, and both
 * restores then put back the wrong thing. These pin the decision that prevents it, and
 * the sharper half: a FAILED run leaves the dev root unrestored on purpose, and the next
 * run must refuse rather than bury that evidence one level deeper.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const { lockDecision, acquire, release, noteStash, readLock, lockPath, STALE_AFTER_MS } =
  require('./tools/canary-lock.cjs');

const NOW = 1_800_000_000_000;
const held = (over = {}) => ({ pid: 4242, agent: 'jim', startedAt: NOW - 60_000, devRoot: 'D', dirty: false, stashed: [], ...over });

test('no lock: take it', () => {
  assert.equal(lockDecision(null, { now: NOW, alive: false }).action, 'take');
});

test('a live holder is refused, and the message NAMES who and how long', () => {
  const d = lockDecision(held(), { now: NOW, alive: true });
  assert.equal(d.action, 'refuse');
  assert.match(d.message, /already running/);
  assert.match(d.message, /jim/, 'names the holder');
  assert.match(d.message, /pid 4242/);
  assert.match(d.message, /1m ago/, 'and its age');
  assert.match(d.message, /CANARY_FORCE=1/, 'and the way out');
});

test('an old lock whose process is gone is debris, and is taken over', () => {
  const d = lockDecision(held({ startedAt: NOW - STALE_AFTER_MS - 1 }), { now: NOW, alive: false });
  assert.equal(d.action, 'steal');
  assert.match(d.why, /stale/);
});

test('a RECENT lock with no live process is refused, not silently taken', () => {
  // A crash mid-stash leaves no owner but a half-moved dev root. Taking the lock here
  // would stash a stash; the run must stop and say what to look for.
  const d = lockDecision(held(), { now: NOW, alive: false });
  assert.equal(d.action, 'refuse');
  assert.match(d.message, /no live process/);
  assert.match(d.message, /\.canary-bak/);
});

test('a DIRTY lock is refused however old it is, and lists exactly what to put back', () => {
  // This is the case a runbook sentence could never enforce: the failed run is long over,
  // its process is long gone, and the dev root is still holding someone's real data.
  const d = lockDecision(
    held({ dirty: true, startedAt: NOW - 10 * STALE_AFTER_MS, stashed: ['D\\hive.canary-bak-7', 'D\\roster.json.canary-bak-7'] }),
    { now: NOW, alive: false }
  );
  assert.equal(d.action, 'refuse', 'age must never make an unrestored stash safe to bury');
  assert.match(d.message, /FAILED/);
  assert.match(d.message, /hive\.canary-bak-7/);
  assert.match(d.message, /roster\.json\.canary-bak-7/);
});

test('CANARY_FORCE overrides both a live holder and a dirty lock', () => {
  assert.equal(lockDecision(held(), { now: NOW, alive: true, force: true }).action, 'steal');
  assert.equal(lockDecision(held({ dirty: true }), { now: NOW, alive: false, force: true }).action, 'steal');
});

test('acquire / noteStash / release round-trip on a real directory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const rec = acquire(dir, { agent: 'andy', now: NOW });
  assert.equal(rec.pid, process.pid);
  assert.ok(existsSync(lockPath(dir)), 'the lock is on disk');

  noteStash(dir, ['x.canary-bak-1']);
  assert.deepEqual(readLock(dir).stashed, ['x.canary-bak-1']);

  release(dir);
  assert.ok(!existsSync(lockPath(dir)), 'a clean run removes the lock');
});

test('a failed run KEEPS the lock, marked dirty, naming the stash', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  acquire(dir, { agent: 'andy', now: NOW });
  release(dir, { dirty: true, stashed: ['hive.canary-bak-9'] });

  const rec = readLock(dir);
  assert.equal(rec.dirty, true, 'the lock survives a failure');
  assert.deepEqual(rec.stashed, ['hive.canary-bak-9']);

  // And the next run is refused by it, which is the whole point.
  assert.throws(() => acquire(dir, { agent: 'jim', now: NOW + 10 * STALE_AFTER_MS }),
    (e) => e.canaryLocked && /FAILED/.test(e.message) && /hive\.canary-bak-9/.test(e.message));
});

test('a second live canary cannot take a held lock', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A lock held by THIS process is by definition alive.
  writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, agent: 'other-agent', startedAt: NOW, devRoot: dir, dirty: false }));
  assert.throws(() => acquire(dir, { agent: 'andy', now: NOW + 1000 }),
    (e) => e.canaryLocked && /already running/.test(e.message) && /other-agent/.test(e.message));
});

test('release by a process that does not hold the lock is a no-op', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const foreign = JSON.stringify({ pid: process.pid + 1, agent: 'someone-else', startedAt: NOW, devRoot: dir });
  writeFileSync(lockPath(dir), foreign);
  release(dir);
  assert.equal(readFileSync(lockPath(dir), 'utf8'), foreign, 'another run\'s lock is never removed');
});

test('the canary acquires BEFORE it stashes, and marks dirty on failure', () => {
  // Order is the property: a lock taken after the stash would already have moved a
  // concurrent run's data by the time it discovered it was not allowed to run.
  const src = readFileSync(join(__dirname, 'tools', 'packaged-wake-canary.cjs'), 'utf8');
  const acquireAt = src.indexOf('lock.acquire(');
  // The CALL SITE, not the function definition above it.
  const stashAt = src.indexOf('const moved = stashDevRoot(stamp)');
  assert.ok(acquireAt > 0 && stashAt > 0);
  assert.ok(acquireAt < stashAt, 'the lock is taken before anything is moved aside');
  assert.match(src, /lock\.release\(DEV_ROOT, \{ dirty: true/, 'a failed run keeps a dirty lock');
  assert.match(src, /lock\.release\(DEV_ROOT\)/, 'a clean run releases it');
});
