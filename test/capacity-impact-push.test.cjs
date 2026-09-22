'use strict';

/**
 * v1.1.45 CRIT-15-PRE — the agent-card impact string is PUSHED by main, never polled by
 * the renderer. Each pin kills a census mutant (test/tools/capacity-mutants.cjs, "c15"):
 * no renderer timer; main pushes on every event that can move the string (capacity
 * publication, admission-ledger move incl. an unresolved reservation's lapse, floor pause,
 * automatic-submit outcome, resolved interference, agent spawn / leave); its OWN channel;
 * rows = the agents asked about through control:snapshot; dedupe on the rows; a push beats
 * a late mount answer. The strings themselves are unit #5's, unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { agentImpactPushOf, AgentImpactPushGate } = loadTs('src/main/agentImpactPush.ts');
const hold = loadTs('src/shared/deliveryHold.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { RECOVERY_RESERVATION_TTL_MS } = loadTs('src/main/capacityAdmission.ts');

const limited = { kind: 'CAPACITY_LIMITED', verb: 'paused', text: 'paused · Codex limited' };
const floor = { kind: 'DELIVERY_PAUSED', verb: 'paused', text: 'paused · auto-delivery off (floor)' };

// ─── Main: the rows, the dedupe, the channel ────────────────────────────────────────

test('rows: one per watched agent, in id order, each the value the snapshot answers (null when nothing is held)', () => {
  const push = agentImpactPushOf(['bob', 'amy', 'bob'], (id) => (id === 'amy' ? limited : null));
  assert.deepEqual(push, { rows: [{ agentId: 'amy', impact: limited }, { agentId: 'bob', impact: null }] });
});

test('dedupe on the ROWS: an unchanged push is not sent again; a real change always is; the key includes the agent', () => {
  const gate = new AgentImpactPushGate();
  const p = (impact, agentId = 'amy') => ({ rows: [{ agentId, impact }] });
  assert.ok(gate.next(p(limited)), 'first push goes');
  assert.equal(gate.next(p(limited)), null, 'unchanged: not sent');
  assert.ok(gate.next(p(floor)), 'a different string is sent');
  assert.ok(gate.next(p(null)), 'a hold that clears is sent');
  assert.ok(gate.next(p(null, 'bob')), 'the same value under another agent is sent');
});

test('its OWN channel, the one computation for both doors, and the snapshot registers the agent', () => {
  assert.equal(hold.AGENT_IMPACT_PUSH, 'control:agentImpactPush');
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const fnStart = main.indexOf('function pushAgentImpact(');
  const fn = main.slice(fnStart, main.indexOf('\n}\n', fnStart));
  assert.ok(fnStart > 0);
  assert.match(fn, /agentImpactPushGate\.next\(agentImpactPushOf\(impactWatched, \(agentId\) => controlFactsOf\(agentId\)\.impact\)\)/);
  assert.match(fn, /w\.webContents\.send\(AGENT_IMPACT_PUSH, push\)/, 'its OWN channel');
  const start = main.indexOf("ipcMain.handle('control:snapshot'");
  const handler = main.slice(start, main.indexOf('});', start));
  assert.match(handler, /impactWatched\.add\(agentId\);/, 'asked about once, pushed from then on');
  assert.match(handler, /const f = controlFactsOf\(agentId\);/);
  const preload = readSource('src/preload/index.ts');
  assert.match(preload, /ipcRenderer\.on\('control:agentImpactPush', listener\)/);
  assert.match(preload, /ipcRenderer\.removeListener\('control:agentImpactPush', listener\)/);
  assert.match(preload, /ipcRenderer\.invoke\('control:snapshot', agentId\)/, 'the mount-time read is kept');
});

test('main pushes on every event that can move the string', () => {
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(main, /onChange: \(\) => \{ pushCapacityStrip\(\); pushAgentUsage\(\); pushAgentImpact\(\); \}/, 'capacity publication (carries decay)');
  assert.match(main, /onAdmission: \(\) => pushAgentImpact\(\)/, 'admission-ledger move');
  assert.match(main, /onOutcome: \(r\) => \{\s*pushAgentImpact\(\);\s*if \(r\.outcome\.kind === 'COMMITTED'\) return;/, 'every submit outcome, before the COMMITTED early return');
  assert.match(main, /ptyProvider\.delete\(id\);[\s\S]{0,120}?pushAgentUsage\(\);\s*pushAgentImpact\(\);/, 'agent leave');
  assert.match(main, /ptyProvider\.set\(opts\.id, provider\);[\s\S]{0,120}?pushAgentUsage\(\);\s*pushAgentImpact\(\);/, 'agent spawn');
  assert.match(main, /writeConfig\(\{ autoDeliveryPausedAgents: Array\.from\(current\)\.sort\(\) \}\);\s*pushAgentImpact\(\);/, 'the floor switch');
  assert.match(main, /controlAutoDelivery: \(id, paused\) => \{ control\.pauseAutoDelivery\(id, paused\); pushAgentImpact\(\); \}/, 'the voice floor switch');
  assert.match(main, /automaticSubmit\.resolveInterference\(ptyId, how as InterferenceResolution\) : false;\s*pushAgentImpact\(\);/, 'a resolved interference');
});

// ─── The runtime's admission hook ───────────────────────────────────────────────────

function runtimeRig() {
  const timers = [];
  const calls = [];
  const rt = new CapacityRuntime({
    deliver: () => {},
    now: () => 1_800_000_000_000,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    onAdmission: () => calls.push('moved')
  });
  return { rt, timers, calls };
}

test('the admission hook fires on admit, confirm, hold-for-human and cancel', () => {
  const { rt, calls } = runtimeRig();
  const d = rt.admit('amy', 'ORDINARY_TURN');
  assert.equal(calls.length, 1, 'admit');
  rt.confirmLaunch(d); assert.equal(calls.length, 2, 'confirm');
  rt.holdGrant(d); assert.equal(calls.length, 3, 'hold for a person');
  rt.cancelGrant(d); assert.equal(calls.length, 4, 'cancel');
});

test('a reserved grant arms ONE one-shot at its TTL, so a lapse nobody resolves still re-pushes; stop() clears it', () => {
  const { rt, timers, calls } = runtimeRig();
  const real = rt.admission.admit.bind(rt.admission);
  rt.admission.admit = (...a) => ({ ...real(...a), grantId: 'pool#post-reset:k#1' });
  rt.admit('amy', 'ORDINARY_TURN');
  const lapse = timers.filter((t) => t.ms === RECOVERY_RESERVATION_TTL_MS + 1);
  assert.equal(lapse.length, 1, 'one one-shot at the reservation TTL');
  const before = calls.length;
  timers.splice(timers.indexOf(lapse[0]), 1);   // it fires: a real timer is gone once it has run
  lapse[0].fn();
  assert.equal(calls.length, before + 1, 'the lapse is an admission move');
  rt.admit('amy', 'ORDINARY_TURN');
  rt.stop();
  assert.equal(timers.filter((t) => t.ms === RECOVERY_RESERVATION_TTL_MS + 1).length, 0, 'stop() clears pending lapses');
});

// ─── Renderer: no polling, by census and by running the hook ────────────────────────

test('crit 15 POLL-ABSENCE: the impact hook has no timer of any kind', () => {
  const src = codeOnly(readSource('src/renderer/src/hooks/useAgentImpact.ts'), 'useAgentImpact.ts');
  assert.ok(!/\bsetInterval\b|\bsetTimeout\b|requestAnimationFrame|POLL_MS/.test(src), 'no poll, no timer');
  assert.match(src, /window\.cth\.onAgentImpact\(onPush\)/, 'it listens to main');
});

/** Subscribe through the real hook with useSyncExternalStore stubbed (no DOM). */
function mount(agentId, bridge) {
  const { useAgentImpact } = loadTs('src/renderer/src/hooks/useAgentImpact.ts');
  const timers = [];
  const saved = { uses: React.useSyncExternalStore, window: global.window, setInterval: global.setInterval, setTimeout: global.setTimeout };
  let unsubscribe = null;
  let getSnapshot = null;
  let notified = 0;
  React.useSyncExternalStore = (sub, get) => { unsubscribe = sub(() => { notified++; }); getSnapshot = get; return get(); };
  global.window = { cth: bridge };
  // Recorded, never started: a timer in the hook must FAIL this test, not hang the process.
  global.setInterval = (...a) => { timers.push(['setInterval', a[1]]); return 0; };
  global.setTimeout = (...a) => { timers.push(['setTimeout', a[1]]); return 0; };
  try { useAgentImpact(agentId); } finally {
    React.useSyncExternalStore = saved.uses;
    global.setInterval = saved.setInterval; global.setTimeout = saved.setTimeout;
  }
  assert.deepEqual(timers, [], 'crit 15: the hook starts no timer');
  return {
    value: () => getSnapshot(),
    notified: () => notified,
    unmount: () => { unsubscribe(); global.window = saved.window; }
  };
}

