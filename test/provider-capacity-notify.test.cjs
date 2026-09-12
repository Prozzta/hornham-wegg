'use strict';

/**
 * L0-NOTIF — transition notifications, and above all the absence of replay.
 *
 * Driven through the real tracker, so every transition tested is one the tracker
 * can actually produce. The reload/reconnect cases simulate what a restart really
 * does: a NEW tracker and a NEW notifier observing the same provider facts again,
 * because that is precisely the situation in which a content-based dedupe fails.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityNotifier } = loadTs('src/main/capacityNotify.ts');

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

function rig(start = T0) {
  let now = start;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now);
  const notifier = new CapacityNotifier();
  return {
    tracker,
    notifier,
    set: (v) => { now = v; },
    tick: () => notifier.observe(tracker.snapshot(), now)
  };
}

test('a first sighting is a BASELINE and never a notification', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  assert.deepEqual(r.tick(), [], 'a pool seen for the first time has no prior state to have moved from');
});

test('a real transition into LIMITED notifies exactly once', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();                                   // baseline: AVAILABLE
  r.set(T0 + 1000);
  r.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  const intents = r.tick();
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'LIMIT_REACHED');
  assert.equal(intents[0].from, 'AVAILABLE');
  assert.equal(intents[0].to, 'LIMITED');
  assert.equal(intents[0].limitEpochAt, r.tracker.pool(POOL).limitEpochAt);
});

test('fifty re-observations of ONE refusal produce ONE intent', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();
  r.set(T0 + 1000);
  r.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  let total = r.tick().length;
  for (let i = 2; i <= 50; i += 1) {
    const t = T0 + 1000 + i * 1000;
    r.set(t);
    r.tracker.ingest(obs({ observedAt: t, receivedAt: t, providerReachedType: 'usage' }));
    total += r.tick().length;
  }
  assert.equal(total, 1);
});

// ── the replay cases ─────────────────────────────────────────────────────────

test('A RELOAD DOES NOT REPLAY: a fresh process hydrating the same facts emits nothing', () => {
  const first = rig();
  first.tracker.ingest(obs());
  first.tick();
  first.set(T0 + 1000);
  first.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  assert.equal(first.tick().length, 1, 'the user is told once');

  // Now the window reloads: a NEW tracker and a NEW notifier see the same provider
  // facts from scratch. A content-based dedupe fails here, because the content is
  // identical - which is the entire point of the baseline rule.
  const after = rig(T0 + 5000);
  after.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 5000, providerReachedType: 'usage' }));
  assert.deepEqual(after.tick(), [], 'a reload must not re-announce a refusal already announced');
});

test('hydrate() establishes baselines silently, and observe() afterwards still works', () => {
  const r = rig();
  r.tracker.ingest(obs({ providerReachedType: 'usage' }));
  r.notifier.hydrate(r.tracker.snapshot());
  assert.deepEqual(r.tick(), [], 'hydration is not a transition');
  // A genuine later move is still reported.
  r.set(RESET_5H + 1);
  r.tracker.evaluate();
  const intents = r.tick();
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'RECOVERY_POSSIBLE');
});

test('a RESUBSCRIBE mid-epoch emits nothing, because nothing moved', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();
  r.set(T0 + 1000);
  r.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  r.tick();
  // Resubscribe: hydrate from the current snapshot, then observe it again.
  r.notifier.hydrate(r.tracker.snapshot());
  assert.deepEqual(r.tick(), []);
});

test('a SECOND, genuinely separate refusal notifies again - identity is the epoch, not a flag', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();
  r.set(T0 + 1000);
  r.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  assert.equal(r.tick()[0].kind, 'LIMIT_REACHED');
  // Confirmed recovery ends the epoch.
  const tk = T0 + 2000;
  r.set(tk);
  r.tracker.ingest(obs({ observedAt: tk, receivedAt: tk, ordinaryUsageAllowed: true }));
  assert.equal(r.tick()[0].kind, 'RECOVERED');
  // A new refusal, later, is a different epoch and is news again.
  const t2 = tk + 60_000;
  r.set(t2);
  r.tracker.ingest(obs({ observedAt: t2, receivedAt: t2, providerReachedType: 'usage' }));
  const second = r.tick();
  assert.equal(second.length, 1);
  assert.equal(second[0].kind, 'LIMIT_REACHED');
  assert.notEqual(second[0].identity, `${POOL}|LIMIT_REACHED|${T0 + 1000}`);
});

// ── which transitions are news, and which are weather ────────────────────────

test('ageing into UNKNOWN does not notify, in either direction', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();
  r.set(T0 + L0_SEM_POLICY.liveTtlMs + 1);
  r.tracker.evaluate();
  assert.deepEqual(r.tick(), [], 'a reading ageing out is not news');
  const back = T0 + L0_SEM_POLICY.liveTtlMs + 2000;
  r.set(back);
  r.tracker.ingest(obs({ observedAt: back, receivedAt: back }));
  assert.deepEqual(r.tick(), [], 'and neither is it coming back');
});

test('a spent window notifies as RESERVE_REACHED, observationally', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();
  r.set(T0 + 1000);
  r.tracker.ingest(obs({
    observedAt: T0 + 1000, receivedAt: T0 + 1000,
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H), win('seven_day', 'SEVEN_DAY', 40, T0 + 86_400_000)]
  }));
  const intents = r.tick();
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'RESERVE_REACHED');
  assert.equal(intents[0].stateReason, 'NUMERICALLY_EXHAUSTED');
});

test('LIMITED to RESERVE_ONLY says NOTHING - the refusal ended but ordinary work is still suppressed', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();
  r.set(T0 + 1000);
  r.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  r.tick();
  const tk = T0 + 2000;
  r.set(tk);
  r.tracker.ingest(obs({
    observedAt: tk, receivedAt: tk, ordinaryUsageAllowed: true,
    windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H), win('seven_day', 'SEVEN_DAY', 40, T0 + 86_400_000)]
  }));
  // Nothing is emitted, and that is the correct answer rather than a gap. Calling
  // this RECOVERED would tell the user they can work again when RESERVE_ONLY still
  // suppresses ordinary work; calling it RESERVE_REACHED would announce a
  // restriction they are already living under. The actionable state did not change.
  assert.deepEqual(r.tick(), []);
});

test('two pools transition independently and produce one intent each', () => {
  const r = rig();
  const other = { poolKey: 'claude:acct-c:subscription', provider: 'claude', accountScope: 'acct-c', limitId: 'subscription', source: 'claude-status-line' };
  r.tracker.ingest(obs());
  r.tracker.ingest(obs(other));
  r.tick();
  r.set(T0 + 1000);
  r.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  r.tracker.ingest(obs({ ...other, observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  const intents = r.tick();
  assert.equal(intents.length, 2);
  assert.equal(new Set(intents.map((i) => i.poolKey)).size, 2);
});

test('a removed pool drops its baseline but keeps its history - returning does not re-announce', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();
  r.set(T0 + 1000);
  r.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 1000, providerReachedType: 'usage' }));
  assert.equal(r.tick().length, 1);
  r.tracker.forget(POOL);
  assert.deepEqual(r.tick(), []);
  // The same pool comes back carrying the same refusal.
  r.set(T0 + 2000);
  r.tracker.ingest(obs({ observedAt: T0 + 1000, receivedAt: T0 + 2000, providerReachedType: 'usage' }));
  assert.deepEqual(r.tick(), [], 'a pool reappearing is a first sighting, not a transition');
});

test('the notifier delivers nothing itself - no Electron, no IPC, no renderer', () => {
  // Comments are stripped first: the file DISCUSSES what it must not do, and a scan
  // that cannot tell prose from code would fail on its own documentation.
  const src = require('node:fs').readFileSync('src/main/capacityNotify.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['electron', 'Notification', 'webContents', 'ipcMain', 'send(', 'require(']) {
    assert.equal(src.includes(banned), false, `the notifier must not reference "${banned}" in code`);
  }
});

// ---------------------------------------------------------------------------
// L0-DEF3 — the counterexamples from the adversarial audit (section 10.5).
//
// Every one of these is a SECOND genuine event. The first version of this module
// keyed identity on the DESTINATION snapshot's `limitEpochAt`, and a confirmed
// recovery clears that field, so every recovery in the life of the process shared
// one identity string and only the first was ever emitted. The bug was invisible to
// the original tests because they each tested one episode.
// ---------------------------------------------------------------------------

/** Drive one full refusal-and-recovery cycle and return the intents, in order. */
function cycle(r, at, reached) {
  r.set(at);
  r.tracker.ingest(obs({ observedAt: at, receivedAt: at, providerReachedType: reached }));
  const limited = r.tick();
  const back = at + 60_000;
  r.set(back);
  r.tracker.ingest(obs({ observedAt: back, receivedAt: back, ordinaryUsageAllowed: true }));
  return [...limited, ...r.tick()];
}

