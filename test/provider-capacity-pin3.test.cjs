'use strict';

/**
 * L0-FIX5 — the four counterexamples Dwight demonstrated at pin 3 (`f66b4f12`),
 * research `0b3df272`, notes/dwight-l0-audit-criteria.md section 12.3.
 *
 * Each one is reproduced here as the audit ran it, and each sits beside the pair
 * that proves the repair did not simply switch the capability off. That pairing is
 * not decoration: three of the four defects are "a bound that does not bind", and
 * every one of those is satisfied by an implementation that retains nothing, admits
 * nothing, or refuses everything.
 *
 * THE FOURTH (12.3 #4, the renderer path that probed and never reserved) IS NO LONGER
 * HERE. Its eight tests drove the delivery-ticket door, which was deleted together with
 * them at L0-FUSION stage 5.5; what each one held, and what holds it now, is recorded
 * row by row in test/l0-fusion-stage5-successor-mapping.md (rows 20-27).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS } =
  loadTs('src/main/providerCapacityTracker.ts');
const { admissionEnvelopeOf } = loadTs('src/main/capacityEnvelope.ts');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct-a:codex';
const RESET_5H = T0 + 3_600_000;

const win = (id, remaining, resetsAt = RESET_5H) => ({
  windowId: id, kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining, resetsAt
});

const obs = (over = {}) => ({
  poolKey: POOL, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s/a.jsonl', sourceSequence: 1,
  observedAt: T0, receivedAt: T0, windows: [win('five_hour', 80)],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

function tracker(start = T0) {
  let now = start;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return { t, set: (v) => { mono += Math.max(0, v - now); now = v; } };
}

// ═══════════════════════════════════════════════════════════════════════════
// 12.3 #1 — the published overflow marker was a live mutable reference
// ═══════════════════════════════════════════════════════════════════════════

/** Arm the marker: 32 pools, then a 33rd that states a typed hard limit. */
function armedMarker() {
  const { t } = tracker();
  for (let i = 0; i < RETENTION_CAPS.maxPools; i += 1) {
    t.ingest(obs({ poolKey: `codex:acct-${i}:codex`, accountScope: `acct-${i}` }));
  }
  t.ingest(obs({
    poolKey: 'codex:zzexcess:codex', accountScope: 'zzexcess',
    providerReachedType: 'rate_limit_reached'
  }));
  return t;
}

test('PIN3/1: the published marker cannot be neutralized through EITHER accessor', () => {
  const t = armedMarker();
  assert.equal(t.collectionAdmission(), 'LIMITED', 'the fact is live to begin with');
  const before = t.snapshot().collectionRevision;

  // The audit's move: take the marker from `snapshot()` and delete the safety
  // fields. Frozen, this either throws (strict mode) or silently no-ops; the
  // assertion is on the PROPERTY, not on which of those the runtime picks, because
  // either one is a correct implementation of "this cannot be edited".
  const marker = t.snapshot().overflow;
  try { delete marker.admission; } catch { /* frozen, as intended */ }
  try { marker.admission = null; } catch { /* frozen, as intended */ }
  try { marker.hardLimitObserved = false; } catch { /* frozen, as intended */ }

  assert.equal(t.collectionAdmission(), 'LIMITED', 'no tracker operation happened, so nothing changed');
  assert.equal(t.snapshot().overflow.admission, 'LIMITED', 'and the other accessor agrees');
  assert.equal(t.snapshot().collectionRevision, before, 'a revision cannot have moved either');
});

test('PIN3/1: freezing at publication closes the accessor the audit did NOT use', () => {
  // The reason freezing beats copying-on-read: `collectionAdmission()` hands out the
  // same object, so a per-accessor copy would have left this route open.
  const t = armedMarker();
  const viaAdmission = t.snapshot().overflow;
  assert.equal(Object.isFrozen(viaAdmission), true);
  try { viaAdmission.completeness = 'COMPLETE'; } catch { /* expected */ }
  assert.equal(t.snapshot().overflow.completeness, 'UNKNOWN');
});

