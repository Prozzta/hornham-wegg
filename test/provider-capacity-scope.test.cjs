'use strict';

/**
 * L0-S19FIX — L0-SEM section 19, read at the source (research `646179ec`).
 *
 * §19 resolves §14's ambiguous noun `scope`: it names the ATTRIBUTION DOMAIN of the
 * hard-limit fact, canonically encoded by the nullable validated `windowId`, and is
 * not the pool's `accountScope` routing identity. The no-`scope`-field envelope
 * conforms — but §19 is not purely permissive. It requires fixtures for BOTH
 * branches, and it makes a behavioural claim nobody had verified:
 *
 *   "In both branches, a valid envelope still creates the pool's normal sticky
 *    LIMITED epoch as section 14 requires; the nullable ID governs attribution, not
 *    whether the refusal blocks ordinary use."
 *
 * The naming rule was already pinned (`ENVELOPE: a window id is kept only when it is
 * ALREADY an admitted identity`). What was not pinned is that the NULL branch still
 * blocks, and that no third state and no second source of truth exists. These arms
 * cover that.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS, REASON } =
  loadTs('src/main/providerCapacityTracker.ts');
const { admissionEnvelopeOf } = loadTs('src/main/capacityEnvelope.ts');
const { CapacityAdmission } = loadTs('src/main/capacityAdmission.ts');

const T0 = 1_800_000_000_000;
const KEY = 'codex:acct-a:codex';
const RESET = T0 + 3_600_000;

const win = (id = 'five_hour', over = {}) => ({
  windowId: id, kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: 20, remainingPercent: 80, resetsAt: RESET, ...over
});

const obs = (over = {}) => ({
  poolKey: KEY, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s.jsonl', sourceSequence: 1,
  observedAt: T0, receivedAt: T0, windows: [win()],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

/** An observation that breaches the per-pool window cap, so the envelope is the
 *  only thing that can carry the refusal through. */
const oversized = (over = {}) => obs({
  windows: Array.from({ length: RETENTION_CAPS.maxWindowsPerPool + 1 }, (_, i) => win(`w${i}`)),
  ...over
});

function rig() {
  let now = T0;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return { t, advance: (ms) => { now += ms; mono += ms; }, at: () => now };
}

