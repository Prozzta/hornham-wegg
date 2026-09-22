'use strict';

/**
 * Pre-M1 event-wake bridge — submit integration and self-resume (test plan C, and the
 * plan's DEFINITION OF DONE).
 *
 * A REAL HiveManager (router effects injected: the reconciliation interval is captured and
 * never fired; there is no heartbeat anywhere in this file), the real coordinator and the
 * real bridge. The owner is a fake that models the real AutomaticSubmitOwner's request-id
 * idempotence (the same id returns the same promise; the same id with other text is
 * REJECTED) and counts the Enters it would press. Only the IMMEDIATE queue is flushed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { WorkerWakeWatchdog, inboxWakeRequestId, WORKER_WAKE_IDLE_MS } = loadTs('src/main/workerWake.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');

const NOW = 50_000_000;

/** The real owner's idempotence, in miniature: one id = one promise = at most one Enter. */
function fakeOwner(decide = () => 'COMMITTED') {
  const o = { calls: [], enters: [], known: new Map() };
  o.submit = (req) => {
    o.calls.push(req);
    const prior = o.known.get(req.requestId);
    if (prior) return prior.text === req.text ? prior.promise : Promise.resolve({ kind: 'REJECTED' });
    const kind = decide(req);
    if (kind === 'COMMITTED') o.enters.push(req.agentId);
    const promise = Promise.resolve({ kind });
    if (kind === 'COMMITTED' || kind === 'INTERFERED') o.known.set(req.requestId, { text: req.text, promise });
    return promise;
  };
  return o;
}

async function floor(t, { decide } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-inbox-wake-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const immediates = [];
  const intervals = [];
  const watchers = new Map();
  const setImmediateFake = (fn) => { immediates.push(fn); };
  const hive = new HiveManager(() => home, undefined, {
    watch: (dir, onHint) => { const w = { hint: onHint, close() {}, on() { return this; } }; watchers.set(dir, w); return w; },
    setImmediate: setImmediateFake,
    setInterval: (fn, ms) => { const h = { ms, fired: false }; h.fn = () => { h.fired = true; fn(); }; intervals.push(h); return h; },
    clearInterval: () => {}
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const control = new Map();          // agentId -> { paused, halted, autoDeliveryPaused }
  const flags = (id) => control.get(id) ?? { paused: false, halted: false, autoDeliveryPaused: false };
  const coordinator = new WorkerWakeWatchdog();
  const owner = fakeOwner(decide);
  const now = { t: NOW };
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: (id) => hive.inbox(id).map((m) => m.id).filter(Boolean),
    facts: (id) => ({ ptyId: `pty-${id}`, lastOutputAt: now.t - 1_000, ...flags(id), inhibited: false }),
    submit: (req) => owner.submit(req),
    text: (ids) => inboxNudgeText([...ids]),
    setImmediate: setImmediateFake,
    now: () => now.t
  });
  hive.setDeliveryObserver(({ agentId, messageId }) => bridge.onDelivery(agentId, messageId));
  hive.startRouter();
  const outbox = (id) => path.join(home, 'hive', 'agents', id, 'outbox');
  const flush = async () => {
    for (let i = 0; i < 20; i++) {
      while (immediates.length) immediates.shift()();
      await new Promise((r) => setImmediate(r));   // let settled promises land
      if (!immediates.length) return;
    }
  };
  const post = (from, id, to = 'god-1') => {
    fs.writeFileSync(path.join(outbox(from), `${id}.json`), JSON.stringify({ id, to, act: 'done', subject: `s-${id}`, body: 'b' }));
    watchers.get(outbox(from)).hint();
  };
  return { home, hive, coordinator, bridge, owner, control, intervals, flush, post, now };
}

test('DoD C1: an outbox file routes to god and commits EXACTLY ONE guarded wake - no interval fired, no heartbeat', async (t) => {
  const f = await floor(t);
  f.coordinator.noteHook('god-1', 'Stop', '', NOW);          // god is parked at its prompt
  f.post('jim-1', 'done-1');                                 // a worker's completion
  await f.flush();
  assert.ok(f.intervals.every((h) => !h.fired), 'the reconciliation interval never ran');
  assert.equal(f.hive.inbox('god-1').length, 1, 'the router delivered it durably');
  assert.equal(f.owner.calls.length, 1);
  const call = f.owner.calls[0];
  assert.equal(call.agentId, 'god-1');
  assert.equal(call.admissionClass, 'CAPACITY_GATED');
  assert.equal(call.requestId, inboxWakeRequestId('god-1', ['done-1']));
  assert.equal(call.text, inboxNudgeText(['done-1']));
  assert.match(call.text, /done-1/);
  assert.deepEqual(f.owner.enters, ['god-1'], 'exactly one Enter');
  assert.deepEqual(f.coordinator.state('god-1').announced, ['done-1'], 'announced only after COMMITTED');
});

