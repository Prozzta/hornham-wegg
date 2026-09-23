'use strict';

/**
 * AGY 1.1.48 commit 3 - two pools per Antigravity account, and the LAZY ROW rule.
 *
 * THE HUMAN'S RULING (2026-09-23, ratified before this was built): "Two POSSIBLE rows.
 * Surely we should see either 3P or Gemini moving? Once shown as moving, trigger that
 * one. If the other starts, do that as well." Most people draw on one of the two
 * allowances, so showing both from boot would sit a permanently idle row next to a real
 * one. A row appears when its pool MOVES - consumption, or a live agent gating on it -
 * and then stays for the run.
 *
 * THE SAFETY OVERRIDE (god, not negotiable) is the exception that cannot be lazy: a pool
 * that is out of allowance AND gating a live agent is always shown, even if it never
 * moved. A hidden row silently blocking an agent is the one failure this strip must not
 * have, and it must not wait for a prior reading to compare against.
 *
 * Design of record: agents/dwight-mu32ztys/agy-1.1.48-DESIGN.md 1.3-1.4.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { normalizeAgyStatusLine } = loadTs('src/main/capacityNormalize.ts');
const { poolKeyOf } = loadTs('src/shared/providerCapacity.ts');

const T0 = 1_800_000_000_000;
const SCOPE = 'agyscope0001';
const P3 = poolKeyOf('antigravity', SCOPE, '3p');
const PG = poolKeyOf('antigravity', SCOPE, 'gemini');

// ─── fixtures ───────────────────────────────────────────────────────────────

/** An AGY statusline payload whose resets agree with `at`, with the given remainders. */
function payload(at, { threeFive = 1, threeWeek = 1, gemFive = 1, gemWeek = 1, model = 'Gemini 3.8 Flash (High)' } = {}) {
  const bucket = (fraction, seconds) => ({
    remaining_fraction: fraction,
    reset_time: new Date(at + seconds * 1000).toISOString(),
    reset_in_seconds: seconds
  });
  return {
    version: '1.2.8',
    product: 'antigravity',
    agent_state: 'working',
    session_id: 'sess-1',
    model: { id: model, display_name: model, effort: 'high' },
    quota: {
      '3p-5h': bucket(threeFive, 18000),
      '3p-weekly': bucket(threeWeek, 604800),
      'gemini-5h': bucket(gemFive, 17000),
      'gemini-weekly': bucket(gemWeek, 71000)
    }
  };
}

const tickAt = (at, over) => normalizeAgyStatusLine({ payload: payload(at, over), accountScope: SCOPE, receivedAt: at });

/** A presenter driven by a real tracker, with a controllable clock and membership. */
function floor() {
  let now = T0;
  let members = {};
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter({ formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 1) });
  const api = {
    get now() { return now; },
    advance(ms) { now += ms; tracker.evaluate(); },
    /** agentId -> poolKey, the runtime's accepted mapping. */
    setMembers(m) { members = m; },
    /** Ingest, then PRESENT - exactly as production does: every accepted tick publishes,
     *  and every publish re-presents. The lazy rule observes at present() time, so a
     *  harness that ingested twice without presenting would test a sequence the app
     *  never produces (and would miss the consumption between them). */
    ingest(tick) { for (const o of tick.observations) tracker.ingest(o); return api.present(); },
    present() {
      return presenter.present({
        snapshot: tracker.snapshot(),
        membersOf: (key) => Object.entries(members).filter(([, v]) => v === key).map(([k]) => k),
        membershipKnown: () => true,
        freshUntil: (k) => tracker.freshUntil(k),
        now
      });
    },
    labels() { return api.present().pools.map((p) => p.poolLabel); },
    tracker, presenter
  };
  return api;
}

// ─── the lazy rule ──────────────────────────────────────────────────────────

test('HIDDEN AT START: a first valid tick seeds both pools and shows NEITHER row', () => {
  const f = floor();
  f.ingest(tickAt(T0));
  assert.deepEqual(f.labels(), [], 'a first observation is a seed, not movement');
  // The pools exist in the domain - they are simply not on the strip yet.
  assert.equal(f.tracker.snapshot().pools.length, 2);
});

test('CONSUMPTION reveals only the pool that moved; the sibling stays hidden', () => {
  const f = floor();
  f.ingest(tickAt(T0));
  f.advance(60_000);
  f.ingest(tickAt(f.now, { gemFive: 0.97 }));            // Gemini consumed, 3P untouched
  assert.deepEqual(f.labels(), ['Antigravity · Gemini']);
});

