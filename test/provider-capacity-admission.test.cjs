'use strict';

/**
 * L0-SEAM — the conservative admission seam.
 *
 * Driven through the REAL tracker rather than a hand-made state, so a decision can
 * only be reached by a state the tracker can actually produce. A seam tested
 * against invented states would pass on transitions that cannot happen and miss the
 * ones that can.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityAdmission, ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct-a:codex';
const RESET_5H = T0 + 3_600_000;

const win = (id, kind, remaining, resetsAt) => ({
  windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080,
  usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining, resetsAt
});

const obs = (over = {}) => ({
  poolKey: POOL, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', observedAt: T0, receivedAt: T0,
  windows: [win('five_hour', 'FIVE_HOUR', 80, RESET_5H), win('seven_day', 'SEVEN_DAY', 60, T0 + 86_400_000)],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

/** Three agents, one subscription - the shape the cardinality rule is about. */
const SHARED = { dwight: POOL, oscar: POOL, meredith: POOL, michael: 'claude:acct-c:subscription' };

function rig(start = T0) {
  let now = start;
  let mono = 0;
  // Both clocks advance together: freshness is decided on a MONOTONIC deadline, so a
  // rig that moved only the wall clock would be simulating a clock anomaly rather
  // than time passing, and nothing would ever expire.
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  const seam = new CapacityAdmission({
    poolKeyForAgent: (id) => SHARED[id] ?? null,
    poolState: (key) => tracker.pool(key),
    now: () => now
  });
  return { tracker, seam, set: (v) => { mono += Math.max(0, v - now); now = v; } };
}

test('AVAILABLE admits ordinary work', () => {
  const r = rig();
  r.tracker.ingest(obs());
  const d = r.seam.admit('dwight');
  assert.equal(d.verdict, 'ALLOW');
  assert.equal(d.reason, ADMISSION_REASON.AVAILABLE);
  assert.equal(d.poolKey, POOL);
});

test('LIMITED refuses ordinary turns AND automatic retries, both work classes', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  assert.equal(r.seam.admit('dwight', 'ORDINARY_TURN').verdict, 'REFUSE');
  assert.equal(r.seam.admit('dwight', 'CLOSURE_TURN').verdict, 'REFUSE');
});

test('RESERVE_ONLY suppresses ordinary work but lets work finish safely', () => {
  const r = rig();
  r.tracker.ingest(obs({ windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H), win('seven_day', 'SEVEN_DAY', 40, T0 + 86_400_000)] }));
  assert.equal(r.tracker.pool(POOL).state, 'RESERVE_ONLY');
  const ordinary = r.seam.admit('dwight', 'ORDINARY_TURN');
  assert.equal(ordinary.verdict, 'REFUSE');
  assert.equal(ordinary.reason, ADMISSION_REASON.RESERVE_ORDINARY);
  assert.equal(r.seam.admit('dwight', 'CLOSURE_TURN').verdict, 'ALLOW');
});

test('UNKNOWN is neither permission nor refusal - the seam declines to infer safety', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.set(T0 + L0_SEM_POLICY.liveTtlMs + 1);
  r.tracker.evaluate();
  const d = r.seam.admit('dwight');
  assert.equal(d.verdict, 'UNKNOWN_NOT_INFERRED_SAFE');
  assert.equal(d.reason, ADMISSION_REASON.UNKNOWN);
});

test('an agent with no pool, and a pool with no state, are both UNKNOWN rather than allowed', () => {
  const r = rig();
  const noPool = r.seam.admit('somebody-else');
  assert.equal(noPool.verdict, 'UNKNOWN_NOT_INFERRED_SAFE');
  assert.equal(noPool.reason, ADMISSION_REASON.NO_POOL);
  assert.equal(noPool.poolKey, null);
  const noState = r.seam.admit('michael');
  assert.equal(noState.verdict, 'UNKNOWN_NOT_INFERRED_SAFE');
  assert.equal(noState.reason, ADMISSION_REASON.NO_STATE);
});

// ── the cardinality rule ─────────────────────────────────────────────────────

test('THREE AGENTS ON ONE POOL GET ONE ANSWER - shared agents are not independent quotas', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  const decisions = ['dwight', 'oscar', 'meredith'].map((id) => r.seam.admit(id));
  for (const d of decisions) {
    assert.equal(d.verdict, 'REFUSE');
    assert.equal(d.poolKey, POOL, 'every shared agent must resolve to the SAME pool');
    assert.equal(d.state, 'LIMITED');
  }
  // One refusal, not three: the decisions are identical because the agent id plays
  // no part once the pool is resolved.
  assert.equal(new Set(decisions.map((d) => JSON.stringify({ ...d, workClass: null }))).size, 1);
});

test('a decision carries no per-agent capacity: no agent id, no tokens, no context, no session', () => {
  const r = rig();
  r.tracker.ingest(obs());
  const d = r.seam.admit('dwight');
  const keys = Object.keys(d).join(' ').toLowerCase();
  for (const banned of ['agent', 'token', 'context', 'session', 'quota', 'percent']) {
    assert.equal(keys.includes(banned), false, `an admission decision must not carry "${banned}"`);
  }
});

