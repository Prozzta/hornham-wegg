'use strict';

/**
 * v1.1.45 unit #13 — crit 15, "no renderer polling": the Monitor 5H / Weekly usage line is
 * PUSHED by main. Main builds one row per agent whose persisted display is 5H or Weekly,
 * dedupes on the ROWS (never on the strip's collectionRevision), and sends them on their
 * OWN channel at the owner's onChange, agent leave, agent spawn and the display setter.
 * The renderer hook invokes once on mount and then only listens: it has no timer at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { agentUsagePushOf, AgentUsagePushGate, agentUsageView } = loadTs('src/main/capacityAgentUsage.ts');
const usage = loadTs('src/shared/agentUsage.ts');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct-secret:codex';
const win = (id, kind, remaining) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: 100 - remaining, remainingPercent: remaining,
  resetsAt: T0 + 3_600_000 });
function rig() {
  let now = T0;
  let seq = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const read = (five, weekly) => {
    now += 1000;
    tracker.ingest({ poolKey: POOL, streamId: 's', sourceSequence: ++seq, provider: 'codex', accountScope: 'acct-secret',
      limitId: 'codex', source: 'codex-rollout', observedAt: now, receivedAt: now,
      windows: [win('five_hour', 'FIVE_HOUR', five), win('seven_day', 'SEVEN_DAY', weekly)],
      providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus' });
  };
  const poolOf = (id) => (id === 'ghost' ? null : tracker.pool(POOL));
  return { read, poolOf, now: () => now };
}

// ─── Main: the rows ──────────────────────────────────────────────────────────────────

test('rows: one per 5H / Weekly agent, in id order, each the SAME view the invoke answers; Budget has none', () => {
  const r = rig();
  r.read(80, 60);
  const push = agentUsagePushOf({ zed: 'weekly', amy: 'fiveHour', bob: 'budget', odd: 'monthly', ghost: 'fiveHour' }, r.poolOf, r.now());
  assert.deepEqual(push.rows.map((x) => x.agentId), ['amy', 'ghost', 'zed'], 'budget and malformed are absent');
  for (const row of push.rows) assert.deepEqual(row.view, agentUsageView(r.poolOf(row.agentId), r.now()));
  assert.deepEqual(usage.validateAgentUsagePush(push), []);
  assert.deepEqual(agentUsagePushOf(undefined, r.poolOf, r.now()), { rows: [] }, 'nobody on 5H / Weekly: an empty push');
});

test('C2.9: a push carries no pool identity - agent ids and display-ready views only', () => {
  const r = rig();
  r.read(80, 60);
  const json = JSON.stringify(agentUsagePushOf({ amy: 'fiveHour' }, r.poolOf, r.now()));
  for (const secret of ['acct-secret', 'codex:', 'poolKey', 'accountScope', 'limitId']) assert.ok(!json.includes(secret), secret);
});

test('the push validator refuses extra properties, duplicate agents and a bad view - whole', () => {
  const v = { fiveHour: { kind: 'TEXT', text: '5h · capacity unknown' }, weekly: { kind: 'TEXT', text: 'Weekly · capacity unknown' } };
  assert.deepEqual(usage.validateAgentUsageView(v), []);
  const row = (agentId, view = v) => ({ agentId, view });
  assert.deepEqual(usage.validateAgentUsagePush({ rows: [row('a')] }), []);
  assert.ok(usage.validateAgentUsagePush({ rows: [row('a')], pools: [] }).length);
  assert.ok(usage.validateAgentUsagePush({ rows: [row('a'), row('a')] }).length);
  assert.ok(usage.validateAgentUsagePush({ rows: [{ ...row('a'), poolKey: 'x' }] }).length);
  assert.ok(usage.validateAgentUsagePush({ rows: [row('a', { fiveHour: 1 })] }).length);
  assert.ok(usage.validateAgentUsagePush({ rows: 'no' }).length);
});

// ─── Main: dedupe on the ROWS ───────────────────────────────────────────────────────

test('dedupe on the ROWS: an unchanged push is not sent again; a real usage change always is', () => {
  const r = rig();
  const gate = new AgentUsagePushGate();
  const displays = { amy: 'fiveHour' };
  r.read(80, 60);
  assert.ok(gate.next(agentUsagePushOf(displays, r.poolOf, r.now())), 'the first push is sent');
  assert.equal(gate.next(agentUsagePushOf(displays, r.poolOf, r.now())), null, 'the same rows are not re-sent');
  r.read(79, 60);                                                // 5h used 20% -> 21%
  const moved = gate.next(agentUsagePushOf(displays, r.poolOf, r.now()));
  assert.ok(moved, 'a usage change is sent even though nothing else moved');
  assert.match(moved.rows[0].view.fiveHour.text, /21% used/);
  assert.ok(gate.next(agentUsagePushOf({ amy: 'fiveHour', bob: 'weekly' }, r.poolOf, r.now())), 'a new 5H / Weekly agent is sent');
  assert.ok(gate.next(agentUsagePushOf({}, r.poolOf, r.now())), 'everyone back on Budget is sent (the rows emptied)');
  assert.equal(gate.next({ rows: [{ agentId: 'a', view: { fiveHour: 1 } }] }), null, 'an invalid push is refused, not sent');
});

// ─── Main: the wiring ───────────────────────────────────────────────────────────────

test('main pushes on the owner onChange (carries FRESH -> STALE decay), agent leave, agent spawn and the display setter', () => {
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(main, /onChange: \(\) => \{ pushCapacityStrip\(\); pushAgentUsage\(\); pushAgentImpact\(\); \}/);
  assert.match(main, /ptyProvider\.delete\(id\);\s*pushCapacityStrip\(\);\s*pushAgentUsage\(\);/, 'agent leave');
  assert.match(main, /ptyProvider\.set\(opts\.id, provider\);\s*pushCapacityStrip\(\);\s*pushAgentUsage\(\);/, 'agent spawn');
  assert.match(main, /ipcMain\.handle\('config:setAgentUsageDisplay', \(_evt, agentId: unknown, display: unknown\) => \{\s*const next = setAgentUsageDisplay\(agentId, display\);\s*pushAgentUsage\(\);\s*return next;/);
  const fnStart = main.indexOf('function pushAgentUsage(');
  const fn = main.slice(fnStart, main.indexOf('\n}\n', fnStart));
  assert.match(fn, /agentUsagePushGate\.next\(agentUsagePushOf\(readConfig\(\)\.agentUsageDisplay,/);
  assert.match(fn, /w\.webContents\.send\(CAPACITY_AGENT_USAGE_PUSH, push\)/, 'its OWN channel');
  assert.ok(!/collectionRevision|lastPushedCapacityStrip/.test(fn), 'never keyed on the strip revision');
  assert.equal(usage.CAPACITY_AGENT_USAGE_PUSH, 'capacity:agentUsagePush');
  assert.notEqual(usage.CAPACITY_AGENT_USAGE_PUSH, 'control:snapshot');
  const preload = readSource('src/preload/index.ts');
  assert.match(preload, /ipcRenderer\.on\('capacity:agentUsagePush', listener\)/);
  assert.match(preload, /ipcRenderer\.removeListener\('capacity:agentUsagePush', listener\)/);
  assert.match(preload, /ipcRenderer\.invoke\('capacity:agentUsage', agentId\)/, 'the mount-time invoke is kept');
});

// ─── Renderer: no polling, by census ────────────────────────────────────────────────

test('crit 15 POLL-ABSENCE: the usage line has no timer of any kind', () => {
  const src = codeOnly(readSource('src/renderer/src/components/AgentUsageLine.tsx'), 'AgentUsageLine.tsx');
  assert.ok(!/\bsetInterval\b|\bsetTimeout\b|requestAnimationFrame|USAGE_POLL_MS/.test(src), 'no poll, no timer');
  assert.match(src, /window\.cth\.onAgentUsage\(/, 'it listens to main');
});

/** Run the hook once with React's hooks stubbed on the real module (no DOM). */
function runHook(agentId, display, bridge) {
  const { useAgentUsageWindow } = loadTs('src/renderer/src/components/AgentUsageLine.tsx');
  const views = [];
  const cleanups = [];
  const timers = [];
  const saved = { useEffect: React.useEffect, useState: React.useState, window: global.window,
    setInterval: global.setInterval, setTimeout: global.setTimeout };
  React.useEffect = (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c); };
  React.useState = (init) => [init, (v) => views.push(v)];
  global.window = { cth: bridge };
  // Recorded, never started: a timer in the hook must FAIL this test, not hang the process.
  global.setInterval = (...a) => { timers.push(['setInterval', a[1]]); return 0; };
  global.setTimeout = (...a) => { timers.push(['setTimeout', a[1]]); return 0; };
  try { useAgentUsageWindow(agentId, display); } finally {
    React.useEffect = saved.useEffect; React.useState = saved.useState; global.window = saved.window;
    global.setInterval = saved.setInterval; global.setTimeout = saved.setTimeout;
  }
  assert.deepEqual(timers, [], 'crit 15: the hook starts no timer');
  return { views, cleanup: () => cleanups.forEach((c) => c()) };
}

