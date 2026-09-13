'use strict';

/**
 * L0-VAL — L0-SEM §8 "Numeric overhead budget", the rows nothing was checking.
 *
 * WHY THIS FILE EXISTS, AND HOW ITS CONTENTS WERE CHOSEN. Not by reading §8 and
 * guessing which rows looked thin: by MUTATION. Each defence in the capacity surface
 * was removed or altered in an isolated worktree and all nine capacity suites rerun.
 * A defence whose removal leaves 171 of 171 green is a defence nothing checks — "a
 * test that would still pass if the thing it names were removed". Of 25 mutants 18
 * were killed and 7 survived; of those 7, six were genuine gaps and every one was a
 * §8 budget row, which is what this file closes. Five of the six are closed here; the
 * sixth cannot be closed by a fixture and is recorded in the arithmetic tripwire below.
 *
 * Each surviving mutant was then probed for EQUIVALENCE before being believed. A
 * mutation that changes no observable behaviour survives for a reason that has
 * nothing to do with coverage, and in a mutation score the two are indistinguishable
 * and mean opposite things. One survivor was exactly that and is deliberately NOT
 * pinned here: the UNKNOWN-applicability guard inside `allWindowsPositive` is
 * unreachable, because `deriveState` already returns UNKNOWN for the same input —
 * and that earlier guard IS killed. Redundant defence in depth is not a coverage gap.
 *
 * Every assertion below was verified against the implementation before being written,
 * and where a boundary is claimed BOTH SIDES of it are asserted. A cap test that only
 * shows the over-cap case passes just as well against an implementation that answers
 * UNKNOWN to everything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { T0, win, obs } = require('./fixtures/capacity-corpus.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS } = loadTs('src/main/providerCapacityTracker.ts');
const { CodexRolloutCapacitySource } = loadTs('src/main/codexRolloutCapacity.ts');

const tracker = () => {
  let now = T0;
  let mono = 0;
  return new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
};

/** An observation for `key`, padded so its SERIALIZED size lands on `bytes`. */
function sizedTo(key, scope, bytes) {
  let pad = 0;
  for (let guard = 0; guard < 64; guard++) {
    const o = obs({
      poolKey: key, accountScope: scope, observedAt: T0, receivedAt: T0,
      windows: [win()], planType: 'z'.repeat(pad)
    });
    const n = JSON.stringify(o).length;
    if (n === bytes) return o;
    if (n > bytes) throw new Error(`cannot size below ${n} bytes`);
    pad += bytes - n;
  }
  throw new Error('sizing did not converge');
}

const poolOf = (t, key) => t.pool(key);

// ---------------------------------------------------------------------------
// §8 retained domain state — "max 32 pools, 16 windows/pool, 8 KiB normalized per
// pool, 256 KiB serialized collection", and line 172: a breach makes the pool
// UNKNOWN and "must not silently discard an applicable window and remain healthy".
// ---------------------------------------------------------------------------

test('§8 PER-POOL BYTES: 8 KiB exactly is accepted and one byte more is UNKNOWN, never healthy', () => {
  assert.equal(RETENTION_CAPS.maxPoolBytes, 8 * 1024, '§8 says 8 KiB normalized per pool');
  const key = 'codex:acct-a:limit-1';

  // AT the cap: accepted. Asserted first, because without it the over-cap assertion
  // below is satisfied by an implementation that calls everything UNKNOWN.
  const atCap = tracker();
  atCap.ingest(sizedTo(key, 'acct-a', RETENTION_CAPS.maxPoolBytes));
  assert.equal(poolOf(atCap, key).state, 'AVAILABLE', 'a reading exactly at the cap is within budget');

  // ONE BYTE OVER: UNKNOWN. This is the case the mutation campaign proved unchecked —
  // deleting the per-pool byte check left all nine capacity suites green while an
  // over-budget reading reported AVAILABLE/FRESH_READING.
  const over = tracker();
  over.ingest(sizedTo(key, 'acct-a', RETENTION_CAPS.maxPoolBytes + 1));
  const p = poolOf(over, key);
  assert.equal(p.state, 'UNKNOWN', '§8 line 172: a cap breach makes the pool UNKNOWN');
  assert.notEqual(p.state, 'AVAILABLE', 'THE FAILURE MODE: an over-budget reading reading healthy');
  assert.equal(p.stateReason, 'RETENTION_CAP_EXCEEDED', 'and says why, once');
});

