'use strict';

/**
 * AGY 1.1.48 commit 4 — the canonical provider-native lifecycle, and the false-active
 * stall it closes (design section 4; agents/dwight-mu32ztys/falseactive-stall-ROOTCAUSE.md).
 *
 * WHAT THIS PINS. A `COMMITTED` wake opens an ACTIVE epoch, and before this commit only a
 * terminal HOOK could close one. In the 1.1.47 incident no AGY lifecycle event reached main
 * at all, so Phyllis was known-active forever: event mode refuses anything but idle, and D3
 * deliberately refuses to let PTY silence stand in for a positively active lifecycle. The
 * watchdog saw the contradiction at 301s and could only announce it.
 *
 * The repair is an AUTHORITATIVE input, not a relaxed guard. Every test below is written so
 * that it fails if elapsed silence, the renderer, inbox age or the watchdog is ever allowed
 * to stand in for the provider's own answer — that substitution is the one thing that would
 * type a second prompt into a turn that is genuinely running and merely quiet.
 *
 * The normaliser is REAL (the golden 1.2.8 fixture), the coordinator and bridge are REAL,
 * and the clock is fake. The owner is the usual miniature of AutomaticSubmitOwner: one
 * request id = one promise = at most one Enter.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { WorkerWakeWatchdog, inboxWakeRequestId, WORKER_WAKE_IDLE_MS, WORKER_WAKE_HITL_REARM_MS } =
  loadTs('src/main/workerWake.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const { classifyAgyStatusLine } = loadTs('src/main/capacityNormalize.ts');
const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');

const src = (f) => codeOnly(readSource(f), path.basename(f));
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `anchor missing: ${a}`); return s.slice(i, s.indexOf(b, i)); };

const FIXTURE = path.join(__dirname, 'fixtures', 'agy-statusline-1.2.8.json');
/** The instant the fixture's reset seconds were measured against (schema test's RECEIVED). */
const RECEIVED = Date.parse('2026-09-22T09:44:03Z');
const SCOPE = 'agyscope0001';
const FIXTURE_SESSION = 'c7d28ffd-108c-451b-8029-fd8920993b71';
/** The wake clock. Deliberately unrelated to RECEIVED: a lifecycle reading is dated by the
 *  provider's tick, a wake decision by the floor's clock, and nothing may couple them. */
const NOW = 50_000_000;

const golden = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** One real statusline payload in the given state, classified by the real normaliser. */
function classify(edit) {
  const p = golden();
  if (edit) edit(p);
  return classifyAgyStatusLine({ payload: p, accountScope: SCOPE, receivedAt: RECEIVED });
}

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

function floor({ decide, ids = [] } = {}) {
  const immediates = [];
  const coordinator = new WorkerWakeWatchdog();
  const owner = fakeOwner(decide);
  const now = { t: NOW };
  const inbox = { ids: [...ids] };
  const facts = { ptyId: 'pty-1', lastOutputAt: NOW - 1_000, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false };
  const diag = [];
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: () => [...inbox.ids],
    facts: () => ({ ...facts }),
    submit: (req) => owner.submit(req),
    text: (batch) => inboxNudgeText([...batch]),
    setImmediate: (fn) => { immediates.push(fn); },
    now: () => now.t,
    diag: (stage, fields) => { diag.push({ stage, ...fields }); }
  });
  const flush = async () => {
    for (let i = 0; i < 20; i++) {
      while (immediates.length) immediates.shift()();
      await new Promise((r) => setImmediate(r));
      if (!immediates.length) return;
    }
  };
  /**
   * EXACTLY what index.ts does with one tick, so these tests exercise the real routing
   * rule rather than a convenient one: capacity always (elsewhere), lifecycle ONLY with an
   * agent id, and a refused tick routed nowhere at all.
   */
  const deliver = (agentId, c) => {
    if (!c.ok) return false;
    if (!agentId) return false;
    bridge.onProviderStatus(agentId, c.tick.lifecycle, c.tick.sessionId);
    return true;
  };
  return { coordinator, bridge, owner, now, inbox, facts, flush, deliver, diag };
}

