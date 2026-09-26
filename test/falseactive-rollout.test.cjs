'use strict';

/**
 * FALSEACTIVE-STALL-2 (B1, god's ruling): Codex's own rollout closes a turn whose Stop was
 * lost. D3 stays: silence never stands in for an active turn; only the provider saying the
 * turn COMPLETED does.
 *
 * Replays Oscar's exact live sequence (2026-09-25): turn 01a0d9c2 opens, runs tools,
 * Codex completes it at 20:12:25.270 (task_complete in the rollout), its Stop NEVER reaches
 * the app, and a straggler PostToolUse of that same turn arrives 5 s later. Three burst
 * messages wait; on 1.1.51 every wake was refused as lifecycle-active forever.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { WorkerWakeWatchdog, WORKER_WAKE_IDLE_MS } = loadTs('src/main/workerWake.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const { latestCodexTurnEvent, codexTurnEnded, CodexRolloutLifecycleSource, CODEX_LIFECYCLE_TAIL_BYTES } = loadTs('src/main/codexRolloutLifecycle.ts');

const A = 'oscar';
const TURN = '01a0d9c2-c9cc-7832-a345-76fd68f1d74e';
const NEXT = '01a0d9f4-6443-73e1-bc78-cdd7067fb492';
const COMPLETED = Date.parse('2026-09-25T18:12:25.270Z');
const T0 = COMPLETED - 60_000;

/** Real rollout line shapes (as in Oscar's rollout). */
const started = (turn, iso) => JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'task_started', turn_id: turn, started_at: 1 } });
const complete = (turn, iso) => JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'done' } });
const tokens = (iso) => JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: {} } });

/** The real coordinator + bridge; a fake owner that commits; `probe` is what Codex's rollout says. */
function floor({ probe }) {
  const coordinator = new WorkerWakeWatchdog();
  const inbox = [];
  const submits = [];
  const diags = [];
  const immediates = [];
  const now = { t: COMPLETED + 30 * 60_000 };
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: () => [...inbox],
    facts: () => ({ ptyId: 'pty-oscar', lastOutputAt: now.t - WORKER_WAKE_IDLE_MS * 10, autoDeliveryPaused: false, paused: false, halted: false, inhibited: false }),
    submit: (req) => { submits.push(req); return Promise.resolve({ kind: 'COMMITTED' }); },
    text: (ids) => ids.join(','),
    setImmediate: (fn) => immediates.push(fn),
    now: () => now.t,
    diag: (stage, fields) => diags.push({ stage, ...fields }),
    codexTurnProbe: () => probe.current
  });
  return { coordinator, bridge, inbox, submits, diags, now };
}

/** Oscar's live sequence up to the stuck state: the Stop is LOST, a straggler lands late. */
function oscarStuck(f) {
  const { coordinator, bridge, inbox } = f;
  bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, TURN);
  bridge.onHook(A, 'PreToolUse', undefined, undefined, TURN);
  bridge.onHook(A, 'PostToolUse', undefined, undefined, TURN);
  // (the turn's Stop never reaches the app)
  bridge.onHook(A, 'PostToolUse', undefined, undefined, TURN);   // the straggler, 5 s after completion
  for (const id of ['burst-1', 'burst-2', 'burst-3']) { inbox.push(id); coordinator.noteDelivery(A, id); }
  assert.equal(coordinator.state(A).lifecycle, 'active');
  assert.equal(coordinator.turnFacts(A).openTurnId, TURN);
}

test('THE LIVE SEQUENCE: lost Stop + straggler + task_complete in the rollout -> the burst is delivered', async () => {
  const probe = { current: { ok: true, latest: { kind: 'complete', turnId: TURN, at: COMPLETED } } };
  const f = floor({ probe });
  oscarStuck(f);
  f.bridge.reconcileAll([A]);
  assert.equal(f.coordinator.state(A).lifecycle !== 'active', true, 'the open turn was closed by the provider\'s own record');
  assert.equal(f.submits.length, 1, `delivered on the next beat (${JSON.stringify(f.diags.filter((d) => d.stage === 'no-claim'))})`);
  assert.deepEqual(f.submits[0].text.split(',').sort(), ['burst-1', 'burst-2', 'burst-3']);
  assert.ok(f.diags.some((d) => d.stage === 'codex-rollout' && d.closed === true && d.turn === TURN), 'and it says why, durably');
});