test('§8 POOL COUNT: the 32nd pool is healthy, and the 33rd leaves ONE MARKER AND NO IDENTITY', () => {
  assert.equal(RETENTION_CAPS.maxPools, 32, '§8 says max 32 pools');
  const t = tracker();
  const key = (i) => `codex:acct-${i}:limit-1`;
  const small = (i) => obs({ poolKey: key(i), accountScope: `acct-${i}`, observedAt: T0, receivedAt: T0, windows: [win()] });

  for (let i = 0; i < RETENTION_CAPS.maxPools; i++) t.ingest(small(i));
  // BOTH SIDES. Raising the cap to any larger number leaves the over-cap assertion
  // satisfied, so the 32nd pool being healthy is what pins the number itself.
  assert.equal(t.snapshot().pools.length, RETENTION_CAPS.maxPools, 'all 32 retained');
  assert.equal(poolOf(t, key(RETENTION_CAPS.maxPools - 1)).state, 'AVAILABLE', 'the 32nd pool is within budget');
  // And the marker must be ABSENT here, because "exactly one marker after the breach"
  // is trivially satisfied by an implementation that never produces one at all.
  assert.equal(t.snapshot().overflow, null, 'no breach yet, so no overflow marker');

  t.ingest(small(RETENTION_CAPS.maxPools));
  const after = t.snapshot();

  // RETARGETED to L0-SEM §13 (Oscar, research b408e69), which resolved a question this
  // file previously left open. The earlier version asserted the 33rd pool was RETAINED,
  // "so the breach is visible" - the visibility half of §8 line 172, and correct as far
  // as it went. §13 rules that for the COUNT cap the breach IS the count, so retaining a
  // 33rd entry is itself the violation: visibility MOVES to one fixed non-pool marker
  // instead. The property survives; what carries it changed.
  assert.equal(after.pools.length, RETENTION_CAPS.maxPools, 'the 33rd pool is NOT retained');
  assert.equal(poolOf(t, key(RETENTION_CAPS.maxPools)), null, 'and has no retained identity');
  // Asserted against the SERIALIZED collection rather than against the fields I thought
  // to check: an identity that survives somewhere I did not look is exactly the leak the
  // cap forbids, and a field-by-field check only proves the fields I remembered.
  assert.ok(
    !JSON.stringify(after).includes(`acct-${RETENTION_CAPS.maxPools}`),
    'no trace of the excess pool anywhere in the published collection'
  );

  assert.deepEqual(
    after.overflow,
    { kind: 'POOL_COUNT_EXCEEDED', completeness: 'UNKNOWN', excess: 'ONE_OR_MORE' },
    '§13: ONE fixed marker, carrying no identity and no count'
  );
  // NOT A COUNT, and not assertable as one: under a one-pool ingest API you cannot tell
  // a 34th NEW pool from a repeat of the 33rd without retaining the identities the cap
  // refuses to retain, so a counter would itself be unbounded. A test asserting k=2
  // would assert something the system cannot honestly know.
  assert.equal(after.overflow.excess, 'ONE_OR_MORE', 'the excess is a bounded fact, never a number');

  assert.equal(
    poolOf(t, key(0)).state,
    'AVAILABLE',
    'and the pools already inside budget keep their own valid states'
  );
});

