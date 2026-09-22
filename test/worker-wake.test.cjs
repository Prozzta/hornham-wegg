'use strict';

/**
 * The inbox-wake COORDINATOR (pre-M1 event-wake bridge, test plan B): pending / announced /
 * in-flight / held per agent, per-message-id dedup, lifecycle edges, announce-only-after-
 * COMMITTED, and no god special case. Pure: every race is driven synchronously.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  WorkerWakeWatchdog,
  InboxWakeCoordinator,
  classifyHook,
  inboxWakeRequestId,
  WORKER_WAKE_NUDGE,
  WORKER_WAKE_IDLE_MS,
  WORKER_WAKE_BOOT_GRACE_MS,
  WORKER_WAKE_COOLDOWN_MS,
  WORKER_WAKE_HITL_REARM_MS
} = loadTs('src/main/workerWake.ts');

const NOW = 10_000_000;
/** A permissive fact; tests override the fields they care about. */
const fact = (over = {}) => ({ agentId: 'alice', ptyId: 'pty-alice', lastOutputAt: NOW - 1_000,
  autoDeliveryPaused: false, paused: false, halted: false, ...over });
/** A coordinator with alice idle (her main agent reported Stop) and the given mail. */
function idleWith(ids, agentId = 'alice') {
  const c = new WorkerWakeWatchdog();
  c.noteHook(agentId, 'Stop', '', NOW);
  for (const id of ids) c.noteDelivery(agentId, id);
  return c;
}

test('B1 a duplicate delivery of the same id is one pending id and one claim', () => {
  const c = idleWith(['m1']);
  assert.equal(c.noteDelivery('alice', 'm1'), false, 'already pending');
  assert.deepEqual(c.state('alice').pending, ['m1']);
  const claim = c.claim(fact(), 'delivery', 'event', NOW);
  assert.deepEqual(claim.ids, ['m1']);
  assert.equal(c.claim(fact(), 'delivery', 'event', NOW), null, 'one in-flight claim');
  assert.equal(c.noteDelivery('alice', 'm1'), false, 'an in-flight id is not pending again');
});

test('B2 two ids before a claim = one sorted immutable batch; a third in flight waits for the next idle edge', () => {
  const c = idleWith(['m2', 'm1']);
  const claim = c.claim(fact(), 'delivery', 'event', NOW);
  assert.deepEqual([...claim.ids], ['m1', 'm2']);
  assert.ok(Object.isFrozen(claim) && Object.isFrozen(claim.ids), 'immutable');
  assert.equal(claim.requestId, inboxWakeRequestId('alice', ['m2', 'm1']), 'stable id from the SORTED set');
  assert.match(claim.requestId, /^inbox-wake:alice:[0-9a-f]{64}$/);
  c.noteDelivery('alice', 'm3');
  assert.deepEqual([...claim.ids], ['m1', 'm2'], 'the claim is never enlarged');
  c.noteHook('alice', 'Stop', '', NOW);      // even with fresh idle evidence and new mail...
  assert.equal(c.claim(fact(), 'hook', 'event', NOW), null, '...no second claim while one is in flight');
  assert.equal(c.claim(fact({ lastOutputAt: NOW - WORKER_WAKE_IDLE_MS - 1 }), 'reconcile', 'reconcile', NOW), null);
  c.settle(claim, 'COMMITTED');
  assert.equal(c.state('alice').lifecycle, 'active', 'a committed wake means a turn started');
  assert.equal(c.claim(fact(), 'delivery', 'event', NOW), null, 'm3 waits for the Stop of that turn');
  c.noteHook('alice', 'Stop', '', NOW);
  assert.deepEqual([...c.claim(fact(), 'hook', 'event', NOW).ids], ['m3']);
});

test('B3 COMMITTED announces exactly the claimed ids; repeated signals never claim them again while the files remain', () => {
  const c = idleWith(['m1']);
  c.settle(c.claim(fact(), 'delivery', 'event', NOW), 'COMMITTED');
  assert.deepEqual(c.state('alice').announced, ['m1']);
  c.noteHook('alice', 'Stop', '', NOW);
  c.noteDelivery('alice', 'm1');
  c.reconcile('alice', ['m1']);
  assert.equal(c.claim(fact(), 'hook', 'event', NOW), null);
  assert.equal(c.claim(fact({ lastOutputAt: NOW - WORKER_WAKE_IDLE_MS - 1 }), 'reconcile', 'reconcile', NOW), null);
});