test('C2 delivered while god is mid-turn: nothing; god\'s Stop: exactly one wake', async (t) => {
  const f = await floor(t);
  f.coordinator.noteHook('god-1', 'UserPromptSubmit', '', NOW);
  f.post('jim-1', 'done-2');
  await f.flush();
  assert.equal(f.owner.calls.length, 0, 'mid-turn: intent recorded, nothing typed');
  f.bridge.onHook('god-1', 'Stop', '');
  await f.flush();
  assert.equal(f.owner.calls.length, 1);
  assert.deepEqual(f.owner.enters, ['god-1']);
});

test('C3 delivery, Stop, a duplicate watch hint, a capacity change, a control release and reconciliation all at once: ONE submit, ONE Enter', async (t) => {
  const f = await floor(t);
  f.coordinator.noteHook('god-1', 'Stop', '', NOW);
  f.post('jim-1', 'done-3');
  f.bridge.onHook('god-1', 'Stop', '');
  f.bridge.onCapacityChange();
  f.bridge.onControlRelease('god-1');
  f.bridge.reconcileAll(['god-1', 'jim-1']);
  await f.flush();
  f.bridge.onHook('god-1', 'SubagentStop', '');
  f.bridge.reconcileAll(['god-1']);
  f.now.t += WORKER_WAKE_IDLE_MS * 10;
  f.bridge.reconcileAll(['god-1']);
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'one submit');
  assert.deepEqual(f.owner.enters, ['god-1'], 'one Enter');
});

test('events for one agent in one turn coalesce into ONE scheduled attempt', () => {
  const queued = [];
  const bridge = new InboxWakeBridge({
    coordinator: new WorkerWakeWatchdog(), inboxIds: () => [], facts: () => null,
    submit: () => Promise.resolve({ kind: 'COMMITTED' }), text: () => '', setImmediate: (fn) => queued.push(fn), now: () => NOW
  });
  bridge.onDelivery('god-1', 'a');
  bridge.onHook('god-1', 'Stop', '');
  bridge.onControlRelease('god-1');
  bridge.scheduleWake('god-1', 'capacity');
  bridge.scheduleWake('jim-1', 'delivery');
  assert.equal(queued.length, 2, 'one per agent, not one per event');
  queued.shift()();
  bridge.scheduleWake('god-1', 'hook');
  assert.equal(queued.length, 2, 'after it runs, the next turn can schedule again');
});

test('C4 a REFUSED wake keeps its ids; the release edge retries at once, with no interval', async (t) => {
  let refuse = true;
  const f = await floor(t, { decide: () => (refuse ? 'REFUSED' : 'COMMITTED') });
  f.coordinator.noteHook('god-1', 'Stop', '', NOW);
  f.control.set('god-1', { paused: false, halted: false, autoDeliveryPaused: false });
  f.post('jim-1', 'done-4');
  await f.flush();
  assert.equal(f.owner.calls.length, 1);
  assert.deepEqual(f.coordinator.state('god-1').pending, ['done-4'], 'refused: not spent');
  // Paused: the release edge is what retries.
  f.control.set('god-1', { paused: true, halted: false, autoDeliveryPaused: false });
  refuse = false;
  f.bridge.onHook('god-1', 'Stop', '');
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'paused: nothing typed');
  f.control.set('god-1', { paused: false, halted: false, autoDeliveryPaused: false });
  f.bridge.onControlRelease('god-1');
  await f.flush();
  assert.equal(f.owner.calls.length, 2);
  assert.deepEqual(f.owner.enters, ['god-1']);
});

test('C5 INTERFERED: no automatic retry until a human rules; ALREADY_HANDLED submits nothing, SEND_AGAIN goes again', async (t) => {
  const f = await floor(t, { decide: () => 'INTERFERED' });
  f.coordinator.noteHook('god-1', 'Stop', '', NOW);
  f.post('jim-1', 'done-5');
  await f.flush();
  f.bridge.onHook('god-1', 'Stop', '');
  f.bridge.onCapacityChange();
  f.now.t += WORKER_WAKE_IDLE_MS * 10;
  f.bridge.reconcileAll(['god-1']);
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'held: nothing automatic');
  f.bridge.onInterferenceResolved('god-1', 'ALREADY_HANDLED');
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'ALREADY_HANDLED resolves without a submit');
  assert.deepEqual(f.coordinator.state('god-1').announced, ['done-5']);

  const g = await floor(t, { decide: () => 'INTERFERED' });
  g.coordinator.noteHook('god-1', 'Stop', '', NOW);
  g.post('jim-1', 'done-6');
  await g.flush();
  g.owner.known.clear();               // the real owner releases the id on SEND_AGAIN
  g.bridge.onInterferenceResolved('god-1', 'SEND_AGAIN');
  await g.flush();
  assert.equal(g.owner.calls.length, 2, 'SEND_AGAIN goes back through every guard');
});

