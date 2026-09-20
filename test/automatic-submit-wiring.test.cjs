'use strict';

/**
 * L0-FUSION stage 5.2 — the submit owner JOINED to the real main-process parts.
 *
 * `automatic-submit.test.cjs` proves the transaction against a fake world. This file
 * proves the JOIN: the real `AutomaticSubmitOwner`, through the real `buildOwnerDeps`,
 * against the REAL `CapacityRuntime` + tracker + admission seam, the real provider
 * capability table, the real eligibility predicate and the real mirrors' shapes. Only
 * the PTY is a double (node-pty does not load under node:test), and it implements exactly
 * the `OwnerPty` slice and nothing else.
 *
 * THE WORKER-WAKE ARMS LIVE HERE NOW. `workerWake.ts` used to own a private copy of the
 * ask -> text -> gap -> Enter order (`submitWorkerNudge`) with five tests in
 * provider-capacity-delivery-death.test.cjs. That copy is deleted: the wake beat submits
 * CAPACITY_GATED work to the one owner. Each of the five guarantees is re-asserted below
 * against the path that actually runs, rather than dropped with the function.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource: read } = require('./read-source.cjs');

const { AutomaticSubmitOwner, GAP_MS } = loadTs('src/main/automaticSubmit.ts');
const { buildOwnerDeps, ScreenReadingBroker, isScreenReading } = loadTs('src/main/automaticSubmitWiring.ts');
const { CapacityRuntime, CLAIM_REASON } = loadTs('src/main/capacityRuntime.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
const { ProviderCapacityTracker } = loadTs('src/main/providerCapacityTracker.ts');
const { L0_SEM_POLICY } = loadTs('src/shared/providerCapacity.ts');
const { automaticAbortCapability } = loadTs('src/shared/providerAutomation.ts');
const { isTerminalPromptState } = loadTs('src/shared/promptState.ts');
const { WorkerWakeWatchdog, WORKER_WAKE_IDLE_MS, WORKER_WAKE_COOLDOWN_MS } = loadTs('src/main/workerWake.ts');

const T0 = 1_800_000_000_000;
// The observation shape is the one provider-capacity-delivery-death.test.cjs already
// drives the real tracker with: a fixture the tracker REJECTS leaves the pool unobserved,
// and every arm below would then be testing NO_STATE while claiming to test AVAILABLE.
const POOL = 'codex:acct-a:codex';
const win = (remaining) => ({
  windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: T0 + 3_600_000
});
const obs = (over = {}) => ({
  poolKey: POOL, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s/a.jsonl', sourceSequence: 1,
  observedAt: T0, receivedAt: T0, windows: [win(80)],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});
const LIMIT = (at) => obs({
  observedAt: at, receivedAt: at, providerReachedType: 'rate_limit_reached', windows: [win(0)]
});

/** One virtual clock for the capacity runtime AND the owner, so "the pool went LIMITED
 *  inside the gap" is a schedule this file controls rather than a race it hopes for. */
