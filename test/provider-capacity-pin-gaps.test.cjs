'use strict';

/**
 * L0-PIN-GAPS — four requirements from the L0-CONFORM map (research `0d8c903`) that
 * the oracle states normatively and no test asserted.
 *
 * Each block says what its arms DISCRIMINATE and, where one exists, names the wrong
 * implementation it kills. Two of the four describe subsystems that do not exist
 * yet; those arms are labelled TRIPWIRE rather than dressed up as behavioural pins,
 * because a bound is trivially true of nothing and saying otherwise would retire the
 * question instead of holding it open.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { CapacityNotifier } = loadTs('src/main/capacityNotify.ts');
const { CapacityAdmission } = loadTs('src/main/capacityAdmission.ts');

const T0 = 1_800_000_000_000;
const KEY = 'codex:acct-a:codex';

const win = (over = {}) => ({
  windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: 20, remainingPercent: 80, resetsAt: T0 + 3_600_000, ...over
});

const obs = (over = {}) => ({
  poolKey: KEY, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s.jsonl', sourceSequence: 1,
  observedAt: T0, receivedAt: T0, windows: [win()],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

/** A tracker whose clocks this test owns. */
function tracker(start = T0) {
  let now = start;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return { t, advance: (ms) => { now += ms; mono += ms; }, at: () => now };
}

// ═══════════════════════════════════════════════════════════════════════════
// U1 — L0-SEM 11.1: a reset boundary is a hint only when it was PROSPECTIVE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §11.1 asks for these IN TERMS: "Add fixtures for both past-at-arrival branches and
 * for a new refusal during RECOVERING carrying its already-expired boundary."
 *
 * NO RED-TO-GREEN HERE AND NONE IS MANUFACTURED. The behaviour was verified
 * conformant on all four ingestion rows before these were written; the rule lives at
 * `nextResetBoundary`, which skips any window whose `resetsAt <= epoch.evidenceAt`.
 * What these arms discriminate is a FUTURE loss: delete that one comparison and rows
 * 1 and 4 below fail by name. A requirement can be implemented correctly and still
 * be one refactor from silent loss, which is the whole reason this card exists.
 */
function refusalAt(F, R) {
  return obs({
    observedAt: F, receivedAt: F, sourceSequence: 2,
    windows: [win({ usedPercent: 100, remainingPercent: 0, resetsAt: R })],
    providerAttributedLimitingWindowId: 'five_hour',
    providerReachedType: 'rate_limit_reached'
  });
}

/** A healthy baseline, then the refusal, evaluated at `nowAt`. */
function ingestRefusal(F, R, nowAt) {
  const rig = tracker();
  rig.t.ingest(obs({ observedAt: F - 2_000, receivedAt: F - 2_000 }));
  rig.advance(nowAt - T0);
  rig.t.ingest(refusalAt(F, R));
  return rig.t.pool(KEY);
}

test('U1/11.1: a boundary ALREADY PAST at the refusal is not a hint — stays LIMITED', () => {
  // Row 1. The provider refused knowing the boundary had gone, so it is not news
  // about that refusal. KILLS: `resetsAt <= now` as the hint test, which would see a
  // passed boundary and hand out RECOVERING on the strength of the refusal's own
  // stale reset time.
  const p = ingestRefusal(T0 + 100_000, T0 + 50_000, T0 + 100_000);
  assert.equal(p.state, 'LIMITED');
  assert.equal(p.recoveryPending, false, 'no recovery is pending on a retrospective boundary');
});

test('U1/11.1: a boundary PROSPECTIVE at the refusal and passed since DOES hint', () => {
  // Row 2, and the arm that stops row 1 being satisfied by "never hint at all".
  const p = ingestRefusal(T0 + 100_000, T0 + 150_000, T0 + 200_000);
  assert.equal(p.state, 'RECOVERING');
  assert.equal(p.recoveryPending, true);
});

test('U1/11.1: a boundary still AHEAD, and a MISSING boundary, both stay LIMITED', () => {
  // Rows 3 and 4. Row 4 is the second arm that a deleted comparison breaks.
  assert.equal(ingestRefusal(T0 + 100_000, T0 + 900_000, T0 + 100_000).state, 'LIMITED');
  assert.equal(ingestRefusal(T0 + 100_000, null, T0 + 100_000).state, 'LIMITED');
});