test('THE OTHER POOL APPEARS INDEPENDENTLY when it starts moving', () => {
  const f = floor();
  f.ingest(tickAt(T0));
  f.advance(60_000);
  f.ingest(tickAt(f.now, { gemFive: 0.97 }));
  assert.deepEqual(f.labels(), ['Antigravity · Gemini']);
  f.advance(60_000);
  f.ingest(tickAt(f.now, { gemFive: 0.97, threeWeek: 0.8 }));
  assert.deepEqual(f.labels(), ['Antigravity · 3P', 'Antigravity · Gemini'], 'both, never merged');
});

test('LATCHED: once shown, a row stays even when later ticks repeat the same numbers', () => {
  const f = floor();
  f.ingest(tickAt(T0));
  f.advance(60_000);
  f.ingest(tickAt(f.now, { gemFive: 0.97 }));
  for (let i = 0; i < 3; i++) { f.advance(60_000); f.ingest(tickAt(f.now, { gemFive: 0.97 })); }
  assert.deepEqual(f.labels(), ['Antigravity · Gemini'], 'no flicker');
});

test('GATING: a live agent drawing on a family reveals it before any number moves', () => {
  const f = floor();
  f.ingest(tickAt(T0));
  assert.deepEqual(f.labels(), []);
  f.setMembers({ 'phyllis-1': PG });                      // its model gates on Gemini
  assert.deepEqual(f.labels(), ['Antigravity · Gemini']);
});

test('A STALE RE-READ WITH A DIFFERENT NUMBER DOES NOT reveal a row', () => {
  // god's required test. STALE-RETAIN re-presents the last safe numbers with their age;
  // re-reading them is not an observation, so it must neither count as movement nor
  // overwrite what we remember.
  const f = floor();
  f.ingest(tickAt(T0));
  f.advance(L0_SEM_POLICY.liveTtlMs + 10);                // both pools go stale
  assert.equal(f.tracker.snapshot().pools.every((p) => p.freshness === 'STALE'), true);
  assert.deepEqual(f.labels(), [], 'still hidden');

  // A stale projection whose figure differs must change nothing.
  f.present();
  assert.deepEqual(f.labels(), []);
});

test('A CHANGE DURING A STALE GAP counts on the next FRESH read - consumption is not lost', () => {
  const f = floor();
  f.ingest(tickAt(T0));
  f.advance(L0_SEM_POLICY.liveTtlMs + 10);
  f.present();                                            // observed while stale: ignored
  f.advance(1000);
  f.ingest(tickAt(f.now, { gemWeek: 0.5 }));              // the fresh reading that follows
  assert.deepEqual(f.labels(), ['Antigravity · Gemini'],
    'compared against the last value we actually trusted');
});

test('EXACT comparison: a genuinely tiny consumption still reveals the row', () => {
  const f = floor();
  f.ingest(tickAt(T0, { gemFive: 0.9763053 }));
  f.advance(60_000);
  f.ingest(tickAt(f.now, { gemFive: 0.9763052 }));        // one part in ten million
  assert.deepEqual(f.labels(), ['Antigravity · Gemini'],
    'a tolerance would swallow exactly the movement this rule watches for');
});

test('A WEEKLY-ONLY change counts: the fingerprint is every applicable window', () => {
  const f = floor();
  f.ingest(tickAt(T0));
  f.advance(60_000);
  f.ingest(tickAt(f.now, { threeWeek: 0.9 }));            // 5h unchanged, weekly consumed
  assert.deepEqual(f.labels(), ['Antigravity · 3P']);
});

test('SAFETY OVERRIDE: an exhausted pool GATING a live agent is shown, though it never moved', () => {
  const f = floor();
  f.ingest(tickAt(T0, { threeFive: 0 }));                 // 3P exhausted on the FIRST tick
  assert.equal(f.tracker.pool(P3).state, 'RESERVE_ONLY');
  assert.deepEqual(f.labels(), [], 'not gating anyone yet, and it has not moved');
  f.setMembers({ 'worker-1': P3 });                       // now an agent draws on it
  assert.deepEqual(f.labels(), ['Antigravity · 3P'],
    'a hidden row silently blocking an agent is the failure this prevents');
});

test('SAFETY OVERRIDE does not depend on a prior remainder - it fires on the very first tick', () => {
  const f = floor();
  f.setMembers({ 'worker-1': P3 });
  f.ingest(tickAt(T0, { threeFive: 0 }));
  assert.deepEqual(f.labels(), ['Antigravity · 3P']);
});