test('PIN3/1: and REAL evidence still clears it — the marker is frozen, not permanent', () => {
  // The other half. "Cannot be changed by a caller" is trivially satisfied by a
  // marker nothing can ever clear, which would be a different defect.
  const t = armedMarker();
  assert.equal(t.collectionAdmission(), 'LIMITED');
  assert.equal(t.noteCompleteInventory(['codex:acct-0:codex']), true, 'an authoritative inventory clears it');
  assert.equal(t.collectionAdmission(), null);
  assert.equal(t.snapshot().overflow, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 12.3 #2 — the collection cap did not bound the serialized collection
// ═══════════════════════════════════════════════════════════════════════════

/** An observation padded to EXACTLY `bytes` serialized bytes. */
function sizedTo(poolKey, scope, bytes) {
  const o = obs({ poolKey, accountScope: scope });
  o.windows[0].label = 'x';
  while (JSON.stringify(o).length < bytes) {
    const short = bytes - JSON.stringify(o).length;
    o.windows[0].label += 'x'.repeat(Math.max(1, short));
  }
  while (JSON.stringify(o).length > bytes) o.windows[0].label = o.windows[0].label.slice(0, -1);
  assert.equal(JSON.stringify(o).length, bytes, 'the fixture must be exactly the size it claims');
  return o;
}

test('PIN3/2: 32 individually legal maximal readings cannot publish over the cap', () => {
  // THE COUNTEREXAMPLE VERBATIM. Thirty-two observations of exactly 8,192 bytes sum
  // to exactly maxCollectionBytes and previously published 267,460 serialized bytes,
  // because the check summed only the OTHER pools' projectionBytes — the arriving
  // pool was never charged, and a sum of per-pool figures does not contain the
  // wrapper or the punctuation between 32 array elements.
  const { t } = tracker();
  let inputBytes = 0;
  for (let i = 0; i < RETENTION_CAPS.maxPools; i += 1) {
    const o = sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes);
    inputBytes += JSON.stringify(o).length;
    t.ingest(o);
  }
  assert.equal(inputBytes, RETENTION_CAPS.maxCollectionBytes, 'the inputs sum to exactly the cap');

  // MEASURED ON THE RETAINED REPRESENTATION, which is the whole repair. Asserting a
  // sum here would re-commit the defect inside its own regression test.
  const published = JSON.stringify(t.snapshot()).length;
  assert.ok(
    published <= RETENTION_CAPS.maxCollectionBytes,
    `the published collection serialized to ${published}, cap ${RETENTION_CAPS.maxCollectionBytes}`
  );
});

test('PIN3/2: the cap binds the ARRIVING pool and leaves the admitted ones alone', () => {
  const { t } = tracker();
  for (let i = 0; i < RETENTION_CAPS.maxPools; i += 1) {
    t.ingest(sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes));
  }
  const snap = t.snapshot();
  assert.equal(snap.pools.length, RETENTION_CAPS.maxPools, 'no pool is dropped: identity is cheap');

  // Exactly the late arrivals are bounded; everything admitted before the collection
  // filled keeps the reading it was admitted with, at full size.
  const bounded = snap.pools.filter((p) => p.state === 'UNKNOWN');
  assert.ok(bounded.length >= 1, 'a collection that cannot fit must report that it cannot');
  assert.ok(bounded.length < RETENTION_CAPS.maxPools, 'but it does not blank the whole collection');
  for (const p of snap.pools.filter((x) => x.state !== 'UNKNOWN')) {
    assert.ok(p.windows.length > 0, `${p.poolKey} kept its reading`);
  }
});

test('PIN3/2: a collection with room retains every reading AT FULL SIZE', () => {
  // The pair. "Never exceeds the cap" is trivially true of a tracker that bounds
  // everything, so the budget has to be shown being SPENT, not only respected.
  const { t } = tracker();
  for (let i = 0; i < 8; i += 1) {
    t.ingest(sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes));
  }
  const snap = t.snapshot();
  assert.equal(snap.pools.filter((p) => p.state === 'UNKNOWN').length, 0, 'nothing is bounded early');
  for (const p of snap.pools) assert.equal(p.windows.length, 1, 'each pool kept its window');
  assert.ok(
    JSON.stringify(snap).length > RETENTION_CAPS.maxPoolBytes * 8,
    'and the retained bytes really are there — the fixtures were not silently shrunk'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 12.3 #3 — the "constant-size" envelope copied accountScope unbounded
// ═══════════════════════════════════════════════════════════════════════════

test('PIN3/3: a 20,000-character scope does not produce a 20,143-byte envelope', () => {
  const huge = 'a'.repeat(20_000);
  const e = admissionEnvelopeOf(obs({ accountScope: huge, providerReachedType: 'rate_limit_reached' }));
  assert.notEqual(e, null, 'the refusal is real and still survives');
  const size = JSON.stringify(e).length;
  assert.ok(size < 512, `envelope was ${size} bytes`);
  assert.equal(JSON.stringify(e).includes(huge), false, 'the unbounded value is not in it');
  assert.equal(e.accountScope, null, 'an identity this parser cannot validate is not an identity');
  assert.equal(e.hardLimit, 'TYPED_REACHED', 'and the fact it exists to carry is untouched');
});

test('PIN3/3: a normal scope IS carried — the bound validates, it does not blank', () => {
  const e = admissionEnvelopeOf(obs({ accountScope: 'a1b2c3d4e5f6', providerReachedType: 'rate_limit_reached' }));
  assert.equal(e.accountScope, 'a1b2c3d4e5f6');
});

test('PIN3/3: the scope is never TRUNCATED to fit, because a shortened id is another id', () => {
  const e = admissionEnvelopeOf(obs({ accountScope: 'b'.repeat(200), providerReachedType: 'rate_limit_reached' }));
  assert.equal(e.accountScope, null, 'rejected outright');
  assert.equal(JSON.stringify(e).includes('bb'), false, 'no prefix of it survives to collide with a real scope');
});

test('PIN3/3: the attributed window id is bounded too, even when it is admitted', () => {
  // Dwight named only accountScope. The window id is the other variable-width field
  // and it was bounded solely by whatever payload had admitted it, which is the same
  // "a property that holds because of what callers pass" argument one field over.
  const huge = 'w'.repeat(5_000);
  const e = admissionEnvelopeOf(
    obs({ providerReachedType: 'rate_limit_reached', providerAttributedLimitingWindowId: huge }),
    [huge]
  );
  assert.equal(e.windowId, null, 'admitted is not the same as bounded');
  assert.ok(JSON.stringify(e).length < 512);

  const ok = admissionEnvelopeOf(
    obs({ providerReachedType: 'rate_limit_reached', providerAttributedLimitingWindowId: 'seven_day' }),
    ['seven_day']
  );
  assert.equal(ok.windowId, 'seven_day', 'a bounded, admitted identity still comes through');
});

test('PIN3/3: every variable-width field pushed at once stays constant-size', () => {
  const e = admissionEnvelopeOf(
    obs({
      accountScope: 'a'.repeat(9_000),
      providerAttributedLimitingWindowId: 'w'.repeat(9_000),
      providerReachedType: 'workspace_owner_credits_depleted'
    }),
    ['w'.repeat(9_000)]
  );
  assert.ok(JSON.stringify(e).length < 512, 'there is nowhere for unbounded data to go, measured');
  assert.equal(e.hardLimit, 'TYPED_REACHED');
});
