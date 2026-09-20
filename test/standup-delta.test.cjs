'use strict';

/**
 * TE0 — the standup delta gate.
 *
 * The gate's whole job is to NOT invoke a model when nothing changed, so the arms
 * that matter are the ones that prove it suppresses for the right reason and
 * dispatches for every other reason. Two of them guard rules that are easy to
 * break later and impossible to notice at run time:
 *
 *   - the fingerprint must ignore god's OWN output (board.md, task prose). Hash
 *     that and the gate sees a delta after every standup and suppresses nothing,
 *     while still looking like a working feature.
 *   - a suppressed tick must still stamp lastFiredAt, or syncMissions re-arms with
 *     a zero delay and spins the mission.
 *
 * The decision layer is pure, so most of this is direct. The two facts that live
 * in the index.ts call site are asserted STRUCTURALLY against its source — that is
 * weaker evidence than a behavioural run and is labelled as such where it appears;
 * `fire()` is a closure inside a 5,500-line Electron main module and cannot be
 * imported without booting Electron.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  decideStandup, fingerprintFloor, projectTasks, canonicalize, skipRecord, DEFAULT_MAX_AGE_MS
} = loadTs('src/main/standupDelta.ts');

const INDEX_TS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

/** A floor with one working agent and one card. */
const floor = (over = {}) => ({
  agents: [{
    id: 'andy', onHold: false, breaker: 'ok', hasLivePty: true,
    actionableInbox: 0, lastCoordinationAtMs: 1_000
  }],
  tasks: [{ id: 'TE0', status: 'doing', assignee: 'andy' }],
  spawnRequests: 0,
  crashes: 0,
  ...over
});

const GATE = { enabled: true, maxAgeMs: DEFAULT_MAX_AGE_MS };

// ── Rule 1: the fingerprint covers floor INPUTS, never god's own OUTPUTS ──────

test('task PROSE is not hashed: only id/status/assignee survive the projection', () => {
  // A no-change standup rewrites `notes` on the cards it reviewed and appends to
  // `result`. If either reached the fingerprint, the next standup would see a
  // delta caused by the previous standup and the gate would never close.
  const raw = [{
    id: 'TE0',
    status: 'doing',
    assignee: 'andy',
    title: 'TE0 — scheduler delta gate',
    notes: 'STANDUP 21:03: no change, floor idle, nothing blocked.',
    result: 'pending',
    humanQA: [{ q: 'authorised?', a: 'yes' }],
    createdAt: '2026-09-10T19:43:40.538Z'
  }];
  assert.deepEqual(projectTasks(raw), [{ id: 'TE0', status: 'doing', assignee: 'andy' }]);

  const after = JSON.parse(JSON.stringify(raw));
  after[0].notes = 'STANDUP 22:03: no change again, still idle. Meredith stale.';
  after[0].result = 'still pending, reviewed twice';
  after[0].title = 'TE0 — scheduler delta gate (renamed by god)';
  assert.equal(
    fingerprintFloor(floor({ tasks: projectTasks(after) })),
    fingerprintFloor(floor({ tasks: projectTasks(raw) })),
    'rewriting notes/result/title must NOT move the fingerprint'
  );
});

test('a real status or assignee transition DOES move the fingerprint', () => {
  // The other half of rule 1: dropping prose must not drop the signal with it.
  const base = fingerprintFloor(floor());
  assert.notEqual(
    fingerprintFloor(floor({ tasks: [{ id: 'TE0', status: 'done', assignee: 'andy' }] })),
    base, 'a status change is real floor movement');
  assert.notEqual(
    fingerprintFloor(floor({ tasks: [{ id: 'TE0', status: 'doing', assignee: 'jim' }] })),
    base, 'a reassignment is real floor movement');
});

test('board.md is not an input: it is never read to build the floor state', () => {
  // board.md is god's OUTPUT — he appends a STANDUP line on every standup,
  // including the no-change ones. The source-level assertion is the honest one
  // here: the fingerprint cannot hash what the collector never reads, and the
  // collector is the only thing that reads the disk.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'standupDelta.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/board/i.test(code), 'standupDelta.ts must not reference board state in code');

  // From the DOC COMMENT, not from the `function` keyword: the rationale lives
  // above the signature and is half of what this arm is protecting.
  const collector = INDEX_TS.slice(
    INDEX_TS.indexOf('/** Read the floor state the TE0 delta gate hashes.'),
    INDEX_TS.indexOf('function recordStandupSkip'));
  assert.ok(collector.length > 0, 'found the collector');
  const collectorCode = collector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/board/i.test(collectorCode), 'the collector must not read board.md');
  // And the rationale must stay next to the rule, or the next person deletes it.
  assert.ok(/god's OUTPUT/.test(collector), 'the collector keeps the load-bearing WHY');
});

