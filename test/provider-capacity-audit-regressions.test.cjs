'use strict';

/**
 * L0-REGR — the five adversarial counterexamples Dwight EXECUTED, pinned.
 *
 * EXPECTED RED AT THE COMMIT THAT INTRODUCES THIS FILE. Every test here asserts a
 * property the audit proved absent, so a green run of this file is the fix landing,
 * not the tests being right. Declared rather than discovered, the way Jim declared
 * his three reds.
 *
 * Provenance: research commit 5d0a4070, notes/dwight-l0-audit-criteria.md, §10.5
 * (notification counterexamples) and §10.6 (admission and timer reality). Written
 * from the AUDIT TRACES, not from the implementation and not from any fix. From the
 * implementation I read only the driving surface: the type declarations in
 * src/shared/providerCapacity.ts, the public method names of ProviderCapacityTracker
 * (ingest, evaluate, noteSuccessfulTurn, snapshot, pool, forget), and the exported
 * intent type plus the hydrate/observe signatures of CapacityNotifier. No identity
 * construction, projection or revision logic was read.
 *
 * A SEPARATE FILE FROM THE SPEC-CONFORMANCE SUITE, DELIBERATELY. That file is 27/27
 * green and its greenness is a reported signal; knowingly-red tests living in it
 * would make both numbers meaningless. A file expected green and a file expected red
 * must not be the same file.
 *
 * EVERY TRACE IS DRIVEN THROUGH THE REAL TRACKER rather than through hand-built
 * snapshots. A hand-built snapshot proves a defect is CONSTRUCTIBLE; an ingested one
 * proves it is REACHABLE. The difference is the whole value of a regression pin.
 *
 * Each test asserts the OBSERVABLE PROPERTY, never a fix shape — the implementation
 * is Jim's on L0-DEF3 and this file must not prescribe it. Where more than one fix
 * would satisfy the contract, the assertion is written so that all of them pass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { T0, win, obs } = require('./fixtures/capacity-corpus.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityNotifier } = loadTs('src/main/capacityNotify.ts');

const KEY = 'codex:acct-a:limit-1';

/** Both clocks move together: elapsed time, never the wall-clock anomaly. */
function rig(startAt = T0) {
  let now = startAt;
  let mono = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return {
    tracker,
    advance(ms) {
      now += ms;
      mono += ms;
    },
    get now() {
      return now;
    },
    pool() {
      return tracker.pool(KEY);
    }
  };
}

/** An ordinary healthy reading, observed right now. */
const healthy = (h) => obs({ observedAt: h.now, receivedAt: h.now, windows: [win()] });

/** A typed provider refusal: hard evidence, so it opens a limit epoch. */
const refusal = (h) =>
  obs({
    observedAt: h.now,
    receivedAt: h.now,
    providerReachedType: 'usage_limit_reached',
    providerAttributedLimitingWindowId: 'w5h',
    windows: [win({ usedPercent: 100, remainingPercent: 0, resetsAt: h.now + 3_600_000 })]
  });

/** A window spent to zero with NO attribution — observational exhaustion, not a refusal. */
const spent = (h) =>
  obs({ observedAt: h.now, receivedAt: h.now, windows: [win({ usedPercent: 100, remainingPercent: 0 })] });

/**
 * One complete, genuine refusal-to-recovery cycle, collecting what the notifier said
 * at each step. Returns the epoch so a caller can PROVE the second cycle was a
 * different refusal and not a repeat of the first.
 */
function refusalCycle(h, notifier) {
  const intents = [];
  h.advance(1_000);
  h.tracker.ingest(refusal(h));
  const epoch = h.pool().limitEpochAt;
  intents.push(...notifier.observe(h.tracker.snapshot(), h.now));

  h.advance(3_600_001); // past the advertised reset
  h.tracker.evaluate();
  intents.push(...notifier.observe(h.tracker.snapshot(), h.now));

  h.tracker.ingest(healthy(h));
  h.tracker.noteSuccessfulTurn(KEY, h.now);
  h.tracker.evaluate();
  intents.push(...notifier.observe(h.tracker.snapshot(), h.now));

  return { epoch, intents, endState: h.pool().state };
}

const kinds = (intents, kind) => intents.filter((i) => i.kind === kind);

// ---------------------------------------------------------------------------
// §10.5 — notification identity loses genuine later events
// ---------------------------------------------------------------------------

