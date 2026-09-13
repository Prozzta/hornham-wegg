'use strict';

/**
 * L0-FIX7 — the three defects Dwight demonstrated at pin 4 (`3bf0ce53`), research
 * `b426852`, notes/dwight-l0-audit-criteria.md section 13.
 *
 * Each test states what it DISCRIMINATES, because a test that passes under both the
 * defect and the fix is context, not evidence. The discriminating pair for each is
 * the one the dispatch named: a bounded identity against a 300,000-character one;
 * the same fixture in ASCII and in supplementary characters; a number that needs
 * more than sixteen characters.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS,
  TIMER_GROWTH_RESERVE_PER_POOL, TIMER_GROWTH_RESERVE_COLLECTION
} = loadTs('src/main/providerCapacityTracker.ts');
const { boundedIdentity, boundedPoolKey, IDENTITY_LIMITS } = loadTs('src/main/capacityEnvelope.ts');

const T0 = 1_800_000_000_000;
const utf8 = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

const win = (label = 'x') => ({
  windowId: 'five_hour', kind: 'FIVE_HOUR', label, windowMinutes: 300,
  usedPercent: 10, remainingPercent: 90, resetsAt: T0 + 3_600_000
});

const obs = (over = {}) => ({
  poolKey: 'codex:acct-a:limit-1', provider: 'codex', accountScope: 'acct-a', limitId: 'limit-1',
  source: 'codex-account-read', streamId: 'codex-account:/a.json', sourceSequence: 1,
  observedAt: T0, receivedAt: T0, windows: [win()],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: null, ...over
});

function tracker() {
  let now = T0;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return { t, advance: (ms) => { now += ms; mono += ms; } };
}

// ═══════════════════════════════════════════════════════════════════════════
// 13.3.1 — the bounded stand-in retained unbounded identity
// ═══════════════════════════════════════════════════════════════════════════

test('FIX7/1: a 300,000-character limitId is refused and NOTHING is retained', () => {
  // DISCRIMINATES: under the defect this was ACCEPTED as POOL_BYTES_EXCEEDED with
  // windows removed, and its published collection was 600,568 bytes against a
  // 262,144 cap - the stand-in bounded the payload and copied the identity through
  // raw. Under the fix nothing is retained at all, so the collection stays empty.
  const { t } = tracker();
  const huge = 'a'.repeat(300_000);
  const r = t.ingestDetailed(obs({ limitId: huge, poolKey: `codex:acct-a:${huge}` }));

  assert.equal(r.accepted, false, 'an identity that cannot be believed cannot be retained');
  assert.equal(r.reason, 'UNBOUNDED_IDENTITY');
  assert.equal(t.snapshot().pools.length, 0, 'no record was created');
  assert.ok(
    utf8(t.snapshot()) < 1_000,
    `published collection is ${utf8(t.snapshot())} bytes - the 300,000-char identity is nowhere in it`
  );
  assert.equal(JSON.stringify(t.snapshot()).includes('aaaaaaaaaa'), false);
});

test('FIX7/1: the PAIR — an ordinary bounded identity is still admitted whole', () => {
  // Without this, "refuse unbounded identities" is satisfied by refusing everything.
  const { t } = tracker();
  const r = t.ingestDetailed(obs());
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'ACCEPTED');
  assert.equal(t.pool('codex:acct-a:limit-1').windows.length, 1, 'retained with its reading');
  assert.equal(t.pool('codex:acct-a:limit-1').state, 'AVAILABLE');
});

test('FIX7/1: every identity field the stand-in copies through is bounded', () => {
  // The defect was one field-class, but the stand-in copies five. Each is pinned
  // beside the ordinary value it must still accept.
  const huge = 'b'.repeat(5_000);
  const cases = {
    poolKey: { poolKey: huge },
    accountScope: { accountScope: huge, poolKey: `codex:${huge}:limit-1` },
    limitId: { limitId: huge, poolKey: `codex:acct-a:${huge}` },
    provider: { provider: huge },
    streamId: { streamId: huge },
    source: { source: 'some-unknown-collector' }
  };
  for (const [field, over] of Object.entries(cases)) {
    const { t } = tracker();
    const r = t.ingestDetailed(obs(over));
    assert.equal(r.accepted, false, `${field} must be bounded`);
    assert.equal(r.reason, 'UNBOUNDED_IDENTITY', field);
    assert.equal(t.snapshot().pools.length, 0, `${field}: nothing retained`);
  }
});

test('FIX7/1: an unbounded reading does not disturb the pool already admitted', () => {
  // Refusing must not be a way to destroy good evidence: the previous reading is
  // still current and still published.
  const { t } = tracker();
  t.ingest(obs());
  const before = t.pool('codex:acct-a:limit-1').revision;
  t.ingestDetailed(obs({ poolKey: 'c'.repeat(9_000) }));
  assert.equal(t.pool('codex:acct-a:limit-1').windows.length, 1, 'still has its reading');
  assert.equal(t.pool('codex:acct-a:limit-1').revision, before, 'and nothing republished');
  assert.equal(t.snapshot().pools.length, 1);
});

test('FIX7/1: identity is never TRUNCATED, because a shortened id is another id', () => {
  // The shared predicate, exercised directly: it returns null rather than a prefix.
  assert.equal(boundedIdentity('d'.repeat(IDENTITY_LIMITS.identityChars + 1)), null);
  assert.equal(boundedIdentity('acct-a'), 'acct-a', 'and a normal one passes through unchanged');
  assert.equal(boundedPoolKey('e'.repeat(IDENTITY_LIMITS.poolKeyChars + 1)), null);
  assert.equal(boundedPoolKey('codex:acct-a:limit-1'), 'codex:acct-a:limit-1');
});

// ═══════════════════════════════════════════════════════════════════════════
// 13.3.2 — both byte caps counted UTF-16 code units, not UTF-8 bytes
// ═══════════════════════════════════════════════════════════════════════════

/** Pad `planType` until the observation reaches `bytes` UTF-8 bytes. */
function sizedUtf8(over, bytes, filler) {
  const o = obs(over);
  o.planType = '';
  while (utf8(o) < bytes) {
    const short = bytes - utf8(o);
    o.planType += filler.repeat(Math.max(1, Math.floor(short / Buffer.byteLength(filler, 'utf8'))));
  }
  while (utf8(o) > bytes && o.planType.length > 0) o.planType = o.planType.slice(0, -1);
  return o;
}

