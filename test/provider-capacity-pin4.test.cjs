'use strict';

/**
 * L0-FIX6 — the two source corrections from Oscar section 15, frozen at research
 * `55f5dbd` (36,700 B / 276 lines / 1E5BFBFF…725D).
 *
 * Both overturn rulings that had gone in my favour, and both were residuals I
 * declared rather than defects anyone found. The first is a counting rule: one
 * accepted ingest is ONE publication. The second is the harder one — "checked only
 * on arrival" is not an accepted residual, and the fix has to be a PROVED bound on
 * what a timer can add, because a measurement of today's fixture is not a bound on
 * growth. The proof is an enumeration of the fields a re-projection can move, so the
 * load-bearing test here is the one that shows the enumeration is COMPLETE.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS, REASON,
  TIMER_GROWTH_RESERVE_PER_POOL, TIMER_GROWTH_RESERVE_COLLECTION
} = loadTs('src/main/providerCapacityTracker.ts');
const { CAPACITY_STATES } = loadTs('src/shared/providerCapacity.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');

const T0 = 1_800_000_000_000;
const RESET_5H = T0 + 3_600_000;

const win = (id, remaining, resetsAt = RESET_5H) => ({
  windowId: id, kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining, resetsAt
});

const obs = (over = {}) => ({
  poolKey: 'codex:acct-a:codex', provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 's', sourceSequence: 1,
  observedAt: T0, receivedAt: T0, windows: [win('five_hour', 80)],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

/**
 * An observation padded to EXACTLY `bytes` serialized bytes.
 *
 * `pad` exists because a test that greps for a short string finds every fixture
 * padded with it, including the ones that were legitimately admitted. Giving the
 * reading under test its own filler is what lets an absence assertion mean anything.
 */
function sizedTo(poolKey, scope, bytes, over = {}, pad = 'x') {
  const o = obs({ poolKey, accountScope: scope, ...over });
  o.windows[0].label = pad;
  while (JSON.stringify(o).length < bytes) {
    o.windows[0].label += pad.repeat(Math.max(1, bytes - JSON.stringify(o).length));
  }
  while (JSON.stringify(o).length > bytes && o.windows[0].label.length > 1) {
    o.windows[0].label = o.windows[0].label.slice(0, -1);
  }
  assert.equal(JSON.stringify(o).length, bytes, 'the fixture must be exactly the size it claims');
  return o;
}

function tracker() {
  let now = T0;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return { t, set: (v) => { mono += Math.max(0, v - now); now = v; } };
}

// ═══════════════════════════════════════════════════════════════════════════
// §15 item 1 — one accepted ingest is ONE publication
// ═══════════════════════════════════════════════════════════════════════════

/** 31 maximal pools plus one small pool: full, legal, and one growth from the edge. */
function nearFull() {
  const { t } = tracker();
  for (let i = 0; i < RETENTION_CAPS.maxPools - 1; i += 1) {
    t.ingest(sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes));
  }
  t.ingest(sizedTo('codex:target:limit-1', 'target', 1_500));
  assert.equal(t.pool('codex:target:limit-1').state, 'AVAILABLE', 'the small pool was admitted whole');
  return t;
}

test('FIX6/1: a collection-breaching ingest advances BOTH revisions exactly ONCE', () => {
  // The defect: the implementation published the full projection, found the
  // collection over budget, substituted the bounded stand-in and published AGAIN.
  // Oscar's ruling names `collectionRevision`; the pool revision had the identical
  // double advance from the identical cause, so both are asserted here.
  const t = nearFull();
  const KEY = 'codex:target:limit-1';
  const beforeCollection = t.snapshot().collectionRevision;
  const beforePool = t.pool(KEY).revision;

  t.ingest(sizedTo(KEY, 'target', RETENTION_CAPS.maxPoolBytes, {
    observedAt: T0 + 5_000, receivedAt: T0 + 5_000, sourceSequence: 7
  }));

  assert.equal(t.pool(KEY).state, 'UNKNOWN', 'this really is the breach path, not a quiet accept');
  assert.equal(t.pool(KEY).windows.length, 0, 'and the oversized reading really was refused');
  assert.equal(t.snapshot().collectionRevision - beforeCollection, 1, 'collectionRevision advanced once');
  assert.equal(t.pool(KEY).revision - beforePool, 1, 'and so did the pool revision');
});

