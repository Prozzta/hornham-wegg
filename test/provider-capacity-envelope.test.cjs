'use strict';

/**
 * L0-SEM 14 — the admission-critical envelope.
 *
 * The value of this ruling is in its DISQUALIFICATION LIST, so the negative cases
 * are pinned at least as hard as the positive one. But a negative-only suite is
 * satisfied by an implementation that honours nothing at all, so every negative here
 * sits beside the positive that proves the path is live.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY, REASON, RETENTION_CAPS } =
  loadTs('src/main/providerCapacityTracker.ts');
const { admissionEnvelopeOf } = loadTs('src/main/capacityEnvelope.ts');
const { CapacityAdmission, ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

const T0 = 1_800_000_000_000;
const KEY = 'codex:acct-a:codex';
const RESET_5H = T0 + 3_600_000;

const win = (id = 'five_hour') => ({
  windowId: id, kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: 20, remainingPercent: 80, resetsAt: RESET_5H
});

const obs = (over = {}) => ({
  poolKey: KEY, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s/a.jsonl', sourceSequence: 4,
  observedAt: T0, receivedAt: T0, windows: [win()],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

/** An observation that breaches the per-pool window cap. */
const oversized = (over = {}) => obs({
  windows: Array.from({ length: RETENTION_CAPS.maxWindowsPerPool + 1 }, (_, i) => win(`w${i}`)),
  ...over
});

function make(start = T0) {
  let now = start;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return {
    t,
    set: (v) => { mono += Math.max(0, v - now); now = v; },
    state: () => t.pool(KEY)?.state,
    reason: () => t.pool(KEY)?.stateReason
  };
}

// ── the parser in isolation ────────────────────────────────────────────────

test('ENVELOPE: a literal false and an exact typed reached both qualify', () => {
  assert.equal(admissionEnvelopeOf(obs({ ordinaryUsageAllowed: false })).hardLimit, 'ORDINARY_USE_DENIED');
  assert.equal(admissionEnvelopeOf(obs({ providerReachedType: 'rate_limit_reached' })).hardLimit, 'TYPED_REACHED');
});

test('ENVELOPE: the disqualification list, every entry', () => {
  const rejected = {
    'the STRING "false"': { ordinaryUsageAllowed: 'false' },
    'the number 0': { ordinaryUsageAllowed: 0 },
    'null': { ordinaryUsageAllowed: null },
    'true': { ordinaryUsageAllowed: true },
    'a generic 429': { providerReachedType: '429' },
    'overload text': { providerReachedType: 'server overloaded, try again' },
    'a refusal sentence': { providerReachedType: 'the request was refused' },
    'a SUBSTRING of an allowlisted value': { providerReachedType: 'rate_limit' },
    'a SUPERSTRING of an allowlisted value': { providerReachedType: 'not_rate_limit_reached_yet' },
    'a truncated value': { providerReachedType: 'workspace_owner_credits_deplet' },
    'an unknown source': { source: 'some-other-collector', providerReachedType: 'rate_limit_reached' },
    'a missing observation time': { observedAt: 0, providerReachedType: 'rate_limit_reached' },
    'nothing stated at all': {}
  };
  for (const [label, over] of Object.entries(rejected)) {
    assert.equal(admissionEnvelopeOf(obs(over)), null, label);
  }
});

test('ENVELOPE: it carries no provider-supplied string, only discriminators', () => {
  const e = admissionEnvelopeOf(obs({ providerReachedType: 'workspace_member_usage_limit_reached' }));
  const serialized = JSON.stringify(e);
  assert.equal(serialized.includes('workspace_member_usage_limit_reached'), false, 'the provider text is gone');
  assert.equal(serialized.includes('plus'), false, 'and so is everything else it arrived with');
  assert.ok(serialized.length < 512, 'constant-size by construction');
});

test('ENVELOPE: a window id is kept only when it is ALREADY an admitted identity', () => {
  const stated = obs({ providerReachedType: 'rate_limit_reached', providerAttributedLimitingWindowId: 'seven_day' });
  assert.equal(admissionEnvelopeOf(stated, ['five_hour']).windowId, null, 'not a current identity: pool-scoped');
  assert.equal(admissionEnvelopeOf(stated, ['five_hour', 'seven_day']).windowId, 'seven_day');
});

// ── across a cap breach, on an admitted pool ───────────────────────────────

test('SEM14: an OVERSIZED typed refusal becomes LIMITED, bulk still rejected', () => {
  const m = make();
  m.t.ingest(oversized({ providerReachedType: 'rate_limit_reached' }));
  assert.equal(m.state(), 'LIMITED', 'UNKNOWN-and-proceed is not intended');
  assert.equal(m.t.pool(KEY).windows.length, 0, 'and the bulk payload is still rejected whole');
});

test('SEM14: an OVERSIZED literal-false refusal becomes LIMITED', () => {
  const m = make();
  m.t.ingest(oversized({ ordinaryUsageAllowed: false }));
  assert.equal(m.state(), 'LIMITED');
  assert.equal(m.reason(), REASON.ORDINARY_USE_DENIED);
});