// ── The decision table ───────────────────────────────────────────────────────

test('no delta inside max-age is the ONLY outcome that suppresses', () => {
  const fp = fingerprintFloor(floor());
  const d = decideStandup({
    state: floor(), gate: GATE, lastFingerprint: fp, lastDispatchAt: 1_000, now: 2_000
  });
  assert.equal(d.dispatch, false);
  assert.equal(d.reason, 'no-delta');
  assert.equal(d.fingerprint, fp, 'the fingerprint is reported even on a skip');
});

test('max-age dispatches even though the floor is provably unchanged', () => {
  const fp = fingerprintFloor(floor());
  const d = decideStandup({
    state: floor(), gate: { enabled: true, maxAgeMs: 1_000 },
    lastFingerprint: fp, lastDispatchAt: 0, now: 1_000
  });
  assert.equal(d.dispatch, true);
  assert.equal(d.reason, 'max-age');
});

test('force dispatches regardless of the fingerprint', () => {
  const fp = fingerprintFloor(floor());
  const d = decideStandup({
    state: floor(), gate: GATE, lastFingerprint: fp, lastDispatchAt: 1_000, now: 2_000, forced: true
  });
  assert.equal(d.dispatch, true);
  assert.equal(d.reason, 'forced');
});

test('the gate FAILS OPEN: no gate, and no baseline, both dispatch', () => {
  // A wrong dispatch costs one standup. A wrong suppression costs an unattended
  // floor. They are not the same mistake and do not get the same default.
  assert.equal(decideStandup({ state: floor(), now: 1 }).reason, 'gate-off');
  assert.equal(decideStandup({ state: floor(), gate: GATE, now: 1 }).reason, 'no-baseline');
  assert.equal(decideStandup({ state: floor(), gate: { enabled: false }, now: 1 }).dispatch, true);
});

test('any real floor movement opens the gate', () => {
  const fp = fingerprintFloor(floor());
  const moved = [
    ['unread agent mail', floor({ agents: [{ ...floor().agents[0], actionableInbox: 1 }] })],
    ['a breaker trip', floor({ agents: [{ ...floor().agents[0], breaker: 'constrained' }] })],
    ['an agent going on hold', floor({ agents: [{ ...floor().agents[0], onHold: true }] })],
    ['a terminal dying', floor({ agents: [{ ...floor().agents[0], hasLivePty: false }] })],
    ['coordination files moving', floor({ agents: [{ ...floor().agents[0], lastCoordinationAtMs: 2_000 }] })],
    ['a new agent', floor({ agents: [...floor().agents, { id: 'jim', onHold: false, breaker: 'ok', hasLivePty: true, actionableInbox: 0, lastCoordinationAtMs: 1 }] })],
    ['a queued spawn', floor({ spawnRequests: 1 })],
    ['a crash', floor({ crashes: 1 })]
  ];
  for (const [what, state] of moved) {
    const d = decideStandup({
      state, gate: GATE, lastFingerprint: fp, lastDispatchAt: 1_000, now: 2_000
    });
    assert.equal(d.dispatch, true, `${what} must dispatch`);
    assert.equal(d.reason, 'delta', `${what} must read as a delta`);
  }
});

