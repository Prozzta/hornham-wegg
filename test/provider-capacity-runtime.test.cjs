'use strict';

/**
 * L0-WIRE — the parts that were correct and were not running.
 *
 * The audit's finding was not that the tracker classified badly; it was that in
 * production nothing ever called `evaluate()`, nothing consumed a verdict and
 * nothing observed the collection. So these tests drive the REAL boundary: the
 * timer is injected, but the runtime is the thing that arms it, and firing it is the
 * only way time passes here. No test calls `evaluate()` directly — that is precisely
 * the impersonation the audit flagged in the earlier reset fixtures.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

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

/**
 * A rig whose only way to move time forward is to FIRE the timer the runtime armed.
 * Both clocks advance by the delay the runtime actually asked for, so what is being
 * tested is the schedule the runtime chose, not one the test chose for it.
 */
function rig() {
  let now = T0;
  let mono = 0;
  let pending = null;
  const delivered = [];
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  const runtime = new CapacityRuntime({
    deliver: (intents) => delivered.push(...intents),
    now: () => now,
    setTimer: (fn, ms) => { pending = { fn, ms }; return { ms, unref() { return this; } }; },
    clearTimer: () => { pending = null; }
  }, tracker);
  return {
    tracker, runtime, delivered,
    armed: () => (pending ? pending.ms : null),
    /** Let the armed boundary arrive. Nothing else in this file moves the clock. */
    fire: () => {
      assert.ok(pending, 'expected the runtime to have armed a boundary');
      const { fn, ms } = pending;
      pending = null;
      now += ms;
      mono += ms;
      fn();
    },
    state: () => tracker.pool(POOL)?.state
  };
}

test('a reading expires with NO new reading, because the runtime scheduled its own boundary', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs());
  assert.equal(r.state(), 'AVAILABLE');
  assert.ok(r.armed() > 0, 'a fresh reading has an expiry and the runtime armed for it');

  r.fire();
  assert.equal(r.state(), 'UNKNOWN', 'freshness expired on the production path, not on a direct evaluate()');
  assert.equal(r.tracker.pool(POOL).stateReason, 'STALE_READING');
});

test('a reset boundary passes on the timer and reaches RECOVERING', () => {
  const r = rig();
  // A healthy reading FIRST, so the refusal is a transition rather than a first
  // sighting. A pool seen for the first time is a baseline and never notifies -
  // that is the replay guard, and it is why this has to be two readings.
  r.runtime.ingest('dwight', obs());
  r.runtime.ingest('dwight', obs({
    observedAt: T0 + 1_000, receivedAt: T0 + 1_000,
    providerReachedType: 'rate_limit_reached',
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H)]
  }));
  assert.equal(r.state(), 'LIMITED');

  // The first boundary is the TTL; the reset is an hour out. Fire until the pool
  // moves, which is what a running process does.
  for (let i = 0; i < 8 && r.state() !== 'RECOVERING'; i += 1) r.fire();
  assert.equal(r.state(), 'RECOVERING', 'ruling 4: the boundary de-escalates and never reaches AVAILABLE');
  assert.deepEqual(
    r.delivered.map((i) => i.kind),
    ['LIMIT_REACHED', 'RECOVERY_POSSIBLE'],
    'and both transitions were DELIVERED, which no production path did before'
  );
});

test('with nothing pending the runtime arms no timer at all', () => {
  const r = rig();
  assert.equal(r.armed(), null, 'an empty tracker has no boundary');
  r.runtime.ingest('dwight', obs());
  r.fire();                                   // expire it
  assert.equal(r.state(), 'UNKNOWN');
  assert.equal(r.armed(), null, 'an expired reading with no epoch has nothing further to wait for');
});

test('a LIMITED pool refuses the automatic start that used to bypass the seam', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs({ providerReachedType: 'rate_limit_reached' }));
  const d = r.runtime.admit('dwight', 'ORDINARY_TURN');
  assert.equal(d.verdict, 'REFUSE');
  assert.equal(d.reason, ADMISSION_REASON.LIMITED);
  assert.equal(r.runtime.admit('dwight', 'CLOSURE_TURN').verdict, 'REFUSE', 'LIMITED refuses both classes');
});

test('an agent belongs to the pool its OWN readings landed in, and to none before that', () => {
  const r = rig();
  const unknown = r.runtime.admit('meredith');
  assert.equal(unknown.verdict, 'UNKNOWN_NOT_INFERRED_SAFE');
  assert.equal(unknown.reason, ADMISSION_REASON.NO_POOL, 'no reading means no pool - not a guessed limit id');

  r.runtime.ingest('meredith', obs());
  assert.equal(r.runtime.admit('meredith').poolKey, POOL);
});