// ─── the mapping ────────────────────────────────────────────────────────────

test('MEASURED SEQUENCE: authenticating yields NO tick; idle/working/tool_use/idle drive idle->active->active->idle exactly', async () => {
  const f = floor({ ids: ['m1'] });
  const seen = [];
  // The real boot tick: authenticating, no model, no quota. The ratified N-1 choice (b) is
  // that it produces NO observation at all, so the lifecycle stays whatever it already was.
  // That matters most at exactly this moment: an invented "authenticating is active" would
  // re-create the 1.1.46 cold-boot deadlock one layer down.
  const boot = classify((p) => { p.agent_state = 'authenticating'; p.model = null; delete p.quota; });
  assert.equal(boot.ok, false, 'the boot tick must not normalize');
  assert.equal(f.deliver('a1', boot), false, 'and it must reach the coordinator not at all');
  assert.equal(f.coordinator.state('a1').lifecycle, 'unknown', 'authenticating leaves lifecycle UNKNOWN');

  for (const state of ['idle', 'working', 'tool_use', 'idle']) {
    const c = classify((p) => { p.agent_state = state; });
    assert.equal(c.ok, true, `${state} must normalize`);
    f.deliver('a1', c);
    seen.push({ state, canonical: c.tick.lifecycle, lifecycle: f.coordinator.state('a1').lifecycle });
  }
  assert.deepEqual(seen.map((s) => s.canonical), ['idle', 'running', 'running', 'idle'],
    'the canonical sequence is idle -> running -> running -> idle');
  assert.deepEqual(seen.map((s) => s.lifecycle), ['idle', 'active', 'active', 'idle'],
    'and the wake lifecycle follows it exactly: idle -> active -> active -> idle');
});

test('TOOL_USE without a confirmation flag is RUNNING: it asserts active and is never a retry edge', () => {
  const f = floor();
  const c = classify((p) => { p.agent_state = 'tool_use'; });
  assert.equal(c.tick.lifecycle, 'running', 'tool_use alone is running, not a confirmation');
  const edge = f.coordinator.noteProviderStatus('a1', c.tick.lifecycle, NOW, c.tick.sessionId);
  assert.equal(edge, false, 'a running agent is NOT a retry edge');
  assert.equal(f.coordinator.state('a1').lifecycle, 'active');
  // And it does not arm the human hold - a tool call is not a person being asked something.
  f.coordinator.noteDelivery('a1', 'm1');
  const claim = f.coordinator.claim({ agentId: 'a1', ptyId: 'p', lastOutputAt: NOW, paused: false, halted: false, autoDeliveryPaused: false }, 'hook', 'event', NOW);
  assert.equal(claim, null);
  assert.equal(f.coordinator.whyNoClaim('a1'), 'lifecycle-active', 'refused for being active, NOT for a HITL hold');
});

test('CONFIRMATION is BOTH active and a HITL hold: mail cannot be typed through a permission prompt', () => {
  const f = floor({ ids: ['m1'] });
  const c = classify((p) => { p.agent_state = 'tool_use'; p.tool_confirmation_pending = true; });
  assert.equal(c.tick.lifecycle, 'waiting_for_confirmation');
  assert.equal(f.coordinator.noteProviderStatus('a1', c.tick.lifecycle, NOW, c.tick.sessionId), false,
    'a confirmation prompt is not a retry edge');
  assert.equal(f.coordinator.state('a1').lifecycle, 'active', 'the turn is still alive');
  f.coordinator.noteDelivery('a1', 'm1');
  // Now let the provider say idle WHILE the hold is still inside its rearm window. The
  // lifecycle clears, and the claim is STILL refused - by the hold, which is the point.
  f.coordinator.noteProviderStatus('a1', 'idle', NOW + 1_000, FIXTURE_SESSION);
  const claim = f.coordinator.claim({ agentId: 'a1', ptyId: 'p', lastOutputAt: NOW, paused: false, halted: false, autoDeliveryPaused: false }, 'hook', 'event', NOW + 1_000);
  assert.equal(claim, null);
  assert.equal(f.coordinator.whyNoClaim('a1'), 'hitl-hold', 'the confirmation hold outlives the confirmation state');
  // Past the rearm window it releases normally; nothing here is permanent.
  const later = f.coordinator.claim({ agentId: 'a1', ptyId: 'p', lastOutputAt: NOW, paused: false, halted: false, autoDeliveryPaused: false }, 'hook', 'event', NOW + WORKER_WAKE_HITL_REARM_MS + 1);
  assert.ok(later, 'the hold is a window, not a latch');
});