test('the fingerprint is order-independent, so readdir order is not a delta', () => {
  const a = floor({ agents: [
    { id: 'andy', onHold: false, breaker: 'ok', hasLivePty: true, actionableInbox: 0, lastCoordinationAtMs: 1 },
    { id: 'jim', onHold: false, breaker: 'ok', hasLivePty: false, actionableInbox: 2, lastCoordinationAtMs: 9 }
  ] });
  const b = floor({ agents: [a.agents[1], a.agents[0]] });
  assert.equal(fingerprintFloor(a), fingerprintFloor(b));
  assert.match(canonicalize(a), /^\["te0\/1"/, 'the canonical form is versioned');
});

test('a skip record names the mission, the reason and the age', () => {
  const d = decideStandup({
    state: floor(), gate: GATE, lastFingerprint: fingerprintFloor(floor()),
    lastDispatchAt: 1_000, now: 5_000
  });
  const rec = skipRecord('ops-standup', d, 5_000, 1_000);
  assert.equal(rec.kind, 'standup-skipped');
  assert.equal(rec.missionId, 'ops-standup');
  assert.equal(rec.reason, 'no-delta');
  assert.equal(rec.sinceLastDispatchMs, 4_000);
  assert.equal(rec.fingerprint, d.fingerprint);
});

// ── The two facts that live at the call site (structural evidence) ────────────

test('STRUCTURAL: a suppressed tick still stamps lastFiredAt', () => {
  // Not a behavioural run — `fire()` is a closure inside syncMissions and needs a
  // live Electron main to execute. What is checked is the shape that makes the
  // stamp unconditional: the gate has no `return`, so control always reaches the
  // stamp below it. If someone converts the skip branch to an early return, this
  // fails, which is the regression worth catching.
  const fire = INDEX_TS.slice(
    INDEX_TS.indexOf('const fire = (forced = false): void => {'),
    INDEX_TS.indexOf('const entry: MissionTimer = {};'));
  assert.ok(fire.length > 0, 'found the dispatch fire()');

  const send = fire.indexOf('hive.send(');
  const skip = fire.indexOf('recordStandupSkip(');
  const stamp = fire.indexOf('lastFiredAt: firedAt');
  assert.ok(send > 0 && skip > 0 && stamp > 0, 'gate, skip and stamp are all present');
  assert.ok(stamp > send && stamp > skip, 'the stamp comes AFTER both gate branches');

  const gateToStamp = fire.slice(fire.indexOf('let gate:'), stamp);
  assert.ok(!/\breturn\b/.test(gateToStamp),
    'no early return between the gate and the stamp — that is what keeps the stamp unconditional');
});

test('STRUCTURAL: the gate reads the PERSISTED mission, not the armed closure', () => {
  // `m` is the snapshot syncMissions armed with. Nothing re-arms on a fire, so a
  // gate reading `m.lastDeltaFingerprint` would compare every tick against the
  // value as of app boot. Fails open rather than dangerously, but the feature
  // would be dead, and dead-but-green is the failure this arm exists for.
  const fire = INDEX_TS.slice(
    INDEX_TS.indexOf('const fire = (forced = false): void => {'),
    INDEX_TS.indexOf('const entry: MissionTimer = {};'));
  assert.match(fire, /const live = \(readConfig\(\)\.missions \?\? \[\]\)\.find/);
  assert.match(fire, /lastFingerprint: live\.lastDeltaFingerprint/);
  assert.match(fire, /lastDispatchAt: live\.lastDispatchAt/);
  assert.ok(!/lastFingerprint: m\.lastDeltaFingerprint/.test(fire), 'must not read the closure copy');
});

test('STRUCTURAL: the skip record does NOT go to log.jsonl', () => {
  // log.jsonl's mtime is an input to isFloorQuiet(). Recording skips there would
  // keep the floor reading "busy" forever and silently disable the heartbeat's
  // re-engage — and since the heartbeat ships disabled, nothing would complain.
  const rec = INDEX_TS.slice(
    INDEX_TS.indexOf('function recordStandupSkip'),
    INDEX_TS.indexOf('/** Rebuild the scheduler from persisted config'));
  assert.ok(rec.length > 0, 'found the recorder');
  assert.match(rec, /standup-skips\.jsonl/);
  assert.ok(!/appendLog|log\.jsonl/.test(rec), 'must not write through the hive log');
  assert.match(INDEX_TS, /pushMtime\(join\(root, 'log\.jsonl'\)\);/,
    'and isFloorQuiet still reads log.jsonl — which is exactly why we stay out of it');
});

test('STRUCTURAL: missions:save cannot erase the scheduler-owned gate fields', () => {
  const handler = INDEX_TS.slice(
    INDEX_TS.indexOf("ipcMain.handle('missions:save'"),
    INDEX_TS.indexOf("ipcMain.handle('hive:textSearch'"));
  assert.match(handler, /lastDeltaFingerprint: prev\?\.lastDeltaFingerprint/);
  assert.match(handler, /lastDispatchAt: prev\?\.lastDispatchAt/);
});

test('an existing install gets the gate through a guarded one-time migration', () => {
  // opsStandupSeeded is already true everywhere, so the seeding branch never runs
  // again: without this migration the gate would reach new installs only.
  assert.match(INDEX_TS, /if \(!cfgGate\.standupDeltaGateSeeded\)/);
  assert.match(INDEX_TS, /standupDeltaGateSeeded: true/);
  assert.match(INDEX_TS, /m\.id === OPS_STANDUP_MISSION\.id && !m\.deltaGate/,
    'and it only fills an ABSENT gate, so a deliberate opt-out survives');
});