test('two agents on one account get ONE answer, not one each', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs());
  r.runtime.ingest('oscar', obs({ observedAt: T0 + 1, receivedAt: T0 + 1 }));
  const d = r.runtime.admit('dwight');
  const o = r.runtime.admit('oscar');
  assert.equal(d.poolKey, o.poolKey);
  assert.equal(d.verdict, o.verdict);
});

test('a recovery grant is spent by a LAUNCH, not by asking the question', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs({
    providerReachedType: 'rate_limit_reached',
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H)]
  }));
  for (let i = 0; i < 8 && r.state() !== 'RECOVERING'; i += 1) r.fire();
  assert.equal(r.state(), 'RECOVERING');

  // Asked, then the turn never happened. The epoch keeps its one attempt.
  const abandoned = r.runtime.admit('dwight');
  assert.equal(abandoned.reason, ADMISSION_REASON.RECOVERING_GRANT);
  r.runtime.cancelGrant(abandoned);

  const real = r.runtime.admit('dwight');
  assert.equal(real.reason, ADMISSION_REASON.RECOVERING_GRANT, 'a cancelled decision did not burn the grant');
  r.runtime.confirmLaunch(real);

  assert.equal(
    r.runtime.admit('dwight').reason,
    ADMISSION_REASON.RECOVERING_SPENT,
    'but a confirmed launch does - one real turn per epoch'
  );
});

test('a reservation blocks a second concurrent asker before either has launched', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs({
    providerReachedType: 'rate_limit_reached',
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H)]
  }));
  for (let i = 0; i < 8 && r.state() !== 'RECOVERING'; i += 1) r.fire();
  // Oscar draws on the SAME pool, learned from his own reading rather than assumed.
  r.runtime.ingest('oscar', r.tracker.pool(POOL) && obs());

  assert.equal(r.runtime.admit('dwight').reason, ADMISSION_REASON.RECOVERING_GRANT);
  assert.equal(
    r.runtime.admit('oscar').reason,
    ADMISSION_REASON.RECOVERING_SPENT,
    'two callers each seeing ALLOW before either starts is the retry storm this prevents'
  );
});

test('a confirmed grant cannot be handed back by a late cancel', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs({
    providerReachedType: 'rate_limit_reached',
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H)]
  }));
  for (let i = 0; i < 8 && r.state() !== 'RECOVERING'; i += 1) r.fire();

  const d = r.runtime.admit('dwight');
  r.runtime.confirmLaunch(d);
  r.runtime.cancelGrant(d);
  assert.equal(
    r.runtime.admit('dwight').reason,
    ADMISSION_REASON.RECOVERING_SPENT,
    'a turn that ran cannot be un-run by cancelling the permission it ran under'
  );
});

test('stop() releases the boundary and the runtime goes quiet', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs());
  assert.ok(r.armed() > 0);
  r.runtime.stop();
  assert.equal(r.armed(), null);
});

test('the runtime reaches no renderer', () => {
  const src = require('node:fs').readFileSync('src/main/capacityRuntime.ts', 'utf8');
  for (const banned of ['webContents', 'BrowserWindow', 'ipcMain', 'ipcRenderer', 'Notification', 'setInterval']) {
    assert.equal(src.includes(banned), false, `the runtime must not reference "${banned}"`);
  }
});

// ── L0-FIX4: membership commits with the reading, not before it ─────────────

test('FIX4: a REJECTED future observation cannot retarget an agent off its pool', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs({ providerReachedType: 'rate_limit_reached' }));
  assert.equal(r.runtime.admit('dwight').reason, ADMISSION_REASON.LIMITED);

  // Invalid, discarded by the tracker - and exactly the shape a clock skew or a
  // forged timestamp produces. It names a DIFFERENT pool. Under the old order it
  // moved Dwight onto that pool and his refusal stopped applying to him.
  const elsewhere = 'codex:acct-z:codex';
  r.runtime.ingest('dwight', obs({
    poolKey: elsewhere, accountScope: 'acct-z',
    observedAt: T0 + 10 * 60_000, receivedAt: T0 + 10 * 60_000
  }));

  const after = r.runtime.admit('dwight');
  assert.equal(after.poolKey, POOL, 'still on the pool that actually refused him');
  assert.equal(after.reason, ADMISSION_REASON.LIMITED);
  assert.equal(r.tracker.pool(elsewhere), null, 'and the rejected reading created nothing');
});