test('C6 the inbox drains between the event and the request: the authoritative re-read submits nothing', async (t) => {
  const f = await floor(t);
  f.coordinator.noteHook('god-1', 'Stop', '', NOW);
  f.coordinator.noteDelivery('god-1', 'gone-1');
  f.bridge.scheduleWake('god-1', 'delivery');
  await f.flush();
  assert.equal(f.owner.calls.length, 0, 'no file on disk: no wake');
});

test('C7 a worker and god go through the SAME code path; no god branch, no heartbeat dependency', async (t) => {
  const f = await floor(t);
  f.coordinator.noteHook('jim-1', 'Stop', '', NOW);
  f.coordinator.noteHook('god-1', 'Stop', '', NOW);
  f.post('god-1', 'task-1', 'jim-1');
  f.post('jim-1', 'done-7', 'god-1');
  await f.flush();
  assert.deepEqual(f.owner.calls.map((c) => c.agentId).sort(), ['god-1', 'jim-1']);
  assert.ok(f.owner.calls.every((c) => c.admissionClass === 'CAPACITY_GATED'));
  const bridgeSrc = codeOnly(readSource('src/main/inboxWakeBridge.ts'), 'inboxWakeBridge.ts');
  assert.ok(!/godId|isGod|heartbeat/i.test(bridgeSrc), 'no god branch and no heartbeat in the bridge');
});

test('D3 through the bridge: god mid-tool with an old last output gets NO reconcile wake until Stop', async (t) => {
  const f = await floor(t);
  f.coordinator.noteHook('god-1', 'PreToolUse', '', NOW);
  f.hive.setDeliveryObserver(null);
  f.post('jim-1', 'mid-1');
  await f.flush();
  f.now.t += 30 * 60_000;                                    // the PTY has been silent for 30 minutes
  f.bridge.reconcileAll(['god-1']);
  await f.flush();
  assert.equal(f.owner.calls.length, 0, 'an active god is not typed into on silence');
  f.bridge.onHook('god-1', 'Stop', '');
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'the Stop edge wakes it once');
});

test('a missed delivery event is found by reconciliation (one wake, then never again)', async (t) => {
  const f = await floor(t);
  f.hive.setDeliveryObserver(null);                           // the callback is lost
  f.coordinator.noteHook('god-1', 'Stop', '', NOW);
  f.post('jim-1', 'lost-1');
  await f.flush();
  assert.equal(f.owner.calls.length, 0);
  f.bridge.reconcileAll(['god-1', 'jim-1']);
  await f.flush();
  assert.equal(f.owner.calls.length, 1);
  f.now.t += 10 * 60_000;
  f.bridge.reconcileAll(['god-1', 'jim-1']);
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'announced mail is not re-woken');
});

// ─── Main wiring (source pins): one path, every edge, no god branch ─────────────────

test('index.ts wires every edge to the ONE bridge, registered before the router starts', () => {
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const at = (s) => { const i = index.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('hive.setDeliveryObserver(') < at('hive.startRouter()'), 'the delivery observer exists before any routing');
  assert.match(index, /hive\.setDeliveryObserver\(\(\{ agentId, messageId \}\) => inboxWake\?\.onDelivery\(agentId, messageId\)\)/);
  assert.match(index, /\(agentId, event, message\) => inboxWake\?\.onHook\(agentId, event, message\)/, 'the hook stream');
  assert.match(index, /transition === 'UNPAUSED' \|\| transition === 'RESUMED' \|\| transition === 'AUTO_DELIVERY_RELEASED'/, 'only releases retry');
  assert.match(index, /onChange: \(\) => \{ pushCapacityStrip\(\); pushAgentUsage\(\); inboxWake\?\.onCapacityChange\(\); \}/);
  assert.match(index, /if \(resolved\) inboxWake\?\.onInterferenceResolved\(agentId, how as InterferenceResolution\);/);
  assert.match(index, /workerWake\.noteSpawn\(opts\.id, Date\.now\(\), opts\.hive\.id\)/);
  const beat = index.slice(at('function runWorkerWakeBeat'), at('function armAlwaysOnBeats'));
  assert.ok(!/godId|isGod/.test(beat), 'no god exclusion in reconciliation');
  assert.match(index, /const WORKER_WAKE_POLL_MS = 15_000;/, 'the 15s scan cadence is unchanged');
  const wake = codeOnly(readSource('src/main/workerWake.ts'), 'workerWake.ts');
  assert.ok(!/isGod|godId/.test(wake), 'the coordinator has no god field or branch');
});