test('FIX7/2: supplementary characters are counted as UTF-8 BYTES, not code units', () => {
  // DISCRIMINATES: a plan type of supplementary characters measures about half in
  // code units. Under the defect this was accepted with capBreach=null and published
  // a 14,632-byte projection against an 8,192-byte ceiling. The SAME byte size in
  // ASCII must breach too - that is the pair, and it is what shows the unit changed
  // rather than the threshold.
  const over = RETENTION_CAPS.maxPoolBytes + 2_000;
  for (const [name, filler] of [['ASCII', 'a'], ['supplementary', '\u{1F600}']]) {
    const { t } = tracker();
    const o = sizedUtf8({}, over, filler);
    assert.ok(utf8(o) > RETENTION_CAPS.maxPoolBytes, `${name} fixture really is over the cap in bytes`);
    t.ingest(o);
    const p = t.pool('codex:acct-a:limit-1');
    assert.equal(p.state, 'UNKNOWN', `${name}: an over-cap reading is UNKNOWN`);
    assert.equal(p.windows.length, 0, `${name}: its payload is not retained`);
  }
});

test('FIX7/2: the PAIR — a legal reading is admitted in ASCII and in supplementary alike', () => {
  // "Everything breaches" would pass the test above. Both encodings must still be
  // admitted when they genuinely fit.
  const under = RETENTION_CAPS.maxPoolBytes - 2_000;
  for (const [name, filler] of [['ASCII', 'a'], ['supplementary', '\u{1F600}']]) {
    const { t } = tracker();
    const o = sizedUtf8({}, under, filler);
    assert.ok(utf8(o) <= RETENTION_CAPS.maxPoolBytes, `${name} fixture fits`);
    t.ingest(o);
    assert.equal(t.pool('codex:acct-a:limit-1').state, 'AVAILABLE', `${name}: admitted`);
    assert.equal(t.pool('codex:acct-a:limit-1').windows.length, 1, `${name}: retained whole`);
  }
});