test('FIX4: an accepted DUPLICATE still commits membership - it is a valid reading', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs());
  r.runtime.ingest('meredith', obs());   // same reading, now a duplicate
  assert.equal(r.runtime.admit('meredith').poolKey, POOL, 'a duplicate proves membership');
});

test('FIX4: an OUT-OF-ORDER reading commits no membership at all', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs({ observedAt: T0 + 1_000, receivedAt: T0 + 1_000 }));

  // Meredith's only reading is an older one for that same pool, so the tracker
  // rejects it as out of order. It is not evidence of anything, membership included.
  r.runtime.ingest('meredith', obs({ observedAt: T0, receivedAt: T0 }));

  const d = r.runtime.admit('meredith');
  assert.equal(d.poolKey, null);
  assert.equal(d.reason, ADMISSION_REASON.NO_POOL, 'rejected evidence proves no membership');
  assert.equal(d.verdict, 'UNKNOWN_NOT_INFERRED_SAFE', 'and UNKNOWN is the conservative answer');
});

// ── L0-FIX4: a grant is spent by a SUBMISSION, not by a call that returns ───

test('FIX4: a launch that FAILS to submit returns the recovery grant', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs());
  r.runtime.ingest('dwight', obs({
    observedAt: T0 + 1_000, receivedAt: T0 + 1_000,
    providerReachedType: 'rate_limit_reached',
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H)]
  }));
  for (let i = 0; i < 8 && r.state() !== 'RECOVERING'; i += 1) r.fire();
  assert.equal(r.state(), 'RECOVERING');

  // The production caller reports the outcome of the ENTER write, which lands a tick
  // after the call returns. A dead PTY reports false.
  const first = r.runtime.admit('dwight');
  assert.equal(first.reason, ADMISSION_REASON.RECOVERING_GRANT);
  r.runtime.cancelGrant(first);            // what onSubmitted(false) does

  const second = r.runtime.admit('dwight');
  assert.equal(
    second.reason,
    ADMISSION_REASON.RECOVERING_GRANT,
    'a turn that was never typed must not consume the epoch its one attempt'
  );
});

// ── L0-FIX4D: the renderer dispatch gate. Asking must not cost the answer ───

test('FIX4: holds() reports a refusal WITHOUT spending the recovery turn', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs());
  r.runtime.ingest('dwight', obs({
    observedAt: T0 + 1_000, receivedAt: T0 + 1_000,
    providerReachedType: 'rate_limit_reached',
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H)]
  }));
  for (let i = 0; i < 8 && r.state() !== 'RECOVERING'; i += 1) r.fire();
  assert.equal(r.state(), 'RECOVERING');

  // The control snapshot is read on every queue tick. If asking consumed the grant,
  // the epoch's one attempt would be spent by the first poll and never by a turn.
  for (let i = 0; i < 20; i += 1) assert.equal(r.runtime.holds('dwight'), false, 'RECOVERING allows one turn');

  assert.equal(
    r.runtime.admit('dwight').reason,
    ADMISSION_REASON.RECOVERING_GRANT,
    'twenty questions later the turn is still available'
  );
});

test('FIX4: holds() is true exactly when an ordinary automatic start is refused', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs({ providerReachedType: 'rate_limit_reached' }));
  assert.equal(r.runtime.holds('dwight'), true, 'LIMITED holds');

  const fresh = rig();
  fresh.runtime.ingest('dwight', obs());
  assert.equal(fresh.runtime.holds('dwight'), false, 'AVAILABLE does not');

  // UNKNOWN is NOT a refusal: the seam declines to infer safety and the caller
  // proceeds, so an agent we have never observed behaves as it did before.
  assert.equal(fresh.runtime.holds('nobody'), false, 'an unknown agent is not held');
});

test('FIX4: a RESERVE_ONLY pool holds ordinary work but not closure work', () => {
  const r = rig();
  r.runtime.ingest('dwight', obs({
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H), win('seven_day', 'SEVEN_DAY', 60, T0 + 86_400_000)]
  }));
  assert.equal(r.state(), 'RESERVE_ONLY');
  assert.equal(r.runtime.holds('dwight', 'ORDINARY_TURN'), true);
  assert.equal(r.runtime.holds('dwight', 'CLOSURE_TURN'), false, 'finishing safely is never held');
});