test('D3 REGRESSION: a RUNNING agent plus more than 12s of PTY silence is still unclaimable', () => {
  const f = floor();
  f.coordinator.noteDelivery('a1', 'm1');
  f.coordinator.noteProviderStatus('a1', 'running', NOW, FIXTURE_SESSION);
  const silent = NOW + WORKER_WAKE_IDLE_MS + 60_000;   // far past quiescence
  const facts = { agentId: 'a1', ptyId: 'p', lastOutputAt: NOW, paused: false, halted: false, autoDeliveryPaused: false };
  assert.equal(f.coordinator.claim(facts, 'reconcile', 'reconcile', silent), null,
    'silence never substitutes for a POSITIVELY active lifecycle');
  assert.equal(f.coordinator.whyNoClaim('a1'), 'lifecycle-active');
  // The same silence DOES carry an unknown lifecycle - that ratified path is untouched.
  const g = floor();
  g.coordinator.noteDelivery('a2', 'm1');
  assert.ok(g.coordinator.claim({ agentId: 'a2', ptyId: 'p', lastOutputAt: NOW, paused: false, halted: false, autoDeliveryPaused: false }, 'reconcile', 'reconcile', silent),
    'unknown + quiescent still claims');
});

// ─── the incident, and the recovery ─────────────────────────────────────────

test('THE FALSE-ACTIVE STALL: a COMMITTED wake with no terminal proof NEVER submits again, however long the silence', async () => {
  const f = floor({ ids: ['m1'] });
  f.coordinator.noteProviderStatus('a1', 'idle', NOW, FIXTURE_SESSION);
  f.bridge.onDelivery('a1', 'm1');
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'the first wake goes through');
  assert.equal(f.coordinator.state('a1').lifecycle, 'active', 'COMMITTED opened an active epoch');

  // The incident: no terminal lifecycle event of any kind reaches main. More mail lands,
  // 16 minutes of PTY silence accumulate, the reconciliation beat runs repeatedly.
  f.inbox.ids.push('m2');
  f.now.t = NOW + 16 * 60_000;
  f.facts.lastOutputAt = NOW;
  f.bridge.onDelivery('a1', 'm2');
  await f.flush();
  for (let i = 0; i < 5; i++) { f.bridge.reconcileAll(['a1']); await f.flush(); }
  assert.equal(f.owner.calls.length, 1, 'NOT ONE further submission - announce only, exactly as the incident behaved');
  assert.equal(f.coordinator.whyNoClaim('a1'), 'lifecycle-active', 'and it says which guard held');
});

test('THE RECOVERY: one matching native idle closes the epoch and produces EXACTLY ONE guarded claim', async () => {
  const f = floor({ ids: ['m1'] });
  f.coordinator.noteProviderStatus('a1', 'idle', NOW, FIXTURE_SESSION);
  f.bridge.onDelivery('a1', 'm1');
  await f.flush();
  f.inbox.ids = ['m2'];
  f.now.t = NOW + 16 * 60_000;
  f.bridge.onDelivery('a1', 'm2');
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'still stalled');

  // The statusline says the turn is over. This is the ONLY new authority in the commit.
  const idle = classify((p) => { p.agent_state = 'idle'; });
  f.deliver('a1', idle);
  await f.flush();
  assert.equal(f.owner.calls.length, 2, 'exactly one further wake');
  assert.deepEqual(f.owner.enters, ['a1', 'a1'], 'and exactly one further Enter');
  const second = f.owner.calls[1];
  assert.equal(second.requestId, inboxWakeRequestId('a1', ['m2']), 'through the existing stable pending-id request');
  assert.equal(second.admissionClass, 'CAPACITY_GATED', 'and the existing admission class');
  assert.equal(second.text, inboxNudgeText(['m2']));
});

