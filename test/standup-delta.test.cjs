'use strict';

/**
 * TE0 — the standup delta gate.
 *
 * WHAT THE FIRST VERSION OF THIS FILE GOT WRONG, because the shape of these arms
 * is a direct consequence of it. It tested `decideStandup` — a pure function — and
 * asserted structurally that the collector did not read board.md. Both passed. The
 * gate was still permanently open, because the collector hashed each agent's
 * coordination MTIME, and dispatching the standup moves exactly those mtimes: the
 * message lands in god's inbox, god handling it moves inbox/.done, memory.md and
 * the outbox, and the standup's own "summarise and compact" request moves every
 * working agent's files too. Every tick therefore saw a delta.
 *
 * No pure-decision test could see that, because the defect was not in the decision.
 * It was in what a dispatch does to the NEXT observation. So the centre of gravity
 * here is `runStandupTick` driven against a fake floor the test mutates between
 * ticks — dispatch, apply the effects a real dispatch has, tick again, and require
 * a SKIP. That arm is the one that matters; it fails against the old logic, and
 * the mutant run quoted in the commit message shows it failing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  decideStandup, runStandupTick, fingerprintFloor, projectTasks, canonicalize,
  skipRecord
} = loadTs('src/main/standupDelta.ts');

/** The module's own source, for the two structural arms at the bottom. The gate's
 *  central guarantee after the owner's revision is an ABSENCE — no clock reaches
 *  the decision — and an absence cannot be proved by calling the function. */
const DELTA_TS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'standupDelta.ts'), 'utf8');

const INDEX_TS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

const GATE = { enabled: true };

/** A floor with one working agent and one card. */
const floor = (over = {}) => ({
  agents: [{ id: 'andy', onHold: false, breaker: 'ok', hasLivePty: true, actionableInbox: 0 }],
  tasks: [{ id: 'TE0', status: 'doing', assignee: 'andy' }],
  spawnRequests: 0,
  crashes: 0,
  unknown: [],
  ...over
});

// ─── A FAKE FLOOR that models what a dispatch actually disturbs ──────────────
//
// It carries BOTH the content-level facts the fingerprint uses and the
// coordination mtimes it deliberately ignores, so the decisive arm can move the
// mtimes (as a real dispatch does) and prove the fingerprint does not follow.
function fakeHive() {
  return {
    god:  { actionableInbox: 0, systemInbox: 0, coordMtime: 1_000 },
    andy: { actionableInbox: 0, coordMtime: 1_000 },
    tasks: [{ id: 'TE0', status: 'doing', assignee: 'andy', notes: 'initial' }],
    readsFail: false,
    /** The projection the real collector performs. `coordMtime` is carried on the
     *  agent object and deliberately NOT folded into the state — that omission is
     *  the fix, and the mutant puts it back. */
    collect() {
      if (this.readsFail) {
        return { agents: [], tasks: [], spawnRequests: 0, crashes: 0, unknown: ['inbox:god'] };
      }
      const mk = (id, a) => ({
        id, onHold: false, breaker: 'ok', hasLivePty: true,
        actionableInbox: a.actionableInbox,
        lastCoordinationAtMs: a.coordMtime      // ignored by canonicalize, by design
      });
      return {
        agents: [mk('god', this.god), mk('andy', this.andy)],
        tasks: projectTasks(this.tasks),
        spawnRequests: 0, crashes: 0, unknown: []
      };
    },
    /** Exactly what dispatching a standup does to the floor, in order:
     *  the scheduler's message lands in god's inbox (a SYSTEM sender, so it is not
     *  actionable mail), god reads it and files it to .done, writes memory.md and
     *  drafts in his outbox — all of which move his coordination mtime — and the
     *  standup asks each working agent to summarise and compact, moving theirs. */
    applyStandupEffects(at) {
      this.systemInboxDelivered = (this.systemInboxDelivered ?? 0) + 1;
      this.god.systemInbox += 1;
      this.god.coordMtime = at;          // inbox touched by the delivery
      this.god.systemInbox -= 1;         // drained in the same turn
      this.god.coordMtime = at + 1;      // .done + memory.md + outbox
      this.andy.coordMtime = at + 2;     // "summarise and compact"
      this.tasks[0].notes = `STANDUP ${at}: no change, floor idle.`;
    }
  };
}