test('REGR-1 §10.5: a SECOND genuine recovery still notifies', () => {
  const h = rig();
  const notifier = new CapacityNotifier();
  h.tracker.ingest(healthy(h));
  notifier.hydrate(h.tracker.snapshot());

  const first = refusalCycle(h, notifier);
  const second = refusalCycle(h, notifier);

  // PRECONDITIONS. Without these the test could go green because the second refusal
  // never happened, which is a broken rig reading as a passing fix.
  assert.ok(first.epoch !== null, 'precondition: cycle 1 opened a limit epoch');
  assert.ok(second.epoch !== null, 'precondition: cycle 2 opened a limit epoch');
  assert.notEqual(second.epoch, first.epoch, 'precondition: TWO DISTINCT refusals, not one repeated');
  assert.equal(first.endState, 'AVAILABLE', 'precondition: cycle 1 genuinely recovered');
  assert.equal(second.endState, 'AVAILABLE', 'precondition: cycle 2 genuinely recovered');

  const r1 = kinds(first.intents, 'RECOVERED');
  const r2 = kinds(second.intents, 'RECOVERED');
  assert.equal(r1.length, 1, 'cycle 1 reports its recovery');
  assert.equal(
    r2.length,
    1,
    'THE DEFECT: the second genuine recovery is silent. Confirmed recovery clears ' +
      'limitEpochAt, so both intents are identified as "…|RECOVERED|none" and the ' +
      'second is swallowed as a duplicate.'
  );
  assert.notEqual(
    r2[0] && r2[0].identity,
    r1[0] && r1[0].identity,
    'PoolCapacitySnapshot.limitEpochAt exists so two consumers can "tell ONE refusal ' +
      'from a later one" — two refusals must not share one recovery identity'
  );
});

test('REGR-2 §10.5: a SECOND genuine reserve transition still notifies', () => {
  const h = rig();
  const notifier = new CapacityNotifier();
  h.tracker.ingest(healthy(h));
  notifier.hydrate(h.tracker.snapshot());

  const rounds = [];
  for (let i = 0; i < 2; i++) {
    h.advance(1_000);
    h.tracker.ingest(spent(h));
    const atSpend = h.pool().state;
    const emitted = notifier.observe(h.tracker.snapshot(), h.now);
    h.advance(1_000);
    h.tracker.ingest(healthy(h));
    notifier.observe(h.tracker.snapshot(), h.now);
    rounds.push({ atSpend, backTo: h.pool().state, emitted });
  }

  // PRECONDITIONS: both transitions genuinely happened, and the pool genuinely left
  // RESERVE_ONLY in between, so round 2 is a real second crossing.
  for (const [i, r] of rounds.entries()) {
    assert.equal(r.atSpend, 'RESERVE_ONLY', `precondition: round ${i + 1} genuinely reached RESERVE_ONLY`);
    assert.notEqual(r.backTo, 'RESERVE_ONLY', `precondition: round ${i + 1} genuinely left RESERVE_ONLY`);
  }

  const first = kinds(rounds[0].emitted, 'RESERVE_REACHED');
  const secondRound = kinds(rounds[1].emitted, 'RESERVE_REACHED');
  assert.equal(first.length, 1, 'round 1 reports the reserve crossing');
  assert.equal(
    secondRound.length,
    1,
    'THE DEFECT: the second genuine reserve crossing is silent. A reserve transition ' +
      'happens outside a refusal, so both are identified as "…|RESERVE_REACHED|none".'
  );
  assert.notEqual(
    secondRound[0] && secondRound[0].identity,
    first[0] && first[0].identity,
    'two separate crossings are two events, and must not share one identity'
  );
});

test('REGR-3 §10.5: replaying an OLDER complete collection notifies nothing and consumes no identity', () => {
  const h = rig();
  const notifier = new CapacityNotifier();
  h.tracker.ingest(healthy(h));

  // structuredClone is REQUIRED here, and the reason is itself a finding: snapshot()
  // hands back live internal references (REGR-4), so without a deep copy "the older
  // collection" would silently become the newer one and this replay would not be a
  // replay at all. The clone keeps the test honest whether or not REGR-4 is fixed.
  const older = structuredClone(h.tracker.snapshot());
  notifier.hydrate(older);

  h.advance(1_000);
  h.tracker.ingest(refusal(h));
  const newer = structuredClone(h.tracker.snapshot());
  const onLimit = notifier.observe(newer, h.now);

  assert.ok(newer.collectionRevision > older.collectionRevision, 'precondition: newer really is newer');
  assert.equal(older.pools[0].state, 'AVAILABLE', 'precondition: the older collection reads healthy');
  assert.equal(newer.pools[0].state, 'LIMITED', 'precondition: the newer collection reads refused');
  assert.equal(kinds(onLimit, 'LIMIT_REACHED').length, 1, 'precondition: the refusal was reported once');

  const onReplay = notifier.observe(older, h.now);
  assert.deepEqual(
    onReplay.map((i) => i.kind),
    [],
    'THE DEFECT: a stale collection arriving late emits a FALSE RECOVERED. The ' +
      'notifier keeps no last-seen collectionRevision, so equal, lower and ' +
      'out-of-order collections are all accepted as news.'
  );

  // The second half of the defect: the false intent ALSO burned the identity the real
  // recovery would have needed. Complete the genuine recovery of this same epoch and
  // require it to be reported.
  h.advance(3_600_001);
  h.tracker.evaluate();
  notifier.observe(structuredClone(h.tracker.snapshot()), h.now);
  h.tracker.ingest(healthy(h));
  h.tracker.noteSuccessfulTurn(KEY, h.now);
  h.tracker.evaluate();
  const genuine = notifier.observe(structuredClone(h.tracker.snapshot()), h.now);

  assert.equal(h.pool().state, 'AVAILABLE', 'precondition: the pool genuinely recovered');
  assert.equal(
    kinds(genuine, 'RECOVERED').length,
    1,
    'a replayed collection must not consume the identity a later REAL recovery needs'
  );
});