test('FIX6/1: an ORDINARY accepted ingest still advances once — not zero', () => {
  // The pair. "Advances exactly once" is trivially satisfied on the breach path by
  // an implementation that stopped publishing at all, so the ordinary path has to be
  // shown moving too, and by the same single step.
  const { t } = tracker();
  t.ingest(obs());
  const c0 = t.snapshot().collectionRevision;
  const r0 = t.pool('codex:acct-a:codex').revision;

  t.ingest(obs({ observedAt: T0 + 1_000, receivedAt: T0 + 1_000, windows: [win('five_hour', 40)] }));
  assert.equal(t.snapshot().collectionRevision - c0, 1);
  assert.equal(t.pool('codex:acct-a:codex').revision - r0, 1);
});

test('FIX6/1: the intermediate full projection is NEVER published', () => {
  // The reason the count matters at all: a second increment means a revision existed
  // that carried a payload the cap had already refused.
  const t = nearFull();
  const KEY = 'codex:target:limit-1';
  const before = t.snapshot().collectionRevision;
  // Its OWN filler, distinct from the 'x' every admitted fixture carries, so the
  // absence assertion below is about this reading and not about the collection.
  t.ingest(sizedTo(KEY, 'target', RETENTION_CAPS.maxPoolBytes, {
    observedAt: T0 + 5_000, receivedAt: T0 + 5_000, sourceSequence: 7
  }, 'Q'));
  const after = t.snapshot();
  assert.equal(after.collectionRevision, before + 1, 'exactly one publication happened');
  assert.equal(
    JSON.stringify(after).includes('QQQ'),
    false,
    'no revision ever carried the payload the cap refused'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// §15 item 2 — the reserve, and the proof that its enumeration is complete
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The fields a re-projection may move with the observation held fixed. The reserve
 * is computed from exactly these; if anything else can move, the reserve does not
 * bound it and the arithmetic is not a proof.
 */
const TIMER_MOVABLE = new Set([
  'state', 'stateReason', 'freshness', 'ageMs', 'revision', 'recoveryPending', 'limitEpochAt'
]);

/** Fire the runtime's own armed boundary; nothing else here moves the clock. */
function rig() {
  let now = T0;
  let mono = 0;
  let pending = null;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  const runtime = new CapacityRuntime({
    deliver: () => {},
    now: () => now,
    setTimer: (fn, ms) => { pending = { fn, ms }; return { ms, unref() { return this; } }; },
    clearTimer: () => { pending = null; }
  }, t);
  return {
    tracker: t, runtime,
    armed: () => (pending ? pending.ms : null),
    fire: () => {
      if (!pending) return false;
      const { fn, ms } = pending;
      pending = null;
      now += ms; mono += ms;
      fn();
      return true;
    }
  };
}

test('FIX6/2: NOTHING outside the enumerated set moves on a timer — the proof is complete', () => {
  // THE LOAD-BEARING TEST. The reserve is arithmetic over closed sets, and that
  // arithmetic only bounds growth if the set of fields that can move is the set I
  // enumerated. So drive real boundaries with NO new reading and collect every field
  // that ever differs between consecutive publications.
  const moved = new Set();
  for (const arm of ['healthy', 'limited']) {
    const r = rig();
    const KEY = 'codex:acct-a:codex';
    r.runtime.ingest('jim', obs());
    if (arm === 'limited') {
      r.runtime.ingest('jim', obs({
        observedAt: T0 + 1_000, receivedAt: T0 + 1_000,
        providerReachedType: 'rate_limit_reached',
        windows: [win('five_hour', 0)]
      }));
    }
    let prev = r.tracker.pool(KEY);
    for (let i = 0; i < 12 && r.fire(); i += 1) {
      const now = r.tracker.pool(KEY);
      for (const key of Object.keys(now)) {
        if (JSON.stringify(now[key]) !== JSON.stringify(prev[key])) moved.add(key);
      }
      prev = now;
    }
  }

  assert.ok(moved.size > 0, 'a timer really did change something, or this proves nothing');
  const unexpected = [...moved].filter((k) => !TIMER_MOVABLE.has(k));
  assert.deepEqual(unexpected, [], `fields moved that the reserve does not account for: ${unexpected}`);
});

test('FIX6/2: the reserve is DERIVED from the enumerations, not a magic number', () => {
  // If a longer reason constant is added later the reserve must widen by itself.
  // Recomputed here independently rather than compared against a literal.
  const spread = (values) => {
    const lengths = values.map((v) => v.length);
    return Math.max(...lengths) - Math.min(...lengths);
  };
  const expected = spread(CAPACITY_STATES) + spread(Object.values(REASON)) + 16 * 3;
  assert.equal(TIMER_GROWTH_RESERVE_PER_POOL, expected);
  assert.ok(TIMER_GROWTH_RESERVE_PER_POOL > 0, 'a zero reserve would reserve nothing');
  assert.ok(TIMER_GROWTH_RESERVE_COLLECTION > 0);
});

test('FIX6/2: a timer cannot put an admitted collection over the ceiling', () => {
  // The property Oscar actually requires: the cap applies to EVERY publication.
  // Admit right up to the edge, then let time run and check the ceiling at every
  // publication rather than only at the end.
  const r = rig();
  for (let i = 0; i < RETENTION_CAPS.maxPools - 1; i += 1) {
    r.runtime.ingest(`a${i}`, sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes, {
      providerReachedType: i % 2 === 0 ? 'rate_limit_reached' : null,
      windows: [win('five_hour', i % 2 === 0 ? 0 : 80)]
    }));
  }
  const atAdmission = JSON.stringify(r.tracker.snapshot()).length;
  assert.ok(atAdmission <= RETENTION_CAPS.maxCollectionBytes, 'admitted within the ceiling');

  let peak = atAdmission;
  for (let i = 0; i < 25 && r.fire(); i += 1) {
    peak = Math.max(peak, JSON.stringify(r.tracker.snapshot()).length);
  }
  assert.ok(peak > 0);
  assert.ok(
    peak <= RETENTION_CAPS.maxCollectionBytes,
    `a timer grew the published collection to ${peak}, ceiling ${RETENTION_CAPS.maxCollectionBytes}`
  );
});

test('FIX6/2: no pool is ever SENTINELLED by the passage of time', () => {
  // The half of the ruling that was upheld: a timer must not destroy an admitted
  // reading, because nothing arrived to cause it. The reserve exists precisely so
  // that this stays true while the ceiling still holds.
  const r = rig();
  const keys = [];
  for (let i = 0; i < RETENTION_CAPS.maxPools - 1; i += 1) {
    const k = `codex:acct-${i}:limit-1`;
    keys.push(k);
    r.runtime.ingest(`a${i}`, sizedTo(k, `acct-${i}`, RETENTION_CAPS.maxPoolBytes));
  }
  for (const k of keys) assert.equal(r.tracker.pool(k).windows.length, 1, 'admitted with its reading');

  for (let i = 0; i < 25 && r.fire(); i += 1) { /* let real boundaries pass */ }

  for (const k of keys) {
    assert.equal(r.tracker.pool(k).windows.length, 1, `${k} kept its reading across every boundary`);
    assert.notEqual(r.tracker.pool(k).capBreach, 'COLLECTION_BYTES_EXCEEDED', `${k} was not timer-sentinelled`);
  }
});

test('FIX6/2: the reserve does not refuse a collection that plainly fits', () => {
  // The pair for the whole item. Reserving headroom is trivially "safe" for an
  // implementation that admits nothing, so a modest collection must still be
  // retained whole, at full size.
  const { t } = tracker();
  for (let i = 0; i < 8; i += 1) {
    t.ingest(sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes));
  }
  const snap = t.snapshot();
  assert.equal(snap.pools.filter((p) => p.state === 'UNKNOWN').length, 0);
  for (const p of snap.pools) assert.equal(p.windows.length, 1);
  assert.ok(JSON.stringify(snap).length > RETENTION_CAPS.maxPoolBytes * 8, 'the bytes are really there');
});

test('FIX6/2: the reserve is charged per RETAINED pool, so it scales with the collection', () => {
  // A flat reserve would be wrong in both directions: too large for a small
  // collection and too small for a full one. Two collections, different sizes, both
  // admitted and both inside the ceiling with their own reserve subtracted.
  for (const count of [4, 16]) {
    const { t } = tracker();
    for (let i = 0; i < count; i += 1) {
      t.ingest(sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes));
    }
    const snap = t.snapshot();
    assert.equal(snap.pools.length, count);
    assert.ok(
      JSON.stringify(snap).length + TIMER_GROWTH_RESERVE_PER_POOL * count <= RETENTION_CAPS.maxCollectionBytes,
      `${count} pools left no room for their own timer growth`
    );
  }
});