/** Drive runStandupTick against a fake hive, recording every effect. */
function driver(hive, mission = { deltaGate: GATE }) {
  const log = { sends: 0, skips: [], stamps: [] };
  let clock = 10_000;
  const state = { ...mission };
  const deps = {
    readMission: () => ({ ...state }),
    collect: () => hive.collect(),
    now: () => (clock += 1_000),
    send: () => { log.sends += 1; },
    recordSkip: (rec) => { log.skips.push(rec); },
    stamp: (patch) => { Object.assign(state, patch); log.stamps.push({ ...patch }); }
  };
  return {
    log, state,
    tick: (forced = false) => runStandupTick('ops-standup', deps, forced),
    at: () => clock,
    /** Advance the wall clock without ticking. Only the no-fallback arms use it,
     *  and that is the point: time passing must not be able to cause anything. */
    jump: (ms) => { clock += ms; }
  };
}

// ─── THE ARM THAT MATTERS ────────────────────────────────────────────────────

test('DECISIVE: a dispatch does not manufacture the delta that justifies the next one', () => {
  const hive = fakeHive();
  const d = driver(hive);

  const first = d.tick();
  assert.equal(first.dispatch, true, 'the first tick has no baseline, so it dispatches');
  assert.equal(first.reason, 'no-baseline');
  assert.equal(d.log.sends, 1, 'exactly one send');

  // Everything a real dispatch does to the floor, and nothing else.
  hive.applyStandupEffects(d.at());

  const second = d.tick();
  assert.equal(second.reason, 'no-delta',
    'the standup\'s own effects are not floor movement — this is the bug Oscar found');
  assert.equal(second.dispatch, false, 'so the second tick must SUPPRESS');
  assert.equal(d.log.sends, 1, 'still exactly one send: no model was invoked');
  assert.equal(d.log.skips.length, 1, 'and exactly one skip record was written');
  assert.equal(d.log.skips[0].reason, 'no-delta');

  // A third tick with nothing happening at all stays suppressed too.
  hive.applyStandupEffects(d.at());
  assert.equal(d.tick().dispatch, false, 'and it keeps suppressing while the floor is still');
  assert.equal(d.log.sends, 1);
});

test('DECISIVE: REAL floor movement still opens the gate on the very next tick', () => {
  // The other half. A gate that never dispatches is as broken as one that always
  // does, and suppression must not survive a genuine change.
  const hive = fakeHive();
  const d = driver(hive);
  d.tick();                               // baseline
  hive.applyStandupEffects(d.at());
  assert.equal(d.tick().dispatch, false, 'suppressed, as above');

  hive.andy.actionableInbox = 1;          // a worker's reply is waiting
  const third = d.tick();
  assert.equal(third.dispatch, true, 'real mail is real movement');
  assert.equal(third.reason, 'delta');
  assert.equal(d.log.sends, 2);
});

// ─── The tick contract: one effect, and always a stamp ───────────────────────

test('a suppressed tick stamps lastFiredAt and NOTHING else', () => {
  // lastFiredAt is the timer's clock: unstamped, syncMissions re-arms with a zero
  // delay and spins the mission. The baseline and lastDispatchAt must NOT move, or
  // the floor looks freshly reviewed when no one reviewed it.
  const hive = fakeHive();
  const d = driver(hive);
  d.tick();
  const afterDispatch = { ...d.state };
  hive.applyStandupEffects(d.at());
  d.tick();

  const stamp = d.log.stamps[d.log.stamps.length - 1];
  assert.deepEqual(Object.keys(stamp), ['lastFiredAt'], 'only the timer clock moves');
  assert.equal(d.state.lastDispatchAt, afterDispatch.lastDispatchAt, 'the gate clock is frozen');
  assert.equal(d.state.lastDeltaFingerprint, afterDispatch.lastDeltaFingerprint,
    'and the comparison baseline is frozen');
  assert.ok(d.state.lastFiredAt > afterDispatch.lastFiredAt, 'but the timer clock advanced');
});

test('a dispatching tick advances the baseline AND the dispatch clock', () => {
  const d = driver(fakeHive());
  const r = d.tick();
  const stamp = d.log.stamps[0];
  assert.equal(stamp.lastDeltaFingerprint, r.fingerprint);
  assert.equal(stamp.lastDispatchAt, stamp.lastFiredAt);
});

test('force and an unreadable floor each produce EXACTLY ONE send', () => {
  // forced
  let hive = fakeHive(); let d = driver(hive);
  d.tick(); hive.applyStandupEffects(d.at());
  assert.equal(d.tick(true).reason, 'forced');
  assert.equal(d.log.sends, 2, 'forced: one more send, not two');

  // read error
  hive = fakeHive(); d = driver(hive);
  d.tick(); hive.applyStandupEffects(d.at());
  hive.readsFail = true;
  const u = d.tick();
  assert.equal(u.reason, 'state-unknown', 'an unobserved floor is never a quiet floor');
  assert.equal(d.log.sends, 2);
});