/** Admit `five_hour` first, so it is an already-admitted current identity. */
function withAdmittedWindow() {
  const r = rig();
  r.t.ingest(obs());
  assert.equal(r.t.pool(KEY).windows.length, 1, 'precondition: five_hour is admitted');
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// The two branches, and the claim that BOTH of them block
// ═══════════════════════════════════════════════════════════════════════════

test('S19: the ATTRIBUTED branch keeps its bounded window id and classifies LIMITED', () => {
  const r = withAdmittedWindow();
  r.advance(1_000);
  r.t.ingest(oversized({
    observedAt: r.at(), receivedAt: r.at(), sourceSequence: 2,
    providerReachedType: 'rate_limit_reached',
    providerAttributedLimitingWindowId: 'five_hour'
  }));
  const p = r.t.pool(KEY);
  assert.equal(p.state, 'LIMITED');
  assert.equal(p.providerAttributedLimitingWindowId, 'five_hour', 'the non-null branch names its window');
  assert.equal(p.stateReason, REASON.PROVIDER_ATTRIBUTED);
});

test('S19: the POOL-SCOPED branch names NO window and STILL classifies LIMITED', () => {
  // THE CLAUSE NOBODY HAD VERIFIED. The nullable id governs attribution, not whether
  // the refusal blocks. KILLS an implementation that treats a null window as "no
  // usable fact" and leaves the pool UNKNOWN — which is the tempting reading of
  // section 13's reject-whole rule and exactly what section 14 exists to prevent.
  const r = withAdmittedWindow();
  r.advance(1_000);
  r.t.ingest(oversized({
    observedAt: r.at(), receivedAt: r.at(), sourceSequence: 2,
    providerReachedType: 'rate_limit_reached',
    providerAttributedLimitingWindowId: null
  }));
  const p = r.t.pool(KEY);
  assert.equal(p.state, 'LIMITED', 'a pool-scoped refusal blocks just as hard');
  assert.equal(p.providerAttributedLimitingWindowId, null, 'and names no window');
  assert.equal(p.stateReason, REASON.PROVIDER_REACHED_UNATTRIBUTED, 'reported as unattributed, not invented');
});

test('S19: BOTH branches suppress ordinary work at the admission seam', () => {
  // "Blocks ordinary use" asserted where it is actually consumed, not only as a
  // state name. If only the attributed branch refused, the pool-scoped refusal would
  // be a label with no consequence.
  for (const [label, windowId] of [['attributed', 'five_hour'], ['pool-scoped', null]]) {
    const r = withAdmittedWindow();
    r.advance(1_000);
    r.t.ingest(oversized({
      observedAt: r.at(), receivedAt: r.at(), sourceSequence: 2,
      providerReachedType: 'rate_limit_reached',
      providerAttributedLimitingWindowId: windowId
    }));
    const seam = new CapacityAdmission({
      poolKeyForAgent: () => KEY,
      poolState: (k) => r.t.pool(k),
      now: () => r.at()
    });
    assert.equal(seam.probe('jim', 'ORDINARY_TURN').verdict, 'REFUSE', `${label} must suppress ordinary work`);
  }
});

test('S19: BOTH branches create a STICKY epoch that time does not clear', () => {
  // §14's "normal sticky LIMITED epoch", asserted for the null branch too.
  for (const windowId of ['five_hour', null]) {
    const r = withAdmittedWindow();
    r.advance(1_000);
    r.t.ingest(oversized({
      observedAt: r.at(), receivedAt: r.at(), sourceSequence: 2,
      providerReachedType: 'rate_limit_reached',
      providerAttributedLimitingWindowId: windowId
    }));
    assert.equal(r.t.pool(KEY).state, 'LIMITED', `${windowId}: precondition`);
    assert.ok(r.t.pool(KEY).limitEpochAt !== null, `${windowId}: an epoch really opened`);

    r.advance(30 * 60_000);
    r.t.evaluate();
    assert.equal(r.t.pool(KEY).state, 'LIMITED', `${windowId}: staleness never clears an epoch`);
  }
});

test('S19: and K clears BOTH — sticky is not permanent', () => {
  // The pair. "Stays LIMITED" is trivially satisfied by a pool that can never leave.
  for (const windowId of ['five_hour', null]) {
    const r = withAdmittedWindow();
    r.advance(1_000);
    r.t.ingest(oversized({
      observedAt: r.at(), receivedAt: r.at(), sourceSequence: 2,
      providerReachedType: 'rate_limit_reached',
      providerAttributedLimitingWindowId: windowId
    }));
    r.advance(10_000);
    r.t.ingest(obs({ observedAt: r.at(), receivedAt: r.at(), sourceSequence: 9, ordinaryUsageAllowed: true }));
    assert.notEqual(r.t.pool(KEY).state, 'LIMITED', `${windowId}: explicit permission clears it`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Every non-qualifying identity selects the NULL branch — there is no third state
// ═══════════════════════════════════════════════════════════════════════════

test('S19: missing, malformed, unbounded and unadmitted identities all select NULL', () => {
  // §19 names the list and says these "must select the null branch and must not be
  // relabelled as Weekly". Each is asserted to land on null AND to still be LIMITED,
  // because a disqualified attribution must not also disqualify the refusal.
  const cases = {
    missing: null,
    'malformed (not a string)': 12345,
    'unbounded (over the identity ceiling)': 'w'.repeat(5_000),
    'unadmitted (never seen on this pool)': 'seven_day',
    'empty string': ''
  };
  for (const [label, attributed] of Object.entries(cases)) {
    const r = withAdmittedWindow();
    r.advance(1_000);
    r.t.ingest(oversized({
      observedAt: r.at(), receivedAt: r.at(), sourceSequence: 2,
      providerReachedType: 'rate_limit_reached',
      providerAttributedLimitingWindowId: attributed
    }));
    const p = r.t.pool(KEY);
    assert.equal(p.providerAttributedLimitingWindowId, null, `${label}: selects the null branch`);
    assert.equal(p.state, 'LIMITED', `${label}: the refusal still blocks`);
  }
});

test('S19: a disqualified identity is never relabelled as Weekly or anything else', () => {
  // The specific prohibition. Asserted as an absence across the whole published
  // projection, not just on the attribution field, so a relabel that landed
  // somewhere else would still be caught.
  const r = withAdmittedWindow();
  r.advance(1_000);
  r.t.ingest(oversized({
    observedAt: r.at(), receivedAt: r.at(), sourceSequence: 2,
    providerReachedType: 'rate_limit_reached',
    providerAttributedLimitingWindowId: 'seven_day'
  }));
  const serialized = JSON.stringify(r.t.pool(KEY));
  assert.equal(serialized.includes('seven_day'), false, 'the unadmitted id appears nowhere');
  assert.equal(serialized.toLowerCase().includes('weekly'), false, 'and nothing was relabelled Weekly');
});

test('S19: the envelope exposes exactly two scope shapes and no third', () => {
  // Directly on the parser: `windowId` is the whole discriminator, and it is either
  // a bounded admitted id or null. Nothing else is produced for any input.
  const inputs = ['five_hour', 'seven_day', null, '', 'w'.repeat(500), 12345, {}, []];
  const seen = new Set();
  for (const attributed of inputs) {
    const e = admissionEnvelopeOf(
      obs({ providerReachedType: 'rate_limit_reached', providerAttributedLimitingWindowId: attributed }),
      ['five_hour']
    );
    assert.notEqual(e, null, 'the refusal itself always qualifies here');
    seen.add(e.windowId === null ? 'NULL' : 'BOUNDED_ADMITTED');
    assert.ok(e.windowId === null || e.windowId === 'five_hour', `unexpected windowId: ${e.windowId}`);
  }
  assert.deepEqual([...seen].sort(), ['BOUNDED_ADMITTED', 'NULL'], 'both branches reached, and only those two');
});

test('S19: no convenience scope label is retained as a second source of truth', () => {
  // §19: "Duplicating the discriminator would permit contradictory states such as
  // scope: 'POOL' with a non-null window ID." An implementation may compute a label
  // at a boundary but must not retain, serialize, order or compare it.
  const e = admissionEnvelopeOf(
    obs({ providerReachedType: 'rate_limit_reached', providerAttributedLimitingWindowId: 'five_hour' }),
    ['five_hour']
  );
  assert.equal(Object.prototype.hasOwnProperty.call(e, 'scope'), false, 'no retained scope field');
  const serialized = JSON.stringify(e);
  for (const label of ['"POOL"', '"WINDOW"', 'POOL_SCOPED', 'WINDOW_SCOPED']) {
    assert.equal(serialized.includes(label), false, `no serialized ${label} discriminator`);
  }

  // And the routing identity is NOT the attribution domain: accountScope is present
  // and is a different thing, which is the confusion §19 exists to end.
  assert.equal(e.accountScope, 'acct-a');
  assert.equal(e.windowId, 'five_hour');
});
