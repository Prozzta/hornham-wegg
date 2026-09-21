'use strict';

/**
 * v1.1.45 unit #7 — capacity toasts aligned to the design of record §13: ONLY entering
 * LIMITED and the confirmed return to ordinary use raise an OS toast; everything else is
 * strip-only. Still gated on the notifications setting; no replay (a first sighting is a
 * baseline); the delivery outcome is recorded on the notice; the #6 banner is independent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityNotifier } = loadTs('src/main/capacityNotify.ts');
const { CapacityStripPresenter, TOASTED_KINDS } = loadTs('src/main/capacityStrip.ts');
const { deliverCapacityToast } = loadTs('src/main/capacityToast.ts');
const { validateCapacityStrip, NOTICE_DELIVERIES } = loadTs('src/shared/capacityStrip.ts');
const { selectLimitBanners } = loadTs('src/renderer/src/capacity/capacityStrip.ts');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct:codex';
const win = (id, kind, remaining) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: 100 - remaining, remainingPercent: remaining,
  resetsAt: kind === 'FIVE_HOUR' ? T0 + 3_600_000 : T0 + 3 * 86_400_000 });
const ATTRIB = { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' };

function rig() {
  let now = T0;
  let seq = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const notifier = new CapacityNotifier();
  const presenter = new CapacityStripPresenter({ idKey: Buffer.alloc(32, 6) });
  const read = (five, weekly, over = {}) => {
    now += 1000;
    tracker.ingest({ poolKey: POOL, streamId: 's', sourceSequence: ++seq, provider: 'codex', accountScope: 'acct', limitId: 'codex',
      source: 'codex-rollout', observedAt: now, receivedAt: now, windows: [win('five_hour', 'FIVE_HOUR', five), win('seven_day', 'SEVEN_DAY', weekly)],
      providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: null, ...over });
    return notifier.observe(tracker.snapshot(), now);
  };
  return { read, presenter, tracker, now: () => now };
}
const intent = (kind, over = {}) => ({ kind, poolKey: POOL, provider: 'codex', from: 'AVAILABLE', to: 'LIMITED',
  stateReason: 'X', limitEpochAt: null, identity: `${POOL}|${kind}|e1`, at: T0, ...over });

// ─── Which transitions toast (§13) ────────────────────────────────────────────────

test('§13: ONLY entering LIMITED and the confirmed return to ordinary use toast', () => {
  assert.deepEqual([...TOASTED_KINDS], ['LIMIT_REACHED', 'RECOVERED']);
  const r = rig();
  assert.equal(r.presenter.toastFor(intent('RESERVE_REACHED', { to: 'RESERVE_ONLY' }), null), null, 'reserve-only is a strip change');
  assert.equal(r.presenter.toastFor(intent('RECOVERY_POSSIBLE', { from: 'LIMITED', to: 'RECOVERING' }), null), null, 'recovery-possible is a strip change');
  assert.deepEqual(r.presenter.toastFor(intent('RECOVERED', { from: 'LIMITED', to: 'AVAILABLE' }), null),
    { title: 'Codex available again', body: 'Automatic delivery to Codex agents has resumed.' });
});

test('an entry to LIMITED toasts with the SAME words as the #6 banner, and no figure', () => {
  const r = rig();
  r.read(80, 60);                                              // baseline
  const [lim] = r.read(63, 0, ATTRIB);
  assert.equal(lim.kind, 'LIMIT_REACHED');
  const toast = r.presenter.toastFor(lim, r.tracker.pool(POOL));
  assert.deepEqual(toast, {
    title: 'Codex limited',
    body: 'Codex reports the Weekly limit reached. Automatic delivery to Codex agents is paused until capacity returns. Queued messages wait; nothing is lost.'
  });
  for (const k of ['RECOVERED']) {
    const t = r.presenter.toastFor(intent(k, { from: 'LIMITED', to: 'AVAILABLE' }), null);
    assert.ok(!/\d|%/.test(t.title + t.body), 'no figure in a toast');
  }
  assert.ok(!/\d|%/.test(toast.title + toast.body));
});

test('a real RESERVE_ONLY entry is recorded STRIP_ONLY: no toast, even with notifications on', () => {
  const r = rig();
  r.read(80, 60);
  const [reserve] = r.read(63, 0);
  assert.equal(reserve.kind, 'RESERVE_REACHED');
  let shown = 0;
  const delivery = deliverCapacityToast(r.presenter.toastFor(reserve, r.tracker.pool(POOL)),
    { notificationsOn: () => true, supported: () => true, show: () => { shown++; } });
  assert.equal(delivery, 'STRIP_ONLY');
  assert.equal(shown, 0);
});

// ─── Delivery: gated on the setting, recorded on the notice ─────────────────────────

test('delivery: SHOWN once; SUPPRESSED when the setting is off; UNSUPPORTED on a platform that cannot', () => {
  const toast = { title: 'Codex limited', body: 'x' };
  const shown = [];
  const deps = (over) => ({ notificationsOn: () => true, supported: () => true, show: (t) => shown.push(t), ...over });
  assert.equal(deliverCapacityToast(toast, deps()), 'SHOWN');
  assert.deepEqual(shown, [toast], 'shown exactly once, with the presenter words');
  assert.equal(deliverCapacityToast(toast, deps({ notificationsOn: () => false })), 'SUPPRESSED');
  assert.equal(deliverCapacityToast(toast, deps({ supported: () => false })), 'UNSUPPORTED');
  assert.equal(deliverCapacityToast(toast, deps({ show: () => { throw new Error('x'); } })), 'UNSUPPORTED');
  assert.equal(shown.length, 1, 'nothing shown while suppressed or unsupported');
  assert.ok(NOTICE_DELIVERIES.includes('STRIP_ONLY'));
});

test('no replay: a pool first seen LIMITED after a restart is a baseline — no intent, so no toast', () => {
  const r = rig();
  assert.deepEqual(r.read(63, 0, ATTRIB), [], 'a first sighting is never news (correction 4)');
});

test('independence: the #6 banner shows even when the toast was suppressed; a STRIP_ONLY notice is valid', () => {
  const r = rig();
  r.read(80, 60);
  const [lim] = r.read(63, 0, ATTRIB);
  r.presenter.noteIntent(lim, 'SUPPRESSED');
  const present = () => r.presenter.present({ snapshot: r.tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => r.tracker.freshUntil(k), now: r.now() });
  const c = present();
  assert.deepEqual(validateCapacityStrip(c), []);
  assert.equal(c.pools[0].notice.delivery, 'SUPPRESSED');
  assert.equal(selectLimitBanners(c).length, 1, 'the in-app banner does not depend on the toast');
  const r2 = rig();
  r2.read(80, 60);
  const [reserve] = r2.read(63, 0);
  r2.presenter.noteIntent(reserve, 'STRIP_ONLY');
  const c2 = r2.presenter.present({ snapshot: r2.tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => r2.tracker.freshUntil(k), now: r2.now() });
  assert.deepEqual(validateCapacityStrip(c2), []);
  assert.equal(c2.pools[0].notice.delivery, 'STRIP_ONLY');
});

test('main wiring: every intent goes through toastFor + the setting gate; the raw reason-code toast is gone', () => {
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(main, /capacityStrip\.noteIntent\(intent, capacityToast\(capacityStrip\.toastFor\(intent, providerCapacity\.tracker\.pool\(intent\.poolKey\)\)\)\);/);
  const fnStart = main.indexOf('function capacityToast(');
  const fn = main.slice(fnStart, main.indexOf('\n}\n', fnStart));
  assert.match(fn, /return deliverCapacityToast\(toast, \{/);
  assert.match(fn, /notificationsOn: \(\) => readConfig\(\)\.notifications === true/);
  assert.ok(!/stateReason|->/.test(fn), 'the old raw "codex AVAILABLE -> LIMITED (REASON)" body is gone');
});