test('two genuinely distinct pools decide independently', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  r.tracker.ingest(obs({ poolKey: 'claude:acct-c:subscription', provider: 'claude', accountScope: 'acct-c', limitId: 'subscription', source: 'claude-status-line' }));
  assert.equal(r.seam.admit('dwight').verdict, 'REFUSE');
  assert.equal(r.seam.admit('michael').verdict, 'ALLOW');
});

// ── recovery: exactly one real turn per epoch ────────────────────────────────

test('RECOVERING grants exactly ONE real turn, and the second attempt is refused', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  r.set(RESET_5H + 1);
  r.tracker.evaluate();
  assert.equal(r.tracker.pool(POOL).state, 'RECOVERING');
  const first = r.seam.admit('dwight');
  assert.equal(first.verdict, 'ALLOW');
  assert.equal(first.reason, ADMISSION_REASON.RECOVERING_GRANT);
  assert.equal(r.seam.admit('dwight').reason, ADMISSION_REASON.RECOVERING_SPENT);
  // And the grant is per POOL, not per agent - a second agent cannot spend it again.
  assert.equal(r.seam.admit('oscar').verdict, 'REFUSE');
});

test('a re-refusal inside an UNRESOLVED epoch does NOT hand out a second turn', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  r.set(RESET_5H + 1);
  r.tracker.evaluate();
  const granted = r.seam.admit('dwight');
  assert.equal(granted.verdict, 'ALLOW', 'the one permitted turn');
  // And the turn actually STARTED, so the grant is committed. A reservation that is
  // never confirmed is treated as abandoned and returned to the epoch, which is the
  // right behaviour for a caller that died before launching and the wrong one here.
  r.seam.confirmLaunch(granted);
  // That turn evidently did not succeed: the provider refused again. The epoch was
  // never cleared, so it is the SAME refusal continuing - and granting another turn
  // would be the retry storm the single-grant rule exists to prevent.
  const t2 = RESET_5H + 10_000;
  r.set(t2);
  r.tracker.ingest(obs({
    observedAt: t2, receivedAt: t2, providerReachedType: 'usage',
    // A reset still AHEAD of this refusal, so the pool can reach RECOVERING again -
    // otherwise it simply stays LIMITED and the grant logic is never reached.
    windows: [win('five_hour', 'FIVE_HOUR', 0, t2 + 3_600_000)]
  }));
  assert.equal(r.tracker.pool(POOL).state, 'LIMITED');
  r.set(t2 + 3_600_001);
  r.tracker.evaluate();
  assert.equal(r.tracker.pool(POOL).state, 'RECOVERING');
  assert.equal(r.seam.admit('dwight').reason, ADMISSION_REASON.RECOVERING_SPENT);
});

test('a CLEARED epoch followed by a fresh refusal is a new epoch, and earns its own single turn', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  r.set(RESET_5H + 1);
  r.tracker.evaluate();
  assert.equal(r.seam.admit('dwight').verdict, 'ALLOW');
  assert.equal(r.seam.admit('dwight').verdict, 'REFUSE');
  // Recovery is CONFIRMED - explicit provider permission - so the epoch ends.
  const tk = RESET_5H + 5_000;
  r.set(tk);
  r.tracker.ingest(obs({ observedAt: tk, receivedAt: tk, ordinaryUsageAllowed: true }));
  assert.equal(r.tracker.pool(POOL).state, 'AVAILABLE');
  assert.equal(r.tracker.pool(POOL).limitEpochAt, null);
  // A later refusal is then genuinely a NEW epoch.
  const t2 = tk + 60_000;
  r.set(t2);
  r.tracker.ingest(obs({ observedAt: t2, receivedAt: t2, providerReachedType: 'usage', windows: [win('five_hour', 'FIVE_HOUR', 0, t2 + 3_600_000)] }));
  r.set(t2 + 3_600_001);
  r.tracker.evaluate();
  assert.equal(r.tracker.pool(POOL).state, 'RECOVERING');
  assert.equal(r.seam.admit('dwight').verdict, 'ALLOW', 'a new epoch must earn a new single turn');
});

test('the seam never proposes another provider - a decision has no alternative field', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  const d = r.seam.admit('dwight');
  const keys = Object.keys(d).join(' ').toLowerCase();
  for (const banned of ['alternative', 'fallback', 'migrat', 'route', 'other']) {
    assert.equal(keys.includes(banned), false, `the seam must not offer "${banned}"`);
  }
});

test('the seam computes no capacity of its own - it only reads what the tracker published', () => {
  const src = require('node:fs').readFileSync('src/main/capacityAdmission.ts', 'utf8');
  for (const banned of ['remainingPercent', 'usedPercent', 'windows', 'Date.now', 'readFile', 'statSync']) {
    assert.equal(src.includes(banned), false, `the seam must not touch "${banned}"`);
  }
});