test('U1/11.1: a NEW refusal during RECOVERING carrying an expired boundary returns to LIMITED', () => {
  // The third fixture §11.1 names. KILLS: hint state surviving across epochs — an
  // implementation that kept `hinted` from the old epoch would bounce straight back
  // to RECOVERING on a refusal that carries nothing but a dead reset time.
  const rig = tracker();
  rig.t.ingest(obs());
  rig.advance(100_000);
  rig.t.ingest(refusalAt(T0 + 100_000, T0 + 150_000));
  rig.advance(100_000);
  rig.t.evaluate();
  assert.equal(rig.t.pool(KEY).state, 'RECOVERING', 'precondition: genuinely recovering');

  // A newer refusal whose carried boundary was already past when IT was recorded.
  const F2 = rig.at() + 10_000;
  rig.advance(10_000);
  rig.t.ingest(obs({
    observedAt: F2, receivedAt: F2, sourceSequence: 9,
    windows: [win({ usedPercent: 100, remainingPercent: 0, resetsAt: F2 - 5_000 })],
    providerAttributedLimitingWindowId: 'five_hour',
    providerReachedType: 'rate_limit_reached'
  }));
  assert.equal(rig.t.pool(KEY).state, 'LIMITED', 'the new epoch does not inherit the old hint');
  assert.equal(rig.t.pool(KEY).recoveryPending, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// U2 — L0-SEM 3: the four IMPOSSIBLE edges into RECOVERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §3: "'Impossible' is normative: implementation must not emit that edge." Every
 * other RECOVERING test in the suite starts from an established epoch, so nothing
 * asserted that a pool with NO epoch can never reach RECOVERING.
 *
 * KILLS: recovery keyed on "a reset boundary passed" rather than on "an unresolved
 * limit epoch exists". That implementation is plausible — the boundary is the
 * observable thing — and it would move a never-limited pool to RECOVERING the moment
 * its reset time went by.
 */
test('U2/3: AVAILABLE never reaches RECOVERING, however many resets pass', () => {
  const rig = tracker();
  rig.t.ingest(obs({ windows: [win({ resetsAt: T0 + 60_000 })] }));
  assert.equal(rig.t.pool(KEY).state, 'AVAILABLE');
  for (let i = 0; i < 6; i += 1) {
    rig.advance(60_000);
    rig.t.evaluate();
    assert.notEqual(rig.t.pool(KEY).state, 'RECOVERING', `after ${i + 1} boundaries`);
  }
});

test('U2/3: UNKNOWN never reaches RECOVERING', () => {
  const rig = tracker();
  rig.t.ingest(obs({ windows: [win({ usedPercent: null, remainingPercent: null, resetsAt: T0 + 60_000 })] }));
  assert.equal(rig.t.pool(KEY).state, 'UNKNOWN', 'precondition');
  for (let i = 0; i < 6; i += 1) {
    rig.advance(60_000);
    rig.t.evaluate();
    assert.notEqual(rig.t.pool(KEY).state, 'RECOVERING', `after ${i + 1} boundaries`);
  }
});

test('U2/3: RESERVE_ONLY never reaches RECOVERING — exhaustion is not a limit epoch', () => {
  // §3's own wording for this cell: "numeric exhaustion without a limit epoch is not
  // recovery." A zero window carries a reset time, so this is the edge most likely
  // to be emitted by accident.
  const rig = tracker();
  rig.t.ingest(obs({ windows: [win({ usedPercent: 100, remainingPercent: 0, resetsAt: T0 + 60_000 })] }));
  assert.equal(rig.t.pool(KEY).state, 'RESERVE_ONLY', 'precondition');
  for (let i = 0; i < 6; i += 1) {
    rig.advance(60_000);
    rig.t.evaluate();
    assert.notEqual(rig.t.pool(KEY).state, 'RECOVERING', `after ${i + 1} boundaries`);
  }
});

test('U2/3: the APPROACHING edge is VACUOUS, and that is recorded rather than faked', () => {
  // APPROACHING is unreachable from any payload these adapters can produce (§2, and
  // `RULING 3: APPROACHING is unreachable from any payload these adapters can
  // produce`). The edge therefore cannot be exercised, and constructing a fake
  // APPROACHING pool to "cover" it would assert something about a state the system
  // cannot enter. What IS assertable is the premise the vacuity rests on.
  const rig = tracker();
  for (const remaining of [99, 50, 5, 1]) {
    rig.t.ingest(obs({
      observedAt: T0 + remaining, receivedAt: T0 + remaining, sourceSequence: 100 + remaining,
      windows: [win({ usedPercent: 100 - remaining, remainingPercent: remaining })]
    }));
    assert.notEqual(rig.t.pool(KEY).state, 'APPROACHING',
      `${remaining}% remaining must not synthesize APPROACHING`);
  }
});

test('U2/3: and the edge IS reachable from LIMITED — the four above are not vacuous', () => {
  // The pair for the whole block. "Never RECOVERING" is trivially satisfied by an
  // implementation that never recovers at all.
  const rig = tracker();
  rig.t.ingest(obs());
  // The refusal's clock must have arrived: a timestamp 100 s ahead of `now` is past
  // the 30 s future skew and would be rejected, not accepted-and-latched.
  rig.advance(100_000);
  rig.t.ingest(refusalAt(T0 + 100_000, T0 + 150_000));
  assert.equal(rig.t.pool(KEY).state, 'LIMITED', 'precondition: the refusal was accepted');
  rig.advance(100_000);
  rig.t.evaluate();
  assert.equal(rig.t.pool(KEY).state, 'RECOVERING', 'an epoch plus a passed prospective boundary does reach it');
});

// ═══════════════════════════════════════════════════════════════════════════
// U10 — L0-SEM 8: nothing that could be recorded carries provider content
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §8: "Performance counters record counts and byte sizes, never prompt, response or
 * credential content."
 *
 * TRIPWIRE PLUS A REAL PROPERTY. There are no performance counters in this surface
 * today — the word appears only in prose — so the requirement is vacuously true and
 * a test of "the counter holds no secret" would assert something about nothing.
 * What IS assertable now is the property a future counter would have to draw on:
 * the structures that would feed one — admission decisions and notify intents —
 * carry no provider-supplied text at all. Every provider-supplied field is marked
 * with its own distinctive token, so this covers the FIELD SET rather than one
 * sample field.
 */
const MARKERS = {
  planType: 'ZZPLANZZ',
  reached: 'rate_limit_reached',
  label: 'ZZLABELZZ',
  windowId: 'ZZWINDOWZZ',
  accountScope: 'ZZSCOPEZZ',
  limitId: 'ZZLIMITZZ'
};

test('U10/8: an admission decision carries no provider-supplied text', () => {
  const rig = tracker();
  const poolKey = `codex:${MARKERS.accountScope}:${MARKERS.limitId}`;
  const marked = obs({
    poolKey, accountScope: MARKERS.accountScope, limitId: MARKERS.limitId,
    planType: MARKERS.planType, providerReachedType: MARKERS.reached,
    providerAttributedLimitingWindowId: MARKERS.windowId,
    windows: [win({ windowId: MARKERS.windowId, label: MARKERS.label, usedPercent: 100, remainingPercent: 0 })]
  });
  rig.t.ingest(marked);
  assert.equal(rig.t.pool(poolKey).state, 'LIMITED', 'precondition: the marked payload was really accepted');

  const seam = new CapacityAdmission({
    poolKeyForAgent: () => poolKey,
    poolState: (k) => rig.t.pool(k),
    now: () => rig.at()
  });
  const serialized = JSON.stringify(seam.probe('some-agent', 'ORDINARY_TURN'));
  for (const [field, token] of Object.entries(MARKERS)) {
    if (field === 'accountScope' || field === 'limitId') continue; // identity, bounded and legitimately carried
    assert.equal(serialized.includes(token), false, `${field} text must not reach an admission decision`);
  }
});

test('U10/8: a notify intent carries no provider-supplied text either', () => {
  const rig = tracker();
  const poolKey = `codex:${MARKERS.accountScope}:${MARKERS.limitId}`;
  const base = obs({
    poolKey, accountScope: MARKERS.accountScope, limitId: MARKERS.limitId,
    planType: MARKERS.planType,
    windows: [win({ windowId: MARKERS.windowId, label: MARKERS.label })]
  });
  const notifier = new CapacityNotifier();
  rig.t.ingest(base);
  notifier.observe(rig.t.snapshot(), rig.at());           // baseline, never notifies

  rig.advance(1_000);
  rig.t.ingest({
    ...base, observedAt: rig.at(), receivedAt: rig.at(), sourceSequence: 5,
    providerReachedType: MARKERS.reached,
    providerAttributedLimitingWindowId: MARKERS.windowId,
    windows: [win({ windowId: MARKERS.windowId, label: MARKERS.label, usedPercent: 100, remainingPercent: 0 })]
  });
  const intents = notifier.observe(rig.t.snapshot(), rig.at());
  assert.equal(intents.length, 1, 'precondition: a real transition really did occur');

  const serialized = JSON.stringify(intents);
  for (const [field, token] of Object.entries(MARKERS)) {
    if (field === 'accountScope' || field === 'limitId') continue; // identity, bounded
    assert.equal(serialized.includes(token), false, `${field} text must not reach a notify intent`);
  }
});

test('U10/8: TRIPWIRE — this surface exposes no counter to hold anything', () => {
  // If someone adds a counter/telemetry sink here, this fails and the two arms above
  // stop being the whole story: the requirement then needs a real content test
  // against the counter itself rather than against its inputs.
  const modules = {
    tracker: loadTs('src/main/providerCapacityTracker.ts'),
    runtime: loadTs('src/main/capacityRuntime.ts'),
    notify: loadTs('src/main/capacityNotify.ts'),
    admission: loadTs('src/main/capacityAdmission.ts')
  };
  const suspicious = /counter|metric|telemetry|record[A-Z]|report[A-Z]/;
  for (const [name, mod] of Object.entries(modules)) {
    const hits = Object.keys(mod).filter((k) => suspicious.test(k));
    assert.deepEqual(hits, [], `${name} gained a counter-shaped export: ${hits}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// U4 — L0-SEM 8: account reconciliation is never periodic
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §8: reconciliation triggers only at startup-without-fresh-data, a reset boundary,
 * or stale/missing data while work is queued; cooldown 5 minutes per pool; max 3
 * calls per hour per pool; "never periodic and never direct OAuth/auth-file access".
 *
 * THE COOLDOWN AND THE HOURLY CEILING CANNOT BE PINNED YET: nothing in main calls
 * `account/rateLimits/read`. `codex-account-read` exists only as a normalizer input
 * type, an envelope trusted source and a TTL branch. A test of a ceiling with no
 * caller would be a bound trivially true of nothing.
 *
 * NEVER PERIODIC IS PINNABLE NOW, AND IT IS THE LEG THAT MATTERS: a ceiling that
 * holds while a periodic trigger exists is one config change from firing
 * continuously. The assertable form is that the one boundary timer produces no
 * observation and no provider work of any kind — it only re-evaluates what is
 * already held. KILLS: reconciliation wired onto the boundary timer, which is the
 * obvious place to put it and would make it periodic by construction.
 */
function timerRig() {
  let now = T0;
  let mono = 0;
  let pending = null;
  const delivered = [];
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  const runtime = new CapacityRuntime({
    deliver: (i) => delivered.push(...i),
    now: () => now,
    setTimer: (fn, ms) => { pending = { fn, ms }; return { ms, unref() { return this; } }; },
    clearTimer: () => { pending = null; }
  }, t);
  return {
    t, runtime, delivered,
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

test('U4/8: firing the boundary timer manufactures no observation, ever', () => {
  const r = timerRig();
  r.runtime.ingest('jim', obs());
  const poolsAtStart = r.t.snapshot().pools.length;
  const sourcesAtStart = new Set(r.t.snapshot().pools.map((p) => p.source));

  let fired = 0;
  for (let i = 0; i < 20 && r.fire(); i += 1) fired += 1;
  assert.ok(fired > 0, 'the timer really did fire, or this proves nothing');

  const snap = r.t.snapshot();
  assert.equal(snap.pools.length, poolsAtStart, 'no pool appeared from nowhere');
  for (const p of snap.pools) {
    assert.ok(sourcesAtStart.has(p.source), `${p.poolKey} changed provenance without a reading`);
  }
});

test('U4/8: an idle collection eventually stops arming anything at all', () => {
  // "Never periodic" in its strongest observable form: once nothing can change on
  // its own, the timer is not re-armed. A periodic reconciler would keep one alive.
  const r = timerRig();
  r.runtime.ingest('jim', obs());
  for (let i = 0; i < 40 && r.armed() !== null; i += 1) r.fire();
  assert.equal(r.armed(), null, 'a fully settled collection arms no further boundary');
});

test('U4/8: TRIPWIRE — no account-read caller exists to have a cooldown yet', () => {
  // Records WHY the cooldown and the 3/hour ceiling are unpinned, so the gap is not
  // mistaken for coverage. When a caller appears this fails, and the ceiling legs
  // must then be pinned for real.
  const runtime = loadTs('src/main/capacityRuntime.ts');
  const callers = Object.keys(runtime).filter((k) => /reconcil|accountRead|fetch|request/i.test(k));
  assert.deepEqual(callers, [], `a reconciliation caller appeared: ${callers} — pin the cooldown and the hourly ceiling now`);
});