test('NO PERIODIC FALLBACK: an unchanged floor stays silent for 30 days', () => {
  // The owner's revised ruling, as an executable assertion: "A provably unchanged
  // floor may therefore go indefinitely without a Michael standup. Do not add a
  // periodic 12h or 24h fallback."
  //
  // This arm is the former max-age test turned inside out. It used to prove that
  // a frozen floor was woken once a day; it now proves that it is never woken at
  // all. It is also the behavioural half of the mutant kill: reintroduce ANY
  // age-based dispatch with a period under a month and the send count moves off 1.
  const hive = fakeHive();
  const d = driver(hive);

  assert.equal(d.tick().reason, 'no-baseline', 'the first run always dispatches');
  hive.applyStandupEffects(d.at());
  assert.equal(d.log.sends, 1);

  const DAY = 86_400_000;
  for (let day = 1; day <= 30; day += 1) {
    d.jump(DAY);                       // a whole day passes between ticks
    const r = d.tick();
    assert.equal(r.reason, 'no-delta', `day ${day} must still read as unchanged`);
    assert.equal(r.dispatch, false, `day ${day} must not dispatch`);
  }

  assert.equal(d.log.sends, 1, 'thirty days, and still exactly the one first send');
  assert.equal(d.log.skips.length, 30, 'every suppressed tick is still recorded');
  // And the diagnostic that replaces the ceiling: the skip record says how long
  // the silence has run, which is now the only thing that reports it.
  const last = d.log.skips[d.log.skips.length - 1];
  assert.ok(last.sinceLastDispatchMs >= 30 * DAY,
    'the last skip reports a month of quiet, so the span is visible to an operator');
});

test('a PERSISTENTLY unreadable floor keeps dispatching instead of settling', () => {
  // The safety finding: swallowing read errors into zeros made two failed reads
  // hash identically, so the gate suppressed on an observation that never happened.
  const hive = fakeHive();
  const d = driver(hive);
  hive.readsFail = true;
  for (let i = 0; i < 3; i++) assert.equal(d.tick().reason, 'state-unknown');
  assert.equal(d.log.sends, 3, 'every tick dispatches while the floor cannot be read');
  assert.equal(d.log.skips.length, 0, 'and nothing is ever recorded as a skip');
});

// ─── Rule 1, at the level of the fingerprint itself ──────────────────────────

test('coordination MTIMES are not inputs, for ANY agent', () => {
  // Not just god's. The standup asks every working agent to summarise and compact,
  // which moves theirs too — so excluding god alone would not have fixed this.
  const withMtimes = (ms) => floor({
    agents: [{ id: 'god', onHold: false, breaker: 'ok', hasLivePty: true, actionableInbox: 0, lastCoordinationAtMs: ms },
      { id: 'andy', onHold: false, breaker: 'ok', hasLivePty: true, actionableInbox: 0, lastCoordinationAtMs: ms }]
  });
  assert.equal(fingerprintFloor(withMtimes(1)), fingerprintFloor(withMtimes(999_999)));
  assert.ok(!/lastCoordination/.test(canonicalize(withMtimes(1))), 'and no mtime reaches the canonical form');
});

test('task PROSE is not hashed: only id/status/assignee survive the projection', () => {
  const raw = [{
    id: 'TE0', status: 'doing', assignee: 'andy',
    title: 'TE0 — scheduler delta gate',
    notes: 'STANDUP 21:03: no change, floor idle, nothing blocked.',
    result: 'pending', humanQA: [{ q: 'authorised?', a: 'yes' }],
    createdAt: '2026-09-10T19:43:40.538Z'
  }];
  assert.deepEqual(projectTasks(raw), [{ id: 'TE0', status: 'doing', assignee: 'andy' }]);
  const after = JSON.parse(JSON.stringify(raw));
  after[0].notes = 'STANDUP 22:03: no change again. Meredith stale.';
  after[0].result = 'still pending, reviewed twice';
  after[0].title = 'TE0 — renamed by god';
  assert.equal(
    fingerprintFloor(floor({ tasks: projectTasks(after) })),
    fingerprintFloor(floor({ tasks: projectTasks(raw) })),
    'rewriting notes/result/title must NOT move the fingerprint');
});

test('a real status or assignee transition DOES move the fingerprint', () => {
  const base = fingerprintFloor(floor());
  assert.notEqual(fingerprintFloor(floor({ tasks: [{ id: 'TE0', status: 'done', assignee: 'andy' }] })), base);
  assert.notEqual(fingerprintFloor(floor({ tasks: [{ id: 'TE0', status: 'doing', assignee: 'jim' }] })), base);
});