test('§8 WINDOWS PER POOL: the cap is 16 — sixteen windows are healthy, seventeen breach', () => {
  assert.equal(RETENTION_CAPS.maxWindowsPerPool, 16, '§8 says 16 windows per pool');
  const key = 'codex:acct-a:limit-1';
  const windows = (n) =>
    Array.from({ length: n }, (_, i) => win({ windowId: `w${i}`, kind: 'OTHER', windowMinutes: 60 + i }));

  const atCap = tracker();
  atCap.ingest(obs({ observedAt: T0, receivedAt: T0, windows: windows(RETENTION_CAPS.maxWindowsPerPool) }));
  assert.equal(poolOf(atCap, key).state, 'AVAILABLE', 'sixteen valid windows are within budget');

  const over = tracker();
  over.ingest(obs({ observedAt: T0, receivedAt: T0, windows: windows(RETENTION_CAPS.maxWindowsPerPool + 1) }));
  const p = poolOf(over, key);
  // FIRST, and deliberately before anything dereferences it: a breach must not become
  // a disappearance. Placed here because the version of this assertion that sat at the
  // END of the test could never fire - when the pool is genuinely dropped, the
  // classification lines above dereference null and the test dies on a TypeError
  // instead. A kill is not the same as a kill FOR THE NAMED REASON, and an assertion
  // that cannot be reached is not pinning anything.
  assert.ok(p, 'the pool entity itself survives the breach');
  assert.equal(p.state, 'UNKNOWN', 'the seventeenth window breaches');
  assert.equal(p.stateReason, 'RETENTION_CAP_EXCEEDED');
  // §8 line 172's actual words. A truncate-to-16-and-carry-on implementation would
  // also report healthy, and that is the outcome the clause forbids by name.
  assert.notEqual(p.state, 'AVAILABLE', 'it must not silently discard a window and remain healthy');

  // AND THE SIZE HALF, which classification cannot reach. FOUND BY MUTATION: padding
  // the retained stand-in with 64 KiB ON THE WINDOW-COUNT PATH ONLY left all 821 tests
  // green, while the same padding on the per-pool BYTE path is caught at once. The two
  // breach kinds had one half each — the byte kind a size assertion, the window kind a
  // visibility assertion — and each half is passable by an implementation that fails
  // the other. Classification-only proves visibility without boundedness; size-only
  // proves boundedness without visibility; §8 line 172 states both.
  assert.ok(
    JSON.stringify(p).length < RETENTION_CAPS.maxPoolBytes,
    'what is RETAINED after a window-count breach is bounded, not merely classified'
  );
});

