'use strict';

/**
 * WAKE TELEMETRY (D8). The durable breadcrumbs say what happened to one wake; these
 * counters say whether the floor is advancing itself at all — the question the 1.1.46
 * stall went fifteen minutes without anyone being able to ask.
 *
 * The test that matters most is the replay: feed the counters the exact stage stream the
 * broken build produced and check the rollup names the cause on its own.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WakeTelemetry } = loadTs('src/main/wakeTelemetry.ts');

const T = 1_700_000_000_000;

test('a healthy wake is counted end to end, per agent and on the floor', () => {
  const w = new WakeTelemetry(T);
  w.note('observer', { agentId: 'a', messageId: 'm1', bridge: true }, T);
  w.note('enter', { agentId: 'a', cause: 'delivery', mode: 'event' }, T);
  w.note('facts', { agentId: 'a' }, T);                    // not counted; carries no outcome
  w.note('claim', { agentId: 'a', ids: 1 }, T);
  w.note('submit', { agentId: 'a' }, T);
  w.note('settle', { agentId: 'a', outcome: 'COMMITTED' }, T + 50);

  const a = w.forAgent('a');
  assert.equal(a.deliveries, 1);
  assert.equal(a.requests, 1);
  assert.equal(a.claims, 1);
  assert.equal(a.submits, 1);
  assert.equal(a.outcomes.COMMITTED, 1);
  assert.equal(a.causes.delivery, 1);
  assert.equal(a.lastCommitAt, T + 50);

  const floor = w.floor();
  assert.equal(floor.claims, 1);
  assert.equal(floor.outcomes.COMMITTED, 1);
  assert.equal(floor.agents, 1);
});

test('THE 1.1.46 REPLAY: the rollup names the cause without reading a single row', () => {
  // The exact shape of the stall: the beat runs, every agent is entered, every claim is
  // refused for the same reason, nothing is ever submitted or committed.
  const w = new WakeTelemetry(T);
  for (let tick = 0; tick < 60; tick++) {          // 15 minutes of 15s beats
    const now = T + tick * 15_000;
    w.note('beat', { live: 2 }, now);
    for (const agentId of ['jim', 'andy']) {
      w.note('enter', { agentId, cause: 'reconcile', mode: 'reconcile' }, now);
      w.note('no-claim', { agentId, why: 'lifecycle-active', mode: 'reconcile', inboxIds: 1 }, now);
    }
  }
  w.note('stall', { agentId: 'jim', why: 'lifecycle-active' }, T + 300_000);

  const floor = w.floor();
  assert.equal(floor.beats, 60, 'the beat WAS armed and running — not the problem');
  assert.equal(floor.claims, 0, 'and not one wake was ever claimed');
  assert.equal(floor.submits, 0);
  assert.equal(floor.lastCommitAt, null, 'nothing has committed for the whole session');
  assert.equal(floor.refusals['lifecycle-active'], 120, 'every refusal, same reason');
  assert.equal(floor.lastRefusalWhy, 'lifecycle-active', 'named in one field');
  assert.equal(floor.stalls, 1, 'and the watchdog said so');
});

test('refusal reasons, outcomes and causes are each counted by kind', () => {
  const w = new WakeTelemetry(T);
  w.note('no-claim', { agentId: 'a', why: 'boot-grace' }, T);
  w.note('no-claim', { agentId: 'a', why: 'boot-grace' }, T + 1);
  w.note('no-claim', { agentId: 'a', why: 'reconcile-cooldown' }, T + 2);
  w.note('settle', { agentId: 'a', outcome: 'REFUSED' }, T + 3);
  w.note('settle', { agentId: 'a', outcome: 'INTERFERED' }, T + 4);
  w.note('enter', { agentId: 'a', cause: 'renderer' }, T + 5);
  w.note('enter', { agentId: 'a', cause: 'capacity' }, T + 6);

  const a = w.forAgent('a');
  assert.deepEqual(a.refusals, { 'boot-grace': 2, 'reconcile-cooldown': 1 });
  assert.deepEqual(a.outcomes, { REFUSED: 1, INTERFERED: 1 });
  assert.deepEqual(a.causes, { renderer: 1, capacity: 1 });
  assert.equal(a.lastRefusalWhy, 'reconcile-cooldown', 'the LAST one, not the commonest');
});

test('floor-wide stages are floor-wide, and never attributed to an agent', () => {
  const w = new WakeTelemetry(T);
  w.note('beat', { live: 3 }, T);
  w.note('heartbeat', { quiet: false, actionable: 0 }, T);
  w.note('observer-missing', { agentId: 'a', messageId: 'm' }, T);

  const floor = w.floor();
  assert.equal(floor.beats, 1);
  assert.equal(floor.heartbeats, 1);
  assert.equal(floor.observerMissing, 1, 'a durable write with no observer is a wake that could never happen');
  assert.equal(floor.agents, 0, 'none of those created an agent record');
  assert.equal(w.forAgent('a'), null);
});

test('the floor rollup sums agents and keeps the most recent facts', () => {
  const w = new WakeTelemetry(T);
  w.note('settle', { agentId: 'a', outcome: 'COMMITTED' }, T + 100);
  w.note('settle', { agentId: 'b', outcome: 'COMMITTED' }, T + 900);
  w.note('no-claim', { agentId: 'a', why: 'paused' }, T + 200);
  w.note('no-claim', { agentId: 'b', why: 'lifecycle-active' }, T + 800);

  const floor = w.floor();
  assert.equal(floor.outcomes.COMMITTED, 2);
  assert.equal(floor.agents, 2);
  assert.equal(floor.lastCommitAt, T + 900, 'the newest commit across the floor');
  assert.equal(floor.lastRefusalAt, T + 800);
  assert.equal(floor.lastRefusalWhy, 'lifecycle-active', 'the reason that goes with the newest refusal');
});

test('throws are counted, from either leg', () => {
  const w = new WakeTelemetry(T);
  w.note('throw', { agentId: 'a', error: 'boom' }, T);
  w.note('submit-threw', { agentId: 'a', error: 'bang' }, T);
  assert.equal(w.forAgent('a').throws, 2);
});

test('a missing or malformed field never throws and never invents an agent', () => {
  const w = new WakeTelemetry(T);
  w.note('enter', {}, T);                                   // no agentId
  w.note('no-claim', { agentId: 'a' }, T);                  // no why
  w.note('settle', { agentId: 'a', outcome: undefined }, T);// no outcome
  w.note('nonsense-stage', { agentId: 'a' }, T);
  const a = w.forAgent('a');
  assert.equal(a.refusals.unknown, 1, 'an unnamed reason is still counted, as unknown');
  assert.equal(a.outcomes.unknown, 1);
  assert.equal(w.floor().agents, 1, 'the fieldless row created nothing');
});

test('forAgent hands back a COPY — a reader cannot corrupt the counters', () => {
  const w = new WakeTelemetry(T);
  w.note('no-claim', { agentId: 'a', why: 'paused' }, T);
  const snap = w.forAgent('a');
  snap.refusals.paused = 999;
  snap.claims = 999;
  assert.equal(w.forAgent('a').refusals.paused, 1);
  assert.equal(w.forAgent('a').claims, 0);
});

test('it is OBSERVABILITY ONLY — the wake path must never read it back', () => {
  // The one property that keeps this safe to ship: counting cannot change a wake outcome.
  const fs = require('node:fs');
  const { join } = require('node:path');
  const root = join(__dirname, '..');
  for (const f of ['src/main/workerWake.ts', 'src/main/inboxWakeBridge.ts', 'src/main/wakeStall.ts']) {
    const src = fs.readFileSync(join(root, f), 'utf8');
    assert.ok(!/wakeTelemetry|WakeTelemetry/.test(src), `${f} must not read the counters`);
  }
  const tel = fs.readFileSync(join(root, 'src/main/wakeTelemetry.ts'), 'utf8');
  assert.ok(!/from '\.\/(workerWake|inboxWakeBridge|automaticSubmit)'/.test(tel),
    'and the counters import nothing from the wake path');
  // It is fed from the sink, and counted BEFORE the log folds reconcile rows away.
  const index = fs.readFileSync(join(root, 'src/main/index.ts'), 'utf8');
  const noteAt = index.indexOf('wakeTelemetry.note(');
  const dedupeAt = index.indexOf("if (fields.mode === 'reconcile')");
  assert.ok(noteAt > 0 && dedupeAt > 0 && noteAt < dedupeAt,
    'counted before the de-duplication, or a stall would be invisible to the counters too');
});

test('fleet.json carries the floor rollup and each agent its own counters', () => {
  const fs = require('node:fs');
  const { join } = require('node:path');
  const index = fs.readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(index, /hive\.writeFleetSnapshot\(\{ ts: now, agents, wake: wakeTelemetry\.snapshot\(now\) \}\)/);
  assert.match(index, /wake: wakeTelemetry\.forAgent\(id\)/, 'per-agent counters ride with the row');
  const row = index.slice(index.indexOf('inboxBacklog: hive.inboxBacklog(id)'), index.indexOf('wake: wakeTelemetry.forAgent(id)'));
  assert.ok(row.length < 500, 'and they sit next to the backlog they explain');
});