function rig(over = {}) {
  const r = {
    now: T0, mono: 0, seq: 0, timers: [],
    writes: [], record: [],
    session: { incarnation: 1, gen: 0, lastHumanAt: undefined, hasOutput: true,
      inputState: { mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'pass' },
      promptState: { block: null } },
    provider: 'codex',
    prompt: '', oracle: 'answers',
    ...over
  };
  const setTimer = (fn, ms) => { const t = { at: r.now + ms, seq: (r.seq += 1), fn, ms }; r.timers.push(t); return { id: t.seq, unref() { return this; } }; };
  r.tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => r.now, () => r.mono);
  r.runtime = new CapacityRuntime({
    deliver: () => {}, now: () => r.now, setTimer,
    clearTimer: (h) => { r.timers = r.timers.filter((t) => t.seq !== (h && h.id)); }
  }, r.tracker);
  r.pty = {
    write: (id, data, origin) => {
      assert.equal(origin, 'PROGRAMMATIC', 'the owner only ever declares PROGRAMMATIC');
      if (!r.session) return { ok: false, error: `no pty: ${id}` };
      if (r.writeFails && r.writeFails(data)) return { ok: false, error: 'simulated' };
      if (r.writeThrows && r.writeThrows(data)) throw new Error('pty exploded');
      r.writes.push(data);
      const state = r.tracker.pool(POOL)?.state ?? 'NONE';
      if (data === '\r') { r.record.push(`enter:${state}`); r.prompt = ''; }
      else if (data === '\x15') { r.record.push(`abort:${state}`); r.prompt = ''; }
      else { r.prompt += data; if (r.onStaged) r.onStaged(); }
      return { ok: true };
    },
    incarnation: () => r.session?.incarnation,
    humanInputGeneration: () => r.session?.gen,
    lastHumanInputAt: () => r.session?.lastHumanAt,
    hasOutput: () => r.session?.hasOutput,
    inputState: () => r.session?.inputState,
    promptState: () => r.session?.promptState
  };
  r.deps = buildOwnerDeps({
    pty: r.pty, capacity: r.runtime,
    ptyForAgent: (agentId) => (r.session && agentId === 'jim' ? 'pty-jim' : undefined),
    providerForPty: () => r.provider,
    requestScreenReading: (ptyId, needle) => {
      if (r.oracle === 'silent') return new Promise(() => {});
      return Promise.resolve({ onPromptRow: r.prompt.includes(needle), screenCount: r.prompt.includes(needle) ? 1 : 0 });
    },
    now: () => r.now, setTimer
  });
  r.owner = new AutomaticSubmitOwner(r.deps);
  r.at = (ms, fn) => { r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn, ms }); };
  r.state = () => r.tracker.pool(POOL)?.state;
  r.settle = async (promise) => {
    let done = false; let value;
    promise.then((v) => { done = true; value = v; });
    for (let i = 0; i < 5000; i += 1) {
      await new Promise((res) => setImmediate(res));
      if (done) return value;
      assert.ok(r.timers.length, 'stuck: unsettled and no timer pending');
      r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = r.timers.shift();
      const dt = Math.max(0, next.at - r.now);
      r.now += dt; r.mono += dt;
      next.fn();
    }
    throw new Error('did not settle');
  };
  return r;
}

const wake = (r, id = 'w1') => r.owner.submit({
  requestId: id, agentId: 'jim', admissionClass: 'CAPACITY_GATED', text: 'You have new hive inbox message(s)'
});

function recovering(r) {
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', LIMIT(T0 + 1_000));
  assert.equal(r.state(), 'LIMITED');
  for (let i = 0; i < 40 && r.state() !== 'RECOVERING'; i += 1) {
    r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = r.timers.shift();
    assert.ok(next, 'expected an armed capacity boundary');
    const dt = Math.max(0, next.at - r.now); r.now += dt; r.mono += dt; next.fn();
  }
  assert.equal(r.state(), 'RECOVERING', 'the rig reached RECOVERING through the production path');
}

// ─── The five L0-WAKE guarantees, on the path that now runs ───────────────────────────

test('L0-WAKE via the owner: a refused wake types NOTHING - not the nudge text either', async () => {
  const r = rig();
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', LIMIT(T0 + 1_000));
  const out = await r.settle(wake(r));
  assert.deepEqual(r.writes, [], 'nothing typed: no text staged and no keystroke');
  assert.equal(out.kind, 'REFUSED'); assert.equal(out.reason, 'CAPACITY_HOLD');
  assert.equal(out.detail, ADMISSION_REASON.LIMITED);
});

test('L0-WAKE via the owner: a permitted wake types, in order - the gate is not a blanket refusal', async () => {
  const r = rig();
  r.runtime.ingest('jim', obs());
  const out = await r.settle(wake(r));
  assert.deepEqual(r.writes, ['You have new hive inbox message(s)', '\r'], 'the nudge, then the TUI gap, then Enter');
  assert.deepEqual(r.record, ['enter:AVAILABLE']);
  assert.equal(out.kind, 'COMMITTED');
});