test('board.md is not an input: it is never read to build the floor state', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'standupDelta.ts'), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/board/i.test(strip(src)), 'standupDelta.ts must not reference board state in code');
  const collector = INDEX_TS.slice(
    INDEX_TS.indexOf('/** Read the floor state the TE0 delta gate hashes.'),
    INDEX_TS.indexOf('/** Append the durable record'));
  assert.ok(collector.length > 0, 'found the collector');
  assert.ok(!/board/i.test(strip(collector)), 'the collector must not read board.md');
  assert.ok(!/lastCoordinationAt\(/.test(strip(collector)),
    'and it must not read coordination mtimes either — that was the reopened trap');
});

// ─── The decision table ──────────────────────────────────────────────────────

test('any real floor movement opens the gate', () => {
  const fp = fingerprintFloor(floor());
  const a0 = floor().agents[0];
  const moved = [
    ['unread agent mail', floor({ agents: [{ ...a0, actionableInbox: 1 }] })],
    ['a breaker trip', floor({ agents: [{ ...a0, breaker: 'constrained' }] })],
    ['an agent going on hold', floor({ agents: [{ ...a0, onHold: true }] })],
    ['a terminal dying', floor({ agents: [{ ...a0, hasLivePty: false }] })],
    ['a new agent', floor({ agents: [a0, { id: 'jim', onHold: false, breaker: 'ok', hasLivePty: true, actionableInbox: 0 }] })],
    ['a queued spawn', floor({ spawnRequests: 1 })],
    ['a crash', floor({ crashes: 1 })]
  ];
  for (const [what, state] of moved) {
    const d = decideStandup({ state, gate: GATE, lastFingerprint: fp });
    assert.equal(d.dispatch, true, `${what} must dispatch`);
    assert.equal(d.reason, 'delta', `${what} must read as a delta`);
  }
});

test('the gate FAILS OPEN: no gate, and no baseline, both dispatch', () => {
  // Unchanged by the revision, and deliberately re-stated: removing the periodic
  // fallback removes a reason to dispatch, never a reason to suppress. A first
  // run still fails OPEN.
  assert.equal(decideStandup({ state: floor() }).reason, 'gate-off');
  assert.equal(decideStandup({ state: floor(), gate: GATE }).reason, 'no-baseline');
  assert.equal(decideStandup({ state: floor(), gate: { enabled: false } }).dispatch, true);
});

