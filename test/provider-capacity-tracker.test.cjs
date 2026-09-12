'use strict';

/**
 * L0-CORE — ProviderCapacityTracker.
 *
 * The clock is injected in every test. Nothing here waits, and nothing here
 * depends on the machine's wall time, because the two facts most worth pinning -
 * staleness and "a reset time passed" - are both time-derived and would otherwise
 * be untestable without sleeping.
 *
 * The state BOUNDARIES exercised here are provisional and belong to Oscar's L0-SEM.
 * What these tests fix is the STRUCTURE that must hold whatever the boundaries
 * become: evidence outranks numbers, a clock is not evidence, a repeat is not a
 * change, and attribution is never manufactured.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, PROVISIONAL_POLICY, REASON } = loadTs('src/main/providerCapacityTracker.ts');

const T0 = 1_800_000_000_000;

function obs(over = {}) {
  return {
    poolKey: 'codex:acct-a:codex',
    provider: 'codex',
    accountScope: 'acct-a',
    limitId: 'codex',
    source: 'codex-rollout',
    observedAt: T0,
    receivedAt: T0,
    windows: [
      { windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300, usedPercent: 20, remainingPercent: 80, resetsAt: T0 + 3_600_000 },
      { windowId: 'seven_day', kind: 'SEVEN_DAY', label: 'Weekly', windowMinutes: 10080, usedPercent: 40, remainingPercent: 60, resetsAt: T0 + 86_400_000 }
    ],
    providerAttributedLimitingWindowId: null,
    providerReachedType: null,
    ordinaryUsageAllowed: null,
    planType: 'plus',
    ...over
  };
}

/** A tracker whose clock the test drives. */
function make(start = T0) {
  let now = start;
  const t = new ProviderCapacityTracker(PROVISIONAL_POLICY, () => now);
  return { t, set: (v) => { now = v; }, at: () => now };
}

test('a first fresh reading produces AVAILABLE at revision 1', () => {
  const { t } = make();
  assert.equal(t.ingest(obs()), true);
  const p = t.pool('codex:acct-a:codex');
  assert.equal(p.state, 'AVAILABLE');
  assert.equal(p.freshness, 'FRESH');
  assert.equal(p.revision, 1);
  assert.equal(t.snapshot().collectionRevision, 1);
});

test('a REPEAT reading bumps no revision - revisions count changes, not events', () => {
  const { t } = make();
  t.ingest(obs());
  const before = t.snapshot().collectionRevision;
  assert.equal(t.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000 })), false);
  assert.equal(t.snapshot().collectionRevision, before);
  assert.equal(t.pool('codex:acct-a:codex').revision, 1);
});

test('a changed figure bumps BOTH the pool revision and the collection revision', () => {
  const { t } = make();
  t.ingest(obs());
  const w = obs({ observedAt: T0 + 1000 }).windows;
  w[0] = { ...w[0], usedPercent: 30, remainingPercent: 70 };
  assert.equal(t.ingest(obs({ observedAt: T0 + 1000, windows: w })), true);
  assert.equal(t.pool('codex:acct-a:codex').revision, 2);
  assert.equal(t.snapshot().collectionRevision, 2);
});

test('two accounts of one provider are two pools and never merge', () => {
  const { t } = make();
  t.ingest(obs());
  t.ingest(obs({ poolKey: 'codex:acct-b:codex', accountScope: 'acct-b' }));
  assert.equal(t.snapshot().pools.length, 2);
});

test('an OLDER reading cannot overwrite a newer one', () => {
  const { t } = make();
  t.ingest(obs({ observedAt: T0 + 5000, providerReachedType: 'usage' }));
  const older = obs({ observedAt: T0, providerReachedType: null });
  assert.equal(t.ingest(older), false);
  // The typed refusal survives the late-arriving quiet snapshot.
  assert.equal(t.pool('codex:acct-a:codex').state, 'LIMITED');
});

test('a stale 80%-remaining snapshot does not clear a newer typed refusal', () => {
  const { t } = make();
  t.ingest(obs({ observedAt: T0 + 10_000, providerReachedType: 'usage' }));
  assert.equal(t.ingest(obs({ observedAt: T0 + 9_000 })), false);
  assert.equal(t.pool('codex:acct-a:codex').state, 'LIMITED');
});

// ── attribution vs numeric exhaustion, kept apart ────────────────────────────

test('numeric exhaustion is LIMITED with an OBSERVATIONAL reason and no attributed window', () => {
  const { t } = make();
  const w = obs().windows.map((x) => (x.windowId === 'seven_day' ? { ...x, usedPercent: 100, remainingPercent: 0 } : x));
  t.ingest(obs({ windows: w }));
  const p = t.pool('codex:acct-a:codex');
  assert.equal(p.state, 'LIMITED');
  assert.equal(p.stateReason, REASON.NUMERICALLY_EXHAUSTED);
  assert.deepEqual(p.numericallyExhaustedWindowIds, ['seven_day']);
  assert.equal(p.providerAttributedLimitingWindowId, null);
});

test('provider attribution is LIMITED with the CAUSAL reason, and the two facts stay in separate fields', () => {
  const { t } = make();
  const w = obs().windows.map((x) => (x.windowId === 'seven_day' ? { ...x, usedPercent: 100, remainingPercent: 0 } : x));
  t.ingest(obs({ windows: w, providerReachedType: 'secondary', providerAttributedLimitingWindowId: 'seven_day' }));
  const p = t.pool('codex:acct-a:codex');
  assert.equal(p.stateReason, REASON.PROVIDER_ATTRIBUTED);
  assert.equal(p.providerAttributedLimitingWindowId, 'seven_day');
  assert.deepEqual(p.numericallyExhaustedWindowIds, ['seven_day']);
});