test('L0-WAKE via the owner: a limit arriving INSIDE the gap stops the Enter and erases the nudge', async () => {
  // The defect the old order could only push to "fails safe": it gated before the text
  // and then typed the Enter 140 ms later with nothing re-checked. Now the final check is
  // adjacent to the Enter, and a late refusal un-types what was staged.
  const r = rig();
  r.runtime.ingest('jim', obs());
  // Scheduled FROM THE STAGE, not from the submit: the owner first waits out the
  // provider's readiness settle, and a limit landing in THAT wait is a pre-STAGE refusal
  // that types nothing (which is what this arm did, correctly, when first written).
  r.onStaged = () => r.at(GAP_MS / 2, () => r.runtime.ingest('jim', LIMIT(r.now)));
  const out = await r.settle(wake(r));
  assert.deepEqual(r.record, ['abort:LIMITED'], 'abort:LIMITED, never enter:LIMITED');
  assert.equal(out.kind, 'ABORTED');
  assert.equal(r.prompt, '', 'and the nudge is not left staged for a human to send');
});

test('L0-WAKE via the owner: a failed text write never presses Enter', async () => {
  const r = rig();
  r.runtime.ingest('jim', obs());
  r.writeFails = () => true;
  const out = await r.settle(wake(r));
  assert.deepEqual(r.writes, []);
  assert.equal(out.reason, 'STAGE_WRITE_FAILED');
});

test('L0-WAKE via the owner: an Enter that THROWS is not a launch - the recovery turn goes back', async () => {
  const r = rig();
  recovering(r);
  r.writeThrows = (d) => d === '\r';
  const out = await r.settle(wake(r));
  assert.equal(out.kind, 'INTERFERED'); assert.equal(out.reason, 'ENTER_WRITE_FAILED');
  assert.equal(r.runtime.admit('jim').verdict, 'ALLOW',
    'the epoch’s single recovery turn was RETURNED, so a real turn can still take it');
});

// ─── The join to the REAL capacity runtime ────────────────────────────────────────────

test('a RECOVERING pool: the owner’s own reservation is not a refusal of the owner', async () => {
  // The carve-out, through `revalidate`. The probe answers REFUSE/RECOVERING_SPENT for
  // everyone once this claim holds the turn - including, read naively, for this claim.
  const r = rig();
  recovering(r);
  const out = await r.settle(wake(r));
  assert.equal(out.kind, 'COMMITTED', 'the delivery that reserved the turn is allowed to spend it');
  assert.equal(r.runtime.admit('jim').verdict, 'REFUSE', 'and it is SPENT: confirmLaunch ran in-section');
});

test('revalidate keeps the verdict tri-state and names each structural refusal', () => {
  const r = rig();
  r.runtime.ingest('jim', obs());
  const decision = r.runtime.admit('jim');
  const claim = { decision, agentId: 'jim', workClass: 'ORDINARY_TURN', target: 'pty-jim' };
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-jim'), { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE });
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-other'), { verdict: 'REFUSE', reason: CLAIM_REASON.TARGET },
    'a grant is not transferable');
  const stranger = r.runtime.admit('nobody-mapped');
  assert.equal(stranger.verdict, 'UNKNOWN_NOT_INFERRED_SAFE');
  assert.deepEqual(
    r.runtime.revalidate({ decision: stranger, agentId: 'nobody-mapped', workClass: 'ORDINARY_TURN', target: null }, null),
    { verdict: 'UNKNOWN_NOT_INFERRED_SAFE', reason: ADMISSION_REASON.NO_POOL },
    'UNKNOWN reaches the owner’s resolver AS UNKNOWN, with its evidence - not collapsed to a boolean');
  r.runtime.ingest('jim', LIMIT(T0 + 1_000));
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-jim'), { verdict: 'REFUSE', reason: CLAIM_REASON.EPOCH });
  assert.equal(r.runtime.maySubmitNow(claim, 'pty-jim'), false, 'the legacy boolean agrees while it still exists');
});