test('CLAUDE AND CODEX ARE UNAFFECTED: their single-limit row is never hidden', () => {
  // The rule is Antigravity-only. Hiding a Claude row until it moved would be a
  // regression: that provider has one current limit identity and its row IS the provider.
  let now = T0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter({ formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 1) });
  tracker.ingest({
    poolKey: 'claude:acct-a:subscription', provider: 'claude', accountScope: 'acct-a', limitId: 'subscription',
    source: 'claude-status-line', sourceVersion: null, streamId: 's', sourceSequence: 1,
    observedAt: now, receivedAt: now,
    windows: [{ windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
      usedPercent: 20, remainingPercent: 80, resetsAt: now + 3_600_000 }],
    providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: null
  });
  const c = presenter.present({ snapshot: tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now });
  assert.deepEqual(c.pools.map((p) => p.poolLabel), ['Claude'], 'shown on its first reading');
});

test('A POOL THAT LEAVES AND RETURNS starts clean - the memory is pruned with the latches', () => {
  const f = floor();
  f.ingest(tickAt(T0));
  f.advance(60_000);
  f.ingest(tickAt(f.now, { gemFive: 0.97 }));
  assert.deepEqual(f.labels(), ['Antigravity · Gemini']);
  // The presenter prunes per-pool state for pools absent from a complete-replace snapshot.
  f.presenter.present({ snapshot: { pools: [], overflow: null, collectionRevision: 99, updatedAt: f.now },
    membersOf: () => [], membershipKnown: () => true, freshUntil: () => null, now: f.now });
  f.advance(60_000);
  f.ingest(tickAt(f.now, { gemFive: 0.97 }));
  assert.deepEqual(f.labels(), [], 'its first reading back is a seed again, not movement');
});

/**
 * A hand-built pool projection, so a STALE reading can carry DIFFERENT numbers.
 *
 * WHY BY HAND. Driven through the tracker, STALE-RETAIN re-presents the LAST SAFE numbers
 * unchanged, so a stale projection can never disagree with the fresh one that preceded it
 * - which means the live pipeline cannot produce god's required case at all. The guard is
 * therefore defence in depth: it must hold if a stale projection ever DOES carry different
 * figures (a reading restored from the durable store is the obvious future source). The
 * presenter takes a snapshot as input, so the case is expressible here even though the
 * tracker will not currently generate it.
 */
function handPool(poolKey, limitId, { fresh = true, five = 100, weekly = 100, state = 'AVAILABLE' } = {}) {
  const w = (id, kind, remaining) => ({
    windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
    windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080,
    usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: T0 + 3_600_000,
    applicability: 'APPLICABLE'
  });
  return {
    poolKey, provider: 'antigravity', accountScope: SCOPE, limitId, revision: 1,
    state, stateReason: 'FRESH_READING',
    windows: [w(`${limitId}-5h`, 'FIVE_HOUR', five), w(`${limitId}-weekly`, 'SEVEN_DAY', weekly)],
    source: 'antigravity-status-line', sourceVersion: '1.2.8',
    freshness: fresh ? 'FRESH' : 'STALE',
    observedAt: T0, receivedAt: T0, ageMs: 0,
    providerAttributedLimitingWindowId: null, numericallyExhaustedWindowIds: [],
    ordinaryUsageAllowed: null, planType: null, recoveryPending: false, capBreach: null, limitEpochAt: null
  };
}

test('A STALE reading with DIFFERENT numbers neither reveals the row NOR overwrites the memory', () => {
  // god's required test, in the only form that can exist (see handPool). Two properties in
  // one sequence, because they fail independently: the stale read must not count as
  // movement, and it must not become the value the NEXT fresh read is compared against.
  const presenter = new CapacityStripPresenter({ formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 1) });
  const show = (pool) => presenter.present({
    snapshot: { pools: [pool], overflow: null, collectionRevision: 1, updatedAt: T0 },
    membersOf: () => [], membershipKnown: () => true, freshUntil: () => null, now: T0
  }).pools.map((p) => p.poolLabel);

  assert.deepEqual(show(handPool(PG, 'gemini', { fresh: true, five: 100 })), [], 'seeded at 100');
  assert.deepEqual(show(handPool(PG, 'gemini', { fresh: false, five: 50 })), [],
    'a STALE reading is not an observation, whatever it says');
  assert.deepEqual(show(handPool(PG, 'gemini', { fresh: true, five: 100 })), [],
    'and it did not become the remembered value: 100 is still unchanged, so still hidden');
  assert.deepEqual(show(handPool(PG, 'gemini', { fresh: true, five: 99 })), ['Antigravity · Gemini'],
    'real consumption from the remembered value still reveals it');
});

// ─── the coherent pair (runtime) ────────────────────────────────────────────