test('§15 the three cap CONSTANTS are unchanged — and this proves NOTHING about the collection ceiling', () => {
  // THIS ASSERTION IS UNINFORMATIVE ABOUT THE COLLECTION CAP, AND IT ALWAYS WAS. That
  // is the point of the comment, so it is stated first rather than derived at the end.
  //
  // It used to say: the product is exactly maxCollectionBytes and the check fires on
  // strictly more, "so the collection cap can never fire", with "zero headroom". When
  // L0-FIX5 made the cap fire on 32 maximal pools I was about to replace that with the
  // OPPOSITE reading — that the two caps overshoot the collection cap. BOTH READINGS ARE
  // WRONG, and L0-SEM §15 says why in one sentence: "the same equality can accompany
  // either an unreachable cap under input-only summing or an exceeded cap under actual
  // post-projection measurement". An equality that held in both worlds was never
  // evidence for either. The product of two INDEPENDENT CEILINGS says nothing about the
  // third: it counts input budget and omits collection and projection overhead, and only
  // the serialized post-projection collection decides that ceiling.
  //
  // SO WHY KEEP IT. Not as a statement about behaviour. §15 rules that no cap constant
  // moves, so this is a CHANGE DETECTOR on three frozen numbers and nothing more. If it
  // fires, a constant moved without a ruling, and the response is to RE-MEASURE the
  // frontiers — never to infer reachability or headroom from the arithmetic in either
  // direction. The behavioural properties are below and in provider-capacity-pin3.test.cjs,
  // where they are measured rather than computed.
  //
  // AND THE LESSON I RECORDED HERE BEFORE WAS ITSELF ONE NOTCH TOO STRONG. I wrote that
  // the name had been "honest all along" and that only the METHOD was a proxy. The name's
  // second clause was "or the collection cap cannot fire" — the unsupportable inference,
  // sitting in the one part of a test everyone reads. It is gone from the NAME, not just
  // from the prose.
  const product = RETENTION_CAPS.maxPools * RETENTION_CAPS.maxPoolBytes;
  assert.equal(
    product,
    RETENTION_CAPS.maxCollectionBytes,
    'a §8 cap constant has MOVED, which §15 does not authorise. This says nothing about ' +
      'whether the collection cap is reachable or how much headroom exists — it never ' +
      'could, in either direction. Re-measure the two valid frontiers instead of reading ' +
      'an implication off this equality.'
  );

  // ── THE MEASURED HALF, RETARGETED AFTER L0-FIX5 (Jim, 64023382) ──────────────
  // WHAT THIS USED TO ASSERT, so nobody reads the change as the budget property being
  // abandoned: that 32 maximal legal pools produce ZERO UNKNOWN pools — "a collection
  // exactly at its budget is within budget". THAT ASSERTION ENCODED THE DEFECT IT WAS
  // WRITTEN BESIDE. 262,144 bytes of INPUT do not make a 262,144-byte COLLECTION: the
  // old check summed the other pools' projections, charging neither the arriving pool
  // nor the wrapper nor the punctuation between 32 array elements, so the maximal
  // collection published 267,460 bytes against a 262,144 cap and reported nothing.
  //
  // The property did not go away, IT MOVED — from arithmetic about inputs to the
  // RETAINED REPRESENTATION, which is the only place a byte cap means anything.
  //
  // I USED TO CREDIT THE TRIPWIRE ABOVE WITH PREDICTING THIS, and that credit is
  // withdrawn: an equality that holds whether or not the cap can fire cannot have
  // predicted which. What actually caught it was this fixture being run against a
  // changed implementation. The error was treating arithmetic over inputs as a stand-in
  // for the cap — in the METHOD and, as it turned out, in the test's own NAME.
  const t = tracker();
  let inputBytes = 0;
  for (let i = 0; i < RETENTION_CAPS.maxPools; i++) {
    const o = sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes);
    inputBytes += JSON.stringify(o).length;
    t.ingest(o);
  }
  assert.equal(inputBytes, RETENTION_CAPS.maxCollectionBytes, 'the maximal legal INPUTS sum to exactly the cap');

  const snap = t.snapshot();
  const published = JSON.stringify(snap).length;
  assert.ok(
    published <= RETENTION_CAPS.maxCollectionBytes,
    `the RETAINED collection serialized to ${published} against a cap of ` +
      `${RETENTION_CAPS.maxCollectionBytes}. Measured on the published representation, ` +
      'not summed from inputs — summing here would re-commit the defect inside the test ' +
      'that exists to pin it.'
  );

  // AND THE CAP IS REACHABLE ON LEGAL INPUT, which is the half this test is named for.
  // While it was unreachable, `published <= cap` was true for a reason unrelated to
  // the cap: nothing measured the collection at all. A bound nothing can reach is not
  // a bound, so the fixture has to show the cap ACTING.
  const bounded = snap.pools.filter((p) => p.state === 'UNKNOWN').length;
  assert.ok(
    bounded >= 1,
    'thirty-two INDIVIDUALLY LEGAL maximal pools exhaust the collection budget, so the ' +
      'collection cap must fire on legal input. Zero bounded pools here means the cap is ' +
      'dead again and the tripwire above is the place to start.'
  );
  assert.ok(
    bounded < RETENTION_CAPS.maxPools,
    'but a full collection is not a blanked one: the cap binds the arrivals it cannot fit'
  );

  // The other side, because "the cap fires" is trivially true of a tracker that bounds
  // everything, exactly as "within budget" was trivially true of one that measured
  // nothing. HALF the pools must spend the budget and keep every reading.
  const half = tracker();
  const halfCount = RETENTION_CAPS.maxPools / 2;
  for (let i = 0; i < halfCount; i++) {
    half.ingest(sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes));
  }
  const halfSnap = half.snapshot();
  assert.equal(
    halfSnap.pools.filter((p) => p.state === 'UNKNOWN').length,
    0,
    'a collection with room bounds nothing — the cap is not firing on everything'
  );
  assert.ok(
    JSON.stringify(halfSnap).length > halfCount * RETENTION_CAPS.maxPoolBytes,
    'and the retained bytes are really there, so "within budget" is not being satisfied ' +
      'by a collection that quietly kept less than it was given'
  );
});