test('the fingerprint is order-independent, so readdir order is not a delta', () => {
  const a = floor({ agents: [
    { id: 'andy', onHold: false, breaker: 'ok', hasLivePty: true, actionableInbox: 0 },
    { id: 'jim', onHold: false, breaker: 'ok', hasLivePty: false, actionableInbox: 2 }
  ] });
  const b = floor({ agents: [a.agents[1], a.agents[0]] });
  assert.equal(fingerprintFloor(a), fingerprintFloor(b));
  assert.match(canonicalize(a), /^\["te0\/1"/, 'the canonical form is versioned');
});

test('a skip record names the mission, the reason and the age', () => {
  const d = decideStandup({
    state: floor(), gate: GATE, lastFingerprint: fingerprintFloor(floor())
  });
  const rec = skipRecord('ops-standup', d, 5_000, 1_000);
  assert.equal(rec.kind, 'standup-skipped');
  assert.equal(rec.missionId, 'ops-standup');
  assert.equal(rec.reason, 'no-delta');
  assert.equal(rec.sinceLastDispatchMs, 4_000);
  assert.equal(rec.fingerprint, d.fingerprint);
});

// ─── The absence that has to stay absent ─────────────────────────────────────

test('MUTANT GUARD: the decision function cannot observe time at all', () => {
  // A behavioural arm can only disprove the fallback periods it thinks to try —
  // the 30-day arm above would not notice a 60-day one. This arm closes that off
  // at the source instead: if the decision cannot READ a clock, no period exists.
  const sig = DELTA_TS.slice(
    DELTA_TS.indexOf('export function decideStandup(input: {'),
    DELTA_TS.indexOf('}): StandupDecision {'));
  assert.ok(sig.length > 0, 'found the decideStandup signature');
  assert.ok(!/\bnow\b/.test(sig), 'decideStandup must not take a clock');
  assert.ok(!/lastDispatchAt/.test(sig), 'nor the last dispatch time');
  assert.ok(!/maxAge/i.test(sig), 'nor a maximum age');

  const body = DELTA_TS.slice(
    DELTA_TS.indexOf('}): StandupDecision {', DELTA_TS.indexOf('export function decideStandup')),
    DELTA_TS.indexOf('export interface StandupTickDeps'));
  assert.ok(!/maxAge/i.test(body), 'and no age comparison survives in the body');
  assert.ok(!/'max-age'/.test(DELTA_TS), "and 'max-age' is not a reason any more");
});

test('MUTANT GUARD: the gate type offers no period to configure', () => {
  // Removing the reason but leaving the field would invite it straight back.
  const gate = DELTA_TS.slice(
    DELTA_TS.indexOf('export interface DeltaGate {'),
    DELTA_TS.indexOf('export type StandupReason'));
  assert.ok(!/maxAge/i.test(gate), 'DeltaGate carries no maxAgeMs');
  assert.ok(!/DEFAULT_MAX_AGE_MS/.test(DELTA_TS), 'and no default to fall back on');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.ts'), 'utf8');
  assert.ok(!/maxAge/i.test(cfg), 'config.ts declares and seeds no period either');
});

// ─── Main-side integration (structural: fire() needs a live Electron main) ────

test('STRUCTURAL: fire() drives the tick and reads the PERSISTED mission', () => {
  const fire = INDEX_TS.slice(
    INDEX_TS.indexOf('const fire = (forced = false): void => {'),
    INDEX_TS.indexOf('const entry: MissionTimer = {};'));
  assert.ok(fire.length > 0, 'found the dispatch fire()');
  assert.match(fire, /gate = runStandupTick\(m\.id, \{/, 'the tick owns the whole decision');
  assert.match(fire, /readMission: \(\) => \(readConfig\(\)\.missions \?\? \[\]\)\.find/,
    're-read each tick: the armed closure would freeze the baseline at app-boot values');
  assert.match(fire, /\}, forced\);/, 'and the force flag is threaded through');
  // A tick the gate never saw (compact-only mission, or hive disabled) still needs
  // its timer clock advanced, and nothing may return before that happens.
  assert.match(fire, /if \(!gate\) \{/);
  assert.ok(!/\breturn\b/.test(fire.slice(fire.indexOf('let gate:'), fire.indexOf('if (!gate) {'))),
    'no early return between the gate and the fallback stamp');
});

test('STRUCTURAL: read failures become `unknown`, never a silent zero', () => {
  const collector = INDEX_TS.slice(
    INDEX_TS.indexOf('function collectFloorState'),
    INDEX_TS.indexOf('/** Append the durable record'));
  assert.match(collector, /unknown\.push\(`inbox:\$\{id\}`\)/);
  assert.match(collector, /unknown\.push\('registry'\)/);
  assert.match(collector, /unknown\.push\('tasks'\)/);
  assert.match(collector, /code === 'ENOENT'/,
    'a missing directory is a real answer; any other error is a failure to observe');
});

test('STRUCTURAL: the skip record does NOT go to log.jsonl', () => {
  const rec = INDEX_TS.slice(
    INDEX_TS.indexOf('/** Append the durable record'),
    INDEX_TS.indexOf('/** Rebuild the scheduler from persisted config'));
  assert.ok(rec.length > 0, 'found the recorder');
  assert.match(rec, /standup-skips\.jsonl/);
  // Comments stripped first: the doc comment above the function NAMES log.jsonl in
  // order to explain why the code stays out of it.
  const recCode = rec.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/appendLog|log\.jsonl/.test(recCode), 'must not write through the hive log');
  assert.match(INDEX_TS, /pushMtime\(join\(root, 'log\.jsonl'\)\);/,
    'and isFloorQuiet still reads log.jsonl — which is exactly why we stay out of it');
});

test('STRUCTURAL: missions:save cannot erase the scheduler-owned gate fields', () => {
  const handler = INDEX_TS.slice(
    INDEX_TS.indexOf("ipcMain.handle('missions:save'"),
    INDEX_TS.indexOf("ipcMain.handle('missions:runNow'"));
  assert.match(handler, /lastDeltaFingerprint: prev\?\.lastDeltaFingerprint/);
  assert.match(handler, /lastDispatchAt: prev\?\.lastDispatchAt/);
});

test('an existing install gets the gate through a guarded one-time migration', () => {
  assert.match(INDEX_TS, /if \(!cfgGate\.standupDeltaGateSeeded\)/);
  assert.match(INDEX_TS, /standupDeltaGateSeeded: true/);
  assert.match(INDEX_TS, /m\.id === OPS_STANDUP_MISSION\.id && !m\.deltaGate/,
    'and it only fills an ABSENT gate, so a deliberate opt-out survives');
});