test('DUPLICATE native idles coalesce: a statusline that ticks every render still produces ONE request', async () => {
  const f = floor({ ids: ['m1'] });
  const idle = classify((p) => { p.agent_state = 'idle'; });
  for (let i = 0; i < 12; i++) f.deliver('a1', idle);
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'twelve idle ticks, one submission');
  assert.deepEqual(f.owner.enters, ['a1']);
});

test('ORDINARY GUARDS still block a native idle: paused, halted, auto-delivery-paused, owner-inhibited, no PTY', async () => {
  const idle = classify((p) => { p.agent_state = 'idle'; });
  for (const [flag, why] of [['paused', 'paused'], ['halted', 'halted'], ['autoDeliveryPaused', 'auto-delivery-paused'], ['inhibited', 'owner-inhibited']]) {
    const f = floor({ ids: ['m1'] });
    f.facts[flag] = true;
    f.deliver('a1', idle);
    await f.flush();
    assert.equal(f.owner.calls.length, 0, `${flag}: native idle is an observation, not an override`);
    assert.equal(f.coordinator.whyNoClaim('a1'), why);
  }
  const f = floor({ ids: ['m1'] });
  f.facts.ptyId = undefined;
  f.deliver('a1', idle);
  await f.flush();
  assert.equal(f.owner.calls.length, 0, 'no terminal, no wake');
  assert.equal(f.coordinator.whyNoClaim('a1'), 'no-pty');
});

// ─── what must NOT become idle ──────────────────────────────────────────────

test('POSTINVOCATION never creates idle and never creates a wake claim', async () => {
  const f = floor({ ids: ['m1'] });
  f.coordinator.noteProviderStatus('a1', 'running', NOW, FIXTURE_SESSION);
  // agy fires PostInvocation once per model invocation, so a tool-using turn fires it
  // several times MID-TURN. Reading it as idle is what put the floor's display and main's
  // submission authority into disagreement during the 1.1.47 stall.
  //
  // ASSERTED AFTER EACH ONE, and the chain ENDS on a PostInvocation. A tool chain that
  // reads PreToolUse -> PostInvocation -> PreToolUse would hide the defect completely:
  // the following PreToolUse re-asserts active, so only the last event would be visible
  // and the claim would be refused for the wrong reason.
  for (let i = 0; i < 4; i++) {
    f.bridge.onHook('a1', 'PreToolUse', undefined);
    f.bridge.onHook('a1', 'PostInvocation', undefined);
    assert.equal(f.coordinator.state('a1').lifecycle, 'active',
      `PostInvocation ${i + 1} must not make an agent idle`);
  }
  await f.flush();
  assert.equal(f.coordinator.state('a1').lifecycle, 'active', 'and the turn is still active when the chain ends on one');
  assert.equal(f.owner.calls.length, 0, 'and it must not produce a claim');
  // …and not through the reconciliation beat either, with the PTY fully quiescent, so the
  // refusal can only be D3 refusing to let silence close a turn PostInvocation left open.
  f.facts.lastOutputAt = NOW - 60_000;
  f.bridge.reconcileAll(['a1']);
  await f.flush();
  assert.equal(f.owner.calls.length, 0, 'nor one through the reconciliation beat');
  assert.equal(f.coordinator.whyNoClaim('a1'), 'lifecycle-active', 'refused for being active, not for some other guard');
});