test('FIX7/2: the COLLECTION ceiling is measured in UTF-8 bytes too', () => {
  // Dwight's collection arm: 32 legal-looking pools whose code-unit total was
  // 244,572 published 468,572 UTF-8 bytes with nothing sentinelled.
  const { t } = tracker();
  for (let i = 0; i < RETENTION_CAPS.maxPools; i += 1) {
    t.ingest(sizedUtf8(
      { poolKey: `codex:acct-${i}:limit-1`, accountScope: `acct-${i}` },
      RETENTION_CAPS.maxPoolBytes,
      '\u{1F600}'
    ));
  }
  const published = utf8(t.snapshot());
  assert.ok(
    published <= RETENTION_CAPS.maxCollectionBytes,
    `published ${published} UTF-8 bytes against ${RETENTION_CAPS.maxCollectionBytes}`
  );
});

test('FIX7/2: ASCII is arithmetically unchanged — one code unit is one byte', () => {
  // The integration claim, asserted rather than assumed: for any ASCII value the two
  // units agree exactly, so no ASCII fixture on this floor is re-baselined.
  const { t } = tracker();
  t.ingest(obs());
  const snap = t.snapshot();
  assert.equal(utf8(snap), JSON.stringify(snap).length, 'ASCII: UTF-8 bytes === UTF-16 code units');
});

// ═══════════════════════════════════════════════════════════════════════════
// 13.3.3 (reserve arm) — the number-width premise was false
// ═══════════════════════════════════════════════════════════════════════════

test('FIX7/3: the reserve covers the WIDEST finite JSON number, not the widest safe integer', () => {
  // DISCRIMINATES: the old constant was 16, justified by Number.MAX_SAFE_INTEGER.
  // JSON.stringify(-Number.MAX_VALUE) is 24 characters and a 23-character ageMs was
  // published through the public evaluate(). SEARCHED, not asserted: the test finds
  // the maximum over the extremes of the finite double domain, so it fails if the
  // constant is ever set below what the domain can actually produce.
  const extremes = [
    Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, Number.EPSILON,
    1 / 3, -1 / 3, 0.1 + 0.2, 1e21, -1e21, 5e-324
  ];
  let widest = 0;
  let witness = null;
  for (const n of extremes) {
    const len = JSON.stringify(n).length;
    if (len > widest) { widest = len; witness = n; }
  }
  assert.ok(widest > 16, `the domain really does exceed 16 characters (${widest}, from ${witness})`);

  // The reserve charges three numbers per pool plus two collection-level. Whatever
  // the widest is, the per-pool allowance must cover three of them.
  const statesAndReasons = TIMER_GROWTH_RESERVE_PER_POOL - 3 * widest;
  assert.ok(
    statesAndReasons >= 0,
    `per-pool reserve ${TIMER_GROWTH_RESERVE_PER_POOL} must cover 3 x ${widest} characters of number`
  );
  assert.ok(
    TIMER_GROWTH_RESERVE_COLLECTION >= 2 * widest,
    `collection reserve ${TIMER_GROWTH_RESERVE_COLLECTION} must cover 2 x ${widest}`
  );
});

