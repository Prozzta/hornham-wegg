'use strict';

/**
 * v1.1.45 unit #1 — the pool-level capacity contract (design of record §16, §17,
 * C2.9, correction 3). Driven through the REAL tracker, runtime and notifier, so every
 * pool object tested is one main can actually produce.
 *
 * What is pinned: the projection (one display-ready object per tracker pool), the
 * weekly reveal reasons and C2.5 band, the hidden-weekly-ABSENT rule and its schema
 * rejection, per-pool and collection revisions (complete replace, no rollback), the
 * notice lifecycle, the renderer mirror + selector family incl. the one-way expiry
 * mask, and the plumbing boundary (own channel, not control:snapshot).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityNotifier } = loadTs('src/main/capacityNotify.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { CapacityStripPresenter, DEFAULT_WEEKLY_DISPLAY_THRESHOLD } = loadTs('src/main/capacityStrip.ts');
const shared = loadTs('src/shared/capacityStrip.ts');
const { validateCapacityStrip } = shared;
const { CapacityStripMirror, presentPool, selectPools, selectPool, selectCollectionStatus,
  selectPoolsForAgent, selectOpenNotices } = loadTs('src/renderer/src/capacity/capacityStrip.ts');

const T0 = 1_800_000_000_000;
const ACCOUNT = 'acct-SECRET-SCOPE-7f3a';
const POOL = `codex:${ACCOUNT}:codex`;
const RESET_5H = T0 + 3_600_000;
const RESET_7D = T0 + 3 * 86_400_000;

const win = (id, kind, remaining, resetsAt) => ({
  windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080,
  usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining, resetsAt
});

let seq = 0;
const obs = (at, five, weekly, over = {}) => ({
  poolKey: POOL, streamId: 's1', sourceSequence: ++seq, provider: 'codex', accountScope: ACCOUNT,
  limitId: 'codex', source: 'codex-rollout', observedAt: at, receivedAt: at,
  windows: [win('five_hour', 'FIVE_HOUR', five, RESET_5H), win('seven_day', 'SEVEN_DAY', weekly, RESET_7D)],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

/** Real tracker + real presenter, one clock for both wall and monotonic time. */
function rig({ threshold = DEFAULT_WEEKLY_DISPLAY_THRESHOLD, members = {}, known = true } = {}) {
  let now = T0;
  let T = threshold;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter({
    weeklyThreshold: () => T,
    formatTime: (t) => `@${t - T0}`,
    idKey: Buffer.alloc(32, 7)
  });
  const present = () => presenter.present({
    snapshot: tracker.snapshot(),
    membersOf: (k) => members[k] ?? [],
    membershipKnown: () => known,
    freshUntil: (k) => tracker.freshUntil(k),
    now
  });
  let t = T0;
  return {
    tracker, presenter, present,
    setThreshold: (v) => { T = v; },
    at: (v) => { now = v; },
    /** Ingest a reading one second after the last, and present. */
    read: (five, weekly, over) => {
      t += 1000; now = t;
      tracker.ingest(obs(t, five, weekly, over));
      return present();
    },
    now: () => now
  };
}

const only = (c) => { assert.equal(c.pools.length, 1); return c.pools[0]; };
const valid = (c) => assert.deepEqual(validateCapacityStrip(c), [], 'main must only ever publish schema-valid objects');

// ─── Projection ───────────────────────────────────────────────────────────────

test('a healthy pool projects to ONE display-ready object with main-issued fields only', () => {
  const r = rig({ members: { [POOL]: ['dwight', 'andy'] } });
  const c = r.read(80.6, 60);
  valid(c);
  const p = only(c);
  assert.equal(p.provider, 'codex');
  assert.equal(p.poolLabel, 'Codex');
  assert.equal(p.state, 'AVAILABLE');
  assert.equal(p.stateText, 'Available');
  assert.equal(p.presentation, 'NORMAL');
  assert.deepEqual(p.fiveHour.meter, { remainingPercent: 80.6, displayPercent: 80 }, 'rounded DOWN: never overstate');
  assert.equal(p.fiveHour.text, '5h · 80% remaining');
  assert.equal(p.fiveHour.resetText, `reset expected ~@${RESET_5H - T0}`);
  assert.equal(p.freshness.verdict, 'FRESH');
  assert.equal(p.freshness.expiresAt, p.freshness.observedAt + L0_SEM_POLICY.liveTtlMs,
    'the mask deadline is the tracker\'s OWN freshness deadline');
  assert.deepEqual(p.membership, { known: true, agentIds: ['andy', 'dwight'] });
  assert.equal(p.provenance, 'LIVE');
  assert.equal(p.markers.additionalPressure, 0);
  assert.equal(p.revision, 1);
  assert.equal(p.domainRevision, r.tracker.pool(POOL).revision);
});