test('DRIFT: a malformed tick makes NO lifecycle observation at all - active stays active', async () => {
  const f = floor({ ids: ['m1'] });
  f.coordinator.noteProviderStatus('a1', 'running', NOW, FIXTURE_SESSION);
  // Each of these is refused WHOLE by the normaliser. The half that parsed is exactly as
  // suspect as the half that did not, so none of them may move the lifecycle either way.
  const broken = [
    classify((p) => { p.agent_state = 'finished'; }),
    classify((p) => { delete p.quota['gemini-5h']; }),
    classify((p) => { p.version = 42; }),
    classify((p) => { p.quota['3p-5h'].remaining_fraction = 1.5; })
  ];
  for (const c of broken) {
    assert.equal(c.ok, false, 'must be refused');
    assert.equal(f.deliver('a1', c), false, 'and routed nowhere');
  }
  await f.flush();
  assert.equal(f.coordinator.state('a1').lifecycle, 'active', 'drift never clears active to idle');
  assert.equal(f.owner.calls.length, 0);

  // The rule above is enforced in HookServer, not in this harness's routing helper, so it
  // is pinned WHERE IT LIVES too: a refusal returns before anything is handed on. Without
  // this the test would only be checking a mirror of the production rule against itself.
  const handler = between(src('src/main/hooks.ts'), 'private handleAgyStatus(', 'transcriptPath(agentId: string)');
  const refusal = handler.indexOf('if (!c.ok) {');
  assert.ok(refusal >= 0, 'the refusal branch exists');
  assert.ok(refusal < handler.indexOf('this.onAgyTick?.'), 'and returns BEFORE the tick is handed on');
  assert.match(handler.slice(refusal), /return \{\};/, 'a refused tick is answered and dropped');
});

test('A PERSONAL tick (no agent id) never touches a floor agent', async () => {
  const f = floor({ ids: ['m1'] });
  f.coordinator.noteProviderStatus('a1', 'running', NOW, FIXTURE_SESSION);
  const idle = classify((p) => { p.agent_state = 'idle'; });
  assert.equal(f.deliver(null, idle), false, 'the user\'s own agy session routes to no lifecycle');
  assert.equal(f.coordinator.noteProviderStatus(undefined, 'idle', NOW), false, 'and the coordinator refuses it directly');
  await f.flush();
  assert.equal(f.coordinator.state('a1').lifecycle, 'active', 'somebody else\'s running turn is untouched');
  assert.equal(f.owner.calls.length, 0);
});

// ─── incarnation ────────────────────────────────────────────────────────────

test('INCARNATION: a stale idle from the PREVIOUS session cannot idle a respawned PTY', async () => {
  const f = floor({ ids: ['m1'] });
  const idle = classify((p) => { p.agent_state = 'idle'; });
  f.deliver('a1', idle);                              // learns the fixture session
  assert.equal(f.coordinator.state('a1').providerSession, FIXTURE_SESSION);

  // The PTY is replaced. The new incarnation starts by learning its OWN session.
  f.now.t = NOW + 60_000;
  f.coordinator.noteSpawn('pty-2', f.now.t, 'a1');
  f.facts.ptyId = 'pty-2';
  assert.equal(f.coordinator.state('a1').providerSession, null, 'the old session is forgotten on respawn');
  assert.equal(f.coordinator.state('a1').lifecycle, 'unknown');

  const fresh = classify((p) => { p.agent_state = 'working'; p.session_id = 'new-session'; p.conversation_id = 'new-session'; });
  f.deliver('a1', fresh);
  assert.equal(f.coordinator.state('a1').lifecycle, 'active', 'the new session is running');

  // A late tick from the RETIRED session now arrives - the one shape that could make a
  // genuinely busy new turn look finished. It must change nothing whatsoever.
  f.deliver('a1', idle);
  await f.flush();
  assert.equal(f.coordinator.state('a1').lifecycle, 'active', 'a retired session cannot idle the live one');
  assert.equal(f.coordinator.state('a1').providerSession, 'new-session', 'and cannot steal the learned session');
  assert.equal(f.owner.calls.length, 0, 'and cannot produce a claim');
});

test('INCARNATION: a tick naming NO session is accepted, and does not erase the learned one', () => {
  const f = floor();
  const named = classify((p) => { p.agent_state = 'working'; });
  f.deliver('a1', named);
  const anonymous = classify((p) => { p.agent_state = 'idle'; delete p.session_id; delete p.conversation_id; });
  assert.equal(anonymous.tick.sessionId, null, 'the tick names no session');
  f.deliver('a1', anonymous);
  // One statusline stream per PTY, so receive order settles it; refusing an unnamed tick
  // would blind us to exactly the builds most likely to have dropped the field.
  assert.equal(f.coordinator.state('a1').lifecycle, 'idle', 'an unnamed tick is still authoritative');
  assert.equal(f.coordinator.state('a1').providerSession, FIXTURE_SESSION, 'and leaves the learned session in place');
});