test('FIX7/3: a wide ageMs really is reachable through the public surface', () => {
  // Not hypothetical: the monotonic clock is injected, and evaluate() publishes an
  // ageMs derived from it. This is the shape Dwight used to produce 23 characters.
  let now = T0;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  t.ingest(obs());
  mono = Number.MAX_VALUE;
  t.evaluate();
  const published = t.pool('codex:acct-a:limit-1').ageMs;
  assert.ok(
    JSON.stringify(published).length > 16,
    `ageMs published as ${JSON.stringify(published)} (${JSON.stringify(published).length} chars)`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 13.3.3 / L0-SEM 16 — one evaluate() sweep is ONE atomic publication
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Oscar section 16: one `evaluate(now)` invocation is one atomic sweep and one
 * publication. Dwight measured five expiring pools moving the collection 5 -> 10;
 * the correct answer is 5 -> 6.
 *
 * EACH TEST BELOW HAS AN ARM THAT THE OBVIOUS WRONG FIX WOULD BREAK. "Increment the
 * collection once per sweep, unconditionally" produces the right headline number and
 * is wrong three ways: it advances on a sweep where nothing moved, it says nothing
 * about which POOLS advanced, and it would let an unaffected pool move too.
 */
const live = (i) => obs({
  poolKey: `codex:live-${i}:limit-1`, accountScope: `live-${i}`,
  source: 'codex-rollout', streamId: `codex-rollout:/${i}.jsonl`
});
const slow = (i) => obs({
  poolKey: `codex:slow-${i}:limit-1`, accountScope: `slow-${i}`,
  source: 'codex-account-read', streamId: `codex-account:/${i}.json`
});

test('FIX7/4: five expiring pools advance the collection ONCE, not five times', () => {
  const { t, advance } = tracker();
  for (let i = 0; i < 5; i += 1) t.ingest(live(i));
  const before = t.snapshot().collectionRevision;
  const poolBefore = t.snapshot().pools.map((p) => p.revision);

  advance(L0_SEM_POLICY.liveTtlMs + 1_000);
  const moved = t.evaluate();

  assert.equal(moved, true, 'the sweep really did publish something');
  assert.equal(t.snapshot().collectionRevision - before, 1, 'ONE sweep, ONE collection increment');
  for (const p of t.snapshot().pools) assert.equal(p.freshness, 'STALE', 'all five really expired');
  // And not the other wrong answer: each AFFECTED pool advances exactly once.
  const poolAfter = t.snapshot().pools.map((p) => p.revision);
  for (let i = 0; i < poolAfter.length; i += 1) {
    assert.equal(poolAfter[i] - poolBefore[i], 1, `pool ${i} advanced exactly once`);
  }
});

test('FIX7/4: pools the sweep did NOT affect advance by ZERO', () => {
  // The arm that "increment everything once per sweep" fails. Five short-TTL pools
  // expire; three long-TTL pools are untouched and must not move at all.
  const { t, advance } = tracker();
  for (let i = 0; i < 5; i += 1) t.ingest(live(i));
  for (let i = 0; i < 3; i += 1) t.ingest(slow(i));
  const before = new Map(t.snapshot().pools.map((p) => [p.poolKey, p.revision]));
  const collectionBefore = t.snapshot().collectionRevision;

  advance(L0_SEM_POLICY.liveTtlMs + 1_000);
  t.evaluate();

  const after = new Map(t.snapshot().pools.map((p) => [p.poolKey, p.revision]));
  let advanced = 0;
  for (const [key, rev] of after) {
    const delta = rev - before.get(key);
    if (key.includes('slow-')) {
      assert.equal(delta, 0, `${key} was not affected and must not advance`);
      assert.equal(t.pool(key).freshness, 'FRESH', `${key} is still inside its own TTL`);
    } else {
      assert.equal(delta, 1, `${key} expired and advances once`);
      advanced += 1;
    }
  }
  assert.equal(advanced, 5, 'exactly the five short-TTL pools moved');
  assert.equal(t.snapshot().collectionRevision - collectionBefore, 1, 'still one publication');
});

test('FIX7/4: one pool crossing TWO boundaries in one sweep advances ONCE', () => {
  // FINAL projection, not intermediate: freshness expiry and the reset boundary both
  // pass in the same jump. An implementation that re-published per crossed boundary
  // would advance twice.
  const { t, advance } = tracker();
  t.ingest(obs({
    providerReachedType: 'rate_limit_reached',
    windows: [{ ...win(), usedPercent: 100, remainingPercent: 0, resetsAt: T0 + 60_000 }]
  }));
  const key = 'codex:acct-a:limit-1';
  const before = t.pool(key).revision;
  const collectionBefore = t.snapshot().collectionRevision;

  // Past the live TTL AND past the reset boundary, in one step.
  advance(L0_SEM_POLICY.liveTtlMs + 120_000);
  t.evaluate();

  assert.equal(t.pool(key).revision - before, 1, 'two boundaries, one advance');
  assert.equal(t.snapshot().collectionRevision - collectionBefore, 1, 'and one publication');
});

test('FIX7/4: a second identical sweep is a TOTAL no-op', () => {
  // The arm that "increment once per sweep, unconditionally" fails outright.
  const { t, advance } = tracker();
  for (let i = 0; i < 3; i += 1) t.ingest(live(i));
  advance(L0_SEM_POLICY.liveTtlMs + 1_000);
  assert.equal(t.evaluate(), true, 'the first sweep moved something');

  const collectionAfterFirst = t.snapshot().collectionRevision;
  const poolsAfterFirst = t.snapshot().pools.map((p) => p.revision);

  assert.equal(t.evaluate(), false, 'the second sweep reports no change');
  assert.equal(t.snapshot().collectionRevision, collectionAfterFirst, 'no collection increment at all');
  assert.deepEqual(t.snapshot().pools.map((p) => p.revision), poolsAfterFirst, 'no pool moved');
});

// ═══════════════════════════════════════════════════════════════════════════
// L0-REVBOUND — every publication path advances the collection EXACTLY once
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHAT THIS DOES AND DOES NOT ESTABLISH, STATED PLAINLY. The at-most-once rule lived
 * inside commitPublication() while three other sites advanced `collectionRevision`
 * directly - the excess-pool marker, noteCompleteInventory and forget. Each was a
 * genuinely distinct publication, so the BEHAVIOUR was already correct and NOTHING
 * HERE FAILED BEFORE. Routing them through the one writer is a structural change,
 * not a bug fix, and no test can discriminate it.
 *
 * So this pins the thing that CAN regress: the per-path counts themselves. A fourth
 * writer, or a path that publishes twice, fails here by name.
 */
test('REVBOUND: each publishing path advances the collection by exactly ONE', () => {
  const paths = {
    'an ordinary changing ingest': (t) => t.ingest(obs()),
    'the excess-pool marker': (t) => {
      for (let i = 0; i < RETENTION_CAPS.maxPools; i += 1) {
        t.ingest(obs({ poolKey: `codex:p-${i}:limit-1`, accountScope: `p-${i}` }));
      }
      return () => t.ingest(obs({ poolKey: 'codex:excess:limit-1', accountScope: 'excess' }));
    },
    'noteCompleteInventory clearing the marker': (t) => {
      for (let i = 0; i < RETENTION_CAPS.maxPools; i += 1) {
        t.ingest(obs({ poolKey: `codex:p-${i}:limit-1`, accountScope: `p-${i}` }));
      }
      t.ingest(obs({ poolKey: 'codex:excess:limit-1', accountScope: 'excess' }));
      return () => t.noteCompleteInventory(['codex:p-0:limit-1']);
    },
    'forget': (t) => {
      t.ingest(obs());
      return () => t.forget('codex:acct-a:limit-1');
    }
  };
  for (const [name, setup] of Object.entries(paths)) {
    const { t } = tracker();
    const act = setup(t);
    if (typeof act !== 'function') continue; // the ingest case acted during setup
    const before = t.snapshot().collectionRevision;
    act();
    assert.equal(t.snapshot().collectionRevision - before, 1, name);
  }

  // The ingest case measured on its own, since its action IS the setup.
  const { t } = tracker();
  const before = t.snapshot().collectionRevision;
  t.ingest(obs());
  assert.equal(t.snapshot().collectionRevision - before, 1, 'an ordinary changing ingest');
});

test('REVBOUND: the PAIR — a path that publishes nothing advances by ZERO', () => {
  // Without this, "exactly one" is satisfied by a counter that advances on every
  // call, which is the wrong fix one level up from the sweep defect.
  const { t } = tracker();
  t.ingest(obs());

  const noops = {
    'an exact duplicate ingest': () => t.ingest(obs()),
    'a sweep with nothing to do': () => t.evaluate(),
    'noteCompleteInventory with no marker': () => t.noteCompleteInventory(['codex:acct-a:limit-1']),
    'forgetting a pool that does not exist': () => t.forget('codex:nobody:limit-1')
  };
  for (const [name, act] of Object.entries(noops)) {
    const before = t.snapshot().collectionRevision;
    act();
    assert.equal(t.snapshot().collectionRevision - before, 0, name);
  }
});

test('REVBOUND: a SECOND excess arrival does not multiply the marker publication', () => {
  // L0-SEM 13: later excess arrivals are semantic no-ops. Asserted as === 0 rather
  // than <= 1, because <= 1 passes an implementation that publishes nothing at all -
  // and the first arrival above already proved it publishes once.
  const { t } = tracker();
  for (let i = 0; i < RETENTION_CAPS.maxPools; i += 1) {
    t.ingest(obs({ poolKey: `codex:p-${i}:limit-1`, accountScope: `p-${i}` }));
  }
  t.ingest(obs({ poolKey: 'codex:excess-1:limit-1', accountScope: 'excess-1' }));
  const after = t.snapshot().collectionRevision;
  t.ingest(obs({ poolKey: 'codex:excess-2:limit-1', accountScope: 'excess-2' }));
  assert.equal(t.snapshot().collectionRevision - after, 0, 'a second excess pool is a no-op');
  assert.equal(t.snapshot().overflow.excess, 'ONE_OR_MORE', 'and still carries no count');
});