test('the pool id is OPAQUE: no pool key, no account scope anywhere in the pushed object', () => {
  const r = rig();
  const json = JSON.stringify(r.read(80, 60));
  assert.ok(!json.includes(ACCOUNT), 'account scope must not reach the renderer');
  assert.ok(!json.includes(POOL));
  assert.match(only(JSON.parse(json)).poolId, /^pool-[0-9a-f]{16}$/);
});

// ─── Weekly: absent when hidden, C2.4 reasons, C2.5 band ─────────────────────

test('C2.9: a normally hidden weekly is ABSENT — no property, no figure, no reset, no threshold', () => {
  const r = rig();
  const c = r.read(80, 60);
  const p = only(c);
  assert.ok(!('weekly' in p), 'hidden weekly must be absent, not flagged');
  const json = JSON.stringify(c);
  assert.ok(!json.includes(String(RESET_7D)) && !json.includes(`@${RESET_7D - T0}`), 'no weekly reset leaks');
  assert.ok(!/"60"|:60[,}]|60%/.test(json), 'no weekly figure leaks');
  assert.ok(!/threshold|reveal|hidden/i.test(json), 'no threshold, reveal flag or hidden reason');
});

test('C2.11 crit 2: from hidden at T=15, 14.9 reveals and 15.0 / 15.1 do not; 19.9 holds, 20.0 hides', () => {
  const hiddenAt = (v) => { const r = rig(); return !('weekly' in only(r.read(80, v))); };
  assert.equal(hiddenAt(15.0), true);
  assert.equal(hiddenAt(15.1), true);
  const r = rig();
  const shown = only(r.read(80, 14.9));
  assert.equal(shown.weekly.reason, 'BELOW_DISPLAY_THRESHOLD');
  assert.equal(shown.weekly.attribution, 'display-policy');
  assert.equal(shown.weekly.text, 'Weekly · 14% remaining');
  assert.deepEqual(shown.weekly.meter, { remainingPercent: 14.9, displayPercent: 14 });
  const held = only(r.read(80, 19.9));
  assert.equal(held.weekly.reason, 'HYSTERESIS_HOLD', 'inside the band the row holds');
  assert.equal(held.weekly.text, 'Weekly · 19% remaining', 'one copy per reason family, figure main-rounded');
  assert.ok(!('weekly' in only(r.read(80, 20.0))), 'at min(100, T+5) the row hides');
});

test('C2.5: a re-anchored weekly window re-evaluates from hidden (no generation-long latch)', () => {
  const r = rig();
  assert.equal(only(r.read(80, 10)).weekly.reason, 'BELOW_DISPLAY_THRESHOLD');
  const reanchored = obs(0, 80, 18);
  reanchored.windows[1].resetsAt = RESET_7D + 7 * 86_400_000;
  const p = only(r.read(80, 18, { windows: reanchored.windows }));
  assert.ok(!('weekly' in p), 'after a re-anchor, 18 is outside T=15 and the old latch does not hold it');
});

test('C2.11 crit 7: 5h 100 / weekly 20 / T=15 — weekly may stay hidden, 5h is scoped, nothing claims total', () => {
  const p = only(rig().read(100, 20));
  assert.ok(!('weekly' in p));
  assert.equal(p.fiveHour.text, '5h · 100% remaining');
  assert.ok(!/total|binding|tighter|headroom/i.test(JSON.stringify(p)));
});

test('C2.11 crit 6: numeric weekly exhaustion reveals at EVERY threshold, observational only', () => {
  for (const T of [1, 15, 99]) {
    const r = rig({ threshold: T });
    const c = r.read(80, 0);
    valid(c);
    const p = only(c);
    assert.equal(p.state, 'RESERVE_ONLY');
    assert.equal(p.weekly.reason, 'NUMERICALLY_EXHAUSTED');
    assert.equal(p.weekly.attribution, 'numeric', 'no causal wording without provider attribution');
    assert.equal(p.weekly.text, 'Weekly · 0% remaining');
  }
});