// ---------------------------------------------------------------------------
// §10.4 A10 — authoritative state and revision integrity
// ---------------------------------------------------------------------------

test('REGR-4 A10: a consumer cannot mutate authoritative state through a returned snapshot', () => {
  const h = rig();
  h.tracker.ingest(healthy(h));

  const handed = h.tracker.snapshot();
  const before = {
    state: h.tracker.pool(KEY).state,
    remaining: h.tracker.pool(KEY).windows[0].remainingPercent,
    collectionRevision: handed.collectionRevision,
    poolRevision: handed.pools[0].revision
  };
  assert.equal(before.state, 'AVAILABLE', 'precondition: the pool starts healthy');

  // A hostile-but-ordinary consumer. Wrapped because FREEZING the projection is a
  // legitimate fix and would throw here under strict mode — the assertion below is
  // about the tracker's state, not about whether the assignment succeeded, so either
  // fix (copy or freeze) passes and neither is prescribed.
  try {
    handed.pools[0].state = 'LIMITED';
    handed.pools[0].windows[0].remainingPercent = -999;
  } catch {
    /* frozen projection: the mutation was refused, which is one valid outcome */
  }

  const after = h.tracker.snapshot();
  assert.equal(
    h.tracker.pool(KEY).state,
    before.state,
    'THE DEFECT: snapshot() returns the tracker\'s own pool objects, so a caller ' +
      'rewrote authoritative state — and the tracker\'s own accessor now reports it.'
  );
  assert.equal(after.pools[0].state, before.state, 'the next snapshot must not carry a caller\'s edit');
  assert.equal(
    after.pools[0].windows[0].remainingPercent,
    before.remaining,
    'window contents are authoritative state too, and the windows array is shared by reference'
  );
  // Whichever way it is fixed, the revision must stay put: nothing legitimate happened.
  assert.equal(after.collectionRevision, before.collectionRevision, 'no real change, so no collection revision');
  assert.equal(after.pools[0].revision, before.poolRevision, 'no real change, so no pool revision');
});

test('REGR-5 A10: removing and re-adding a pool never rolls its revision BACKWARD', () => {
  const h = rig();
  h.tracker.ingest(healthy(h));
  for (let i = 0; i < 4; i++) {
    h.advance(1_000);
    h.tracker.ingest(
      obs({ observedAt: h.now, receivedAt: h.now, windows: [win({ usedPercent: 20 + i, remainingPercent: 80 - i })] })
    );
  }

  const before = h.tracker.pool(KEY).revision;
  assert.ok(before > 1, 'precondition: the pool has a revision history worth losing');

  assert.equal(h.tracker.forget(KEY), true, 'precondition: the pool was actually removed');
  assert.equal(h.tracker.pool(KEY), null, 'precondition: and is gone');

  h.advance(1_000);
  h.tracker.ingest(healthy(h));
  const after = h.tracker.pool(KEY).revision;

  assert.ok(
    after >= before,
    `THE ORIGINAL DEFECT: pool revision rolled BACKWARD, ${before} -> ${after}. A ` +
      'consumer that diffs by per-pool revision — the stated purpose of the field — ' +
      'sees a lower number for the same poolKey and treats fresh state as stale.'
  );
  // TIGHTENED after the design owner ruled, which the red version deliberately left
  // open. L0-SEM §"Per-pool revision" (Oscar 1bd4fd19): poolRevision is "a monotonic
  // integer local to stable poolId" and increments on any domain-semantic change
  // INCLUDING MEMBERSHIP. Remove is one membership change and re-add is another, and
  // because the counter belongs to the STABLE identity rather than to the current
  // membership record, a reappearance must move it FORWARD.
  //
  // The weaker >= above is kept, because it names the audit finding and the stronger
  // claim would report a different failure. But >= ALONE IS NOT A PIN: it passes a
  // retained floor that has stopped incrementing (3 -> 3), which is a plausible
  // regression of the very fix it is meant to protect. AN ASSERTION THAT CANNOT
  // DISTINGUISH THE FIXED STATE FROM A PLAUSIBLE REGRESSION IS NOT PROTECTING
  // ANYTHING.
  assert.ok(
    after > before,
    `revision did not advance across remove + re-add, ${before} -> ${after}. A stalled ` +
      'floor is not a monotonic counter: membership changed twice and the consumer ' +
      'that diffs by revision saw neither.'
  );
});