function runtime() {
  let now = T0;
  const changes = [];
  // The tracker is INJECTED on the test clock. The runtime's default builds its own on
  // Date.now(), against which a fixture dated T0 is future-dated - and a future-dated
  // reading is refused, which is correct behaviour and would silently empty every
  // assertion below.
  const r = new CapacityRuntime({
    deliver: () => {},
    now: () => now,
    onChange: () => changes.push('change'),
    setTimer: () => 0,
    clearTimer: () => {}
  }, new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now));
  return { r, changes, advance: (ms) => { now += ms; }, get now() { return now; } };
}

test('ingestAgyTick: BOTH pools ingested, the agent mapped to the ACTIVE family only', () => {
  const rt = runtime();
  const tick = tickAt(T0);                                 // a Gemini-branded model
  rt.r.ingestAgyTick('phyllis-1', { ...tick, accountScope: SCOPE });
  assert.equal(rt.r.snapshot().pools.length, 2, 'both families are visible in the domain');
  assert.equal(rt.r.poolKeyOf('phyllis-1'), PG, 'gated by the family its model draws on');
  assert.deepEqual(rt.r.membersOf(P3), [], 'and NOT a member of the sibling');
  assert.deepEqual(rt.r.membersOf(PG), ['phyllis-1']);
});

test('ingestAgyTick: a 3P-branded model binds 3P, and the sibling is still ingested', () => {
  const rt = runtime();
  const tick = tickAt(T0, { model: 'Claude Sonnet 5' });
  rt.r.ingestAgyTick('worker-1', { ...tick, accountScope: SCOPE });
  assert.equal(rt.r.poolKeyOf('worker-1'), P3);
  assert.equal(rt.r.snapshot().pools.length, 2);
});

test('ingestAgyTick: a PERSONAL session (null agent) updates both pools and invents no member', () => {
  const rt = runtime();
  rt.r.ingestAgyTick(null, { ...tickAt(T0), accountScope: SCOPE });
  assert.equal(rt.r.snapshot().pools.length, 2);
  assert.deepEqual(rt.r.membersOf(P3), []);
  assert.deepEqual(rt.r.membersOf(PG), []);
});

test('ingestAgyTick: ONE publish for the pair, not one per observation', () => {
  const rt = runtime();
  rt.r.ingestAgyTick('phyllis-1', { ...tickAt(T0), accountScope: SCOPE });
  assert.equal(rt.changes.length, 1, 'a tick that moves both pools is still a single push');
});

test('ingestAgyTick: an INCOHERENT pair never remaps the agent', () => {
  // The agent is already gated by 3P; a tick whose observations do not belong to the
  // stated account must not move it. Evidence we cannot accept whole is not evidence.
  const rt = runtime();
  rt.r.ingestAgyTick('worker-1', { ...tickAt(T0, { model: 'Claude Sonnet 5' }), accountScope: SCOPE });
  assert.equal(rt.r.poolKeyOf('worker-1'), P3);
  rt.advance(60_000);
  const foreign = normalizeAgyStatusLine({ payload: payload(rt.now), accountScope: 'someone-else', receivedAt: rt.now });
  rt.r.ingestAgyTick('worker-1', { ...foreign, accountScope: SCOPE });   // scope disagrees
  assert.equal(rt.r.poolKeyOf('worker-1'), P3, 'still on the pool its accepted tick named');
});

test('poolKeyForAgyFamily: names either family of the account, without joining it', () => {
  const rt = runtime();
  rt.r.ingestAgyTick('phyllis-1', { ...tickAt(T0), accountScope: SCOPE });
  assert.equal(rt.r.poolKeyForAgyFamily('phyllis-1', '3p'), P3);
  assert.equal(rt.r.poolKeyForAgyFamily('phyllis-1', 'gemini'), PG);
  assert.deepEqual(rt.r.membersOf(P3), [], 'naming the sibling is not joining it');
  assert.equal(rt.r.poolKeyForAgyFamily('never-seen', '3p'), null, 'and it is never invented');
});

test('ADMISSION stays with the ACTIVE family: a 3P zero cannot block a Gemini-bound turn', () => {
  const rt = runtime();
  rt.r.ingestAgyTick('phyllis-1', { ...tickAt(T0, { threeFive: 0 }), accountScope: SCOPE });
  assert.equal(rt.r.snapshot().pools.find((p) => p.poolKey === P3).state, 'RESERVE_ONLY');
  assert.notEqual(rt.r.admit('phyllis-1').verdict, 'REFUSE',
    'the agent draws on Gemini; the 3P allowance is not its gate');
});