// ─── The fail-closed READY gate, through the real tables and predicates ───────────────

test('READY: an unmeasured provider stages nothing for automatic delivery', async () => {
  for (const provider of ['grok', 'kimi', 'gemini', 'antigravity', 'qwen', 'opencode', 'crush', 'pi', 'copilot', 'cursor', 'custom', undefined]) {
    const r = rig({ provider });
    r.runtime.ingest('jim', obs());
    const out = await r.settle(wake(r));
    assert.deepEqual(r.writes, [], `${provider}: nothing staged`);
    assert.equal(out.reason, 'PROVIDER_ABORT_UNVERIFIED', `${provider}: refused for want of a MEASURED abort`);
  }
});

test('the abort-capability table: two MEASURED rows, everything else UNKNOWN, and it is TOTAL', () => {
  assert.deepEqual(automaticAbortCapability('claude'), { kind: 'MEASURED', clearControl: '\x15', settleMs: 900 });
  assert.deepEqual(automaticAbortCapability('codex'), { kind: 'MEASURED', clearControl: '\x15', settleMs: 900 });
  // TOTAL against the provider union, read from the union's own source rather than from
  // a list this test would have to be told about.
  const union = read('src/shared/agentProvider.ts').match(/export type AgentProvider =([\s\S]*?);/)[1];
  const providers = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(providers.length >= 13, 'the union was found');
  const table = read('src/shared/providerAutomation.ts').split('const AUTOMATIC_ABORT_CAPABILITY')[1].split('};')[0];
  for (const p of providers) {
    assert.match(table, new RegExp(`\\n  ${p}: (MEASURED_CTRL_U|ABORT_UNKNOWN)`), `${p} has a decided row`);
    if (p !== 'claude' && p !== 'codex') assert.equal(automaticAbortCapability(p).kind, 'UNKNOWN', `${p} is UNKNOWN`);
  }
  // Every MEASURED row must have a capture behind it in the committed matrix.
  const captures = read('test/electron-harness/scenarios/tui-clear-matrix.ts');
  for (const p of providers.filter((x) => automaticAbortCapability(x).kind === 'MEASURED')) {
    assert.match(captures, new RegExp(`\\n  ${p}: \\{\\n    mark:`), `${p} is MEASURED, so the matrix holds its capture`);
  }
});

test('READY: every provenance ineligibility refuses, evaluated from the REAL predicate', async () => {
  const cases = [
    [undefined, 'NO_STATE'],
    [{ mouseTrackingMode: 'none', inputOriginAttached: false, selfTest: 'pass' }, 'UNATTACHED'],
    [{ mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'unknown' }, 'SELFTEST_UNKNOWN'],
    [{ mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'fail' }, 'SELFTEST_FAILED'],
    [{ mouseTrackingMode: 'any', inputOriginAttached: true, selfTest: 'pass' }, 'MOUSE_TRACKING']
  ];
  for (const [inputState, reason] of cases) {
    const r = rig();
    r.session.inputState = inputState;
    r.runtime.ingest('jim', obs());
    const out = await r.settle(wake(r));
    assert.deepEqual(r.writes, [], `${reason}: nothing typed`);
    assert.deepEqual(out, { kind: 'REFUSED', reason: 'PROVENANCE_INELIGIBLE', detail: reason });
  }
});

test('BEHAVIOUR CHANGE (reading 3): a wake beat onto a HUMAN DRAFT types nothing', async () => {
  // Before stage 5 the main wake beat typed with no view of the prompt at all. The draft,
  // the picker latch and the settle are now mirrored into main and the beat is refused.
  for (const block of ['draft', 'picker', 'settling']) {
    const r = rig();
    r.session.promptState = { block };
    r.prompt = 'half a sentence the human is writ';
    r.runtime.ingest('jim', obs());
    const out = await r.settle(wake(r));
    assert.deepEqual(r.writes, [], `${block}: the wake types NOTHING`);
    assert.equal(out.reason, `PROMPT_${block.toUpperCase()}`);
    assert.equal(r.prompt, 'half a sentence the human is writ', 'the human’s text is untouched');
    assert.equal(r.owner.inhibition('pty-jim'), null, 'and the human is not punished for typing');
  }
  const unmirrored = rig();
  unmirrored.session.promptState = undefined;
  unmirrored.runtime.ingest('jim', obs());
  assert.equal((await unmirrored.settle(wake(unmirrored))).reason, 'PROMPT_UNKNOWN',
    'a prompt that was never mirrored is UNKNOWN, and UNKNOWN is not free');
});