test('C2.7: provider-attributed weekly limit — BLOCKED_SUBORDINATE, one atomic 5h token, no meter anywhere', () => {
  for (const T of [1, 15, 99]) {
    const r = rig({ threshold: T });
    const c = r.read(63, 0, { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' });
    valid(c);
    const p = only(c);
    assert.equal(p.state, 'LIMITED');
    assert.equal(p.presentation, 'BLOCKED_SUBORDINATE');
    assert.equal(p.weekly.reason, 'PROVIDER_ATTRIBUTED_LIMITING');
    assert.equal(p.weekly.attribution, 'provider');
    assert.equal(p.fiveHour.text, '5h · 63% remaining · unavailable while Weekly is exhausted');
    assert.equal(p.fiveHour.compactText, '5h 63% · blocked by Weekly');
    const json = JSON.stringify(p);
    assert.ok(!json.includes('"meter"'), 'C2.12 rule 1: no meter on either window in the blocked state');
    assert.equal((json.match(/63%/g) || []).length, 2, 'the 5h figure appears only inside its full and compact token');
  }
});

test('C2.6: whole-pool UNKNOWN is text only, and the pool-level row suffices (no weekly property)', () => {
  const r = rig();
  r.read(80, 10);
  r.at(r.now() + L0_SEM_POLICY.liveTtlMs + 10);
  r.tracker.evaluate();
  const c = r.present();
  valid(c);
  const p = only(c);
  assert.equal(p.state, 'UNKNOWN');
  assert.equal(p.presentation, 'UNKNOWN');
  assert.equal(p.freshness.verdict, 'STALE');
  assert.equal(p.freshness.expiresAt, null);
  assert.ok(!('expired' in p.freshness));
  assert.match(p.fiveHour.text, /^5h · Capacity unknown · last update @/);
  assert.ok(!('weekly' in p), 'an unknown pool does not repeat UNKNOWN per window');
  assert.ok(!JSON.stringify(p).includes('"meter"'), 'an empty bar is a drawn claim of zero');
  assert.ok(!/\d+% remaining/.test(JSON.stringify(p)), 'stale removes the number');
});

// ─── Schema: additionalProperties:false and the hidden-weekly rejections ─────

test('C2.11 crit 9: the schema REJECTS hide flags, hidden reasons, thresholds and stray fields', () => {
  const base = rig().read(80, 60);
  valid(base);
  const mutate = (fn) => { const c = JSON.parse(JSON.stringify(base)); fn(c, c.pools[0]); return validateCapacityStrip(c); };
  const rejected = {
    'weekly with a reveal:false flag': (c, p) => { p.weekly = { reason: 'HYSTERESIS_HOLD', text: 'Weekly · 60% remaining', attribution: 'display-policy', reveal: false }; },
    'a pool-level hide flag': (c, p) => { p.weeklyHidden = true; },
    'a raw threshold on the pool': (c, p) => { p.threshold = 15; },
    'a hidden reason': (c, p) => { p.weekly = { reason: 'HIDDEN', text: 'x', attribution: 'display-policy' }; },
    'a comparison operand on weekly': (c, p) => { p.weekly = { reason: 'BELOW_DISPLAY_THRESHOLD', text: 'Weekly · 9% remaining', attribution: 'display-policy', thresholdPercent: 15 }; },
    'undisclosed weekly freshness on the pool': (c, p) => { p.freshness.weeklyObservedAt = 1; },
    'a raw poolKey': (c, p) => { p.poolKey = POOL; },
    'a stray collection field': (c) => { c.threshold = 15; },
    'a meter on an UNKNOWN weekly': (c, p) => { p.weekly = { reason: 'UNKNOWN_CAPACITY', text: 'Weekly capacity unknown', attribution: 'unknown', meter: { remainingPercent: 1, displayPercent: 1 } }; },
    'a meter outside NORMAL': (c, p) => { p.presentation = 'UNKNOWN'; },
    'an expired view that reveals a hidden weekly': (c, p) => { p.freshness.expired.weekly = { reason: 'UNKNOWN_CAPACITY', text: 'Weekly capacity unknown', attribution: 'unknown' }; },
    'an expired view without a deadline': (c, p) => { p.freshness.expiresAt = null; },
    'a display figure rounded UP': (c, p) => { p.fiveHour.meter = { remainingPercent: 80.2, displayPercent: 81 }; },
    'a clamp-shaped out-of-range figure': (c, p) => { p.fiveHour.meter = { remainingPercent: 101, displayPercent: 100 }; },
    'a five-hour row not labelled 5h': (c, p) => { p.fiveHour.label = 'Weekly'; }
  };
  for (const [name, fn] of Object.entries(rejected)) {
    assert.notDeepEqual(mutate(fn), [], `must reject: ${name}`);
  }
  assert.notDeepEqual(mutate((c, p) => { p.weekly = undefined; }), [],
    'present-but-undefined weekly is a hide flag by another name');
});

// ─── Revisions (§16, correction 3) ───────────────────────────────────────────

test('revisions: unchanged re-projection is a no-op; a change moves pool AND collection exactly once', () => {
  const r = rig();
  const a = r.read(80, 60);
  const again = r.present();
  assert.equal(again.collectionRevision, a.collectionRevision);
  assert.equal(only(again).revision, only(a).revision);
  const b = r.read(70, 60);
  assert.equal(b.collectionRevision, a.collectionRevision + 1);
  assert.equal(only(b).revision, only(a).revision + 1);
});

test('C2.11 crit 4: a threshold change moves ONLY the presentation revision, never domain truth', () => {
  const r = rig();
  const before = r.read(80, 40);
  const domainPool = r.tracker.pool(POOL);
  const domainCollection = r.tracker.snapshot().collectionRevision;
  r.setThreshold(99);
  const after = r.present();
  assert.equal(only(after).weekly.reason, 'BELOW_DISPLAY_THRESHOLD');
  assert.equal(only(after).revision, only(before).revision + 1);
  assert.equal(after.collectionRevision, before.collectionRevision + 1);
  assert.equal(only(after).domainRevision, only(before).domainRevision, 'same domain revision');
  assert.equal(r.tracker.pool(POOL), domainPool, 'the tracker projection is the very same object');
  assert.equal(r.tracker.snapshot().collectionRevision, domainCollection);
});

test('complete replace: a removed pool leaves, and on return its revision continues UPWARD (no rollback)', () => {
  const r = rig();
  const first = only(r.read(80, 60));
  r.read(70, 60);
  r.tracker.forget(POOL);
  const gone = r.present();
  assert.equal(gone.pools.length, 0);
  const back = only(r.read(80, 60));
  assert.equal(back.poolId, first.poolId, 'same stable identity in this process');
  assert.ok(back.revision > 2, `revision must not roll back (got ${back.revision})`);
});

test('an overflowing tracker marks the collection INCOMPLETE rather than presenting it as whole', () => {
  const r = rig();
  r.read(80, 60);
  const snap = r.tracker.snapshot();
  const c = r.presenter.present({ snapshot: { ...snap, collectionRevision: snap.collectionRevision + 1,
    overflow: { kind: 'POOL_COUNT_EXCEEDED', completeness: 'UNKNOWN', excess: 'ONE_OR_MORE' } },
  membersOf: () => [], membershipKnown: () => true, freshUntil: () => null, now: r.now() });
  assert.equal(c.complete, false);
  assert.equal(selectCollectionStatus(c), 'INCOMPLETE');
});

// ─── Notice lifecycle (§13, correction 4) ────────────────────────────────────

test('notice lifecycle: an intent attaches OPEN, a dismissal is main-recorded, a state change retires it', () => {
  const r = rig();
  const notifier = new CapacityNotifier();
  r.read(80, 60);
  notifier.observe(r.tracker.snapshot(), r.now());                   // baseline
  r.read(63, 0, { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' });
  const [intent] = notifier.observe(r.tracker.snapshot(), r.now());
  assert.equal(intent.kind, 'LIMIT_REACHED');
  r.presenter.noteIntent(intent, 'SUPPRESSED');
  const open = only(r.present());
  assert.equal(open.notice.lifecycle, 'OPEN');
  assert.equal(open.notice.delivery, 'SUPPRESSED');
  assert.match(open.notice.noticeId, /^notice-[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(open.notice).includes(ACCOUNT), 'the identity string carries the pool key; it must not leak');
  assert.equal(r.presenter.dismissNotice('notice-nope'), false);
  assert.equal(r.presenter.dismissNotice(open.notice.noticeId), true);
  const dismissed = only(r.present());
  assert.equal(dismissed.notice.lifecycle, 'DISMISSED');
  assert.equal(dismissed.revision, open.revision + 1);
  assert.equal(r.presenter.dismissNotice(open.notice.noticeId), false, 'dismissing twice changes nothing');
  assert.equal(only(r.present()).notice.lifecycle, 'DISMISSED', 're-projection (a reload pull) does not reopen it');
  r.read(80, 60);                                                   // new state: notice retired
  assert.ok(!('notice' in only(r.present())));
});

// ─── Runtime plumbing ─────────────────────────────────────────────────────────

test('runtime: onChange fires after every publication and on a membership move, after deliver', () => {
  let now = T0;
  const calls = [];
  const runtime = new CapacityRuntime({
    deliver: () => calls.push('deliver'),
    onChange: () => calls.push('change'),
    now: () => now,
    setTimer: () => ({ unref() { return this; } }),
    clearTimer: () => {}
  }, new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now));
  runtime.ingest('dwight', obs(now, 80, 60));
  assert.deepEqual(calls, ['change']);
  assert.deepEqual(runtime.membersOf(POOL), ['dwight']);
  assert.equal(runtime.hasPool('dwight'), true);
  assert.equal(runtime.hasPool('andy'), false);
  calls.length = 0;
  runtime.ingest('andy', obs(now, 80, 60));                          // duplicate: no publication
  assert.deepEqual(calls, ['change'], 'a new member is a display change even with no domain change');
  assert.deepEqual(runtime.membersOf(POOL).sort(), ['andy', 'dwight']);
  calls.length = 0;
  runtime.ingest('andy', obs(now, 80, 60));
  assert.deepEqual(calls, [], 'nothing moved, nothing to re-project');
});

// ─── Renderer mirror + the single selector family ────────────────────────────

test('mirror: validated complete-replace, newer only; invalid and older are refused whole', () => {
  const r = rig({ members: { [POOL]: ['dwight'] } });
  const m = new CapacityStripMirror();
  let notified = 0;
  m.subscribe(() => { notified++; });
  assert.equal(selectCollectionStatus(m.get()), 'NONE', 'nothing received is UNKNOWN, not "no pools"');
  const a = r.read(80, 60);
  assert.equal(m.accept(a), 'ACCEPTED');
  assert.equal(m.accept(a), 'NOT_NEWER');
  const b = r.read(70, 60);
  assert.equal(m.accept({ ...b, pools: [{ ...b.pools[0], hidden: true }] }), 'INVALID');
  assert.equal(m.get(), a, 'an invalid push changes nothing');
  assert.equal(m.accept(b), 'ACCEPTED');
  assert.equal(m.accept(a), 'NOT_NEWER', 'a late older collection cannot overwrite newer truth');
  const rollback = { ...b, collectionRevision: b.collectionRevision + 1, pools: [{ ...b.pools[0], revision: 1 }] };
  assert.equal(m.accept(rollback), 'INVALID', 'a pool revision going backwards is refused');
  assert.equal(notified, 2);
  assert.equal(selectPool(m.get(), b.pools[0].poolId).fiveHour.text, '5h · 70% remaining');
  assert.equal(selectPoolsForAgent(m.get(), 'dwight').length, 1);
  assert.equal(selectPoolsForAgent(m.get(), 'kevin').length, 0);
  r.tracker.forget(POOL);
  assert.equal(m.accept(r.present()), 'ACCEPTED');
  assert.deepEqual(selectPools(m.get()), [], 'complete replace removes a departed pool');
  m.reset();
  assert.equal(m.get(), null, 'reset forgets everything: no durable renderer cache');
});

test('one-way expiry mask: past main\'s expiresAt the row degrades to main\'s own expired rows', () => {
  const r = rig();
  const p = only(r.read(80, 10));
  assert.equal(presentPool(p, p.freshness.expiresAt).masked, false, 'at the deadline itself the reading is still fresh');
  const m = presentPool(p, p.freshness.expiresAt + 1);
  assert.equal(m.masked, true);
  assert.equal(m.state, 'UNKNOWN');
  assert.equal(m.presentation, 'UNKNOWN');
  assert.ok(!('weekly' in m), 'an unknown pool row suffices');
  assert.ok(!JSON.stringify({ ...m, freshness: null }).includes('"meter"'));
  // The mask must say what main itself will say when the reading goes stale.
  r.at(p.freshness.expiresAt + 1);
  r.tracker.evaluate();
  const stale = only(r.present());
  assert.equal(stale.state, m.state);
  assert.equal(stale.fiveHour.text, m.fiveHour.text);
});

test('F1 (Jim): a FRESH epoch-held LIMITED pool with weekly HIDDEN — the expired view carries NO weekly row', () => {
  // The one fixture that reaches the expired-view guard: an open epoch keeps the pool
  // LIMITED once stale, and a stale LIMITED pool's weekly would project as
  // UNKNOWN_CAPACITY. The guard stops the mask from adding that row while the LIVE
  // strip hides weekly (C2.9 absent-when-hidden; §17 the mask may only degrade).
  const r = rig();
  const c = r.read(80, 60, { providerReachedType: 'usage' });
  valid(c);
  const p = only(c);
  assert.equal(p.state, 'LIMITED', 'an unattributed reached signal opens an epoch');
  assert.equal(p.freshness.verdict, 'FRESH');
  assert.ok(!('weekly' in p), 'weekly 60% with no attribution and no exhaustion is normally hidden');
  assert.ok(p.freshness.expired, 'a fresh pool carries its expired view');
  assert.equal(p.freshness.expired.state, 'LIMITED', 'the epoch keeps LIMITED once stale');
  assert.ok(!('weekly' in p.freshness.expired), 'the expired view must not reveal the hidden weekly');
  const masked = presentPool(p, p.freshness.expiresAt + 1);
  assert.equal(masked.masked, true);
  assert.ok(!('weekly' in masked), 'and neither may the mask');
});

test('the mask keeps an epoch-held LIMITED as LIMITED (what the tracker does), minus its figures', () => {
  const r = rig();
  const p = only(r.read(63, 0, { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' }));
  const m = presentPool(p, p.freshness.expiresAt + 1);
  assert.equal(m.state, 'LIMITED');
  assert.equal(m.weekly.reason, 'PROVIDER_ATTRIBUTED_LIMITING');
  assert.ok(!/\d+%/.test(m.fiveHour.text), 'no figure survives the mask');
  r.at(p.freshness.expiresAt + 1);
  r.tracker.evaluate();
  const stale = only(r.present());
  assert.equal(stale.state, 'LIMITED', 'the tracker ranks the open epoch above staleness');
  assert.equal(stale.fiveHour.text, m.fiveHour.text);
  assert.deepEqual(stale.weekly, m.weekly);
});

test('selectOpenNotices returns only OPEN notices', () => {
  const pool = (id, lifecycle) => ({ poolId: id, membership: { agentIds: [] }, notice: lifecycle && { noticeId: `n-${id}`, lifecycle } });
  const c = { pools: [pool('a', 'OPEN'), pool('b', 'DISMISSED'), pool('c', null)] };
  assert.deepEqual(selectOpenNotices(c).map((x) => x.poolId), ['a']);
});

// ─── Plumbing boundary ────────────────────────────────────────────────────────

test('its OWN channel: preload literals match the shared constants, and control:snapshot carries no pool data', () => {
  const preload = readSource('src/preload/index.ts');
  for (const ch of [shared.CAPACITY_STRIP_CHANNEL, shared.CAPACITY_STRIP_CURRENT, shared.CAPACITY_NOTICE_DISMISS]) {
    assert.ok(preload.includes(`'${ch}'`), `preload must use the channel ${ch}`);
  }
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const start = main.indexOf("ipcMain.handle('control:snapshot'");
  const end = main.indexOf('});', start);
  assert.ok(start > 0 && end > start);
  const handler = main.slice(start, end);
  assert.ok(!/capacityStrip|CapacityStrip|weekly|poolLabel/.test(handler), 'C2.9: pool data must not ride on control:snapshot');
  assert.ok(main.includes('webContents.send(CAPACITY_STRIP_CHANNEL'), 'main pushes on the capacity channel');
});

test('single renderer mirror: only the capacity/ family touches the capacity IPC', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'src', 'renderer', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (rel.startsWith('capacity/')) continue;
        if (/onCapacityStrip|capacityStripCurrent|capacityDismissNotice|new CapacityStripMirror/.test(readSource(f))) offenders.push(rel);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

test('C2.11 crit 11: no cross-family ordering vocabulary in any produced string or in the presenter', () => {
  const outputs = [];
  outputs.push(rig().read(80, 60), rig().read(80, 10), rig().read(80, 0), rig({ threshold: 99 }).read(100, 20));
  outputs.push(rig().read(63, 0, { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' }));
  const banned = /\b(binding|tighter|near-tight|headroom|safer window|likely to exhaust)\b/i;
  for (const o of outputs) assert.ok(!banned.test(JSON.stringify(o)), JSON.stringify(o));
  const src = codeOnly(readSource('src/main/capacityStrip.ts'), 'capacityStrip.ts');
  assert.ok(!banned.test(src), 'presenter code must not carry the retired vocabulary');
  assert.ok(!/TIGHTER_THAN_5H|BINDING|R_pool|100\s*\/\s*R/.test(src + codeOnly(readSource('src/shared/capacityStrip.ts'), 'capacityStrip.ts')),
    'C2.11 crit 5: no ratio floor or binding reason');
});