test('ORDERING: an idle reading taken BEFORE the active epoch opened cannot close it', async () => {
  const f = floor({ ids: ['m1'] });
  f.coordinator.noteProviderStatus('a1', 'idle', NOW, FIXTURE_SESSION);
  f.bridge.onDelivery('a1', 'm1');
  await f.flush();
  assert.equal(f.owner.calls.length, 1, 'the turn started');
  assert.equal(f.coordinator.state('a1').lifecycle, 'active');

  // Each tick is its own short-lived shim process on the named pipe, so two in flight can
  // be received out of order. This one describes the PREVIOUS turn and arrives late.
  f.inbox.ids = ['m2'];
  f.bridge.onDelivery('a1', 'm2');
  f.now.t = NOW + 5_000;
  assert.equal(f.coordinator.noteProviderStatus('a1', 'idle', NOW - 1_000, FIXTURE_SESSION), false,
    'a reading older than the active edge is not terminal proof');
  await f.flush();
  assert.equal(f.coordinator.state('a1').lifecycle, 'active', 'the live turn stays active');
  assert.equal(f.owner.calls.length, 1, 'and no second prompt is typed into it');

  // A reading taken AFTER the edge closes it normally - the guard is an ordering rule,
  // not a mute.
  assert.equal(f.coordinator.noteProviderStatus('a1', 'idle', f.now.t, FIXTURE_SESSION), true);
  assert.equal(f.coordinator.state('a1').lifecycle, 'idle');
});

test('ORDERING: a long run of RUNNING ticks does not push the edge forward, so a genuine idle still lands', () => {
  const f = floor({ ids: ['m1'] });
  f.coordinator.noteProviderStatus('a1', 'running', NOW, FIXTURE_SESSION);
  // A statusline ticks on every render. If each one restamped the epoch, terminal proof
  // would have to beat the LAST tick rather than the start of the turn - and on a busy
  // agent something would always be newer, which is the stall all over again.
  for (let i = 1; i <= 20; i++) f.coordinator.noteProviderStatus('a1', 'running', NOW + i * 1_000, FIXTURE_SESSION);
  assert.equal(f.coordinator.noteProviderStatus('a1', 'idle', NOW + 500, FIXTURE_SESSION), true,
    'an idle newer than the EPOCH is terminal proof, even if older than the last running tick');
  assert.equal(f.coordinator.state('a1').lifecycle, 'idle');
});

// ─── the hook fallback ──────────────────────────────────────────────────────

test('STOP FALLBACK: with no native tick a Stop still idles; an explicit fullyIdle:false refuses it', async () => {
  // Claude sends no such field, and must be untouched: absent means terminal.
  const f = floor({ ids: ['m1'] });
  f.coordinator.noteProviderStatus('a1', 'running', NOW, FIXTURE_SESSION);
  assert.equal(f.coordinator.noteHook('a1', 'Stop', undefined, NOW), true, 'a plain Stop is still a retry edge');
  assert.equal(f.coordinator.state('a1').lifecycle, 'idle');

  // agy's own qualifier, preserved through the shim: false means the turn is still running.
  const g = floor({ ids: ['m1'] });
  g.coordinator.noteProviderStatus('a2', 'running', NOW, FIXTURE_SESSION);
  assert.equal(g.coordinator.noteHook('a2', 'Stop', undefined, NOW, false), false, 'fullyIdle:false is not terminal');
  assert.equal(g.coordinator.state('a2').lifecycle, 'active', 'and does not clear active');
  g.bridge.onHook('a2', 'Stop', undefined, false);
  await g.flush();
  assert.equal(g.owner.calls.length, 0, 'nor produce a claim through the bridge');

  // true is the ordinary terminal case and behaves exactly as an unqualified Stop.
  assert.equal(g.coordinator.noteHook('a2', 'Stop', undefined, NOW, true), true);
  assert.equal(g.coordinator.state('a2').lifecycle, 'idle');
});

