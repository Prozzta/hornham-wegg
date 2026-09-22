'use strict';

/**
 * v1.1.46 A2 (CAPUI-STALE-AGE-TICK) — the "Not refreshed in X min" note keeps counting while
 * the provider details stay open on a STALE pool. The time edge is MAIN's
 * (src/main/capacityDetailTick.ts): a re-push of the same projection at each minute boundary
 * of the age. The panel has no clock (crit 15). A close, a switch, a gone window or a pool
 * that is no longer stale stops it. Each pin kills a census mutant
 * (test/tools/capacity-mutants.cjs, "a2").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { capacityDetailView } = loadTs('src/main/capacityDetail.ts');
const { CapacityDetailTicker, DETAIL_TICK_MS } = loadTs('src/main/capacityDetailTick.ts');
const { CAPACITY_DETAIL_PUSH, CAPACITY_DETAIL_CLOSED, validateCapacityDetail } = loadTs('src/shared/capacityDetail.ts');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct-a2:codex';
const POOL_ID = 'pool-a2a2a2a2a2a2a2a2';
const OTHER_ID = 'pool-b3b3b3b3b3b3b3b3';
const WIN = 7;

/** A real tracker with one Codex pool read at T0, a fake clock, fake timers, and main's two deps. */
function rig() {
  const clock = { t: T0 };
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => clock.t, () => clock.t);
  tracker.ingest({ poolKey: POOL, streamId: 's', sourceSequence: 1, provider: 'codex', accountScope: 'acct-a2', limitId: 'codex',
    source: 'codex-rollout', observedAt: T0, receivedAt: T0,
    windows: [{ windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300, usedPercent: 20, remainingPercent: 80, resetsAt: T0 + 3_600_000 }],
    providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus' });
  let seq = 1;
  const read = (fresh = false) => {
    if (fresh) tracker.ingest({ poolKey: POOL, streamId: 's', sourceSequence: ++seq, provider: 'codex', accountScope: 'acct-a2',
      limitId: 'codex', source: 'codex-rollout', observedAt: clock.t, receivedAt: clock.t,
      windows: [{ windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300, usedPercent: 25, remainingPercent: 75, resetsAt: T0 + 3_600_000 }],
      providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus' });
  };
  const timers = [];
  const pushes = [];
  const viewOf = (poolId) => {
    tracker.evaluate();
    const p = tracker.pool(POOL);
    if (poolId !== POOL_ID || !p) return null;
    return capacityDetailView({ pool: p, poolId, poolLabel: 'Codex', presentation: 'NORMAL', members: ['pam'],
      membershipKnown: true, statusNote: null, now: clock.t, formatTime: (t) => `@${t - T0}` });
  };
  const ticker = new CapacityDetailTicker({
    staleSince: (poolId) => {                                  // what index.ts does, on the real tracker
      tracker.evaluate();
      const p = poolId === POOL_ID ? tracker.pool(POOL) : null;
      return p && p.freshness === 'STALE' ? p.observedAt : null;
    },
    push: (windowId, poolId) => pushes.push({ windowId, view: viewOf(poolId) }),
    now: () => clock.t,
    setTimer: (fn, ms) => { const h = { fn, ms, at: clock.t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); }
  });
  /** Moves the clock to `t`, firing every timer due by then, in order (a fired timer is gone). */
  const advanceTo = (t) => {
    for (;;) {
      const due = timers.filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock.t = due.at;
      due.fn();
    }
    clock.t = t;
  };
  return { clock, tracker, ticker, timers, pushes, viewOf, advanceTo, read };
}
const MIN = 60_000;
const ageOf = (v) => v && v.freshness.ageText;

test('the age note ADVANCES 11 -> 12 while the panel stays open on a stale pool, with no reopen and no strip push', () => {
  const r = rig();
  r.clock.t = T0 + 11 * MIN + 30_000;                          // 11.5 min since the last reading
  const opened = r.viewOf(POOL_ID);                            // the panel's own ask
  r.ticker.opened(WIN, POOL_ID);
  assert.equal(ageOf(opened), 'Not refreshed in 11 min');
  assert.equal(r.timers.length, 1, 'one main-side time edge is armed');
  r.advanceTo(T0 + 12 * MIN + 1_000);                          // just past the minute boundary
  assert.equal(r.pushes.length, 1, 'main re-pushed the detail once');
  assert.equal(r.pushes[0].windowId, WIN, 'to the window that has the panel open');
  assert.deepEqual(validateCapacityDetail(r.pushes[0].view), [], 'the SAME validated projection');
  assert.equal(ageOf(r.pushes[0].view), 'Not refreshed in 12 min');
  r.advanceTo(T0 + 14 * MIN + 1_000);
  assert.deepEqual(r.pushes.map((p) => ageOf(p.view)),
    ['Not refreshed in 12 min', 'Not refreshed in 13 min', 'Not refreshed in 14 min'], 'once a minute, each minute');
  assert.equal(r.timers.length, 1, 'never more than one edge per window');
});

test('the edge lands on the minute boundary of the AGE, not a minute after the open', () => {
  const r = rig();
  r.clock.t = T0 + 11 * MIN + 50_000;
  r.ticker.opened(WIN, POOL_ID);
  assert.ok(r.timers[0].ms <= 10_500, `first edge in ~10s, got ${r.timers[0].ms}`);
  assert.ok(r.timers[0].at > T0 + 12 * MIN, 'past the boundary, so the floor has moved');
});

test('closing the panel stops the re-push; a crit-17 re-ask of the same pool does not add a second edge', () => {
  const r = rig();
  r.clock.t = T0 + 5 * MIN;
  r.ticker.opened(WIN, POOL_ID);
  r.ticker.opened(WIN, POOL_ID);                               // a strip push re-asked
  assert.equal(r.timers.length, 1, 'a re-ask keeps the one edge');
  r.ticker.closed(WIN, POOL_ID);
  assert.equal(r.timers.length, 0, 'the close clears the edge');
  assert.equal(r.ticker.ticking(WIN), null);
  r.advanceTo(T0 + 30 * MIN);
  assert.equal(r.pushes.length, 0, 'nothing is pushed to a closed panel');
});

test('a close for ANOTHER pool (a late switch cleanup) leaves the open pool ticking; a switch moves the edge', () => {
  const r = rig();
  r.clock.t = T0 + 5 * MIN;
  r.ticker.opened(WIN, POOL_ID);
  r.ticker.closed(WIN, OTHER_ID);
  assert.equal(r.ticker.ticking(WIN), POOL_ID);
  r.ticker.opened(WIN, OTHER_ID);                              // switched to a pool that is not stale
  assert.equal(r.timers.length, 0, 'the old edge is gone and the new pool needs none');
  r.advanceTo(T0 + 30 * MIN);
  assert.equal(r.pushes.length, 0);
});

test('the pool going FRESH stops it: the due edge pushes nothing and arms nothing', () => {
  const r = rig();
  r.clock.t = T0 + 5 * MIN;
  r.ticker.opened(WIN, POOL_ID);
  r.clock.t = T0 + 5 * MIN + 20_000;
  r.read(true);                                                // a live reading arrives
  r.advanceTo(T0 + 30 * MIN);
  assert.equal(r.pushes.length, 0, 'no re-push for a fresh pool');
  assert.equal(r.timers.length, 0, 'and no further edge');
  assert.equal(r.ticker.ticking(WIN), null);
});

test('a fresh or never-read pool is never ticked; one that turns stale is armed by the next crit-17 re-ask', () => {
  const r = rig();
  r.clock.t = T0 + 30_000;                                     // fresh
  r.ticker.opened(WIN, POOL_ID);
  assert.equal(r.timers.length, 0, 'fresh: nothing to count');
  r.clock.t = T0 + 5 * MIN;                                    // it aged; the strip pushed and the panel re-asked
  r.ticker.opened(WIN, POOL_ID);
  assert.equal(r.timers.length, 1, 'stale now: armed');
  r.ticker.opened(WIN, OTHER_ID);                              // never read / not in the tracker
  assert.equal(r.timers.length, 0);
});

test('stopAll clears every edge (quit)', () => {
  const r = rig();
  r.clock.t = T0 + 5 * MIN;
  r.ticker.opened(WIN, POOL_ID);
  r.ticker.opened(WIN + 1, POOL_ID);
  assert.equal(r.timers.length, 2, 'one per window');
  r.ticker.stopAll();
  assert.equal(r.timers.length, 0);
  assert.equal(DETAIL_TICK_MS, 60_000);
});

// ─── The wiring: main owns the edge, the panel has no clock ─────────────────────────

test('crit 15 POLL-ABSENCE: the details panel has no timer of any kind', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CapacityDetailPanel.tsx'), 'CapacityDetailPanel.tsx');
  assert.ok(!/\bsetInterval\b|\bsetTimeout\b|requestAnimationFrame|Date\.now|performance\.now/.test(src), 'no clock in the panel');
});

test('the panel takes a pushed view only for the pool on show, and tells main when it closes or switches', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CapacityDetailPanel.tsx'), 'CapacityDetailPanel.tsx');
  assert.match(src, /window\.cth\.onCapacityDetailPush\(\(v\) => \{ if \(v && v\.poolId === poolId\) setView\(v\); \}\)/);
  assert.match(src, /return \(\) => \{ off\(\); window\.cth\.capacityDetailClosed\(poolId\); \};\s*\}, \[poolId\]\);/);
});

