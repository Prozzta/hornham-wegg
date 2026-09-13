'use strict';

/**
 * L0-FIX — spec-conformance fixtures for ProviderCapacityTracker.
 *
 * Written against research/notes/oscar-l0-sem.md (sha256 643D45C0…86CC), whose
 * identity was verified from disk first. Expectations cite the clause they come
 * from. Where a fixture disagrees with the implementation the fixture is not
 * "fixed" to match — the disagreement is the result.
 *
 * Independence: this file and its corpus were derived from the spec. From the
 * implementation I read ONLY the exported surface needed to drive it — the type
 * declarations in src/shared/providerCapacity.ts, and the constructor plus the
 * public method names of ProviderCapacityTracker. No classification logic was read.
 *
 * The clock is injected, so staleness, TTL boundaries and "a reset time passed"
 * are exercised without waiting and without touching wall time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const {
  T0,
  LIVE_TTL_MS,
  ATTRIBUTION_CAPABILITY,
  CORPUS,
  win,
  obs
} = require('./fixtures/capacity-corpus.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');

/**
 * A tracker whose clocks this test owns outright — BOTH of them.
 *
 * §6 converts the remaining wall TTL into a MONOTONIC deadline on acceptance, so
 * that wall-clock changes cannot make stale data healthy. That makes the two
 * clocks semantically different, and a rig that moves only the wall clock is not
 * simulating time passing — it is simulating the very anomaly the deadline
 * defends against, which is indistinguishable from it by construction.
 *
 * So ordinary time travel moves both together, and wall-only movement is a
 * separate, explicitly named operation used only where the anomaly IS the subject.
 */