test('a SECOND genuine recovery notifies — it does not share an identity with the first', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();                                        // baseline: AVAILABLE

  const first = cycle(r, T0 + 10_000, 'rate_limit_reached');
  assert.deepEqual(first.map((i) => i.kind), ['LIMIT_REACHED', 'RECOVERED']);

  const second = cycle(r, T0 + 600_000, 'workspace_member_usage_limit_reached');
  assert.deepEqual(
    second.map((i) => i.kind),
    ['LIMIT_REACHED', 'RECOVERED'],
    'the second refusal AND the second recovery are both genuinely new events'
  );

  // The identities must differ, and specifically the RECOVERED ones: that is the
  // pair that used to collide on `|none`.
  const recovered = [first, second].map((c) => c.find((i) => i.kind === 'RECOVERED').identity);
  assert.notEqual(recovered[0], recovered[1]);
  assert.ok(!recovered[0].endsWith('|none'), `a recovery is scoped by the epoch it CLOSED: ${recovered[0]}`);
});

test('a RECOVERED intent carries the epoch it ended, not the cleared one', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();
  const at = T0 + 10_000;
  r.set(at);
  r.tracker.ingest(obs({ observedAt: at, receivedAt: at, providerReachedType: 'rate_limit_reached' }));
  const opened = r.tick()[0];
  const back = at + 60_000;
  r.set(back);
  r.tracker.ingest(obs({ observedAt: back, receivedAt: back, ordinaryUsageAllowed: true }));
  const closed = r.tick()[0];

  assert.equal(closed.kind, 'RECOVERED');
  assert.equal(closed.limitEpochAt, opened.limitEpochAt, 'the recovery reports the refusal it ended');
  assert.equal(r.tracker.pool(POOL).limitEpochAt, null, 'while the pool itself has correctly cleared it');
});