test('§15 ONE accepted ingest is ONE publication, even the one the collection cap bounds', () => {
  // L0-SEM §15 line 276: "one accepted one-pool ingest is one atomic transaction/
  // publication and advances collectionRevision ONCE, EVEN IF implementation internally
  // projects a candidate and then its bounded stand-in."
  //
  // WRITTEN AS A DECLARED RED AND IT IS GREEN, BECAUSE THE FIX LANDED WHILE I WAS
  // WRITING IT. I measured the nonconformance myself at b0646966 — a plain ingest
  // advanced by 1 and the breaching ingest by 2, because the cap path projected, then
  // re-projected the bounded stand-in, and published both. Jim's L0-FIX6 (b00ca4e2)
  // then made one ingest one publication. So this is NOT an expected-red and the red
  // list stays at nine.
  //
  // THE RED-TO-GREEN EVIDENCE EXISTS ANYWAY, and it is better than a mutant: this exact
  // test fails at b0646966 on the does-not-multiply clause with advanced=2 and passes at
  // b00ca4e2, so the pair across Jim's commit is what proves his fix did what it claims
  // rather than merely that the behaviour is correct now. Recorded here because that
  // pair is not visible in any single run of the suite.
  //
  // §11 line 210 is NOT in tension with this: five SERIAL ingests are five
  // transactions and legitimately five increments, an accepted L0 scope boundary. This
  // is about ONE ingest publishing twice, which is a different claim entirely.
  const t = tracker();
  for (let i = 0; i < RETENTION_CAPS.maxPools - 1; i++) {
    t.ingest(sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes));
  }
  // The 31-pool frontier is VALID (§15): nothing is bounded here, so the breach below
  // is caused by the arriving pool and not by a fixture that was already over.
  const atFrontier = t.snapshot();
  assert.equal(
    atFrontier.pools.filter((p) => p.state === 'UNKNOWN').length,
    0,
    '§15 precondition: 31 per-pool-maximum pools are a VALID frontier, nothing bounded yet'
  );

  const before = atFrontier.collectionRevision;
  const accepted = t.ingest(sizedTo('codex:acct-last:limit-1', 'acct-last', RETENTION_CAPS.maxPoolBytes));
  assert.ok(accepted, 'the 32nd maximal reading is ACCEPTED — the cap bounds it, it is not rejected');
  const snap = t.snapshot();

  // FIRST, because the two revision clauses below pin NOTHING if the breach never
  // happened. If a later change stops 32 maximal pools breaching, this test must fail
  // here rather than pass on a fixture that no longer exercises the cap path.
  assert.equal(
    snap.pools.filter((p) => p.state === 'UNKNOWN').length,
    1,
    'the arriving pool IS bounded, so the candidate-then-stand-in path really was taken'
  );

  const advanced = snap.collectionRevision - before;
  // Clause one: it ADVANCES. An implementation that froze the revision on the cap path
  // would hide a real membership change from every consumer that diffs by revision.
  assert.ok(
    advanced > 0,
    `§15: an accepted ingest is a publication, so the collection revision must ADVANCE; it moved ${advanced}`
  );
  // Clause two: it does NOT MULTIPLY. Separate from clause one and separately named,
  // because one equality would go red for both and tell you which for neither.
  assert.equal(
    advanced,
    1,
    `§15: ONE accepted ingest is ONE publication, so the collection revision must advance ` +
      `ONCE; it advanced ${advanced}. The internal candidate-then-bounded-stand-in ` +
      'projection must not publish twice. This clause is the one that failed at b0646966 ' +
      'with advanced=2, before L0-FIX6.'
  );
});