test('WITHOUT the rollout proof (1.1.51 behaviour) the same sequence is refused forever', () => {
  const f = floor({ probe: { current: undefined } });   // not treated as Codex: no probe
  oscarStuck(f);
  for (let i = 0; i < 5; i++) { f.now.t += 15_000; f.bridge.reconcileAll([A]); }
  assert.equal(f.submits.length, 0);
  assert.equal(f.coordinator.whyNoClaim(A), 'lifecycle-active');
});

test('NEGATIVE: a task_started NEWER than the task_complete means a turn is running -> no delivery', () => {
  const probe = { current: { ok: true, latest: { kind: 'started', turnId: NEXT, at: COMPLETED + 60_000 } } };
  const f = floor({ probe });
  oscarStuck(f);
  f.bridge.reconcileAll([A]);
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.submits.length, 0);
});

test('NEGATIVE: a completion of a DIFFERENT turn than the open one proves nothing', () => {
  const probe = { current: { ok: true, latest: { kind: 'complete', turnId: 'some-older-turn', at: COMPLETED + 1 } } };
  const f = floor({ probe });
  oscarStuck(f);
  f.bridge.reconcileAll([A]);
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.submits.length, 0);
});

test('NEGATIVE: a missing or unreadable rollout fails CLOSED, and is reported ONCE', () => {
  for (const why of ['no-rollout', 'unreadable']) {
    const f = floor({ probe: { current: { ok: false, why } } });
    oscarStuck(f);
    for (let i = 0; i < 4; i++) { f.now.t += 15_000; f.bridge.reconcileAll([A]); }
    assert.equal(f.submits.length, 0, `${why}: no delivery`);
    assert.equal(f.coordinator.state(A).lifecycle, 'active');
    assert.equal(f.diags.filter((d) => d.stage === 'codex-rollout' && d.why === why).length, 1, `${why}: logged once, not every beat`);
  }
});

test('the probe runs ONLY for an ACTIVE agent WITH mail waiting (the bounded-cost guardrail)', () => {
  let calls = 0;
  const probe = { get current() { calls += 1; return { ok: true, latest: { kind: 'complete', turnId: TURN, at: COMPLETED } }; } };
  const f = floor({ probe });
  f.bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, TURN);
  f.bridge.reconcileAll([A]);                       // active, but no mail
  assert.equal(calls, 0, 'no mail: no probe');
  f.bridge.onHook(A, 'Stop', undefined, undefined, TURN);
  f.inbox.push('m1'); f.coordinator.noteDelivery(A, 'm1');
  f.bridge.reconcileAll([A]);                       // mail, but idle
  assert.equal(calls, 0, 'idle: no probe');
});

test('an UNNAMED open turn (begun by our own submit): only a completion newer than the epoch closes it', () => {
  const c = new WorkerWakeWatchdog();
  c.noteDelivery(A, 'm1');
  c.noteHook(A, 'Stop', undefined, T0);
  const claim = c.claim({ agentId: A, ptyId: 'p', lastOutputAt: 1, autoDeliveryPaused: false, paused: false, halted: false }, 'delivery', 'event', T0 + 1);
  c.settle(claim, 'COMMITTED', T0 + 1_000);       // our submit opened a turn with no id
  assert.equal(c.turnFacts(A).openTurnId, null);
  assert.equal(c.noteProviderTurnEnded(A, 'x', T0 + 500), false, 'a completion OLDER than our submit is about a previous turn');
  assert.equal(c.state(A).lifecycle, 'active');
  assert.equal(c.noteProviderTurnEnded(A, 'x', T0 + 5_000), true, 'a newer completion closes it');
  assert.equal(c.state(A).lifecycle, 'idle');
});