test('the hook: invoke once on mount, then pushes for THIS agent only; a push beats a late invoke; cleanup unsubscribes', async () => {
  const listeners = new Set();
  let resolveInvoke;
  const calls = [];
  const bridge = {
    capacityAgentUsage: (id) => { calls.push(id); return new Promise((res) => { resolveInvoke = res; }); },
    onAgentUsage: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }
  };
  const h = runHook('amy', 'weekly', bridge);
  assert.deepEqual(calls, ['amy'], 'one mount-time invoke');
  assert.equal(listeners.size, 1, 'one subscription');
  const view = (w) => ({ fiveHour: { kind: 'TEXT', text: '5h' }, weekly: { kind: 'TEXT', text: w } });
  for (const cb of listeners) cb({ rows: [{ agentId: 'bob', view: view('bob') }] });
  assert.deepEqual(h.views, [], 'another agent\'s row is ignored');
  for (const cb of listeners) cb({ rows: [{ agentId: 'amy', view: view('pushed') }] });
  assert.deepEqual(h.views, [{ kind: 'TEXT', text: 'pushed' }], 'this agent\'s chosen window, from the push');
  resolveInvoke(view('stale invoke'));
  await new Promise((res) => setImmediate(res));
  assert.equal(h.views.length, 1, 'the late mount answer does not overwrite a newer push');
  h.cleanup();
  assert.equal(listeners.size, 0, 'unsubscribed on cleanup');
});