// ---------------------------------------------------------------------------
// §8 Codex file processing — "max 256 KiB appended bytes per read".
// ---------------------------------------------------------------------------

/** A CODEX_HOME whose rollout hides one usable snapshot `fromEnd` bytes from EOF. */
function homeWithSnapshotAt(fromEnd) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-l0val-'));
  const dir = path.join(home, 'sessions', '2026', '09', '13');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-09-13T10-00-00-aaa.jsonl');
  const usable = JSON.stringify({
    timestamp: '2026-09-13T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 41, window_minutes: 300, resets_at: 1789004151 },
        secondary: { used_percent: 9, window_minutes: 10080, resets_at: 1789590951 },
        plan_type: 'plus',
        rate_limit_reached_type: null
      }
    }
  });
  // Filler lines carry NO rate_limits, so the reader must actually reach the snapshot
  // rather than find a nearer one. One filler line is 128 bytes including its newline.
  const filler = JSON.stringify({ type: 'other', pad: 'p'.repeat(80) });
  const fillerLine = filler + '\n';
  const after = Math.max(1, Math.round(fromEnd / fillerLine.length));
  fs.writeFileSync(file, `${'lead\n'.repeat(64)}${usable}\n${fillerLine.repeat(after)}`);
  return { home, file, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('§8 ROLLOUT READ: the tail reaches a snapshot 128 KiB back, which a 64 KiB tail cannot', () => {
  // Nothing in the rollout suite builds a file larger than a few hundred bytes, so the
  // read budget was exercised by nothing: shrinking the tail from 256 KiB back to the
  // 64 KiB it was raised FROM (commit 7c0ce776) left all nine suites green. A revert of
  // that commit was therefore invisible.
  const h = homeWithSnapshotAt(128 * 1024);
  try {
    assert.ok(fs.statSync(h.file).size > 64 * 1024, 'precondition: the snapshot really is out of a 64 KiB tail');
    const o = new CodexRolloutCapacitySource(() => 'scope-x').observe(h.home);
    assert.ok(o, 'a usable snapshot 128 KiB from the end is still found');
    assert.equal(o.windows.find((w) => w.kind === 'FIVE_HOUR').remainingPercent, 59);
    assert.equal(o.observedAt, Date.parse('2026-09-13T10:00:00.000Z'), 'dated by its own event time');
  } finally {
    h.cleanup();
  }
});

test('§8 ROLLOUT READ: the tail is a CEILING — a snapshot beyond 256 KiB is not read', () => {
  // The other side of the same budget, and the reason it must be asserted: "max 256 KiB
  // appended bytes per read" is a maximum, so an implementation that simply read the
  // whole file would satisfy the test above and breach the budget. This is the bound.
  const h = homeWithSnapshotAt(400 * 1024);
  try {
    const o = new CodexRolloutCapacitySource(() => 'scope-x').observe(h.home);
    assert.equal(o, null, 'a snapshot outside the 256 KiB read budget is a miss, not a larger read');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// §8 Timers — "One main-process earliest-boundary timer for all freshness/reset
// deadlines" — and Quiet-state work, which only became measurable once L0-WIRE gave
// the runtime an injected timer seam.
// ---------------------------------------------------------------------------

const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');

/**
 * A runtime rig that can hold MANY timers at once, which is the whole point.
 *
 * The existing runtime rig keeps ONE `pending` slot, so a second armed timer
 * silently overwrites the first and the violation is invisible by construction:
 * arming an extra timer on every rearm leaves all nine capacity suites green. A
 * budget of "one timer" cannot be checked by a rig that can only represent one.
 *
 * Both clocks advance by the delay the runtime actually asked for, so what is under
 * test is the schedule the runtime chose rather than one this test chose for it.
 */
function runtimeRig() {
  let now = T0;
  let mono = 0;
  const delivered = [];
  const live = new Map();
  let seq = 0;
  let maxOutstanding = 0;
  let armedTotal = 0;
  let fired = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  const runtime = new CapacityRuntime({
    deliver: (intents) => delivered.push(...intents),
    now: () => now,
    setTimer: (fn, ms) => {
      const h = ++seq;
      live.set(h, { fn, at: now + ms });
      armedTotal += 1;
      maxOutstanding = Math.max(maxOutstanding, live.size);
      return h;
    },
    clearTimer: (h) => live.delete(h)
  }, tracker);
  return {
    tracker, runtime, delivered,
    outstanding: () => live.size,
    stats: () => ({ maxOutstanding, armedTotal, fired }),
    now: () => now,
    /** Fire every boundary due on or before `until`, in order. */
    runUntil(until) {
      for (let guard = 0; guard < 1000; guard++) {
        const due = [...live.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [h, t] = due;
        const delta = t.at - now;
        now = t.at;
        mono += delta;
        live.delete(h);
        fired += 1;
        t.fn();
      }
      mono += Math.max(0, until - now);
      now = Math.max(now, until);
    }
  };
}

test('§8 TIMERS: at most ONE boundary timer is outstanding, across repeated re-arming', () => {
  const h = runtimeRig();
  const reading = (at, remaining) =>
    obs({ observedAt: at, receivedAt: at, windows: [win({ usedPercent: 100 - remaining, remainingPercent: remaining })] });

  // Several arming events, because one rearm cannot distinguish "replaces" from "adds".
  h.runtime.ingest('agent-1', reading(h.now(), 80));
  assert.equal(h.outstanding(), 1, 'a fresh reading arms exactly one boundary');
  h.runtime.ingest('agent-1', reading(h.now(), 70));
  h.runtime.ingest('agent-2', reading(h.now(), 60));
  assert.equal(h.outstanding(), 1, 'later readings REPLACE the boundary rather than adding one');

  h.runUntil(T0 + 10 * 60_000);
  assert.equal(
    h.stats().maxOutstanding,
    1,
    '§8: "One main-process earliest-boundary timer for all freshness/reset deadlines" — ' +
      'never two at once, at any point in the run'
  );
});

test('§8 QUIET STATE: ten minutes of one fresh static reading fires ONE boundary and notifies nobody', () => {
  const h = runtimeRig();
  h.runtime.ingest('agent-1', obs({ observedAt: T0, receivedAt: T0, windows: [win()] }));
  const key = 'codex:acct-a:limit-1';
  assert.equal(h.tracker.pool(key).state, 'AVAILABLE', 'precondition: the reading was accepted and is healthy');
  assert.equal(h.outstanding(), 1, 'precondition: a boundary was actually scheduled');

  h.runUntil(T0 + 10 * 60_000);

  // §8 Quiet-state work: "only the single scheduled semantic boundary may fire".
  assert.equal(h.stats().fired, 1, 'exactly ONE boundary fires in ten quiet minutes — the freshness expiry');
  assert.equal(h.delivered.length, 0, '0 notifications: a reading ageing out is not news');
  assert.equal(h.outstanding(), 0, 'and nothing is left armed, so the quiet state is genuinely quiet');

  // The boundary did real work rather than being a no-op that costs nothing to pass.
  const p = h.tracker.pool(key);
  assert.equal(p.freshness, 'STALE', 'the scheduled boundary is what expired the reading');
  assert.equal(p.state, 'UNKNOWN', 'and an expired reading reads UNKNOWN, never healthy');
});