test('a reached type with no named window stays UNATTRIBUTED', () => {
  const { t } = make();
  t.ingest(obs({ providerReachedType: 'usage' }));
  const p = t.pool('codex:acct-a:codex');
  assert.equal(p.state, 'LIMITED');
  assert.equal(p.stateReason, REASON.PROVIDER_REACHED_UNATTRIBUTED);
  assert.equal(p.providerAttributedLimitingWindowId, null);
});

test('ordinaryUsageAllowed false is LIMITED; null is never read as permission', () => {
  const a = make();
  a.t.ingest(obs({ ordinaryUsageAllowed: false }));
  assert.equal(a.t.pool('codex:acct-a:codex').stateReason, REASON.ORDINARY_USE_DENIED);
  const b = make();
  b.t.ingest(obs({ ordinaryUsageAllowed: null }));
  assert.equal(b.t.pool('codex:acct-a:codex').state, 'AVAILABLE');
});

// ── recovery is never inferred from a clock ──────────────────────────────────

test('a passed reset time moves LIMITED to RECOVERING and NEVER to AVAILABLE', () => {
  const { t, set } = make();
  const w = obs().windows.map((x) => (x.windowId === 'five_hour' ? { ...x, usedPercent: 100, remainingPercent: 0 } : x));
  t.ingest(obs({ windows: w }));
  assert.equal(t.pool('codex:acct-a:codex').state, 'LIMITED');
  // Walk past the five-hour reset with no new reading at all.
  set(T0 + 3_600_001);
  assert.equal(t.evaluate(), true);
  const p = t.pool('codex:acct-a:codex');
  assert.equal(p.state, 'RECOVERING');
  assert.equal(p.stateReason, REASON.RESET_PASSED_UNCONFIRMED);
  assert.equal(p.recoveryPending, true);
});

test('RECOVERING leaves only on EVIDENCE - a restored fresh reading', () => {
  const { t, set } = make();
  const w = obs().windows.map((x) => (x.windowId === 'five_hour' ? { ...x, usedPercent: 100, remainingPercent: 0 } : x));
  t.ingest(obs({ windows: w }));
  set(T0 + 3_600_001);
  t.evaluate();
  set(T0 + 3_600_002);
  t.ingest(obs({ observedAt: T0 + 3_600_002, receivedAt: T0 + 3_600_002 }));
  assert.equal(t.pool('codex:acct-a:codex').state, 'AVAILABLE');
});

test('explicit ordinaryUsageAllowed true is accepted as recovery evidence', () => {
  const { t, set } = make();
  t.ingest(obs({ providerReachedType: 'usage' }));
  set(T0 + 1000);
  t.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, ordinaryUsageAllowed: true }));
  assert.equal(t.pool('codex:acct-a:codex').state, 'AVAILABLE');
});

test('a quiet reading that is still near zero does NOT clear a refusal', () => {
  const { t, set } = make();
  t.ingest(obs({ providerReachedType: 'usage' }));
  set(T0 + 1000);
  const flat = obs().windows.map((x) => ({ ...x, usedPercent: 99, remainingPercent: 1 }));
  t.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, windows: flat }));
  assert.equal(t.pool('codex:acct-a:codex').state, 'LIMITED');
});

// ── freshness ────────────────────────────────────────────────────────────────

test('a reading past the freshness budget becomes STALE and UNKNOWN, not last-known-good', () => {
  const { t, set } = make();
  t.ingest(obs());
  set(T0 + PROVISIONAL_POLICY.freshnessMs + 1);
  assert.equal(t.evaluate(), true);
  const p = t.pool('codex:acct-a:codex');
  assert.equal(p.freshness, 'STALE');
  assert.equal(p.state, 'UNKNOWN');
  assert.equal(p.stateReason, REASON.STALE);
  // The figures are still carried - they are just no longer current.
  assert.equal(p.windows.length, 2);
});

test('evaluate() with nothing to change reports no change', () => {
  const { t } = make();
  t.ingest(obs());
  const before = t.snapshot().collectionRevision;
  assert.equal(t.evaluate(T0 + 1000), false);
  assert.equal(t.snapshot().collectionRevision, before);
});

test('windows carrying no numbers at all are UNKNOWN rather than available', () => {
  const { t } = make();
  const none = obs().windows.map((x) => ({ ...x, usedPercent: null, remainingPercent: null }));
  t.ingest(obs({ windows: none }));
  const p = t.pool('codex:acct-a:codex');
  assert.equal(p.state, 'UNKNOWN');
  assert.equal(p.stateReason, REASON.NO_NUMBERS);
});

test('the least remaining window drives the state, across windows of different durations', () => {
  const { t } = make();
  const w = obs().windows.map((x) => (x.windowId === 'seven_day' ? { ...x, usedPercent: 97, remainingPercent: 3 } : x));
  t.ingest(obs({ windows: w }));
  assert.equal(t.pool('codex:acct-a:codex').state, 'RESERVE_ONLY');
});

test('forget() removes a pool and moves the collection revision', () => {
  const { t } = make();
  t.ingest(obs());
  const before = t.snapshot().collectionRevision;
  assert.equal(t.forget('codex:acct-a:codex'), true);
  assert.equal(t.snapshot().pools.length, 0);
  assert.equal(t.snapshot().collectionRevision, before + 1);
  assert.equal(t.forget('codex:acct-a:codex'), false);
});

test('the projection carries no binding/tighter vocabulary at all', () => {
  const { t } = make();
  t.ingest(obs());
  const keys = Object.keys(t.pool('codex:acct-a:codex')).join(' ').toLowerCase();
  for (const banned of ['binding', 'tighter', 'headroom', 'safer']) {
    assert.equal(keys.includes(banned), false, `projection must not expose a "${banned}" field`);
  }
});