test('B4 REFUSED / ABORTED / FAILED / REJECTED keep the ids; INTERFERED holds the claim; SEND_AGAIN re-enables, ALREADY_HANDLED resolves', () => {
  for (const kind of ['REFUSED', 'ABORTED', 'FAILED', 'REJECTED']) {
    const c = idleWith(['m1']);
    c.settle(c.claim(fact(), 'delivery', 'event', NOW), kind);
    assert.deepEqual(c.state('alice').pending, ['m1'], `${kind}: not spent`);
    assert.deepEqual(c.state('alice').announced, [], `${kind}: not announced`);
    assert.ok(c.claim(fact(), 'hook', 'event', NOW), `${kind}: claimable again`);
  }
  const c = idleWith(['m1']);
  const claim = c.claim(fact(), 'delivery', 'event', NOW);
  c.settle(claim, 'INTERFERED');
  assert.equal(c.state('alice').held.requestId, claim.requestId, 'the exact claim is held');
  c.noteHook('alice', 'Stop', '', NOW);
  assert.equal(c.claim(fact(), 'hook', 'event', NOW), null, 'no automatic retry while held');
  assert.equal(c.resolveInterference('alice', 'SEND_AGAIN'), true);
  assert.deepEqual(c.state('alice').pending, ['m1']);
  assert.ok(c.claim(fact(), 'interference', 'event', NOW), 'SEND_AGAIN goes back through the guards');
  const d = idleWith(['m9']);
  d.settle(d.claim(fact(), 'delivery', 'event', NOW), 'INTERFERED');
  d.resolveInterference('alice', 'ALREADY_HANDLED');
  assert.deepEqual(d.state('alice').announced, ['m9'], 'resolved without another submit');
  d.noteHook('alice', 'Stop', '', NOW);
  assert.equal(d.claim(fact(), 'hook', 'event', NOW), null);
  const e = idleWith(['m7']);
  e.settle(e.claim(fact(), 'delivery', 'event', NOW), 'HUMAN_HANDLED');
  assert.deepEqual(e.state('alice').announced, ['m7'], 'a replayed HUMAN_HANDLED is terminal');
});

test('B4b a stale outcome for a claim that is no longer in flight changes nothing', () => {
  const c = idleWith(['m1']);
  const claim = c.claim(fact(), 'delivery', 'event', NOW);
  c.settle(claim, 'REFUSED');
  c.noteDelivery('alice', 'm2');              // a DIFFERENT batch, so a different request id
  const again = c.claim(fact(), 'hook', 'event', NOW);
  assert.notEqual(again.requestId, claim.requestId);
  c.settle(claim, 'COMMITTED');               // the old claim's late replay
  assert.equal(c.state('alice').inFlight.requestId, again.requestId);
  assert.deepEqual(c.state('alice').announced, []);
});

test('B5 inbox drain prunes pending and announced; a reappearing id is ONE reconciliation wake, not a loop', () => {
  const c = idleWith(['m1']);
  c.settle(c.claim(fact(), 'delivery', 'event', NOW), 'COMMITTED');
  c.reconcile('alice', []);
  assert.deepEqual(c.state('alice'), { pending: [], announced: [], inFlight: null, held: null, lifecycle: 'active' });
  // A new process: nothing in memory, the file is still on disk.
  const fresh = new WorkerWakeWatchdog();
  fresh.reconcile('alice', ['m1']);
  const quiet = fact({ lastOutputAt: NOW - WORKER_WAKE_IDLE_MS - 1 });
  const claim = fresh.claim(quiet, 'reconcile', 'reconcile', NOW);
  assert.deepEqual([...claim.ids], ['m1']);
  fresh.settle(claim, 'COMMITTED');
  fresh.reconcile('alice', ['m1']);
  assert.equal(fresh.claim(quiet, 'reconcile', 'reconcile', NOW + WORKER_WAKE_COOLDOWN_MS + 1), null, 'announced: never again');
});

test('B6 a delivery while active stays pending; Stop yields ONE claim; duplicate Stop / SubagentStop add none', () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook('alice', 'UserPromptSubmit', '', NOW);
  c.noteDelivery('alice', 'm1');
  assert.equal(c.claim(fact(), 'delivery', 'event', NOW), null, 'working: intent recorded, nothing typed');
  assert.equal(c.noteHook('alice', 'Stop', '', NOW), true, 'Stop is a retry edge');
  assert.ok(c.claim(fact(), 'hook', 'event', NOW));
  assert.equal(c.noteHook('alice', 'Stop', '', NOW), true);
  assert.equal(c.claim(fact(), 'hook', 'event', NOW), null);
  assert.equal(c.noteHook('alice', 'SubagentStop', '', NOW), true, 'retry edge while idle');
  assert.equal(c.claim(fact(), 'hook', 'event', NOW), null, 'still one in flight');
});

test('B7 SubagentStop never turns an active main agent idle; an idle Notification does; a permission Notification blocks', () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook('alice', 'PreToolUse', '', NOW);
  c.noteDelivery('alice', 'm1');
  assert.equal(c.noteHook('alice', 'SubagentStop', '', NOW), false);
  assert.equal(c.state('alice').lifecycle, 'active');
  assert.equal(c.claim(fact(), 'hook', 'event', NOW), null);
  assert.equal(c.noteHook('alice', 'Notification', 'Claude is waiting for your input', NOW), true);
  assert.equal(c.state('alice').lifecycle, 'idle');
  const h = new WorkerWakeWatchdog();
  h.noteHook('alice', 'Stop', '', NOW);
  h.noteDelivery('alice', 'm1');
  assert.equal(h.noteHook('alice', 'Notification', 'Claude needs your permission to use Bash', NOW), false);
  assert.equal(h.claim(fact(), 'hook', 'event', NOW + 1), null, 'HITL blocks');
  assert.ok(h.claim(fact(), 'hook', 'event', NOW + WORKER_WAKE_HITL_REARM_MS + 1), 'and re-arms after its window');
});