test('channels: the push and the close are their own channels, literal in the preload', () => {
  assert.equal(CAPACITY_DETAIL_PUSH, 'capacity:detailPush');
  assert.equal(CAPACITY_DETAIL_CLOSED, 'capacity:detailClosed');
  const pre = readSource('src/preload/index.ts');
  assert.match(pre, /ipcRenderer\.on\('capacity:detailPush', listener\)/);
  assert.match(pre, /ipcRenderer\.send\('capacity:detailClosed', poolId\)/);
});

test('main: the ask arms the ticker, the close channel stops it, and only a STALE pool counts', () => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(src, /if \(view\) capacityDetailTicker\.opened\(evt\.sender\.id, poolId\);/);
  assert.match(src, /ipcMain\.on\(CAPACITY_DETAIL_CLOSED, \(evt, poolId: unknown\) => \{\s*if \(typeof poolId === 'string'\) capacityDetailTicker\.closed\(evt\.sender\.id, poolId\);/);
  assert.match(src, /return pool && pool\.freshness === 'STALE' \? pool\.observedAt : null;/);
  assert.match(src, /const view = capacityDetailViewOf\(poolId\);\s*if \(!view\) \{ capacityDetailTicker\.closed\(windowId\); return; \}\s*try \{ wc\.send\(CAPACITY_DETAIL_PUSH, view\); \}/,
    'the re-push is the same projection the ask returns');
});
