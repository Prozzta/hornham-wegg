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

// ─── Jim's two hardening observations ───────────────────────────────────────

test('OBS-1: two canaries stealing the SAME stale lock — only one wins', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A stale lock both would judge stealable: old, and its process is long gone.
  writeFileSync(lockPath(dir), JSON.stringify({
    pid: 999_999, agent: 'crashed', startedAt: NOW - 10 * STALE_AFTER_MS, devRoot: dir, dirty: false, stashed: []
  }));

  // `wx` only settles the race when there is NO file. Both of these decide 'steal', so
  // without unlink-then-wx both would fall through to a plain overwrite and both would
  // believe they owned the dev root. Here the competitor re-creates the lock in the
  // window between our unlink and our create.
  let created = 0;
  const ops = {
    unlinkSync: require('node:fs').unlinkSync,
    writeFileSync: (p, body, opts) => {
      if (opts && opts.flag === 'wx') {
        created += 1;
        if (created === 2) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      }
      return require('node:fs').writeFileSync(p, body, opts);
    }
  };

  assert.throws(() => acquire(dir, { agent: 'andy', now: NOW, ops }),
    (e) => e.canaryLocked && /claimed the lock a moment ago/.test(e.message),
    'the loser is refused, never allowed to overwrite the winner');
});

test('OBS-1: a clean steal still succeeds and the lock ends up OURS', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(lockPath(dir), JSON.stringify({
    pid: 999_999, agent: 'crashed', startedAt: NOW - 10 * STALE_AFTER_MS, devRoot: dir, dirty: false, stashed: []
  }));
  const rec = acquire(dir, { agent: 'andy', now: NOW });
  assert.equal(rec.pid, process.pid);
  assert.equal(readLock(dir).agent, 'andy', 'the stale holder was replaced, not merged');
});

test('OBS-2: a crashed run that RECORDED a stash is never buried by the stale rule', () => {
  // The gap: a hard crash leaves the lock still marked CLEAN, but noteStash had already
  // written down what was moved aside. After an hour the stale branch used to take it
  // over, orphaning those originals under .canary-bak forever.
  const d = lockDecision(
    held({ dirty: false, startedAt: NOW - 10 * STALE_AFTER_MS, stashed: ['D\hive.canary-bak-3'] }),
    { now: NOW, alive: false }
  );
  assert.equal(d.action, 'refuse', 'a recorded stash outranks staleness');
  assert.match(d.message, /left the dev root displaced/);
  assert.match(d.message, /hive\.canary-bak-3/, 'and it names what to put back');
});

test('OBS-2: a stale lock with NOTHING stashed is still ordinary debris', () => {
  // The fix must not make every crash permanently blocking — only the ones holding data.
  const d = lockDecision(held({ dirty: false, startedAt: NOW - 10 * STALE_AFTER_MS, stashed: [] }),
    { now: NOW, alive: false });
  assert.equal(d.action, 'steal');
});

test('OBS-2: a LIVE holder with a stash is "already running", not "displaced"', () => {
  // A stash is only orphaned if nobody is coming back for it.
  const d = lockDecision(held({ stashed: ['x.canary-bak-1'] }), { now: NOW, alive: true });
  assert.equal(d.action, 'refuse');
  assert.match(d.message, /already running/);
});

test('OBS-2: force still overrides a displaced-stash refusal', () => {
  const d = lockDecision(held({ startedAt: NOW - 10 * STALE_AFTER_MS, stashed: ['x'] }),
    { now: NOW, alive: false, force: true });
  assert.equal(d.action, 'steal');
});

// ─── OBS-1b: verify before unlink ───
//
// The staleness judgement is made against a record read a moment earlier. By the time
// the steal runs, that record may belong to a DIFFERENT, live canary that took the lock
// in between - and unlinking blind would delete a FRESH lock and put two runs in the same
// dev root, the exact outcome this file exists to prevent. The seam is `ops.readFileSync`:
// `acquire` judges with the real fs, the steal re-reads through ops, so a test can make
// the file "change" between the two without a second process.

const STALE_REC = (dir) => ({
  pid: 999_999, agent: 'crashed', startedAt: NOW - 10 * STALE_AFTER_MS, devRoot: dir, dirty: false, stashed: []
});

/** ops whose first `wx` create reports EEXIST, so the steal path is always taken. */
function stealOps({ reread, created = [] , unlinked = [] }) {
  let creates = 0;
  return {
    readFileSync: reread,
    unlinkSync: (path) => { unlinked.push(path); },
    writeFileSync: (path, body, opts) => {
      if (opts && opts.flag === 'wx') {
        creates += 1;
        if (creates === 1) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      }
      created.push(path);
    },
    _unlinked: unlinked,
    _created: created
  };
}

test('OBS-1b: a stale lock REPLACED by a live one before the steal is refused, not removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  writeFileSync(lockPath(dir), JSON.stringify(STALE_REC(dir)));
  const unlinked = [];
  // Between our judgement and our unlink, a live canary took the lock for itself.
  const fresh = JSON.stringify({ ...STALE_REC(dir), pid: 4242, agent: 'jim', startedAt: NOW });
  const ops = stealOps({ reread: () => fresh, unlinked });

  assert.throws(() => acquire(dir, { agent: 'andy', now: NOW, ops }),
    (e) => e.canaryLocked && /changed between the staleness check/.test(e.message),
    'a lock that is no longer the one we judged must refuse');
  assert.deepEqual(unlinked, [], 'and the live run\u2019s lock must still be on disk');
});

test('OBS-1b: the SAME stale lock is still stolen - the guard must not break recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  const stale = STALE_REC(dir);
  writeFileSync(lockPath(dir), JSON.stringify(stale));
  const unlinked = [];
  const ops = stealOps({ reread: () => JSON.stringify(stale), unlinked });

  const rec = acquire(dir, { agent: 'andy', now: NOW, ops });
  assert.equal(rec.pid, process.pid);
  assert.equal(unlinked.length, 1, 'genuine crash debris is still cleared');
});

test('OBS-1b: a lock that VANISHED before the steal is fine - wx still settles the race', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  writeFileSync(lockPath(dir), JSON.stringify(STALE_REC(dir)));
  const unlinked = [];
  const gone = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  const ops = stealOps({ reread: gone, unlinked });

  const rec = acquire(dir, { agent: 'andy', now: NOW, ops });
  assert.equal(rec.pid, process.pid, 'nothing of ours is at risk, so the claim proceeds');
});

test('OBS-1b: CANARY_FORCE still overrides - it means override ANYTHING', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-lock-'));
  writeFileSync(lockPath(dir), JSON.stringify(STALE_REC(dir)));
  const unlinked = [];
  const fresh = JSON.stringify({ ...STALE_REC(dir), pid: 4242, agent: 'jim', startedAt: NOW });
  const ops = stealOps({ reread: () => fresh, unlinked });

  const rec = acquire(dir, { agent: 'andy', now: NOW, force: true, ops });
  assert.equal(rec.pid, process.pid);
  assert.equal(unlinked.length, 1, 'force already overrides a LIVE holder and a dirty lock; be consistent');
});