test('a refused wake is RETRIED after the cooldown, not forgotten until new mail arrives', () => {
  const w = new WorkerWakeWatchdog();
  const fact = (now) => ({ agentId: 'jim', ptyId: 'pty-jim', lastOutputAt: now - WORKER_WAKE_IDLE_MS - 1,
    inboxIds: ['mail-1'], autoDeliveryPaused: false, paused: false, halted: false });
  let now = 1_000_000;
  assert.deepEqual(w.decide([fact(now)], now), ['jim']);
  now += WORKER_WAKE_COOLDOWN_MS + 1;
  assert.deepEqual(w.decide([fact(now)], now), [], 'delivered mail is not re-announced');
  w.retract('jim'); // ...but this one was REFUSED by the owner
  assert.deepEqual(w.decide([fact(now)], now), ['jim'], 'so the same ids are tried again');
  w.retract('jim');
  assert.deepEqual(w.decide([fact(now + 1)], now + 1), [], 'and never faster than the cooldown');
});

test('readiness is answered by MAIN, per incarnation', () => {
  const r = rig();
  r.session.hasOutput = false;
  assert.equal(r.deps.terminalReady('pty-jim', 'jim', 10_000), 'WAIT', 'no first frame yet');
  r.session.hasOutput = true;
  assert.equal(r.deps.terminalReady('pty-jim', 'jim', 499), 'WAIT', 'codex’s 500 ms settle has not elapsed');
  assert.equal(r.deps.terminalReady('pty-jim', 'jim', 500), 'READY');
  assert.equal(r.deps.terminalReady('pty-jim', 'jim', 0), 'READY', 'ready stays ready for THIS incarnation');
  r.session.incarnation = 2;
  assert.equal(r.deps.terminalReady('pty-jim', 'jim', 0), 'WAIT', 'a respawn waits for its own first frame');
  r.session = null;
  assert.equal(r.deps.terminalReady('pty-jim', 'jim', 0), 'GONE');
});

// ─── The screen-reading broker and the mirror guard ───────────────────────────────────

test('ScreenReadingBroker: nobody to ask, a malformed answer and a stranger’s id are all NO reading', async () => {
  const nobody = new ScreenReadingBroker(() => false);
  assert.equal(await nobody.request('p', 'needle'), null, 'no renderer owns the pty: null at once');
  assert.equal(nobody.outstanding, 0);

  const sent = [];
  const timers = [];
  const b = new ScreenReadingBroker((ptyId, requestId, needle) => { sent.push({ ptyId, requestId, needle }); return true; },
    10_000, (fn) => { timers.push(fn); });
  const good = b.request('p', 'needle');
  b.answer('not-a-pending-id', { onPromptRow: false, screenCount: 0 });
  assert.equal(b.outstanding, 1, 'an id that is not pending settles nothing');
  b.answer(sent[0].requestId, { onPromptRow: true, screenCount: 2, extra: 'ignored' });
  assert.deepEqual(await good, { onPromptRow: true, screenCount: 2 });

  const bad = b.request('p', 'needle');
  b.answer(sent[1].requestId, { onPromptRow: 'no', screenCount: 0 });
  assert.equal(await bad, null, 'a malformed answer is no answer, never a guess');

  const forgotten = b.request('p', 'needle');
  timers[timers.length - 1]();
  assert.equal(await forgotten, null);
  assert.equal(b.outstanding, 0, 'an unanswered request does not grow the map');

  for (const v of [null, {}, { onPromptRow: true }, { onPromptRow: true, screenCount: -1 }, { onPromptRow: true, screenCount: 1.5 }]) {
    assert.equal(isScreenReading(v), false, JSON.stringify(v));
  }
});