test('the hook: one mount-time read, then pushes for THIS agent; a push beats a late mount answer; unmount unsubscribes', async () => {
  const listeners = new Set();
  let resolveRead;
  const reads = [];
  const bridge = {
    controlSnapshot: (id) => { reads.push(id); return new Promise((res) => { resolveRead = res; }); },
    onAgentImpact: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }
  };
  const h = mount('c15-amy', bridge);
  assert.deepEqual(reads, ['c15-amy'], 'one mount-time read');
  assert.equal(listeners.size, 1, 'one subscription');
  for (const cb of listeners) cb({ rows: [{ agentId: 'c15-bob', impact: limited }] });
  assert.equal(h.value(), null, 'another agent\'s row is ignored');
  for (const cb of listeners) cb({ rows: [{ agentId: 'c15-amy', impact: limited }] });
  assert.deepEqual(h.value(), limited, 'a real impact change arrives by push');
  assert.equal(h.notified(), 1);
  resolveRead({ impact: floor });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(h.value(), limited, 'the late mount answer does not overwrite a newer push');
  for (const cb of listeners) cb({ rows: [{ agentId: 'c15-amy', impact: null }] });
  assert.equal(h.value(), null, 'a cleared hold arrives by push');
  h.unmount();
  assert.equal(listeners.size, 0, 'unsubscribed when nothing is shown');
});

test('before any push for the agent, the mount answer lands', async () => {
  const listeners = new Set();
  let resolveRead;
  const bridge = {
    controlSnapshot: () => new Promise((res) => { resolveRead = res; }),
    onAgentImpact: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }
  };
  const h = mount('c15-cy', bridge);
  for (const cb of listeners) cb({ rows: [{ agentId: 'c15-dee', impact: limited }] });
  resolveRead({ impact: floor });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(h.value(), floor);
  h.unmount();
});