test('noteProviderTurnEnded never touches an idle or unknown agent, and never opens anything', () => {
  const c = new WorkerWakeWatchdog();
  assert.equal(c.noteProviderTurnEnded(A, TURN, COMPLETED), false, 'unknown agent');
  c.noteHook(A, 'Stop', undefined, T0);
  assert.equal(c.noteProviderTurnEnded(A, TURN, COMPLETED), false, 'already idle: not an edge');
  assert.equal(c.state(A).lifecycle, 'idle');
});

// ─── the reader: real line shapes, bounded tail, fail-closed ───

test('latestCodexTurnEvent: the NEWEST boundary wins; token counts, junk and a cut first line are skipped', () => {
  const tail = [
    '{"timestamp":"2026-09-25T18:11:00.000Z","type":"event_msg","payload":{"type":"task_comp',   // cut mid-line
    started(TURN, '2026-09-25T18:11:40.000Z'),
    complete(TURN, '2026-09-25T18:12:25.270Z'),
    tokens('2026-09-25T18:12:25.300Z'),
    'not json at all',
    ''
  ].join('\n');
  assert.deepEqual(latestCodexTurnEvent(tail), { kind: 'complete', turnId: TURN, at: COMPLETED });
  assert.equal(latestCodexTurnEvent([complete(TURN, '2026-09-25T18:12:25.270Z'), started(NEXT, '2026-09-25T19:04:27.503Z')].join('\n')).kind, 'started');
  assert.equal(latestCodexTurnEvent(tokens('2026-09-25T18:12:25.300Z')), null);
});

test('codexTurnEnded: the pure rule', () => {
  const done = { kind: 'complete', turnId: TURN, at: COMPLETED };
  assert.equal(codexTurnEnded(done, TURN, COMPLETED + 5_000), true, 'same turn id: exact, no clock (the straggler arrived AFTER completion)');
  assert.equal(codexTurnEnded(done, NEXT, 0), false);
  assert.equal(codexTurnEnded({ ...done, kind: 'started' }, TURN, 0), false);
  assert.equal(codexTurnEnded(null, TURN, 0), false);
  assert.equal(codexTurnEnded(done, null, COMPLETED - 1), true);
  assert.equal(codexTurnEnded(done, null, COMPLETED + 1), false);
  assert.equal(codexTurnEnded(done, null, 0), false, 'no epoch, no id: nothing to prove');
});

test('CodexRolloutLifecycleSource: reads the newest rollout, a BOUNDED tail only, and fails closed', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-life-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const src = new CodexRolloutLifecycleSource();
  assert.deepEqual(src.probe(home), { ok: false, why: 'no-rollout' }, 'no sessions dir');
  const day = path.join(home, 'sessions', '2026', '09', '15');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-2026-09-15T21-45-19-x.jsonl');
  // A huge old history, then the boundary at the end: only the tail is needed.
  const filler = tokens('2026-09-15T21:45:20.000Z') + '\n';
  fs.writeFileSync(file, filler.repeat(Math.ceil((CODEX_LIFECYCLE_TAIL_BYTES * 4) / filler.length)) + started(TURN, '2026-09-25T18:11:40.000Z') + '\n' + complete(TURN, '2026-09-25T18:12:25.270Z') + '\n');
  assert.deepEqual(src.probe(home), { ok: true, latest: { kind: 'complete', turnId: TURN, at: COMPLETED } });
  // A boundary OUTSIDE the bounded window is not found: fail closed rather than read it all.
  fs.appendFileSync(file, filler.repeat(Math.ceil((CODEX_LIFECYCLE_TAIL_BYTES * 2) / filler.length)));
  const later = new CodexRolloutLifecycleSource();
  assert.deepEqual(later.probe(home), { ok: true, latest: null }, 'beyond the tail = no proof');
});