test('B8 boot grace, pause, halt, auto-delivery pause, an owner inhibition, a missing PTY: all fail closed, ids kept', () => {
  const cases = {
    pause: fact({ paused: true }), halt: fact({ halted: true }), delivery: fact({ autoDeliveryPaused: true }),
    inhibited: fact({ inhibited: true }), noPty: fact({ ptyId: undefined })
  };
  for (const [name, f] of Object.entries(cases)) {
    const c = idleWith(['m1']);
    assert.equal(c.claim(f, 'delivery', 'event', NOW), null, name);
    assert.equal(c.claim(f, 'reconcile', 'reconcile', NOW), null, `${name} (reconcile)`);
    assert.deepEqual(c.state('alice').pending, ['m1'], `${name}: kept`);
  }
  const boot = idleWith(['m1']);
  boot.noteSpawn('pty-alice', NOW - 1_000);
  assert.equal(boot.claim(fact(), 'delivery', 'event', NOW), null, 'boot grace');
  assert.ok(boot.claim(fact(), 'delivery', 'event', NOW + WORKER_WAKE_BOOT_GRACE_MS));
});

test('B8b reconciliation: PTY quiescence may stand in for a missed Stop, never twice inside the cooldown; never-output is booting', () => {
  const c = new WorkerWakeWatchdog();
  c.reconcile('alice', ['m1']);
  assert.equal(c.claim(fact(), 'reconcile', 'reconcile', NOW), null, 'recent output: mid-turn');
  assert.equal(c.claim(fact({ lastOutputAt: 0 }), 'reconcile', 'reconcile', NOW), null, 'never produced output');
  assert.equal(c.claim(fact(), 'delivery', 'event', NOW), null, 'event mode needs recorded idle');
  const quiet = fact({ lastOutputAt: NOW - WORKER_WAKE_IDLE_MS });
  const claim = c.claim(quiet, 'reconcile', 'reconcile', NOW);
  assert.ok(claim);
  c.settle(claim, 'REFUSED');
  assert.equal(c.claim(quiet, 'reconcile', 'reconcile', NOW + 1), null, 'the cooldown rate-limits scans');
  assert.ok(c.claim(quiet, 'reconcile', 'reconcile', NOW + WORKER_WAKE_COOLDOWN_MS));
});

test('B9 god is not special: there is no isGod, and god passes the same guards and claims', () => {
  const c = idleWith(['m1'], 'god-1');
  const claim = c.claim({ ...fact({ agentId: 'god-1', ptyId: 'pty-god' }), isGod: true }, 'delivery', 'event', NOW);
  assert.deepEqual([...claim.ids], ['m1']);
  assert.equal(claim.agentId, 'god-1');
  assert.equal(InboxWakeCoordinator, WorkerWakeWatchdog);
});

test('a new PTY incarnation releases a stale held claim to pending; pendingAgents lists work waiting', () => {
  const c = idleWith(['m1']);
  c.settle(c.claim(fact(), 'delivery', 'event', NOW), 'INTERFERED');
  assert.deepEqual(c.pendingAgents(), []);
  c.noteSpawn('pty-alice-2', NOW, 'alice');
  assert.equal(c.state('alice').held, null);
  assert.deepEqual(c.pendingAgents(), ['alice']);
  assert.equal(c.state('alice').lifecycle, 'unknown', 'a new process starts with no idle claim');
});

test('forget clears the agent and its boot grace', () => {
  const c = idleWith(['m1']);
  c.noteSpawn('pty-alice', NOW);
  c.forget('alice', 'pty-alice');
  assert.deepEqual(c.state('alice').pending, []);
  c.noteHook('alice', 'Stop', '', NOW);
  c.noteDelivery('alice', 'm2');
  assert.ok(c.claim(fact(), 'delivery', 'event', NOW), 'no boot grace left over');
});

test('classifyHook: permission/approve/confirm shapes are needsHuman', () => {
  assert.equal(classifyHook('Notification', 'Claude needs your permission to use Bash.'), 'needsHuman');
  assert.equal(classifyHook('Notification', 'Approve tool use?'), 'needsHuman');
  assert.equal(classifyHook('Notification', 'confirm the change?'), 'needsHuman');
});

test('classifyHook: idle-waiting shapes are idle, other events are null', () => {
  assert.equal(classifyHook('Notification', 'waiting for your input'), 'idle');
  assert.equal(classifyHook('Notification', 'Claude is idle — waiting for input'), 'idle');
  assert.equal(classifyHook('Notification', ''), 'idle');
  assert.equal(classifyHook('Stop', 'some message'), null);
  assert.equal(classifyHook('UserPromptSubmit', undefined), null);
});

test('the #151 nudge text is kept for reference', () => {
  assert.equal(WORKER_WAKE_NUDGE.length > 100, true);
  assert.match(WORKER_WAKE_NUDGE, /read your inbox/i);
});