test('the prompt mirror is validated at the boundary', () => {
  for (const block of [null, 'exited', 'picker', 'draft', 'settling']) assert.equal(isTerminalPromptState({ block }), true);
  for (const bad of [null, {}, { block: 'free' }, { block: undefined }, { block: 0 }, 'draft']) {
    assert.equal(isTerminalPromptState(bad), false, JSON.stringify(bad));
  }
});

// ─── Static: the renderer half ────────────────────────────────────────────────────────

test('the erase oracle reads the SCREEN and never the keystroke model (design 5.1 prohibition)', () => {
  const pool = read('src/renderer/src/components/terminalPool.ts');
  const start = pool.indexOf('export function readScreenForNeedle(');
  const body = pool.slice(start, pool.indexOf('\n}\n', start));
  assert.ok(start > 0 && body.length > 100, 'the oracle exists');
  for (const banned of ['inputDirty', 'hasTerminalDraft', 'lineBuf', 'promptLineHasText', 'writePty']) {
    assert.ok(!body.includes(banned), `the erase oracle must not consult or call \`${banned}\``);
  }
  assert.match(body, /buf\.baseY \+ buf\.cursorY/, 'the prompt row is baseY + cursorY');
  assert.match(body, /entry\.term\.rows/, 'and the screen half walks the visible rows');
});

test('the prompt mirror is re-derived at every site that changes it, and caches only on ACK', () => {
  const pool = read('src/renderer/src/components/terminalPool.ts');
  const calls = pool.split('reportPromptState(entry)').length - 1;
  assert.equal(calls, 4, 'four sites: the onData pass, the picker release, the user clear, and the tick');
  for (const site of ['function releasePickerBlock(', 'export function clearTerminalDraft(', 'function startPromptMirror(']) {
    const at = pool.indexOf(site);
    assert.ok(at > 0 && pool.slice(at, pool.indexOf('\n}\n', at)).includes('reportPromptState(entry)'), `${site} re-derives the mirror`);
  }
  const start = pool.indexOf('function reportPromptState(');
  const body = pool.slice(start, pool.indexOf('\n}\n', start));
  const ack = body.indexOf('r && r.ok');
  const cache = body.indexOf('entry.promptStateReported = block');
  assert.ok(ack > 0 && cache > ack, 'the cache is written only inside the ACK branch');
  assert.match(body, /entry\.generation === gen/, 'and only for the incarnation it was sent under');
});

// ─── Static: the wake path holds no private submit order any more ─────────────────────

test('workerWake.ts decides WHO and types nothing; index.ts sends the wake through the owner', () => {
  const wakeSrc = read('src/main/workerWake.ts');
  assert.ok(!/submitWorkerNudge|writeSubmit|writeText|delaySubmit/.test(wakeSrc), 'the private order is gone');
  const index = read('src/main/index.ts');
  assert.equal(index.split('ptyManager.write(').length - 1, 1,
    'index.ts has exactly ONE direct ptyManager.write: the declared-origin pty:write handler');
  const beat = index.slice(index.indexOf('function runWorkerWakeBeat'), index.indexOf('/** (Re)arm the always-on beats'));
  assert.match(beat, /automaticSubmit\.submit\(\{[\s\S]*admissionClass: 'CAPACITY_GATED'/, 'the beat submits CAPACITY_GATED work to the owner');
  assert.ok(!/providerCapacity\.(admit|maySubmitNow|confirmLaunch|cancelGrant)/.test(beat),
    'and keeps no capacity decision of its own - no private `!== REFUSE`');
  assert.match(index, /if \(!isTerminalPromptState\(state\)\) return \{ ok: false, error: 'invalid prompt state' \}/);
});