test('BREADCRUMB: every provider status is recorded with its session and whether it was an edge', () => {
  const f = floor();
  f.deliver('a1', classify((p) => { p.agent_state = 'working'; }));
  f.deliver('a1', classify((p) => { p.agent_state = 'idle'; }));
  const rows = f.diag.filter((d) => d.stage === 'provider-status');
  assert.equal(rows.length, 2, 'both readings leave a durable breadcrumb');
  assert.deepEqual(rows.map((r) => [r.status, r.edge]), [['running', false], ['idle', true]]);
  assert.equal(rows[0].session, FIXTURE_SESSION, 'a discarded tick can be explained by its session');
});

// ─── censuses: who is allowed to decide what ────────────────────────────────

test('CENSUS renderer: PostInvocation no longer asserts idle, and the canonical status is consumed not parsed', () => {
  const hive = src('src/renderer/src/hooks/useHive.ts');
  const branch = between(hive, "e.event === 'PostInvocation'", "e.event === 'Stop'");
  assert.ok(!/status: 'idle'/.test(branch), 'the renderer must not map PostInvocation to idle');
  const consumer = between(hive, 'onHiveProviderStatus', '2b) Consume circuit-breaker');
  assert.match(consumer, /e\.status === 'idle'/, 'it displays the canonical status');
  // The raw provider vocabulary must never be re-derived renderer-side.
  assert.ok(!/agent_state|tool_confirmation_pending|agy_status|remaining_fraction/.test(hive),
    'no renderer code parses a raw statusline payload');
});

test('CENSUS main: the classifier is the ONLY producer of a canonical status, and the raw payload never crosses IPC', () => {
  const index = src('src/main/index.ts');
  // Anchored on CODE, not on a comment: readSource strips comments, and a census whose
  // anchor is a comment silently slices nothing the day somebody rewords it.
  const wiring = between(index, '(agentId, tick) => {', 'const memory = new MemoryManager');
  assert.match(wiring, /if \(!agentId\) return;/, 'lifecycle is routed ONLY with an agent id');
  assert.match(wiring, /inboxWake\?\.onProviderStatus\(agentId, tick\.lifecycle, tick\.sessionId\)/);
  assert.match(wiring, /send\('hive:providerStatus', \{ agentId, status: tick\.lifecycle \}\)/);
  assert.ok(!/agy_status/.test(wiring), 'the raw payload is not forwarded anywhere');
  // Capacity is ingested for a personal tick too - an allowance is an account fact.
  const capacityLine = wiring.indexOf('ingestAgyTick');
  assert.ok(capacityLine >= 0 && capacityLine < wiring.indexOf('if (!agentId) return;'),
    'the allowance pair is ingested BEFORE the agent-id gate, not behind it');
});

test('CENSUS wake: the coordinator still types nothing and still owns exactly one claim path', () => {
  for (const f of ['src/main/workerWake.ts', 'src/main/inboxWakeBridge.ts']) {
    const s = src(f);
    assert.ok(!/ptyManager|sendToOwner|\.write\(/.test(s), `${f}: no terminal access`);
    assert.ok(!/agent_state|agy_status|remaining_fraction/.test(s), `${f}: no raw provider parsing`);
  }
  const bridge = src('src/main/inboxWakeBridge.ts');
  const method = between(bridge, 'onProviderStatus(', 'onControlRelease(');
  assert.match(method, /this\.scheduleWake\(agentId, 'hook'\)/, 'it rides the existing scheduling path');
  assert.equal((bridge.match(/this\.deps\.submit\(/g) ?? []).length, 1, 'still exactly one submit call site');
});

test('CENSUS shim: the agy hook shim preserves fullyIdle and still forwards no account data', () => {
  const hive = src('src/main/hive.ts');
  const shim = between(hive, 'const AGY_HOOK_SHIM = ', '// ─── pi bridge extension');
  assert.match(shim, /fully_idle: typeof agy\.fullyIdle === 'boolean'/, 'the terminal qualifier survives the shim');
  assert.ok(!/email/.test(shim), 'and the shim still carries no account identity');
});
