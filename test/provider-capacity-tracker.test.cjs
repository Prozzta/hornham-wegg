'use strict';

/**
 * L0-CORE — ProviderCapacityTracker, against Oscar's L0-SEM
 * (research/notes/oscar-l0-sem.md, sha256 643D45C0…86CC, research 8b92e2ea).
 *
 * The clock is injected everywhere. Nothing sleeps, and nothing depends on wall
 * time, because the facts most worth pinning - staleness, TTL boundaries and "a
 * reset time passed" - are all time-derived and would otherwise need a real wait.
 *
 * Where a test name cites a ruling it is one of the four that drive the
 * reconciliation: sticky limit epochs, numeric zero is RESERVE_ONLY and not
 * LIMITED, percentages never synthesize APPROACHING, and a clock never reaches
 * AVAILABLE.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY, REASON } = loadTs('src/main/providerCapacityTracker.ts');

const T0 = 1_800_000_000_000;
const KEY = 'codex:acct-a:codex';
const RESET_5H = T0 + 3_600_000;

const win = (id, kind, remaining, resetsAt) => ({
  windowId: id,
  kind,
  label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080,
  usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining,
  resetsAt
});

function obs(over = {}) {
  return {
    poolKey: KEY,
    provider: 'codex',
    accountScope: 'acct-a',
    limitId: 'codex',
    source: 'codex-rollout',
    observedAt: T0,
    receivedAt: T0,
    windows: [win('five_hour', 'FIVE_HOUR', 80, RESET_5H), win('seven_day', 'SEVEN_DAY', 60, T0 + 86_400_000)],
    providerAttributedLimitingWindowId: null,
    providerReachedType: null,
    ordinaryUsageAllowed: null,
    planType: 'plus',
    ...over
  };
}

function make(start = T0) {
  let now = start;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return {
    t,
    // Ordinary time passing: both clocks move together, which is what actually
    // happens on a machine nobody is fiddling with.
    set: (v) => { mono += Math.max(0, v - now); now = v; },
    // The system clock alone moves - an NTP correction, a timezone change, a
    // suspended laptop, a restored VM. Monotonic time does NOT follow it.
    setWallOnly: (v) => { now = v; },
    state: () => t.pool(KEY)?.state,
    reason: () => t.pool(KEY)?.stateReason
  };
}

// ── normal predicates ────────────────────────────────────────────────────────

test('N-A: a complete fresh positive snapshot is AVAILABLE at revision 1', () => {
  const m = make();
  assert.equal(m.t.ingest(obs()), true);
  assert.equal(m.state(), 'AVAILABLE');
  assert.equal(m.t.pool(KEY).revision, 1);
  assert.equal(m.t.snapshot().collectionRevision, 1);
});

test('N-U: an incomplete snapshot is UNKNOWN even when the window it DOES have looks healthy', () => {
  const m = make();
  m.t.ingest(obs({ windows: [win('five_hour', 'FIVE_HOUR', 95, RESET_5H), win('seven_day', 'SEVEN_DAY', null, null)] }));
  assert.equal(m.state(), 'UNKNOWN');
  assert.equal(m.reason(), REASON.NO_NUMBERS);
});

test('RULING 2: a fresh numeric zero with NO attribution is RESERVE_ONLY, not LIMITED', () => {
  const m = make();
  m.t.ingest(obs({ windows: [win('five_hour', 'FIVE_HOUR', 40, RESET_5H), win('seven_day', 'SEVEN_DAY', 0, T0 + 86_400_000)] }));
  const p = m.t.pool(KEY);
  assert.equal(p.state, 'RESERVE_ONLY');
  assert.equal(p.stateReason, REASON.NUMERICALLY_EXHAUSTED);
  assert.deepEqual(p.numericallyExhaustedWindowIds, ['seven_day']);
  // The observation never becomes an attribution.
  assert.equal(p.providerAttributedLimitingWindowId, null);
});

test('RULING 3: a small POSITIVE percentage is AVAILABLE - no reserve floor, no APPROACHING', () => {
  for (const remaining of [1, 2, 3, 5, 12, 15, 20, 23]) {
    const m = make();
    m.t.ingest(obs({ windows: [win('five_hour', 'FIVE_HOUR', remaining, RESET_5H), win('seven_day', 'SEVEN_DAY', remaining, T0 + 86_400_000)] }));
    assert.equal(m.state(), 'AVAILABLE', `${remaining}% remaining must not synthesize a state`);
  }
});

test('RULING 3: APPROACHING is unreachable from any payload these adapters can produce', () => {
  const m = make();
  for (const r of [0, 1, 50, 99, 100]) {
    m.set(T0 + r);
    m.t.ingest(obs({ observedAt: T0 + r, windows: [win('five_hour', 'FIVE_HOUR', r, RESET_5H), win('seven_day', 'SEVEN_DAY', r, T0 + 86_400_000)] }));
    assert.notEqual(m.state(), 'APPROACHING');
  }
});

// ── hard evidence and the sticky epoch ───────────────────────────────────────

test('RULING 1: a typed reached signal is LIMITED and STICKY across an ordinary later reading', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage' }));
  assert.equal(m.state(), 'LIMITED');
  assert.equal(m.reason(), REASON.PROVIDER_REACHED_UNATTRIBUTED);
  // A later quiet rollout event - no reached field - must not clear a real refusal
  // by itself. Only the three confirmations in section 5 do that, and this snapshot
  // is not one: it is fresh, but it arrives with every window positive… which IS K3.
  // So use a snapshot that is NOT authoritative recovery: one window still at zero.
  m.set(T0 + 1000);
  m.t.ingest(obs({ observedAt: T0 + 1000, windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H), win('seven_day', 'SEVEN_DAY', 50, T0 + 86_400_000)] }));
  assert.equal(m.state(), 'LIMITED');
});

test('explicit ordinaryUsageAllowed=false is LIMITED with its own reason', () => {
  const m = make();
  m.t.ingest(obs({ ordinaryUsageAllowed: false }));
  assert.equal(m.state(), 'LIMITED');
  assert.equal(m.reason(), REASON.ORDINARY_USE_DENIED);
});

test('attribution and exhaustion coexist on DIFFERENT windows without either rewriting the other', () => {
  const m = make();
  m.t.ingest(obs({
    windows: [win('five_hour', 'FIVE_HOUR', 30, RESET_5H), win('seven_day', 'SEVEN_DAY', 0, T0 + 86_400_000)],
    providerReachedType: 'primary',
    providerAttributedLimitingWindowId: 'five_hour'
  }));
  const p = m.t.pool(KEY);
  assert.equal(p.state, 'LIMITED');
  assert.equal(p.stateReason, REASON.PROVIDER_ATTRIBUTED);
  // The provider named the five-hour window while it still reads 30%. The number is
  // kept as observed; the provider is not "corrected" from the percentage.
  assert.equal(p.providerAttributedLimitingWindowId, 'five_hour');
  assert.equal(p.windows.find((w) => w.windowId === 'five_hour').remainingPercent, 30);
  assert.deepEqual(p.numericallyExhaustedWindowIds, ['seven_day']);
});

test('a pool-scoped typed refusal invents no window attribution', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage', providerAttributedLimitingWindowId: null }));
  assert.equal(m.t.pool(KEY).providerAttributedLimitingWindowId, null);
});

test('a STALE reading never clears a limit epoch', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage' }));
  m.set(T0 + L0_SEM_POLICY.liveTtlMs + 1);
  m.t.evaluate();
  assert.equal(m.state(), 'LIMITED');
});

// ── recovery ─────────────────────────────────────────────────────────────────

test('RULING 4: a passed reset time reaches RECOVERING and never AVAILABLE', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'primary', providerAttributedLimitingWindowId: 'five_hour' }));
  m.set(RESET_5H + 1);
  assert.equal(m.t.evaluate(), true);
  const p = m.t.pool(KEY);
  assert.equal(p.state, 'RECOVERING');
  assert.equal(p.stateReason, REASON.RECOVERY_HINT_UNCONFIRMED);
  assert.equal(p.recoveryPending, true);
  // And it stays there with time alone, however much passes.
  m.set(RESET_5H + 86_400_000);
  m.t.evaluate();
  assert.equal(m.state(), 'RECOVERING');
});

test('K1: explicit permission, strictly newer, clears the epoch', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage' }));
  m.set(T0 + 1000);
  m.t.ingest(obs({ observedAt: T0 + 1000, ordinaryUsageAllowed: true }));
  assert.equal(m.state(), 'AVAILABLE');
});

test('K1 at the SAME ordering key as the refusal cannot confirm anything', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage' }));
  m.t.ingest(obs({ observedAt: T0, ordinaryUsageAllowed: true }));
  assert.equal(m.state(), 'LIMITED');
});

test('K1 plus a fresh ZERO clears the refusal and lands on RESERVE_ONLY, not AVAILABLE', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage' }));
  m.set(T0 + 1000);
  m.t.ingest(obs({
    observedAt: T0 + 1000,
    ordinaryUsageAllowed: true,
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H), win('seven_day', 'SEVEN_DAY', 40, T0 + 86_400_000)]
  }));
  assert.equal(m.state(), 'RESERVE_ONLY');
});

test('K2: a successful real turn confirms recovery but proves NO headroom - UNKNOWN, not AVAILABLE', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage' }));
  // Let the reading go stale so the only fact left is the successful turn.
  m.set(T0 + L0_SEM_POLICY.liveTtlMs + 1);
  m.t.evaluate();
  m.t.noteSuccessfulTurn(KEY, T0 + L0_SEM_POLICY.liveTtlMs);
  assert.equal(m.state(), 'UNKNOWN');
  assert.equal(m.reason(), REASON.STALE);
});

test('K3: a fresh authoritative snapshot with every window positive clears the epoch', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage' }));
  m.set(T0 + 2000);
  m.t.ingest(obs({ observedAt: T0 + 2000 }));
  assert.equal(m.state(), 'AVAILABLE');
});

test('new hard evidence during RECOVERING returns immediately to LIMITED', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage' }));
  m.set(RESET_5H + 1);
  m.t.evaluate();
  assert.equal(m.state(), 'RECOVERING');
  m.t.ingest(obs({ observedAt: RESET_5H + 2, receivedAt: RESET_5H + 2, providerReachedType: 'usage' }));
  assert.equal(m.state(), 'LIMITED');
});

test('a re-anchored reset time is a HINT, not a confirmation', () => {
  const m = make();
  m.t.ingest(obs({ providerReachedType: 'usage', windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H)] }));
  assert.equal(m.state(), 'LIMITED');
  m.set(T0 + 1000);
  m.t.ingest(obs({ observedAt: T0 + 1000, windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H + 999_000)] }));
  assert.equal(m.state(), 'RECOVERING');
});

// ── freshness ────────────────────────────────────────────────────────────────

test('live TTL boundary: fresh AT the TTL, stale one millisecond past it', () => {
  const at = make();
  at.t.ingest(obs());
  at.set(T0 + L0_SEM_POLICY.liveTtlMs);
  at.t.evaluate();
  assert.equal(at.t.pool(KEY).freshness, 'FRESH');
  at.set(T0 + L0_SEM_POLICY.liveTtlMs + 1);
  at.t.evaluate();
  assert.equal(at.t.pool(KEY).freshness, 'STALE');
  assert.equal(at.state(), 'UNKNOWN');
  // The figures survive as diagnostics; they are simply no longer current.
  assert.equal(at.t.pool(KEY).windows.length, 2);
});

test('the account read gets its own longer TTL', () => {
  const m = make();
  m.t.ingest(obs({ source: 'codex-account-read' }));
  m.set(T0 + L0_SEM_POLICY.liveTtlMs + 1);
  m.t.evaluate();
  assert.equal(m.t.pool(KEY).freshness, 'FRESH');
  m.set(T0 + L0_SEM_POLICY.accountReadTtlMs + 1);
  m.t.evaluate();
  assert.equal(m.t.pool(KEY).freshness, 'STALE');
});

test('a BACKWARDS wall-clock move cannot revive an expired reading', () => {
  const m = make();
  m.t.ingest(obs());
  // Let it expire honestly.
  m.set(T0 + L0_SEM_POLICY.liveTtlMs + 1);
  m.t.evaluate();
  assert.equal(m.t.pool(KEY).freshness, 'STALE');
  assert.equal(m.state(), 'UNKNOWN');
  // Now the system clock jumps BACK to before the reading was taken. Under a
  // wall-clock freshness test this reading would read as fresh again - which is the
  // single thing this design says must never happen. The deadline is monotonic, so
  // it does not move.
  m.setWallOnly(T0 - 3_600_000);
  m.t.evaluate();
  assert.equal(m.t.pool(KEY).freshness, 'STALE', 'a clock moved backwards must not make stale data healthy');
  assert.equal(m.state(), 'UNKNOWN');
});

test('a FORWARD wall-clock jump does not expire a reading that is genuinely current', () => {
  const m = make();
  m.t.ingest(obs());
  assert.equal(m.t.pool(KEY).freshness, 'FRESH');
  // An NTP correction of an hour, one second after the reading arrived. No real
  // time has passed, so the reading is still current and must stay so.
  m.setWallOnly(T0 + 3_600_000);
  m.t.evaluate();
  assert.equal(m.t.pool(KEY).freshness, 'FRESH', 'a clock moved forwards must not expire current data');
  assert.equal(m.state(), 'AVAILABLE');
});

test('a reading that is ALREADY past its TTL on arrival is stale immediately', () => {
  const m = make(T0 + L0_SEM_POLICY.liveTtlMs + 5000);
  // Accepted now, but the event happened more than a TTL ago: the remaining budget
  // is negative, so the deadline lands in the past.
  m.t.ingest(obs({ observedAt: T0, receivedAt: T0 }));
  assert.equal(m.t.pool(KEY).freshness, 'STALE');
  assert.equal(m.reason(), REASON.STALE);
});

test('a timestamp far in the future is INVALID, not extremely fresh', () => {
  const m = make();
  assert.equal(m.t.ingest(obs({ observedAt: T0 + L0_SEM_POLICY.futureSkewMs + 1 })), false);
  assert.equal(m.t.pool(KEY), null);
});

// ── ordering, duplicates, revisions ──────────────────────────────────────────

test('an out-of-order reading is ignored and cannot undo a newer refusal', () => {
  const m = make();
  m.t.ingest(obs({ observedAt: T0 + 5000, providerReachedType: 'usage' }));
  assert.equal(m.t.ingest(obs({ observedAt: T0 })), false);
  assert.equal(m.state(), 'LIMITED');
});

test('an exact duplicate is a no-op at both revision levels', () => {
  const m = make();
  m.t.ingest(obs());
  const before = m.t.snapshot().collectionRevision;
  assert.equal(m.t.ingest(obs()), false);
  assert.equal(m.t.snapshot().collectionRevision, before);
  assert.equal(m.t.pool(KEY).revision, 1);
});

test('identical renewals are coalesced: the published anchor moves at most once per window', () => {
  const m = make();
  m.t.ingest(obs());
  const rev = m.t.pool(KEY).revision;
  // Four renewals inside the coalescing window: same values, later timestamps.
  for (let i = 1; i <= 4; i += 1) {
    m.set(T0 + i * 5000);
    m.t.ingest(obs({ observedAt: T0 + i * 5000, receivedAt: T0 + i * 5000 }));
  }
  assert.equal(m.t.pool(KEY).revision, rev, 'renewals inside the window must not bump the revision');
  // Past the window, one publication is allowed.
  m.set(T0 + L0_SEM_POLICY.anchorCoalesceMs + 1);
  m.t.ingest(obs({ observedAt: T0 + L0_SEM_POLICY.anchorCoalesceMs + 1, receivedAt: T0 + L0_SEM_POLICY.anchorCoalesceMs + 1 }));
  assert.equal(m.t.pool(KEY).revision, rev + 1);
});

test('a renewal still refreshes freshness immediately, even while the anchor is coalesced', () => {
  const m = make();
  m.t.ingest(obs());
  // Renew just before the TTL would have expired the first reading.
  m.set(T0 + 119_000);
  m.t.ingest(obs({ observedAt: T0 + 119_000, receivedAt: T0 + 119_000 }));
  m.set(T0 + 121_000);
  m.t.evaluate();
  assert.equal(m.t.pool(KEY).freshness, 'FRESH', 'a renewed reading must not expire on the first timestamp');
});

test('a same-key CONFLICT invalidates the facts instead of merging two stories', () => {
  const m = make();
  m.t.ingest(obs());
  const different = obs({ windows: [win('five_hour', 'FIVE_HOUR', 10, RESET_5H), win('seven_day', 'SEVEN_DAY', 60, T0 + 86_400_000)] });
  assert.equal(m.t.ingest(different), true);
  assert.equal(m.state(), 'UNKNOWN');
  assert.equal(m.reason(), REASON.CONFLICT);
});

test('a same-key conflict carrying HARD evidence is risk-dominant and wins', () => {
  const m = make();
  m.t.ingest(obs());
  m.t.ingest(obs({ ordinaryUsageAllowed: false }));
  assert.equal(m.state(), 'LIMITED');
});

test('a changed figure bumps both revisions; five pools each move the collection', () => {
  const m = make();
  m.t.ingest(obs());
  m.t.ingest(obs({ observedAt: T0 + 1, windows: [win('five_hour', 'FIVE_HOUR', 70, RESET_5H), win('seven_day', 'SEVEN_DAY', 60, T0 + 86_400_000)] }));
  assert.equal(m.t.pool(KEY).revision, 2);
  for (let i = 0; i < 4; i += 1) {
    m.t.ingest(obs({ poolKey: `codex:acct-${i}:codex`, accountScope: `acct-${i}` }));
  }
  assert.equal(m.t.snapshot().pools.length, 5);
  assert.equal(m.t.snapshot().collectionRevision, 6);
});

test('forget() removes a pool and moves the collection revision', () => {
  const m = make();
  m.t.ingest(obs());
  const before = m.t.snapshot().collectionRevision;
  assert.equal(m.t.forget(KEY), true);
  assert.equal(m.t.snapshot().pools.length, 0);
  assert.equal(m.t.snapshot().collectionRevision, before + 1);
  assert.equal(m.t.forget(KEY), false);
});

// ── what must NOT be here ────────────────────────────────────────────────────

test('no display threshold, no reserve floor and no forecast reaches this tracker', () => {
  const keys = Object.keys(L0_SEM_POLICY).join(' ').toLowerCase();
  for (const banned of ['threshold', 'reserve', 'approach', 'forecast', 'ratio']) {
    assert.equal(keys.includes(banned), false, `policy must not carry a "${banned}" input`);
  }
});

test('the projection exposes no binding/tighter/headroom vocabulary', () => {
  const m = make();
  m.t.ingest(obs());
  const keys = Object.keys(m.t.pool(KEY)).join(' ').toLowerCase();
  for (const banned of ['binding', 'tighter', 'headroom', 'safer']) {
    assert.equal(keys.includes(banned), false, `projection must not expose a "${banned}" field`);
  }
});

// ── L0-DEF3: published state is not a scratch pad, and revisions never go back ──

test('a pool removed and seen again RESUMES its revision instead of restarting', () => {
  const m = make();
  m.t.ingest(obs());
  m.set(T0 + 1_000);
  m.t.ingest(obs({ observedAt: T0 + 1_000, receivedAt: T0 + 1_000,
    windows: [win('five_hour', 'FIVE_HOUR', 70, RESET_5H), win('seven_day', 'SEVEN_DAY', 60, T0 + 86_400_000)] }));
  const before = m.t.pool(KEY).revision;
  assert.ok(before >= 2, 'two distinct readings published two revisions');

  assert.equal(m.t.forget(KEY), true);
  m.set(T0 + 2_000);
  m.t.ingest(obs({ observedAt: T0 + 2_000, receivedAt: T0 + 2_000 }));

  const after = m.t.pool(KEY).revision;
  assert.ok(
    after > before,
    `a re-added pool keeps counting (${before} -> ${after}); restarting at 1 makes a consumer `
    + 'holding the old number discard every update until the count catches up'
  );
});

test('a published projection cannot be edited by whoever reads it', () => {
  const m = make();
  m.t.ingest(obs());
  const pool = m.t.pool(KEY);
  assert.equal(pool.state, 'AVAILABLE');

  assert.throws(() => { pool.state = 'LIMITED'; }, TypeError, 'the pool object itself is sealed');
  assert.throws(() => { pool.windows[0].remainingPercent = 0; }, TypeError, 'and so is each window');
  assert.throws(() => { pool.windows.push(win('x', 'OTHER', 5, null)); }, TypeError, 'and the window list');

  // The authoritative state is what it always was, with no revision spent.
  assert.equal(m.t.pool(KEY).state, 'AVAILABLE');
  assert.equal(m.t.pool(KEY).windows[0].remainingPercent, 80);
  assert.equal(m.t.pool(KEY).revision, pool.revision);
});

test('the collection handed out is sealed the same way', () => {
  const m = make();
  m.t.ingest(obs());
  const snap = m.t.snapshot();
  assert.throws(() => { snap.pools[0].freshness = 'FRESH'; }, TypeError);
  assert.equal(m.t.snapshot().pools[0].freshness, m.t.pool(KEY).freshness);
});

test('an invalid NEGATIVE percentage reaching the tracker is UNKNOWN, never AVAILABLE', () => {
  // The normaliser rejects it at the source; this is the tracker's own arm of the
  // same rule, so a future collector cannot reintroduce the defect downstream.
  const m = make();
  m.t.ingest(obs({ windows: [win('five_hour', 'FIVE_HOUR', null, RESET_5H), win('seven_day', 'SEVEN_DAY', 60, T0 + 86_400_000)] }));
  assert.equal(m.state(), 'UNKNOWN');
  assert.equal(m.reason(), REASON.NO_NUMBERS);
});