function makeTracker(startAt = T0) {
  let now = startAt;
  let mono = 0; // monotonic milliseconds; never moves backwards
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return {
    tracker,
    /** Assigning a wall time advances the monotonic clock by the same delta: time passing. */
    set now(v) {
      mono += v - now;
      now = v;
    },
    get now() {
      return now;
    },
    /** Elapsed time, both clocks. */
    advance(ms) {
      now += ms;
      mono += ms;
    },
    /**
     * THE ANOMALY, named rather than implied: the wall clock moves and monotonic
     * time does not. An NTP correction or a manual clock change, never elapsed time.
     */
    setWallOnly(v) {
      now = v;
    },
    pool(key) {
      return tracker.snapshot().pools.find((p) => p.poolKey === key) ?? null;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Corpus format invariants — gap #16, enforced rather than described
// ─────────────────────────────────────────────────────────────────────────────

test('every fixture declares attribution capability and presence independently', () => {
  for (const f of CORPUS) {
    assert.ok(f.attribution, `${f.id} declares attribution`);
    assert.ok(
      ['CAPABLE', 'INCAPABLE'].includes(f.attribution.capability),
      `${f.id} capability is explicit`
    );
    assert.equal(typeof f.attribution.present, 'boolean', `${f.id} presence is explicit`);
    assert.ok(f.spec && f.catches, `${f.id} cites a clause and says what it would catch`);
  }
});

test('a source that CANNOT attribute never carries attribution', () => {
  for (const f of CORPUS) {
    if (f.attribution.capability !== 'INCAPABLE') continue;
    assert.equal(f.attribution.present, false, `${f.id}: incapable source cannot be present`);
    assert.equal(
      f.observation.providerAttributedLimitingWindowId,
      null,
      `${f.id}: incapable source names no window`
    );
    assert.equal(f.observation.providerReachedType, null, `${f.id}: incapable source has no reached type`);
  }
});

test('declared capability matches the source it came from', () => {
  for (const f of CORPUS) {
    assert.equal(
      f.attribution.capability,
      ATTRIBUTION_CAPABILITY[f.observation.source],
      `${f.id}: capability must follow the source, not the author's intent`
    );
  }
});

test('CANNOT-ATTRIBUTE and DID-NOT-ATTRIBUTE are indistinguishable in the production type, and distinct in the corpus', () => {
  const cannot = CORPUS.find((f) => f.id === 'CLAUDE-CANNOT-ATTRIBUTE');
  const didNot = CORPUS.find((f) => f.id === 'CODEX-DID-NOT-ATTRIBUTE');

  // The three production fields that carry attribution are identical...
  for (const field of ['providerAttributedLimitingWindowId', 'providerReachedType', 'ordinaryUsageAllowed']) {
    assert.deepEqual(
      cannot.observation[field],
      didNot.observation[field],
      `${field} is identical, which is exactly the ambiguity`
    );
  }
  // ...and the corpus still separates them, which is the point of gap #16.
  assert.notEqual(
    cannot.attribution.capability,
    didNot.attribution.capability,
    'the corpus distinguishes what the production observation type cannot'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Drive every corpus fixture through the tracker
// ─────────────────────────────────────────────────────────────────────────────

for (const f of CORPUS) {
  test(`${f.id} — ${f.spec}`, () => {
    const h = makeTracker(T0);
    const accepted = h.tracker.ingest(f.observation);

    if (f.expect.rejected) {
      assert.equal(accepted, false, 'an invalid observation is rejected, not absorbed');
      return;
    }

    if (f.evaluateAt !== undefined) {
      h.now = f.evaluateAt;
      h.tracker.evaluate();
    }

    const pool = h.pool(f.observation.poolKey);
    assert.ok(pool, `${f.id}: pool is published`);

    if (f.expect.state !== undefined) {
      assert.equal(pool.state, f.expect.state, `${f.id}: state — would catch: ${f.catches}`);
    }
    if (f.expect.freshness !== undefined) {
      assert.equal(pool.freshness, f.expect.freshness, `${f.id}: freshness verdict`);
    }
    if (f.expect.attributedWindowId !== undefined) {
      assert.equal(
        pool.providerAttributedLimitingWindowId,
        f.expect.attributedWindowId,
        `${f.id}: attribution is preserved exactly and never invented`
      );
    }
    if (f.expect.numericallyExhausted !== undefined) {
      assert.deepEqual(
        [...pool.numericallyExhaustedWindowIds].sort(),
        [...f.expect.numericallyExhausted].sort(),
        `${f.id}: numeric exhaustion is recorded separately from attribution`
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. §6's monotonic deadline — the defence my own rig could not see
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This case exists because of a blind spot in the first version of this file.
 * §6 states the wall-clock age formula AND the monotonic deadline in one
 * paragraph, and on a machine nobody is fiddling with the two agree exactly — so
 * a wall-clock-only rig tests the letter of one sentence and CANNOT detect a
 * missing monotonic deadline, because what it does on every step is
 * indistinguishable from the anomaly the deadline defends against.
 *
 * The dangerous direction is the one asserted here: a reading that IS genuinely
 * stale must not be resurrected by the wall clock moving backwards.
 */
test('a backwards wall-clock move does not make a genuinely stale reading healthy', () => {
  const h = makeTracker(T0);
  const key = 'codex:acct-a:limit-1';
  h.tracker.ingest(obs({ windows: [win()] }));

  // Real elapsed time: both clocks. The reading is now genuinely stale.
  h.advance(LIVE_TTL_MS + 1);
  h.tracker.evaluate();
  assert.equal(h.pool(key).freshness, 'STALE', 'precondition: the reading has genuinely expired');
  assert.equal(h.pool(key).state, 'UNKNOWN', 'precondition: stale never reads healthy');

  // Now the system clock is corrected backwards to before the reading was taken.
  // Monotonic time does not move. Under wall-clock-only freshness this reading
  // would look brand new.
  h.setWallOnly(T0 - 60_000);
  h.tracker.evaluate();

  assert.equal(
    h.pool(key).freshness,
    'STALE',
    '§6: "wall-clock changes do not make stale data healthy"'
  );
  assert.notEqual(h.pool(key).state, 'AVAILABLE', 'a clock correction must not resurrect an expired reading');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Recovery — built to CATCH, per §5. A clock must never reach AVAILABLE.
// ─────────────────────────────────────────────────────────────────────────────

test('a reset time passing with the provider disconnected yields RECOVERING and NEVER AVAILABLE', () => {
  const h = makeTracker(T0);
  const key = 'codex:acct-a:limit-1';
  const resetAt = T0 + 3_600_000;

  h.tracker.ingest(
    obs({
      providerReachedType: 'usage_limit_reached',
      windows: [win({ usedPercent: 100, remainingPercent: 0, resetsAt: resetAt })]
    })
  );
  assert.equal(h.pool(key).state, 'LIMITED', 'typed refusal opens a limit epoch');

  // The provider is gone. Time passes across the advertised reset and NOTHING ELSE
  // HAPPENS — no snapshot, no permission, no successful turn.
  h.now = resetAt + 1;
  h.tracker.evaluate();

  const after = h.pool(key);
  assert.notEqual(after.state, 'AVAILABLE', 'THE FAILURE MODE: a clock must never reach AVAILABLE');
  assert.equal(after.state, 'RECOVERING', '§5: a passed reset is a hint, never confirmation');

  // Still nothing after a long silence.
  h.now = resetAt + 86_400_000;
  h.tracker.evaluate();
  assert.equal(h.pool(key).state, 'RECOVERING', 'elapsed time alone never promotes to healthy');
});

test('staleness does not clear a limit epoch', () => {
  const h = makeTracker(T0);
  const key = 'codex:acct-a:limit-1';
  h.tracker.ingest(obs({ providerReachedType: 'usage_limit_reached', windows: [win()] }));

  h.now = T0 + LIVE_TTL_MS * 10;
  h.tracker.evaluate();
  const s = h.pool(key).state;
  assert.ok(s === 'LIMITED' || s === 'RECOVERING', `§5 sticky epoch, got ${s}`);
  assert.notEqual(s, 'UNKNOWN', 'a limit epoch outranks staleness');
  assert.notEqual(s, 'AVAILABLE', 'stale data never reads healthy');
});

test('a successful real turn without a fresh snapshot does not yield AVAILABLE', () => {
  const h = makeTracker(T0);
  const key = 'codex:acct-a:limit-1';
  h.tracker.ingest(obs({ providerReachedType: 'usage_limit_reached', windows: [win()] }));

  h.now = T0 + LIVE_TTL_MS + 1;
  h.tracker.noteSuccessfulTurn(key, h.now);
  h.tracker.evaluate();

  assert.notEqual(
    h.pool(key).state,
    'AVAILABLE',
    '§5: confirmation proves recovery from the old refusal, not current headroom'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. §7 ordering, duplicates, revisions
// ─────────────────────────────────────────────────────────────────────────────

test('an out-of-order reading cannot overwrite a newer typed refusal', () => {
  const h = makeTracker(T0);
  const key = 'codex:acct-a:limit-1';

  h.tracker.ingest(
    obs({ observedAt: T0 + 1_000, receivedAt: T0 + 1_000, providerReachedType: 'usage_limit_reached', windows: [win()] })
  );
  assert.equal(h.pool(key).state, 'LIMITED');

  const changed = h.tracker.ingest(obs({ observedAt: T0, receivedAt: T0, windows: [win()] }));
  assert.equal(changed, false, '§7: a lower ordering key is ignored');
  assert.equal(h.pool(key).state, 'LIMITED', 'a late stale snapshot never clears a newer refusal');
});

test('an exact duplicate is a no-op and does not move the revision', () => {
  const h = makeTracker(T0);
  const key = 'codex:acct-a:limit-1';
  const reading = obs({ windows: [win()] });

  h.tracker.ingest(reading);
  const first = h.pool(key).revision;
  const collectionFirst = h.tracker.snapshot().collectionRevision;

  const changed = h.tracker.ingest({ ...reading, windows: [win()] });
  assert.equal(changed, false, '§7: identical key and fingerprint is a duplicate');
  assert.equal(h.pool(key).revision, first, 'a duplicate does not increment poolRevision');
  assert.equal(
    h.tracker.snapshot().collectionRevision,
    collectionFirst,
    '§7: a no-op increments neither revision'
  );
});

test('§11 five serial one-pool ingests are FIVE transactions, so the collection advances five times', () => {
  // RENAMED, AND THE OLD NAME WAS QUOTING A SUPERSEDED CLAUSE. It read "one transaction
  // over several pools increments the collection once, not once per pool", which is §7
  // line 141 — and §11 line 210 supersedes it for L0: "The current tracker exposes no
  // batch-ingest API. Each accepted one-pool ingest is its own atomic transaction;
  // therefore five serial pool ingests increment collectionRevision five times. This is
  // an accepted L0 scope boundary, not a semantic defect." §11 line 214 then replaces
  // §10's "five-pool atomic collection update" fixture with exactly this shape.
  //
  // SO THE NAME PROMISED A SCENARIO NOTHING CAN BUILD — there is no multi-pool
  // transaction on the public surface, only ingest and ingestDetailed, one observation
  // each — AND IT NAMED THE OPPOSITE OF THE RULING EXPECTATION. Had I "fixed" the body
  // to match the old name it would have gone red against an accepted scope boundary.
  //
  // The invariant that IS real here is per-ingest and it is the same one §15 line 276
  // states: one accepted ingest is one publication. Asserted below as two separate
  // clauses so a frozen revision and a multiplying one fail on different messages.
  const h = makeTracker(T0);
  const first = h.tracker.snapshot().collectionRevision;

  for (let i = 0; i < 5; i += 1) {
    const before = h.tracker.snapshot().collectionRevision;
    const poolKey = `codex:acct-${i}:limit-1`;
    const accepted = h.tracker.ingest(
      obs({
        poolKey,
        accountScope: `acct-${i}`,
        windows: [win()]
      })
    );
    assert.ok(accepted, `ingest ${i} was accepted`);
    const after = h.tracker.snapshot().collectionRevision;
    assert.ok(after > before, `§11: accepted ingest ${i} is a publication, so it ADVANCES the collection`);
    assert.equal(
      after - before,
      1,
      `§15: accepted ingest ${i} is ONE publication and must not MULTIPLY the revision, ` +
        `advanced by ${after - before}`
    );
    // Replaces a `typeof p.revision === 'number'` check that asserted nothing — it
    // passed against an implementation whose every revision stayed 0 forever.
    assert.ok(
      h.pool(poolKey).revision > 0,
      `${poolKey} carries its OWN revision and it has moved, not merely exists`
    );
  }

  const snap = h.tracker.snapshot();
  assert.equal(snap.pools.length, 5, 'five distinct pools, keyed by account scope');
  assert.equal(
    snap.collectionRevision - first,
    5,
    '§11: five serial ingests are five transactions, so five increments — the accepted L0 ' +
      'scope boundary, NOT the superseded "once, not five times"'
  );
});

test('two accounts of one provider never merge into one pool', () => {
  const h = makeTracker(T0);
  h.tracker.ingest(obs({ poolKey: 'codex:acct-a:limit-1', accountScope: 'acct-a', windows: [win()] }));
  h.tracker.ingest(obs({ poolKey: 'codex:acct-b:limit-1', accountScope: 'acct-b', windows: [win()] }));

  assert.equal(
    h.tracker.snapshot().pools.length,
    2,
    '§1: a pool is keyed by provider + account scope + limitId, or the UI understates consumption'
  );
});