test('SEM14: the SAME oversized payload without a valid fact stays UNKNOWN', () => {
  // The other half. Without this, "malformed input cannot create evidence" is
  // satisfied by an implementation that never creates evidence at all.
  for (const over of [{}, { ordinaryUsageAllowed: 'false' }, { providerReachedType: 'rate_limit' }]) {
    const m = make();
    m.t.ingest(oversized(over));
    assert.equal(m.state(), 'UNKNOWN', JSON.stringify(over));
    assert.equal(m.reason(), REASON.CAP_EXCEEDED, 'section 13 stands untouched');
  }
});

test('SEM14: no provider string is retained even when the fact survives', () => {
  const m = make();
  m.t.ingest(oversized({ providerReachedType: 'workspace_owner_credits_depleted' }));
  assert.equal(m.state(), 'LIMITED');
  assert.equal(
    JSON.stringify(m.t.snapshot()).includes('workspace_owner_credits_depleted'),
    false,
    'the surviving fact is a discriminator, not the text that carried it'
  );
});

test('SEM14: the surviving epoch is sticky and clears only through K', () => {
  const m = make();
  m.t.ingest(oversized({ providerReachedType: 'rate_limit_reached' }));
  assert.equal(m.state(), 'LIMITED');

  // Time passing is not K.
  m.set(T0 + 10 * 60_000);
  m.t.evaluate();
  assert.equal(m.state(), 'LIMITED', 'staleness never clears an epoch');

  // K1: explicit provider permission on a reading that fits.
  const t1 = T0 + 11 * 60_000;
  m.set(t1);
  m.t.ingest(obs({ observedAt: t1, receivedAt: t1, ordinaryUsageAllowed: true }));
  assert.notEqual(m.state(), 'LIMITED', 'K clears it');
});

// ── the novel 33rd pool ────────────────────────────────────────────────────

function fill(m) {
  for (let i = 0; i < RETENTION_CAPS.maxPools; i += 1) {
    m.t.ingest(obs({ poolKey: `codex:acct-${i}:codex`, accountScope: `acct-${i}` }));
  }
}

test('SEM14: a refusing 33rd pool marks the MARKER, not the retained pools', () => {
  const m = make();
  fill(m);
  m.t.ingest(obs({
    poolKey: 'codex:zzexcess:codex', accountScope: 'zzexcess',
    providerReachedType: 'rate_limit_reached'
  }));

  const snap = m.t.snapshot();
  assert.equal(snap.overflow.hardLimitObserved, true);
  assert.equal(snap.overflow.admission, 'LIMITED');
  assert.equal(snap.overflow.excess, 'ONE_OR_MORE', 'still no count');
  assert.equal(JSON.stringify(snap).includes('zzexcess'), false, 'and no excess identity');

  // The retained pools are NOT relabelled by someone else's refusal.
  for (const pool of snap.pools) assert.equal(pool.state, 'AVAILABLE', pool.poolKey);
});

test('SEM14: a 33rd pool WITHOUT a valid fact leaves the marker unarmed', () => {
  const m = make();
  fill(m);
  m.t.ingest(obs({ poolKey: 'codex:zzexcess:codex', accountScope: 'zzexcess', providerReachedType: '429' }));
  const snap = m.t.snapshot();
  assert.ok(snap.overflow, 'the collection is still incomplete');
  assert.equal(snap.overflow.admission, undefined, 'but nothing was observed refusing');
  assert.equal(m.t.collectionAdmission(), null);
});

test('SEM14: the armed marker suppresses ONLY bindings that cannot be resolved', () => {
  const m = make();
  fill(m);
  m.t.ingest(obs({
    poolKey: 'codex:zzexcess:codex', accountScope: 'zzexcess',
    providerReachedType: 'rate_limit_reached'
  }));

  const seam = new CapacityAdmission({
    poolKeyForAgent: (id) => (id === 'known' ? 'codex:acct-0:codex' : null),
    poolState: (key) => m.t.pool(key),
    collectionAdmission: () => m.t.collectionAdmission(),
    now: () => T0
  });

  const unresolved = seam.admit('stranger');
  assert.equal(unresolved.verdict, 'REFUSE');
  assert.equal(unresolved.reason, ADMISSION_REASON.OMITTED_POOL_LIMITED);

  const resolved = seam.admit('known');
  assert.equal(resolved.verdict, 'ALLOW', 'a pool we DO know keeps its own verdict');
  assert.equal(resolved.reason, ADMISSION_REASON.AVAILABLE);
});

test('SEM14: without the marker an unresolved binding is UNKNOWN, not refused', () => {
  const m = make();
  const seam = new CapacityAdmission({
    poolKeyForAgent: () => null,
    poolState: () => null,
    collectionAdmission: () => m.t.collectionAdmission(),
    now: () => T0
  });
  const d = seam.admit('stranger');
  assert.equal(d.verdict, 'UNKNOWN_NOT_INFERRED_SAFE');
  assert.equal(d.reason, ADMISSION_REASON.NO_POOL, 'the seam still declines to infer safety');
});