test('a SECOND genuine reserve episode notifies, though RESERVE_ONLY has no epoch at all', () => {
  const r = rig();
  r.tracker.ingest(obs());
  r.tick();

  const spend = (at) => {
    r.set(at);
    r.tracker.ingest(obs({
      observedAt: at, receivedAt: at,
      windows: [win('five_hour', 'FIVE_HOUR', 0, RESET_5H), win('seven_day', 'SEVEN_DAY', 60, at + 86_400_000)]
    }));
    const out = r.tick();
    const back = at + 30_000;
    r.set(back);
    r.tracker.ingest(obs({ observedAt: back, receivedAt: back }));
    r.tick();
    return out;
  };

  const first = spend(T0 + 10_000);
  const second = spend(T0 + 300_000);
  assert.deepEqual(first.map((i) => i.kind), ['RESERVE_REACHED']);
  assert.deepEqual(second.map((i) => i.kind), ['RESERVE_REACHED'], 'a window spent twice is two events');
  assert.notEqual(first[0].identity, second[0].identity);
  assert.equal(first[0].limitEpochAt, null, 'and neither invents an epoch ruling 2 says does not exist');
});

test('an OLDER collection is ignored wholesale — no false recovery, no identity consumed', () => {
  const r = rig();
  r.tracker.ingest(obs());
  const healthy = r.tracker.snapshot();
  r.notifier.hydrate(healthy);

  const at = T0 + 10_000;
  r.set(at);
  r.tracker.ingest(obs({ observedAt: at, receivedAt: at, providerReachedType: 'rate_limit_reached' }));
  const limited = r.tracker.snapshot();
  assert.ok(limited.collectionRevision > healthy.collectionRevision);
  assert.deepEqual(r.notifier.observe(limited, at).map((i) => i.kind), ['LIMIT_REACHED']);

  // The replay. Under the old code this read as LIMITED -> AVAILABLE and emitted a
  // RECOVERED that was not true, AND burned `pool|RECOVERED|none` so the real
  // recovery could never be delivered.
  assert.deepEqual(r.notifier.observe(healthy, at + 1).map((i) => i.kind), [], 'an older collection is not news');

  // And the state it should still be in is undisturbed: re-observing the newer
  // collection is a duplicate, not a fresh transition.
  assert.deepEqual(r.notifier.observe(limited, at + 2).map((i) => i.kind), []);

  // The real recovery still gets through.
  const back = at + 60_000;
  r.set(back);
  r.tracker.ingest(obs({ observedAt: back, receivedAt: back, ordinaryUsageAllowed: true }));
  assert.deepEqual(r.notifier.observe(r.tracker.snapshot(), back).map((i) => i.kind), ['RECOVERED']);
});

test('an EQUAL collection revision is ignored too', () => {
  const r = rig();
  r.tracker.ingest(obs());
  const snap = r.tracker.snapshot();
  r.notifier.observe(snap, T0);
  assert.deepEqual(r.notifier.observe(snap, T0 + 1), [], 'equal is not strictly higher');
});