// ─── Jim's #13 audit: F11 + F12 (tests only; the code is correct in both spots) ─────

test('F11: a push WITHOUT this agent\'s row does not count as "pushed" - the mount answer still lands', async () => {
  let resolveInvoke;
  const listeners = new Set();
  const bridge = {
    capacityAgentUsage: () => new Promise((res) => { resolveInvoke = res; }),
    onAgentUsage: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }
  };
  const h = runHook('amy', 'fiveHour', bridge);
  const view = (w) => ({ fiveHour: { kind: 'TEXT', text: w }, weekly: { kind: 'TEXT', text: 'Weekly' } });
  for (const cb of listeners) cb({ rows: [{ agentId: 'bob', view: view('bob') }] });   // row-less for amy
  for (const cb of listeners) cb({ rows: [] });
  resolveInvoke(view('mount answer'));
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(h.views, [{ kind: 'TEXT', text: 'mount answer' }], 'the initial state is not lost to an unrelated push');
  h.cleanup();
});

test('F12: the dedupe key includes the agent id - the SAME view under a DIFFERENT agent is sent again', () => {
  const gate = new AgentUsagePushGate();
  const v = { fiveHour: { kind: 'TEXT', text: '5h · capacity unknown' }, weekly: { kind: 'TEXT', text: 'Weekly · capacity unknown' } };
  assert.ok(gate.next({ rows: [{ agentId: 'amy', view: v }] }));
  const moved = gate.next({ rows: [{ agentId: 'bob', view: v }] });
  assert.ok(moved, 'amy switched to Budget and bob to 5H with an identical view: the rows changed, so it is sent');
  assert.deepEqual(moved.rows.map((r) => r.agentId), ['bob']);
});