test('B8 (Jim\'s pin): the tail bound is 64 KB in ABSOLUTE bytes, and the reader is called with it', (t) => {
  assert.ok(CODEX_LIFECYCLE_TAIL_BYTES <= 64 * 1024, `the guardrail is a 64 KB tail (is ${CODEX_LIFECYCLE_TAIL_BYTES})`);
  const src = codeOnly(readSource('src/main/codexRolloutLifecycle.ts'));
  assert.match(src, /readTail\(file, CODEX_LIFECYCLE_TAIL_BYTES\)/);
  // Behaviourally, in fixed bytes (not scaled by the constant): a boundary followed by
  // 256 KB of later lines is out of reach.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-b8-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const day = path.join(home, 'sessions', '2026', '09', '25');
  fs.mkdirSync(day, { recursive: true });
  const filler = tokens('2026-09-25T18:13:00.000Z') + '\n';
  fs.writeFileSync(path.join(day, 'rollout-2026-09-25T18-00-00-b8.jsonl'),
    complete(TURN, '2026-09-25T18:12:25.270Z') + '\n' + filler.repeat(Math.ceil((256 * 1024) / filler.length)));
  assert.deepEqual(new CodexRolloutLifecycleSource().probe(home), { ok: true, latest: null });
});

test('B9 (Jim\'s pin): the cache re-reads on an mtime change, so a LATER lost Stop is still recoverable', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-b9-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const day = path.join(home, 'sessions', '2026', '09', '25');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-2026-09-25T18-00-00-b9.jsonl');
  fs.writeFileSync(file, started(TURN, '2026-09-25T18:11:40.000Z') + '\n' + complete(TURN, '2026-09-25T18:12:25.270Z') + '\n');
  const src = new CodexRolloutLifecycleSource();
  assert.equal(src.probe(home).latest.turnId, TURN);
  // The next turn runs and completes, and its Stop is lost too. The file changed, so the
  // SAME source must see the new boundary.
  fs.appendFileSync(file, started(NEXT, '2026-09-25T18:20:00.000Z') + '\n' + complete(NEXT, '2026-09-25T18:21:00.000Z') + '\n');
  const later = new Date(fs.statSync(file).mtimeMs + 5_000);
  fs.utimesSync(file, later, later);
  assert.deepEqual(src.probe(home), { ok: true, latest: { kind: 'complete', turnId: NEXT, at: Date.parse('2026-09-25T18:21:00.000Z') } });
});

test('WIRING: main feeds the bridge a Codex-only probe, from a bounded reader', () => {
  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /codexTurnProbe: \(agentId\) => \{\s*const home = hive\.codexHomeFor\(agentId\);\s*return home \? codexLifecycle\.probe\(home\) : undefined;\s*\}/);
  const bridge = codeOnly(readSource('src/main/inboxWakeBridge.ts'));
  // 1.1.53: the beat reads the inbox ONCE, reconciles, probes, runs the coordinator's beat, then claims with those ids.
  assert.match(bridge, /reconcileAll\(agentIds: readonly string\[\]\): void \{\s*for \(const agentId of agentIds\) \{\s*try \{\s*const ids = this\.deps\.inboxIds\(agentId\);\s*this\.deps\.coordinator\.reconcile\(agentId, ids\);\s*try \{ this\.closeLostCodexTurn\(agentId, ids\); \}[\s\S]*?this\.deps\.coordinator\.beat\(agentId, this\.deps\.now\(\)\)[\s\S]*?this\.requestInboxWake\(agentId, 'reconcile', 'reconcile', ids\);/, 'probed on the beat, before the claim');
  const life = codeOnly(readSource('src/main/codexRolloutLifecycle.ts'));
  assert.match(life, /readTail\(file, CODEX_LIFECYCLE_TAIL_BYTES\)/, 'bounded tail read');
  assert.doesNotMatch(life, /readFileSync/, 'never a whole-file read');
});

test('NEGATIVE (the dangerous one): the newest boundary is the OPEN turn\'s own START -> it is running, never closed', () => {
  // Mid-turn: the rollout's newest boundary is task_started of exactly the turn the app has open.
  const probe = { current: { ok: true, latest: { kind: 'started', turnId: TURN, at: COMPLETED - 30_000 } } };
  const f = floor({ probe });
  oscarStuck(f);
  f.bridge.reconcileAll([A]);
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'a START of the open turn is proof it is RUNNING');
  assert.equal(f.submits.length, 0, 'nothing is typed into a running turn');
});
