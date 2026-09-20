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
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource: read, codeOnly } = require('./read-source.cjs');

const { AutomaticSubmitOwner, GAP_MS } = loadTs('src/main/automaticSubmit.ts');
const { buildOwnerDeps, ScreenReadingBroker, isScreenReading } = loadTs('src/main/automaticSubmitWiring.ts');
const { CapacityRuntime, CLAIM_REASON } = loadTs('src/main/capacityRuntime.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
assert.ok(L0_SEM_POLICY && L0_SEM_POLICY.liveTtlMs > 0, 'the production policy really loaded (an undefined one silently falls back to the default parameter)');
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
  r.runtime = new (over.Runtime ?? CapacityRuntime)({
    deliver: () => {}, now: () => r.now, setTimer,
    clearTimer: (h) => { r.timers = r.timers.filter((t) => t.seq !== (h && h.id)); }
  }, r.tracker);
  if (over.Admission) {
    // A MUTANT admission seam, wired exactly as CapacityRuntime wires the real one.
    const real = r.runtime.admission;
    r.runtime.admission = new over.Admission(real.deps);
  }
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
  r.owner = new (over.Owner ?? AutomaticSubmitOwner)(r.deps);
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

test('L0-WAKE via the owner: an Enter that THROWS is not a launch - and the recovery turn is HELD FOR A HUMAN, not handed back', async () => {
  // god's ruling on G1b. Our nudge is still on a live prompt where a person can press
  // Enter on it, so the evidence has run out: the turn is neither spent nor returned.
  const r = rig();
  recovering(r);
  r.writeThrows = (d) => d === '\r';
  const out = await r.settle(wake(r));
  assert.equal(out.kind, 'INTERFERED'); assert.equal(out.reason, 'ENTER_WRITE_FAILED');
  assert.deepEqual([r.runtime.admit('jim').verdict, r.runtime.admit('jim').reason], ['REFUSE', ADMISSION_REASON.RECOVERING_SPENT],
    'the epoch’s single turn is IN SUSPENSE: nobody else is handed it while a person may still launch ours');
  assert.equal(r.owner.resolveInterference('pty-jim', 'SEND_AGAIN'), true);
  assert.equal(r.runtime.admit('jim').verdict, 'ALLOW', 'a person says it was NOT sent: only then does the turn go back');
});

// --- The grant in suspense, against the REAL admission seam (stage 5.6) -------------------
//
// THE COLLISION god asked to be told about: admission ABANDONS an unconfirmed reservation
// after RECOVERY_RESERVATION_TTL_MS (60 s). "Do not return the grant at INTERFERED" is
// therefore not enough by itself - left merely unconfirmed, the turn would be handed to
// someone else a minute later, while a person is still reading the prompt. So the seam has
// a third state, `holdGrantForHuman`: not confirmed, not abandoned, no timer.

/** RECOVERING, then a delivery a human interferes with. Returns the rig, mid-hold. */
async function interferedOnRecovering(Admission) {
  const r = rig({ Admission });
  recovering(r);
  r.onStaged = () => { r.at(40, () => { r.session.gen += 1; r.session.lastHumanAt = r.now; r.prompt += 'x'; }); };
  const out = await r.settle(wake(r));
  assert.deepEqual([out.kind, out.reason], ['INTERFERED', 'HUMAN_INPUT_AFTER_STAGE'], 'precondition');
  return r;
}
const TEN_MINUTES = 600_000;
const KA = {};

KA.aGrantHeldForAHumanOutlivesTheReservationTtl = async (Admission) => {
  const r = await interferedOnRecovering(Admission);
  r.now += TEN_MINUTES; r.mono += TEN_MINUTES;
  assert.equal(r.state(), 'RECOVERING', 'precondition: still the same recovery epoch');
  assert.deepEqual([r.runtime.admit('jim').verdict, r.runtime.admit('jim').reason], ['REFUSE', ADMISSION_REASON.RECOVERING_SPENT],
    'TEN MINUTES into an INTERFERED hold the turn is STILL in suspense - the 60 s reservation TTL does not hand it to someone else');
  // ...and the control: a reservation nobody is holding for a human IS abandoned by then.
  const plain = rig({ Admission });
  recovering(plain);
  const reserved = plain.runtime.admit('jim');
  assert.ok(reserved.grantId, 'precondition: a plain reservation');
  plain.now += TEN_MINUTES; plain.mono += TEN_MINUTES;
  assert.equal(plain.runtime.admit('jim').verdict, 'ALLOW', 'an ordinary abandoned reservation still expires: the hold is an exception, not a new default');
};

KA.alreadyHandledSpendsTheTurn = async (Admission) => {
  const r = await interferedOnRecovering(Admission);
  assert.equal(r.owner.resolveInterference('pty-jim', 'ALREADY_HANDLED'), true);
  r.now += TEN_MINUTES; r.mono += TEN_MINUTES;
  assert.equal(r.runtime.admit('jim').verdict, 'REFUSE', '"already handled" CONFIRMS the launch: the epoch’s one turn is spent for good');
};

KA.sendAgainReturnsTheTurnAndAsksAfresh = async (Admission) => {
  const r = await interferedOnRecovering(Admission);
  assert.equal(r.owner.resolveInterference('pty-jim', 'SEND_AGAIN'), true);
  r.prompt = ''; r.session.promptState = { block: null }; r.onStaged = null;
  r.now += 5_000; r.mono += 5_000;
  const writesBefore = r.writes.length;
  const out = await r.settle(wake(r));
  assert.equal(out.kind, 'COMMITTED', '"send queued message" returned the turn, and the re-admission took it again through the real seam');
  assert.deepEqual(r.writes.slice(writesBefore), ['You have new hive inbox message(s)', '\r'], 'exactly one delivery');
  assert.equal(r.runtime.admit('jim').verdict, 'REFUSE', 'and NOW it is spent - by the launch, not by the hold');
};

KA.aHeldGrantCanStillBeSettledOnlyOnce = async (Admission) => {
  const r = await interferedOnRecovering(Admission);
  const probe = () => r.runtime.admission.probe('jim', 'ORDINARY_TURN').verdict;
  assert.equal(probe(), 'REFUSE');
  assert.equal(r.owner.resolveInterference('pty-jim', 'SEND_AGAIN'), true);
  assert.equal(probe(), 'ALLOW', 'returned');
  assert.equal(r.owner.resolveInterference('pty-jim', 'ALREADY_HANDLED'), false, 'a second resolution finds nothing to resolve');
  assert.equal(probe(), 'ALLOW', 'and cannot retroactively spend a turn that was given back');
};

for (const [name, killer] of Object.entries(KA)) test(`grant in suspense (REAL admission): ${name}`, () => killer(undefined));

const ADMISSION_MUTANTS = [
  { name: 'a grant held for a human is abandoned at the reservation TTL',
    edits: [['    return !grant.confirmed && !grant.heldForHuman && this.deps.now()', '    return !grant.confirmed && this.deps.now()']],
    killer: 'aGrantHeldForAHumanOutlivesTheReservationTtl', dies: /STILL in suspense/ },
  { name: 'holding for a human makes EVERY reservation immortal',
    edits: [['    return !grant.confirmed && !grant.heldForHuman && this.deps.now()', '    return false && this.deps.now()']],
    killer: 'aGrantHeldForAHumanOutlivesTheReservationTtl', dies: /an exception, not a new default/ },
  { name: 'holding for a human silently confirms the launch',
    edits: [['    held.heldForHuman = true;', '    held.confirmed = true;']],
    killer: 'sendAgainReturnsTheTurnAndAsksAfresh', dies: /returned the turn/ }
];

test('MUTANT CENSUS (capacityAdmission.holdGrantForHuman): every mutant applies exactly once and dies at the named assertion', async (t) => {
  const source = read('src/main/capacityAdmission.ts');
  fs.rmSync(RUNTIME_MUTANT_DIR + '-adm', { recursive: true, force: true });
  fs.mkdirSync(RUNTIME_MUTANT_DIR + '-adm', { recursive: true });
  try {
    for (const [i, mutant] of ADMISSION_MUTANTS.entries()) {
      await t.test(`mutant: ${mutant.name}`, async () => {
        await KA[mutant.killer](undefined); // passes on the real class...
        let text = source;
        for (const [from, to] of mutant.edits) {
          const hits = text.split(from).length - 1;
          assert.equal(hits, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE, matched ${hits}`);
          text = text.replace(from, () => to);
        }
        text = text.replace(/from '\.\/(\w+)'/g, "from '../../src/main/$1'").replace(/from '\.\.\/shared\//g, "from '../../src/shared/");
        const file = path.join(RUNTIME_MUTANT_DIR + '-adm', `a${i}.ts`);
        fs.writeFileSync(file, text, 'utf8');
        const Mutant = loadTs(path.relative(path.resolve(__dirname, '..'), file)).CapacityAdmission;
        let died = null;
        try { await KA[mutant.killer](Mutant); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong assertion`);
      });
    }
  } finally {
    fs.rmSync(RUNTIME_MUTANT_DIR + '-adm', { recursive: true, force: true });
  }
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

// ─── The owner against the REAL PtyManager (stage 5.5a) ───────────────────────────────
//
// Every arm above uses a PTY double that RESTATES pty.ts's accounting. This one does not:
// the real `PtyManager` is the `pty` handed to `buildOwnerDeps`, its mirrors are set
// through its real setters, and the human's keystroke goes in through its real
// `write(id, data, 'HUMAN')`. The only fake is the OS process behind the session (node-pty
// is not spawned), injected the way test/input-provenance.test.cjs already injects one.
// So the generation the owner compares, the timestamp it reads and the incarnation it
// scopes to are the production ones.

function realPtyRig(humanInGap) {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  const r = rig();
  const procWrites = [];
  pm.sessions.set('pty-jim', {
    id: 'pty-jim', cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true,
    humanInputGeneration: 0, incarnation: 7,
    proc: { write: (d) => {
      procWrites.push(d);
      // A person types the moment our payload lands - through the REAL human ingress.
      if (humanInGap && d.includes('inbox') && !procWrites.includes('x')) r.at(40, () => { pm.write('pty-jim', 'x', 'HUMAN'); });
    } }
  });
  assert.deepEqual(pm.setInputState('pty-jim', { mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'pass' }), { ok: true });
  assert.deepEqual(pm.setPromptState('pty-jim', { block: null }), { ok: true });
  r.runtime.ingest('jim', obs());
  const owner = new AutomaticSubmitOwner(buildOwnerDeps({
    pty: pm, capacity: r.runtime,
    ptyForAgent: (agentId) => (agentId === 'jim' ? 'pty-jim' : undefined),
    providerForPty: () => 'codex',
    requestScreenReading: () => Promise.resolve(null),
    now: () => r.now,
    setTimer: (fn, ms) => { const t = { at: r.now + ms, seq: (r.seq += 1), fn, ms }; r.timers.push(t); return t; }
  }));
  return { r, pm, owner, procWrites };
}

test('REAL PtyManager: nobody types - the owner’s PROGRAMMATIC writes never move the human generation, and it commits', async () => {
  const { r, pm, owner, procWrites } = realPtyRig(false);
  const out = await r.settle(owner.submit({ requestId: 'rp1', agentId: 'jim', admissionClass: 'CAPACITY_GATED', text: 'read your inbox' }));
  assert.deepEqual(out, { kind: 'COMMITTED' });
  assert.deepEqual(procWrites, ['read your inbox', '\r'], 'text, then Enter, into the real manager’s process');
  assert.equal(pm.humanInputGeneration('pty-jim'), 0, 'the owner cannot interfere with itself: PROGRAMMATIC never advances the REAL generation');
  assert.equal(pm.lastHumanInputAt('pty-jim'), undefined);
});

test('REAL PtyManager: a HUMAN write through the real ingress, in the gap -> INTERFERED, and no Enter reaches the process', async () => {
  const { r, pm, owner, procWrites } = realPtyRig(true);
  const out = await r.settle(owner.submit({ requestId: 'rp2', agentId: 'jim', admissionClass: 'CAPACITY_GATED', text: 'read your inbox' }));
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' });
  assert.deepEqual(procWrites, ['read your inbox', 'x'], 'our payload, their key - and NOTHING after it: no Enter, no clear');
  assert.equal(pm.humanInputGeneration('pty-jim'), 1, 'the REAL generation is what moved');
  assert.ok(owner.inhibition('pty-jim'), 'and the terminal is held for a person');
  // The hold is scoped to the REAL incarnation: a same-id respawn is a different terminal.
  pm.sessions.get('pty-jim').incarnation = 8;
  assert.equal(owner.inhibition('pty-jim'), null, 'a new incarnation under the same id does not inherit the hold');
});

// ─── L0-TOCTOU, MIGRATED ONTO `revalidate` (stage 5.5a; nothing is deleted by this) ────
//
// The five L0-TOCTOU tests and the L0-WAKE shared check in
// provider-capacity-delivery-death.test.cjs ask their question through the TICKET door
// (`markAutomaticDeliveryWriting`) and the legacy boolean (`maySubmitNow`), neither of
// which has a production caller any more. The question itself is alive: it is what the
// owner asks inside its critical section, through `revalidate`. These are the same five
// schedules asked through THAT door, with the full answer (verdict AND reason) pinned
// rather than a boolean - so when the ticket door is removed (its own commit, after a
// validator signs the successor mapping) nothing the old tests held is left unheld.
// The old tests stay until then; both sets pass side by side.

/** Killers: each takes the CapacityRuntime CLASS under test, so the census below can hand
 *  it a mutant. They run against the real class as ordinary tests. */
const KR = {};

/** A claim admitted on a healthy pool, as the owner holds one between ADMIT and COMMIT. */
function claimOnHealthyPool(Runtime, target = 'pty-jim') {
  const r = rig({ Runtime });
  r.runtime.ingest('jim', obs());
  assert.equal(r.state(), 'AVAILABLE', 'precondition: admitted on a healthy pool');
  const decision = r.runtime.admit('jim');
  assert.equal(decision.verdict, 'ALLOW');
  return { r, claim: { decision, agentId: 'jim', workClass: 'ORDINARY_TURN', target } };
}

KR.limitedAfterAdmission = (Runtime) => { // TOCTOU on revalidate: a pool that goes LIMITED after admission REFUSES, and says the EPOCH changed
  const { r, claim } = claimOnHealthyPool(Runtime);
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-jim'), { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE },
    'precondition: while the pool is healthy the Enter is authorised');
  r.runtime.ingest('jim', LIMIT(T0 + 1_000));
  assert.equal(r.state(), 'LIMITED', 'the pool really did move');
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-jim'), { verdict: 'REFUSE', reason: CLAIM_REASON.EPOCH },
    'a claim admitted on a healthy pool authorises NOTHING once that pool is LIMITED');
};

KR.reserveOnlyAfterAdmission = (Runtime) => { // TOCTOU on revalidate: a pool that goes RESERVE_ONLY refuses an ORDINARY turn - a different path from LIMITED
  // No refusal, so no limit epoch: the structural checks all pass and the answer has to
  // come from re-asking admission. A revalidation that only compared epochs passes this.
  const { r, claim } = claimOnHealthyPool(Runtime);
  r.runtime.ingest('jim', obs({ observedAt: T0 + 1_000, receivedAt: T0 + 1_000, windows: [win(0)] }));
  assert.equal(r.state(), 'RESERVE_ONLY', 'a fresh numeric zero without attribution');
  const now = r.runtime.revalidate(claim, 'pty-jim');
  assert.equal(now.verdict, 'REFUSE', 'ordinary work is suppressed, so this Enter is not authorised');
  assert.ok(!Object.values(CLAIM_REASON).includes(now.reason),
    `and the reason is ADMISSION's own (${now.reason}), not a structural one: the claim is intact, the pool is spent`);
};

KR.poolMoved = (Runtime) => { // TOCTOU on revalidate: an agent whose readings moved to ANOTHER pool is not this claim's agent
  const { r, claim } = claimOnHealthyPool(Runtime);
  r.runtime.ingest('jim', obs({ poolKey: 'codex:acct-b:codex', accountScope: 'acct-b', observedAt: T0 + 1_000, receivedAt: T0 + 1_000 }));
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-jim'), { verdict: 'REFUSE', reason: CLAIM_REASON.POOL },
    'both pools are healthy - the refusal is that the decision was about a pool this agent no longer draws on');
};

KR.boundToOneTerminal = (Runtime) => { // TOCTOU on revalidate: a claim is bound to ONE terminal - another, or none, is refused; its own is not
  const { r, claim } = claimOnHealthyPool(Runtime, 'pty-A');
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-B'), { verdict: 'REFUSE', reason: CLAIM_REASON.TARGET }, 'another terminal cannot spend it');
  assert.deepEqual(r.runtime.revalidate(claim, null), { verdict: 'REFUSE', reason: CLAIM_REASON.TARGET }, 'nor can an Enter that will not say which terminal it is for');
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-A'), { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE }, 'the binding is a match, not a ban');
};

KR.ownReservationIsNotARefusal = (Runtime) => { // TOCTOU on revalidate: a RECOVERING claim is NOT refused by its own reservation - and a stranger is
  const r = rig({ Runtime });
  recovering(r);
  const decision = r.runtime.admit('jim');
  assert.equal(decision.verdict, 'ALLOW');
  assert.ok(decision.grantId, 'precondition: the epoch granted its one turn to THIS decision');
  const claim = { decision, agentId: 'jim', workClass: 'ORDINARY_TURN', target: 'pty-jim' };
  assert.deepEqual({ ...r.runtime.admission.probe('jim', 'ORDINARY_TURN') }.verdict, 'REFUSE',
    'the probe DOES refuse right now - which is exactly why a naive revalidation breaks');
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-jim'), { verdict: 'ALLOW', reason: ADMISSION_REASON.RECOVERING_GRANT },
    'the pool refuses everyone ELSE because of this claim; that is not a refusal of it');
  const second = r.runtime.admit('jim');
  assert.equal(second.verdict, 'REFUSE', 'a second asker gets no turn');
  assert.equal(r.runtime.revalidate({ ...claim, decision: second }, 'pty-jim').verdict, 'REFUSE',
    'and a claim that does NOT hold the grant is refused by the same pool');
  r.runtime.cancelGrant(decision);
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-jim'), { verdict: 'REFUSE', reason: CLAIM_REASON.GRANT },
    'once the grant is handed back the claim that held it authorises nothing');
};

for (const [name, killer] of Object.entries(KR)) test(`TOCTOU on revalidate: ${name}`, () => killer(CapacityRuntime));

const RUNTIME_MUTANTS = [
  { name: 'the terminal binding dropped',
    edits: [["    if (held.target !== target) return { verdict: 'REFUSE', reason: CLAIM_REASON.TARGET };\n", '']],
    killer: 'boundToOneTerminal', dies: /another terminal cannot spend it/ },
  { name: 'a moved pool goes unnoticed',
    edits: [["    if ((this.poolForAgent.get(held.agentId) ?? null) !== held.decision.poolKey) {\n      return { verdict: 'REFUSE', reason: CLAIM_REASON.POOL };\n    }\n", '']],
    killer: 'poolMoved', dies: /no longer draws on/ },
  { name: 'the epoch comparison dropped (the refusal loses its name)',
    edits: [["    if ((pool?.limitEpochAt ?? null) !== held.decision.limitEpochAt) {\n      return { verdict: 'REFUSE', reason: CLAIM_REASON.EPOCH };\n    }\n", '']],
    killer: 'limitedAfterAdmission', dies: /authorises NOTHING once that pool is LIMITED/ },
  { name: 'structural checks only - admission is never re-asked',
    edits: [['    return { verdict: now.verdict, reason: now.reason };', "    return { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE };"]],
    killer: 'reserveOnlyAfterAdmission', dies: /ordinary work is suppressed/ },
  { name: 'the carve-out removed: the guard refuses its own reservation',
    edits: [["now.reason === ADMISSION_REASON.RECOVERING_SPENT\n", "now.reason === 'NEVER'\n"]],
    killer: 'ownReservationIsNotARefusal', dies: /that is not a refusal of it/ },
  { name: 'the carve-out opened to strangers',
    edits: [["RECOVERING_SPENT\n      && this.admission.holdsGrant(held.decision)) {", 'RECOVERING_SPENT) {']],
    killer: 'ownReservationIsNotARefusal', dies: /does NOT hold the grant/ },
  { name: 'the post-reset probe refused by its own reservation',
    edits: [["now.reason === ADMISSION_REASON.POST_RESET_PROBE_SPENT\n", "now.reason === 'NEVER-PROBE'\n"]],
    killer: 'ownPostResetProbeIsNotARefusal', dies: /that is not a refusal of it/ },
  { name: 'a lost grant still authorises',
    edits: [['    if (held.decision.grantId && !this.admission.holdsGrant(held.decision)) {', '    if (false) {']],
    killer: 'ownReservationIsNotARefusal', dies: /handed back/ }
];

const RUNTIME_MUTANT_DIR = path.join(__dirname, '.mutants-capacity-runtime');

test('MUTANT CENSUS (capacityRuntime.revalidate): every mutant applies exactly once and dies at the named assertion', async (t) => {
  const source = read('src/main/capacityRuntime.ts');
  fs.rmSync(RUNTIME_MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUNTIME_MUTANT_DIR, { recursive: true });
  try {
    for (const [i, mutant] of RUNTIME_MUTANTS.entries()) {
      await t.test(`mutant: ${mutant.name}`, () => {
        assert.ok(KR[mutant.killer], `killer ${mutant.killer} exists`);
        KR[mutant.killer](CapacityRuntime); // passes on the real class...
        let text = source;
        for (const [from, to] of mutant.edits) {
          const hits = text.split(from).length - 1;
          assert.equal(hits, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE, matched ${hits}`);
          text = text.replace(from, () => to);
        }
        // The copy lives two directories away from src/main, so its relative imports move.
        text = text.replace(/from '\.\/(\w+)'/g, "from '../../src/main/$1'").replace(/from '\.\.\/shared\//g, "from '../../src/shared/");
        const file = path.join(RUNTIME_MUTANT_DIR, `m${i}.ts`);
        fs.writeFileSync(file, text, 'utf8');
        const Mutant = loadTs(path.relative(path.resolve(__dirname, '..'), file)).CapacityRuntime;
        let died = null;
        try { KR[mutant.killer](Mutant); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong assertion`);
      });
    }
  } finally {
    fs.rmSync(RUNTIME_MUTANT_DIR, { recursive: true, force: true });
  }
});


// ─── L0-UNKNOWN (human ruling, option B) against the REAL tracker ─────────────────────

const { capacityGateOf, UNKNOWN_POLICY } = loadTs('src/main/automaticSubmit.ts');

/** Let wall and monotonic time pass and let the tracker's own boundary timers run, the
 *  way production does: nothing here calls `evaluate()` by hand. */
function elapse(r, ms) {
  const until = r.now + ms;
  for (;;) {
    r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    if (!r.timers.length || r.timers[0].at > until) break;
    const next = r.timers.shift();
    const dt = Math.max(0, next.at - r.now); r.now += dt; r.mono += dt; next.fn();
  }
  const dt = until - r.now; r.now += dt; r.mono += dt;
}

/** The gate exactly as the control snapshot computes it: probe + the pool's own freshness. */
const gateFor = (r, agentId) => {
  const probed = r.runtime.admission.probe(agentId, 'ORDINARY_TURN');
  return capacityGateOf(probed, probed.poolKey ? r.tracker.pool(probed.poolKey)?.freshness ?? null : null,
    undefined, probed.poolKey ? r.tracker.resetOutlook(probed.poolKey) : null);
};
const RESET_AT = T0 + 3_600_000; // the five-hour window's reset in `win()`
const healthy = (r, seq) => obs({ observedAt: r.now, receivedAt: r.now, sourceSequence: seq });
const limited = (r, seq, over = {}) => obs({
  observedAt: r.now, receivedAt: r.now, sourceSequence: seq,
  providerReachedType: 'rate_limit_reached', windows: [win(0)], ...over
});

test('L0-UNKNOWN rule 1 - NO POOL: delivery proceeds, and the state says OUTSIDE GATING, never "available"', async () => {
  // An agent none of whose readings has ever been accepted maps to no pool. That is every
  // agent at startup: membership is learned only from the agent's own accepted reading.
  const r = rig();
  assert.deepEqual({ ...gateFor(r, 'jim') }, { evidence: 'NO_POOL', holds: false, basis: 'UNKNOWN:NO_POOL' });
  assert.equal((await r.settle(wake(r))).kind, 'COMMITTED', 'NO POOL CONFIGURED -> PROCEED');
  r.runtime.ingest('jim', healthy(r, 2));
  assert.equal(gateFor(r, 'jim').evidence, 'FRESH_HEALTHY', 'and a healthy fresh pool is a DIFFERENT value (rule 2)');
});

// ─── THE SEVEN TESTS THE REVISED RULING NAMES, on the production tracker ──────────────

test('L0-UNKNOWN: STALE-AFTER-HEALTHY PROCEEDS - and is never relabelled AVAILABLE', async () => {
  // Rule 3. The measured deadlock of option B, gone: 121 s of silence after an all-clear no
  // longer holds the delivery that would have woken the agent.
  assert.equal(L0_SEM_POLICY.liveTtlMs, 120_000, 'the freshness window is NOT changed to mask the problem');
  assert.equal(UNKNOWN_POLICY.STALE_AFTER_HEALTHY, 'PROCEED');
  const r = rig();
  r.runtime.ingest('jim', obs());
  elapse(r, L0_SEM_POLICY.liveTtlMs + 1_000);
  assert.equal(r.state(), 'UNKNOWN', 'THE TRACKER STILL SAYS UNKNOWN: staleness did not manufacture AVAILABLE');
  assert.deepEqual({ ...gateFor(r, 'jim') },
    { evidence: 'STALE_AFTER_HEALTHY', holds: false, basis: 'UNKNOWN:STALE_AFTER_HEALTHY' },
    'the state is preserved explicitly as "stale, last known healthy"');
  assert.equal((await r.settle(wake(r, 'w-stale'))).kind, 'COMMITTED', 'STALE, LAST KNOWN HEALTHY -> PROCEED');
  elapse(r, 12 * 60 * 60 * 1000);
  assert.equal((await r.settle(wake(r, 'w-stale-12h'))).kind, 'COMMITTED', 'an idle night no longer deadlocks the floor');
});

test('L0-UNKNOWN: STALE-AFTER-LIMITED HOLDS - the limit epoch outranks staleness', async () => {
  // Rule 5. This was never an UNKNOWN: a provider refusal opens a limit epoch, and the
  // tracker settles the epoch BEFORE freshness, so going quiet cannot clear it.
  const r = rig();
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', limited(r, 2));
  elapse(r, L0_SEM_POLICY.liveTtlMs + 1_000);
  assert.equal(r.tracker.pool(POOL).freshness, 'STALE');
  assert.equal(r.state(), 'LIMITED', 'stale, and STILL LIMITED');
  assert.equal(gateFor(r, 'jim').evidence, 'STALE_AFTER_LIMITED', 'reported as "stale, last known limited"');
  const out = await r.settle(wake(r));
  assert.deepEqual(r.writes, [], 'STALE, LAST KNOWN NON-HEALTHY -> HOLD: nothing typed');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'CAPACITY_HOLD', detail: ADMISSION_REASON.LIMITED });
});

test('L0-UNKNOWN: KNOWN RESET PASSAGE EXITS THE HOLD - and produces RECOVERING, NEVER AVAILABLE', async () => {
  // Rule 6 and the STATE INVARIANT. It is the tracker's EXISTING RECOVERING - a passed reset
  // boundary is a hint, never a confirmation - and admission's EXISTING single-turn grant is
  // exactly "a controlled post-reset re-probe": ONE delivery, as the activity that
  // re-establishes evidence.
  const r = rig();
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', limited(r, 2));
  elapse(r, RESET_AT - r.now - 1_000);
  assert.equal(r.state(), 'LIMITED', 'one second before the known reset: still held');
  assert.equal((await r.settle(wake(r, 'w-before'))).kind, 'REFUSED');
  elapse(r, 2_000 + (RESET_AT - r.now > 0 ? RESET_AT - r.now : 0));
  assert.equal(r.state(), 'RECOVERING', 'RESET PASSAGE PRODUCES RECOVERING');
  assert.notEqual(r.state(), 'AVAILABLE', 'reset passage must NEVER manufacture AVAILABLE');
  assert.equal(r.tracker.pool(POOL).recoveryPending, true);
  assert.equal(gateFor(r, 'jim').evidence, 'RECOVERING', 'and the snapshot says "recovering after reset", not healthy');
  assert.equal((await r.settle(wake(r, 'w-probe'))).kind, 'COMMITTED', 'KNOWN RESET PASSAGE EXITS THE HOLD: the re-probe is delivered');
  assert.equal((await r.settle(wake(r, 'w-second'))).kind, 'REFUSED', 'and it is CONTROLLED: one re-probe per epoch, not an open door');
  assert.equal(r.state(), 'RECOVERING', 'delivering the probe did not manufacture AVAILABLE either');
});

test('L0-UNKNOWN: POST-RESET DELIVERY STILL UNDERGOES FINAL REVALIDATION', async () => {
  // The re-probe is staged, and the provider refuses AGAIN inside the gap. The final check
  // next to the Enter sees it: no Enter, and the staged text is verifiably erased.
  const r = rig();
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', limited(r, 2));
  elapse(r, RESET_AT - r.now + 1_000);
  assert.equal(r.state(), 'RECOVERING');
  r.onStaged = () => r.at(GAP_MS / 2, () => r.runtime.ingest('jim', limited(r, 3,
    { windows: [{ ...win(0), resetsAt: r.now + 3_600_000 }] })));
  const out = await r.settle(wake(r));
  assert.deepEqual(r.record, ['abort:LIMITED'], 'the post-reset delivery was revalidated next to the Enter, and stopped');
  assert.equal(out.kind, 'ABORTED');
});

test('L0-UNKNOWN: A NEW LIMITED OBSERVATION IMMEDIATELY RESTORES THE HOLD', async () => {
  for (const from of ['stale-after-healthy', 'recovering']) {
    const r = rig();
    r.runtime.ingest('jim', obs());
    if (from === 'recovering') { r.runtime.ingest('jim', limited(r, 2)); elapse(r, RESET_AT - r.now + 1_000); }
    else elapse(r, L0_SEM_POLICY.liveTtlMs + 1_000);
    assert.equal(gateFor(r, 'jim').holds, false, `${from}: delivery may proceed`);
    r.runtime.ingest('jim', limited(r, 9, { windows: [{ ...win(0), resetsAt: r.now + 3_600_000 }] }));
    assert.equal(r.state(), 'LIMITED');
    assert.equal(gateFor(r, 'jim').evidence, 'FRESH_NOT_HEALTHY');
    const out = await r.settle(wake(r, `w-${from}`));
    assert.deepEqual(r.writes, [], `${from}: a new limited observation IMMEDIATELY restores the hold`);
    assert.equal(out.reason, 'CAPACITY_HOLD');
  }
});

test('L0-UNKNOWN: A NEW HEALTHY OBSERVATION RESTORES NORMAL FRESH-HEALTH BEHAVIOUR', async () => {
  const r = rig();
  r.runtime.ingest('jim', obs());
  elapse(r, L0_SEM_POLICY.liveTtlMs + 1_000);
  assert.equal(gateFor(r, 'jim').evidence, 'STALE_AFTER_HEALTHY');
  r.runtime.ingest('jim', healthy(r, 2));
  assert.equal(r.state(), 'AVAILABLE');
  assert.deepEqual({ ...gateFor(r, 'jim') }, { evidence: 'FRESH_HEALTHY', holds: false, basis: ADMISSION_REASON.AVAILABLE });
  assert.equal((await r.settle(wake(r))).kind, 'COMMITTED');
});

// ─── CASES THE REVISED RULING DOES NOT NAME: pinned AS THEY ARE, reported, not decided ─

test('UNNAMED CASE (b): an INDETERMINATE pool that is NOT stale still HOLDS (previous ruling kept)', async () => {
  // A window nobody can identify makes the FRESH reading UNKNOWN. That is not staleness, so
  // `staleLastKnown` answers null and the evidence stays INDETERMINATE.
  const r = rig();
  r.runtime.ingest('jim', obs({ windows: [win(80), { ...win(50), windowId: 'mystery', kind: 'OTHER', windowMinutes: null }] }));
  assert.equal(r.state(), 'UNKNOWN');
  assert.equal(r.tracker.pool(POOL).freshness, 'FRESH');
  assert.deepEqual({ ...gateFor(r, 'jim') }, { evidence: 'INDETERMINATE', holds: true, basis: 'UNKNOWN:INDETERMINATE' });
  const out = await r.settle(wake(r));
  assert.deepEqual(r.writes, []);
  assert.equal(out.detail, 'UNKNOWN:INDETERMINATE');
  // ...and once THAT reading goes stale it is "stale, last known NOT healthy" - still held.
  elapse(r, L0_SEM_POLICY.liveTtlMs + 1_000);
  assert.equal(gateFor(r, 'jim').evidence, 'STALE_AFTER_UNHEALTHY');
  assert.equal((await r.settle(wake(r, 'w2'))).kind, 'REFUSED');
});

// --- L0-UNKNOWN, THE HUMAN'S RULING "1a": the post-reset probe, against the REAL tracker ---
//
// CASE 1 of the two unnamed cases. A window at exactly zero WITHOUT a provider refusal is
// RESERVE_ONLY: no limit epoch opens, so there is no RECOVERING hint to fire when its known
// reset passes, and once stale it was held for ever. The ruling: a SEPARATE explicit state -
// not AVAILABLE, not RECOVERING - that allows ONE re-probe once the known reset has passed,
// under final revalidation and every human-interference gate; any new reading restores the
// ordinary behaviour; a second ask is refused until fresh evidence. The tracker's own
// projection never changes for it: it stays UNKNOWN. Named to mirror rule 6's tests above.

/** A spent window (no refusal), gone stale, with its known reset now PASSED. */
function spentAndStale(classes = {}) {
  const r = rig(classes);
  r.runtime.ingest('jim', obs({ windows: [win(0)] }));
  assert.equal(r.state(), 'RESERVE_ONLY');
  assert.equal(r.tracker.pool(POOL).limitEpochAt, null, 'precondition: no refusal, so no epoch - RECOVERING cannot apply');
  elapse(r, L0_SEM_POLICY.liveTtlMs + 1_000);
  return r;
}
const passTheReset = (r) => elapse(r, RESET_AT - r.now + 60_000);
const K1A = {};

K1A.aPassedKnownResetExitsTheHoldAsItsOwnState = async (classes) => {
  const r = spentAndStale(classes);
  assert.equal(r.tracker.resetOutlook(POOL), 'RESET_KNOWN');
  assert.equal(r.tracker.postResetProbeKey(POOL), null, 'BEFORE the reset there is no probe');
  assert.equal(gateFor(r, 'jim').evidence, 'STALE_AFTER_UNHEALTHY', 'before the reset the pool is simply held');
  assert.equal((await r.settle(wake(r, 'before'))).kind, 'REFUSED', 'and delivery is held');
  passTheReset(r);
  assert.equal(r.state(), 'UNKNOWN', 'RESET PASSAGE NEVER MANUFACTURES AVAILABLE - nor RECOVERING: the tracker still publishes UNKNOWN');
  assert.deepEqual({ ...gateFor(r, 'jim') }, { evidence: 'POST_RESET_PROBE', holds: false, basis: ADMISSION_REASON.POST_RESET_PROBE_GRANT },
    'KNOWN RESET PASSAGE EXITS THE HOLD - as the SEPARATE post-reset state, never FRESH_HEALTHY and never RECOVERING');
  const out = await r.settle(wake(r, 'probe'));
  assert.equal(out.kind, 'COMMITTED', 'the one probe turn is delivered');
  assert.deepEqual(r.record, [`enter:UNKNOWN`], 'and it went out against a pool the tracker still calls UNKNOWN');
};

K1A.oneProbePerPassedReset = async (classes) => {
  const r = spentAndStale(classes);
  passTheReset(r);
  assert.equal((await r.settle(wake(r, 'probe'))).kind, 'COMMITTED');
  const second = await r.settle(wake(r, 'second'));
  assert.deepEqual([second.kind, second.reason, second.detail], ['REFUSED', 'CAPACITY_HOLD', ADMISSION_REASON.POST_RESET_PROBE_SPENT],
    'ONE PROBE PER PASSED RESET: a second ask after the probe is refused until fresh evidence');
  assert.deepEqual({ ...gateFor(r, 'jim') }, { evidence: 'POST_RESET_PROBE_SPENT', holds: true, basis: ADMISSION_REASON.POST_RESET_PROBE_SPENT });
  elapse(r, 3_600_000);
  assert.equal((await r.settle(wake(r, 'hour-later'))).kind, 'REFUSED', 'an hour on, with no new reading, it is STILL refused: no timer re-arms the probe');
  assert.equal(r.writes.filter((d) => d === '\r').length, 1, 'exactly one Enter ever went out on this evidence');
};

K1A.aLaterPassedResetIsANewProbe = async (classes) => {
  const r = spentAndStale(classes);
  passTheReset(r);
  assert.equal((await r.settle(wake(r, 'probe-1'))).kind, 'COMMITTED');
  const firstKey = r.tracker.postResetProbeKey(POOL);
  // Fresh evidence: spent AGAIN, with a LATER reset. Then stale, then that reset passes too.
  const laterReset = r.now + 3_600_000;
  r.runtime.ingest('jim', obs({ observedAt: r.now, receivedAt: r.now, sourceSequence: 2, windows: [{ ...win(0), resetsAt: laterReset }] }));
  assert.equal(r.state(), 'RESERVE_ONLY', 'fresh evidence restores the ordinary behaviour at once');
  assert.equal((await r.settle(wake(r, 'while-spent'))).kind, 'REFUSED');
  elapse(r, laterReset - r.now + 60_000);
  assert.notEqual(r.tracker.postResetProbeKey(POOL), firstKey, 'a different reading and a different reset: a different key');
  assert.equal((await r.settle(wake(r, 'probe-2'))).kind, 'COMMITTED', 'a LATER passed reset on NEWER evidence is allowed its own single probe');
  assert.equal((await r.settle(wake(r, 'probe-2b'))).kind, 'REFUSED', 'and only one');
};

K1A.postProbeDeliveryStillUndergoesFinalRevalidation = async (classes) => {
  const r = spentAndStale(classes);
  passTheReset(r);
  r.onStaged = () => { r.at(40, () => r.runtime.ingest('jim', limited(r, 2))); };
  const out = await r.settle(wake(r, 'probe'));
  assert.equal(out.kind, 'ABORTED', 'POST-RESET DELIVERY STILL UNDERGOES FINAL REVALIDATION: a refusal in the gap stops it');
  assert.deepEqual(r.record, ['abort:LIMITED'], 'abort:LIMITED - and no Enter');
};

K1A.aNewLimitedObservationImmediatelyRestoresTheHold = async (classes) => {
  const r = spentAndStale(classes);
  passTheReset(r);
  assert.equal(gateFor(r, 'jim').holds, false, 'precondition: the probe is on offer');
  r.runtime.ingest('jim', limited(r, 2));
  assert.equal(r.state(), 'LIMITED');
  assert.equal(gateFor(r, 'jim').holds, true, 'A NEW LIMITED OBSERVATION IMMEDIATELY RESTORES THE HOLD');
  assert.equal(r.tracker.postResetProbeKey(POOL), null, 'and the probe is off the table');
  assert.deepEqual(r.writes, []);
  assert.equal((await r.settle(wake(r, 'after-limit'))).kind, 'REFUSED');
};

K1A.aNewHealthyObservationRestoresNormalFreshHealthBehaviour = async (classes) => {
  const r = spentAndStale(classes);
  passTheReset(r);
  assert.equal((await r.settle(wake(r, 'probe'))).kind, 'COMMITTED');
  r.runtime.ingest('jim', healthy(r, 2));
  assert.equal(r.state(), 'AVAILABLE');
  assert.deepEqual({ ...gateFor(r, 'jim') }, { evidence: 'FRESH_HEALTHY', holds: false, basis: ADMISSION_REASON.AVAILABLE },
    'A NEW HEALTHY OBSERVATION RESTORES NORMAL FRESH-HEALTH BEHAVIOUR - measured, not manufactured');
  for (const id of ['h1', 'h2', 'h3']) { elapse(r, 2_000); assert.equal((await r.settle(wake(r, id))).kind, 'COMMITTED', `${id}: no single-probe limit on a healthy pool`); }
};

K1A.theProbeFacesEveryHumanInterferenceGate = async (classes) => {
  const r = spentAndStale(classes);
  passTheReset(r);
  r.session.promptState = { block: 'draft' };
  assert.deepEqual([(await r.settle(wake(r, 'onto-a-draft'))).kind, r.writes], ['REFUSED', []], 'a human draft refuses the probe: nothing typed');
  r.session.promptState = { block: null };
  r.onStaged = () => { r.at(40, () => { r.session.gen += 1; r.session.lastHumanAt = r.now; r.prompt += 'x'; }); };
  const out = await r.settle(wake(r, 'probe'));
  assert.deepEqual([out.kind, out.reason], ['INTERFERED', 'HUMAN_INPUT_AFTER_STAGE'], 'a human in the gap: INTERFERED, no Enter');
  assert.equal(r.writes.includes('\r'), false);
  assert.equal(r.runtime.admission.probe('jim', 'ORDINARY_TURN').reason, ADMISSION_REASON.POST_RESET_PROBE_SPENT,
    'and the probe is IN SUSPENSE with the hold - not handed to someone else');
  assert.equal(r.owner.resolveInterference('pty-jim', 'SEND_AGAIN'), true);
  assert.equal(r.runtime.admission.probe('jim', 'ORDINARY_TURN').reason, ADMISSION_REASON.POST_RESET_PROBE_GRANT,
    '"send queued message" gives the ONE probe back; it was never used');
};

/** The single post-reset probe, INTERFERED by a human in the gap. Returns the rig mid-hold. */
async function interferedProbe(classes) {
  const r = spentAndStale(classes);
  passTheReset(r);
  r.onStaged = () => { r.at(40, () => { r.session.gen += 1; r.session.lastHumanAt = r.now; r.prompt += 'x'; }); };
  const out = await r.settle(wake(r, 'probe'));
  assert.deepEqual([out.kind, out.reason], ['INTERFERED', 'HUMAN_INPUT_AFTER_STAGE'], 'precondition: the one probe was interfered with');
  r.onStaged = null;
  return r;
}
const probeReason = (r) => r.runtime.admission.probe('jim', 'ORDINARY_TURN').reason;

K1A.aDeadTerminalSpendsTheProbeAndOnlyAFreshReadingLiftsIt = async (classes) => {
  // EXIT 4 (unproven list, 13c) - STATED AS FACT, NOT FIXED. Ruling (b): a hold that outlives
  // its terminal is SPENT, because nobody can say whether Enter was pressed. For this grant
  // that can strand the pool: if no turn ran, no reading comes and the key never changes.
  // Returning the probe instead would risk a SECOND probe, which is the direction A15 says
  // not to fail in.
  const r = await interferedProbe(classes);
  r.session = { ...r.session, incarnation: 2, gen: 0, lastHumanAt: undefined, promptState: { block: null } }; // died, respawned
  r.prompt = '';
  assert.equal(r.owner.inhibition('pty-jim'), null, 'the hold does not outlive its terminal');
  assert.equal(probeReason(r), ADMISSION_REASON.POST_RESET_PROBE_SPENT, 'TERMINAL DEATH SPENDS THE HELD PROBE - it is not handed back');
  elapse(r, TEN_MINUTES);
  const again = await r.settle(wake(r, 'after-death'));
  assert.deepEqual([again.kind, again.reason, r.writes.filter((d) => d === '\r').length], ['REFUSED', 'CAPACITY_HOLD', 0],
    'NO SECOND PROBE goes out on the same evidence: automatic delivery stays held, ten minutes on');
  assert.deepEqual({ ...gateFor(r, 'jim') }, { evidence: 'POST_RESET_PROBE_SPENT', holds: true, basis: ADMISSION_REASON.POST_RESET_PROBE_SPENT });
  // The way out: a fresh accepted reading from ANY agent on the pool - not only this one.
  r.runtime.ingest('dwight', healthy(r, 2));
  assert.equal(gateFor(r, 'jim').evidence, 'FRESH_HEALTHY', 'A FRESH READING FROM ANOTHER AGENT ON THE POOL LIFTS IT');
  assert.equal((await r.settle(wake(r, 'lifted'))).kind, 'COMMITTED');
};

K1A.alreadyHandledSpendsTheProbeAndTheHumansOwnReadingEndsIt = async (classes) => {
  // EXIT 2. "Already handled" CONFIRMS the probe as spent; the person's own submitted turn
  // is a real turn on the pool and produces the reading that ends POST_RESET_PROBE_SPENT.
  const r = await interferedProbe(classes);
  assert.equal(r.owner.resolveInterference('pty-jim', 'ALREADY_HANDLED'), true);
  r.prompt = ''; r.session.promptState = { block: null };
  elapse(r, TEN_MINUTES);
  assert.equal(probeReason(r), ADMISSION_REASON.POST_RESET_PROBE_SPENT, '"already handled" CONFIRMS the probe: spent for good on this evidence, reservation TTL or not');
  assert.equal((await r.settle(wake(r, 'still-held'))).kind, 'REFUSED');
  r.runtime.ingest('jim', healthy(r, 2)); // the reading the human's own turn produced
  assert.equal(gateFor(r, 'jim').evidence, 'FRESH_HEALTHY', 'the human\u2019s own turn\u2019s reading ends the state');
  assert.equal((await r.settle(wake(r, 'after-reading'))).kind, 'COMMITTED');
};

for (const [name, killer] of Object.entries(K1A)) test(`L0-UNKNOWN 1a: ${name}`, () => killer({}));

KR.ownPostResetProbeIsNotARefusal = (Runtime) => { // the carve-out, for the probe's own claim
  const r = spentAndStale({ Runtime });
  passTheReset(r);
  const decision = r.runtime.admit('jim');
  assert.deepEqual([decision.verdict, decision.reason, !!decision.grantId], ['ALLOW', ADMISSION_REASON.POST_RESET_PROBE_GRANT, true]);
  const claim = { decision, agentId: 'jim', workClass: 'ORDINARY_TURN', target: 'pty-jim' };
  assert.equal(r.runtime.admission.probe('jim', 'ORDINARY_TURN').verdict, 'REFUSE', 'the pool now refuses everyone...');
  assert.deepEqual(r.runtime.revalidate(claim, 'pty-jim'), { verdict: 'ALLOW', reason: ADMISSION_REASON.POST_RESET_PROBE_GRANT },
    '...because of THIS claim - and that is not a refusal of it (or no probe could ever pass its own final revalidation)');
  const stranger = r.runtime.admit('jim');
  assert.equal(r.runtime.revalidate({ ...claim, decision: stranger }, 'pty-jim').verdict, 'REFUSE', 'a claim that does not hold the probe is refused');
};

test('TOCTOU on revalidate: ownPostResetProbeIsNotARefusal', () => KR.ownPostResetProbeIsNotARefusal(CapacityRuntime));

const POST_RESET_MUTANTS = [
  // (Simply DROPPING `held.confirmed = true` is an EQUIVALENT mutant on this path and was
  // tried first: the grant is already exempt from the TTL as held-for-human, so nothing
  // observable changes. The defect that matters is a resolution that releases the human
  // hold WITHOUT confirming - the reservation is then abandoned after 60 s and a second
  // probe goes out.)
  { name: '"already handled" releases the human hold without confirming the launch',
    edits: [['    held.confirmed = true;\n', '    held.heldForHuman = false;\n']],
    killer: 'alreadyHandledSpendsTheProbeAndTheHumansOwnReadingEndsIt', dies: /CONFIRMS the probe: spent for good/ },
  { name: 'the probe is never spent',
    edits: [['            if (held && held.epoch === POST_RESET_EPOCH && held.probeKey === probeKey && !this.abandoned(held)) {', '            if (false) {']],
    killer: 'oneProbePerPassedReset', dies: /ONE PROBE PER PASSED RESET/ },
  { name: 'one probe for ever: a later reset on newer evidence is refused too',
    edits: [['held.epoch === POST_RESET_EPOCH && held.probeKey === probeKey && !this.abandoned(held)', 'held.epoch === POST_RESET_EPOCH && !this.abandoned(held)']],
    killer: 'aLaterPassedResetIsANewProbe', dies: /a LATER passed reset on NEWER evidence/ },
  { name: 'the probe is granted without being reserved',
    edits: [['    if (decision.reason === ADMISSION_REASON.POST_RESET_PROBE_GRANT && decision.poolKey) {', '    if (false) {']],
    killer: 'oneProbePerPassedReset', dies: /ONE PROBE PER PASSED RESET/ },
  { name: 'the probe is offered before the reset has passed',
    edits: [['          if (probeKey !== null) {', '          if (true) {']],
    killer: 'aPassedKnownResetExitsTheHoldAsItsOwnState', dies: /before the reset the pool is simply held/ }
];

test('MUTANT (automaticSubmit.ts): terminal death RETURNING the held probe lets a SECOND probe go out', async () => {
  const from = '      if (held.decision) this.deps.capacity.confirmLaunch(held.decision);\n      if (this.known';
  const source = read('src/main/automaticSubmit.ts');
  assert.equal(source.split(from).length - 1, 1, 'the edit target matches EXACTLY ONCE');
  await K1A.aDeadTerminalSpendsTheProbeAndOnlyAFreshReadingLiftsIt({});
  const dir = RUNTIME_MUTANT_DIR + '-own';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const text = source.replace(from, () => '      if (held.decision) this.deps.capacity.cancelGrant(held.decision);\n      if (this.known')
      .replace(/from '\.\/(\w+)'/g, "from '../../src/main/$1'").replace(/from '\.\.\/shared\//g, "from '../../src/shared/");
    const file = path.join(dir, 'o0.ts');
    fs.writeFileSync(file, text, 'utf8');
    const Owner = loadTs(path.relative(path.resolve(__dirname, '..'), file)).AutomaticSubmitOwner;
    let died = null;
    try { await K1A.aDeadTerminalSpendsTheProbeAndOnlyAFreshReadingLiftsIt({ Owner }); } catch (e) { died = e; }
    assert.ok(died instanceof assert.AssertionError, `must die by ASSERTION, got: ${died && died.stack}`);
    assert.match(died.message, /TERMINAL DEATH SPENDS THE HELD PROBE|NO SECOND PROBE goes out/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MUTANT CENSUS (capacityAdmission, the post-reset probe): every mutant applies exactly once and dies at the named assertion', async (t) => {
  const source = read('src/main/capacityAdmission.ts');
  const dir = RUNTIME_MUTANT_DIR + '-adm';
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const [i, mutant] of POST_RESET_MUTANTS.entries()) {
      await t.test(`mutant: ${mutant.name}`, async () => {
        await K1A[mutant.killer]({});
        let text = source;
        for (const [from, to] of mutant.edits) {
          const hits = text.split(from).length - 1;
          assert.equal(hits, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE, matched ${hits}`);
          text = text.replace(from, () => to);
        }
        text = text.replace(/from '\.\/(\w+)'/g, "from '../../src/main/$1'").replace(/from '\.\.\/shared\//g, "from '../../src/shared/");
        const file = path.join(dir, `p${i}.ts`);
        fs.writeFileSync(file, text, 'utf8');
        const Admission = loadTs(path.relative(path.resolve(__dirname, '..'), file)).CapacityAdmission;
        let died = null;
        try { await K1A[mutant.killer]({ Admission }); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong assertion`);
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UNNAMED CASE (c): stale after a refusal with NO known reset time holds with no exit', async () => {
  const r = rig();
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', limited(r, 2, { windows: [{ ...win(0), resetsAt: null }] }));
  assert.equal(r.state(), 'LIMITED');
  elapse(r, 7 * 24 * 60 * 60 * 1000);
  assert.equal(r.state(), 'LIMITED', 'a week on: no reset boundary was ever known, so no RECOVERING hint can fire');
  assert.deepEqual({ ...gateFor(r, 'jim') }, { evidence: 'LIMITED_NO_KNOWN_RESET', holds: true, basis: ADMISSION_REASON.LIMITED },
    '"limited, no known reset" is shown as its own state - and is STILL held');
  assert.equal((await r.settle(wake(r))).kind, 'REFUSED');
});

test('UNNAMED CASE (d): a reset already in the PAST when the refusal is first seen is not news about it', async () => {
  // The tracker's existing rule (L0-SEM 11.1): the provider refused KNOWING that boundary,
  // so it cannot be the recovery hint for this refusal.
  const r = rig();
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', limited(r, 2, { windows: [{ ...win(0), resetsAt: r.now - 60_000 }] }));
  elapse(r, 10 * 60_000);
  assert.equal(r.state(), 'LIMITED', 'not RECOVERING: a boundary already passed at the refusal is excluded');
});

test('UNNAMED CASE (e): with several windows, the ATTRIBUTED window governs, then the spent ones, then the earliest', async () => {
  const weekly = { windowId: 'weekly', kind: 'WEEKLY', label: '7d', windowMinutes: 10_080, usedPercent: 100, remainingPercent: 0, resetsAt: T0 + 5 * 24 * 3_600_000 };
  const r = rig();
  r.runtime.ingest('jim', obs());
  // Both windows spent; the provider ATTRIBUTES the refusal to the weekly one.
  r.runtime.ingest('jim', limited(r, 2, { windows: [win(0), weekly], providerAttributedLimitingWindowId: 'weekly' }));
  elapse(r, RESET_AT - r.now + 60_000);
  assert.equal(r.state(), 'LIMITED', 'the five-hour reset passed, but the WEEKLY window is the one that refused');
  elapse(r, weekly.resetsAt - r.now + 60_000);
  assert.equal(r.state(), 'RECOVERING', 'the attributed window\u2019s reset is the one that governs');
});

test('L0-UNKNOWN: the control snapshot is computed through the ONE resolver, and carries the evidence', () => {
  const index = read('src/main/index.ts');
  const handler = index.slice(index.indexOf("ipcMain.handle('control:snapshot'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.match(body, /const probed = providerCapacity\.admission\.probe\(agentId, 'ORDINARY_TURN'\);/);
  assert.match(body, /probed\.poolKey \? providerCapacity\.tracker\.pool\(probed\.poolKey\)\?\.freshness \?\? null : null,/,
    'the pool\u2019s own published freshness chooses between labels; it never changes `holds`');
  assert.match(body, /probed\.poolKey \? providerCapacity\.tracker\.resetOutlook\(probed\.poolKey\) : null\)/,
    'and the TRACKER answers whether a hold can end by itself - the handler does not re-derive it');
  assert.match(body, /capacityHold: gate\.holds, capacityEvidence: gate\.evidence/);
  assert.ok(!/providerCapacity\.holds\(/.test(index), 'index.ts no longer reads the boolean collapse at all');
});

test('L0-UNKNOWN: send-now and boot prompts do not consult the capacity mapping anywhere', async () => {
  // The ruling: "This does not alter the separately approved narrow boot/send-now treatment
  // unless those paths explicitly consult this automatic-delivery admission mapping."
  // They do not: ASKS_CAPACITY is false for both, so the seam is never asked.
  for (const admissionClass of ['USER_RELEASED', 'BOOT_SEQUENCE']) {
    const r = rig();
    r.runtime.ingest('jim', obs());
    elapse(r, L0_SEM_POLICY.liveTtlMs + 1_000);
    assert.equal(r.state(), 'UNKNOWN');
    let asked = 0;
    for (const m of ['admit', 'probe']) {
      const real = r.runtime.admission[m].bind(r.runtime.admission);
      r.runtime.admission[m] = (...a) => { asked += 1; return real(...a); };
    }
    const out = await r.settle(r.owner.submit({ requestId: `x-${admissionClass}`, agentId: 'jim', admissionClass, text: 'hello there' }));
    assert.equal(out.kind, 'COMMITTED', `${admissionClass} is delivered under an INDETERMINATE pool`);
    assert.equal(asked, 0, `${admissionClass} never asks the admission seam, so the mapping cannot reach it`);
  }
});

// ─── The fail-closed READY gate, through the real tables and predicates ───────────────

test('READY: an unmeasured provider stages nothing for automatic delivery', async () => {
  for (const provider of ['grok', 'kimi', 'gemini', 'qwen', 'opencode', 'crush', 'pi', 'copilot', 'cursor', 'custom', undefined]) {
    const r = rig({ provider });
    r.runtime.ingest('jim', obs());
    const out = await r.settle(wake(r));
    assert.deepEqual(r.writes, [], `${provider}: nothing staged`);
    assert.equal(out.reason, 'PROVIDER_ABORT_UNVERIFIED', `${provider}: refused for want of a MEASURED abort`);
  }
});

test('the abort-capability table: three MEASURED rows, everything else UNKNOWN, and it is TOTAL', () => {
  const MEASURED = ['claude', 'codex', 'antigravity'];
  for (const p of MEASURED) {
    assert.deepEqual(automaticAbortCapability(p), { kind: 'MEASURED', clearControl: '\x15', settleMs: 900 }, p);
  }
  // TOTAL against the provider union, read from the union's own source rather than from
  // a list this test would have to be told about.
  const union = read('src/shared/agentProvider.ts').match(/export type AgentProvider =([\s\S]*?);/)[1];
  const providers = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(providers.length >= 13, 'the union was found');
  const table = read('src/shared/providerAutomation.ts').split('const AUTOMATIC_ABORT_CAPABILITY')[1].split('};')[0];
  for (const p of providers) {
    assert.match(table, new RegExp(`\\n  ${p}: (MEASURED_CTRL_U|ABORT_UNKNOWN)`), `${p} has a decided row`);
    if (!MEASURED.includes(p)) assert.equal(automaticAbortCapability(p).kind, 'UNKNOWN', `${p} is UNKNOWN`);
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

// ─── Stage 5.3: the renderer holds NO programmatic submit capability ──────────────────

const nodeFs = require('node:fs');
const nodePath = require('node:path');
/** Source with its comments removed. An ABSENCE check must look at code: the files that
 *  removed a thing are exactly the files whose comments explain that it was removed. */
// `codeOnly` is the PARSER-BASED stripper from read-source.cjs. The regex pair that stood
// here until stage 5.5a swallowed ~2000 lines of index.ts as one comment (a `/*` inside a
// string), so every absence check over index.ts was looking at half a file.

/** Every .ts/.tsx under a subtree, so a census cannot be dodged by adding a new file. */
function walkSrc(rel) {
  const out = [];
  for (const ent of nodeFs.readdirSync(nodePath.join(__dirname, '..', rel), { withFileTypes: true })) {
    const child = `${rel}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walkSrc(child));
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(child);
  }
  return out;
}

/** THE BARE-ENTER WALK. It looks for a line that writes a lone carriage return SPELLED AS A
 *  LITERAL. Widened in stage 5.5a to the spellings Dwight showed the first version missed
 *  ('\r', '\x0d', '\u000d', '\u{d}', String.fromCharCode(13)) - and it STILL cannot see a
 *  named constant, a computed string, or an Enter on the end of a longer payload. */
const BARE_ENTER = /(write|writePty|safeWrite)\w*\([^)]*(['"`]\\(r|x0[dD]|u000[dD]|u\{0*[dD]\})['"`]|String\.fromCharCode\(\s*(13|0x0?[dD])\s*\))\s*(,[^)]*)?\)/;
function bareEnterWriters(readFile) {
  const writers = [];
  for (const f of walkSrc('src')) {
    readFile(f).split('\n').forEach((line, i) => { if (BARE_ENTER.test(line)) writers.push(`${f}:${i + 1}`); });
  }
  return writers;
}

test('TRIPWIRE, NOT THE GUARANTEE: a bare Enter is SPELLED in exactly two places, and one is a declared private PTY', () => {
  // WHAT THIS IS WORTH (Dwight, validating stage 5.3): it proves a LITERAL CONVENTION and
  // no more. A regex over the DATA argument cannot enumerate the ways to spell a carriage
  // return, so it can never carry the design's closing claim (section 10: "no current
  // automatic caller uses raw Enter, by exhaustive call-graph"). That claim is carried by
  // the CALLEE census below, which enumerates who can write to an agent terminal AT ALL
  // and is indifferent to how the data is spelled. This walk stays as a cheap tripwire
  // for the ordinary case - someone pasting `write(id, '\r')` somewhere new.
  const writers = bareEnterWriters(read);
  const files = writers.map((w) => w.split(':')[0]).sort();
  assert.deepEqual(files, ['src/main/automaticSubmit.ts', 'src/main/hiddenClaude.ts'],
    `a bare Enter is written ONLY by the submit owner and by hiddenClaude's private PTY; found ${writers.join(', ')}`);
  // The owner's one Enter is inside the critical section, nowhere else.
  const owner = read('src/main/automaticSubmit.ts');
  const section = owner.slice(owner.indexOf('export function commitSection('));
  assert.ok(section.slice(0, section.indexOf('\n}\n')).includes("safeWrite(deps, s.ptyId, '\\r')"), 'and the owner writes it inside commitSection');
  // The exclusion is DECLARED where it lives, not merely tolerated here.
  const hidden = read('src/main/hiddenClaude.ts');
  assert.match(hidden, /NOT routed through the main-owned submit transaction, and\s+\/\/ deliberately: this is a PRIVATE, hidden, single-use PTY/);
  assert.ok(!/ptyManager/.test(codeOnly(hidden)), 'hiddenClaude never touches an AGENT terminal: its code has no reference to ptyManager at all');
});

// ─── THE CALLEE CENSUS: who can write to an agent terminal AT ALL (design section 10) ───
//
// Indifferent to how the data is spelled, because it never looks at the data. It
// enumerates RECEIVERS: every `<receiver>.write(` call in main and preload, code only.
//   - a receiver that is a PTY is pinned to an exact file and an exact COUNT;
//   - a receiver that is not a PTY must be on a per-file allowlist written out here;
//   - a `write` taken as a value, or reached by a computed name, is refused outright;
//   - ANY OTHER RECEIVER FAILS THE CENSUS, so a new writer has to be classified by a person.
// Around it: node-pty is imported by exactly two files; the PTY manager is never aliased;
// the raw process write exists once, inside a method whose signature REQUIRES an origin;
// the 'pty:write' channel has one sender and one handler; the owner writes at three named
// points. The renderer's six `writePty` sites and the single PROGRAMMATIC producer are
// pinned in test/input-provenance.test.cjs and are not repeated here.
//
// KNOWN LIMIT, stated rather than hoped away: a PTY smuggled in under an allowlisted
// non-PTY NAME (a variable called `stream` that is really the manager) is invisible to a
// census of names. The no-alias and node-pty-importer checks are what stand in its way.
const PTY_WRITERS = {
  'src/main/pty.ts': { 's.proc': 1 },                       // THE raw write, inside write(id, data, origin)
  'src/main/index.ts': { ptyManager: 1 },                   // the pty:write handler (renderer origin; PROGRAMMATIC refused)
  'src/main/automaticSubmitWiring.ts': { 'w.pty': 1 },      // the ONLY PROGRAMMATIC producer
  'src/main/automaticSubmit.ts': { deps: 1 },               // safeWrite - the owner's one write
  'src/main/hiddenClaude.ts': { ptyProc: 2 }                // a PRIVATE hidden PTY, declared, never an agent's
};
const NON_PTY_WRITERS = {
  'src/main/index.ts': ['stream', 'roster'],                // a download stream; the roster file
  'src/main/slack.ts': ['req']                              // an https request body
};

/** Parsed, not pattern-matched. A first version stripped comments with a regex and then
 *  searched the text - and a `/*` inside a STRING in index.ts swallowed two thousand lines
 *  of real code, `ptyManager.write(` among them: a census that silently could not see the
 *  thing it counts. The TypeScript AST has no such blind spot: a string is a string, a
 *  comment is trivia, and a call is a call. (Generated hook scripts in hive.ts are string
 *  CONTENT, not calls main makes, and are correctly not counted.) */
const tsc = require('typescript');
function walkAst(file, text, visit) {
  const sf = tsc.createSourceFile(file, text, tsc.ScriptTarget.ES2022, true, file.endsWith('x') ? tsc.ScriptKind.TSX : tsc.ScriptKind.TS);
  const go = (node) => { visit(node, sf); tsc.forEachChild(node, go); };
  go(sf);
}

/** @param readFile (relPath) => source. The census takes its reader so a mutant can be
 *  handed to it as an overlay; it asserts, and returns nothing. */
function calleeCensus(readFile) {
  const files = [...walkSrc('src/main'), ...walkSrc('src/preload')];
  const found = {};
  const importers = [];
  const channel = [];
  let bareManager = 0;
  let safeWrites = 0;
  let managerWrite = null;
  for (const f of files) {
    walkAst(f, readFile(f), (node, sf) => {
      const named = (n) => (tsc.isPropertyAccessExpression(n) && n.name.text === 'write')
        || (tsc.isElementAccessExpression(n) && tsc.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'write');
      if (named(node)) {
        const called = tsc.isCallExpression(node.parent) && node.parent.expression === node;
        assert.ok(called && tsc.isPropertyAccessExpression(node),
          `CALLEE CENSUS: ${f}: \`${node.getText(sf)}\` is a write taken as a VALUE or reached by a computed name (alias, bind, call, apply) - invisible to a census of calls, so it is refused outright`);
        const receiver = node.expression.getText(sf).replace(/\s+/g, '');
        (found[f] ??= {})[receiver] = ((found[f] ?? {})[receiver] ?? 0) + 1;
      }
      if (tsc.isStringLiteralLike(node)) {
        if (node.text === 'node-pty' && (tsc.isImportDeclaration(node.parent) || tsc.isCallExpression(node.parent) || tsc.isExternalModuleReference(node.parent))) importers.push(f);
        if (node.text === 'pty:write') channel.push(f);
      }
      if (f === 'src/main/index.ts' && tsc.isIdentifier(node) && node.text === 'ptyManager'
        && !(tsc.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) bareManager += 1;
      if (f === 'src/main/automaticSubmit.ts' && tsc.isCallExpression(node) && tsc.isIdentifier(node.expression) && node.expression.text === 'safeWrite') safeWrites += 1;
      if (f === 'src/main/pty.ts' && tsc.isMethodDeclaration(node) && node.name.getText(sf) === 'write'
        && tsc.isClassDeclaration(node.parent) && node.parent.name?.text === 'PtyManager') managerWrite = { node, sf };
    });
  }
  for (const [f, receivers] of Object.entries(found)) {
    for (const [receiver, count] of Object.entries(receivers)) {
      const pinned = PTY_WRITERS[f]?.[receiver];
      if (pinned !== undefined) { assert.equal(count, pinned, `CALLEE CENSUS: ${f} writes to the PTY receiver \`${receiver}\` ${count}x, pinned at ${pinned}x - a NEW WRITER TO A TERMINAL must go through the submit owner`); continue; }
      assert.ok((NON_PTY_WRITERS[f] ?? []).includes(receiver), `CALLEE CENSUS: unclassified writer \`${receiver}.write(\` in ${f} (${count}x) - say what it writes to before it ships`);
    }
  }
  for (const [f, receivers] of Object.entries(PTY_WRITERS)) {
    for (const receiver of Object.keys(receivers)) assert.ok(found[f]?.[receiver], `CALLEE CENSUS: the pinned writer \`${receiver}\` is still in ${f} (a stale pin proves nothing)`);
  }
  for (const [f, receivers] of Object.entries(NON_PTY_WRITERS)) {
    for (const receiver of receivers) assert.ok(found[f]?.[receiver], `CALLEE CENSUS: the allowlisted non-PTY writer \`${receiver}\` is still in ${f} (a stale allowance is a hole waiting for a name)`);
  }
  assert.deepEqual([...new Set(importers)].sort(), ['src/main/hiddenClaude.ts', 'src/main/pty.ts'], 'CALLEE CENSUS: only these two files can hold a PTY process at all');
  assert.equal(bareManager, 2, 'CALLEE CENSUS: the PTY manager appears as a bare value exactly twice in index.ts - its construction and its hand-off to the owner wiring - so it is never aliased');
  assert.deepEqual(channel.sort(), ['src/main/index.ts', 'src/preload/index.ts'], "CALLEE CENSUS: 'pty:write' is named once by its handler and once by its sender");
  assert.equal(safeWrites, 3, 'CALLEE CENSUS: the owner writes at exactly three points - the payload, the Enter, the measured clear');
  assert.ok(managerWrite, 'CALLEE CENSUS: PtyManager.write exists');
  const params = managerWrite.node.parameters;
  assert.equal(params.length, 3);
  assert.ok(params[2].name.getText(managerWrite.sf) === 'origin' && !params[2].questionToken && !params[2].initializer,
    'CALLEE CENSUS: PtyManager.write REQUIRES an origin - not optional, no default');
  assert.ok(managerWrite.node.body.getText(managerWrite.sf).includes('s.proc.write(data)'), 'CALLEE CENSUS: and the one raw process write is inside it');
}

test('codeOnly is PARSER-BASED: a `/*` inside a line comment or a string swallows no code (the stage-5.5a blind spot)', () => {
  // The exact shape that blinded the regex stripper: `google/*` in a LINE comment opened a
  // fake block comment, and the next real `*/` was 399 lines later.
  const sample = [
    '// inject both so google/* authenticates',
    'ptyManager.write(id, data, origin);',
    "const glob = 'src/**/*.ts';",
    '/* a real block comment */ const kept = 1; // a real tail comment */',
    'const after = 2;'
  ].join('\n');
  const code = codeOnly(sample, 'sample.ts');
  for (const kept of ['ptyManager.write(id, data, origin);', "'src/**/*.ts'", 'const kept = 1;', 'const after = 2;']) {
    assert.ok(code.includes(kept), `real code survives: ${kept}`);
  }
  for (const gone of ['google', 'a real block comment', 'a real tail comment']) assert.ok(!code.includes(gone), `comment text is gone: ${gone}`);
  assert.equal(code.split('\n').length, sample.split('\n').length, 'and line numbers survive');
  const regexPair = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.ok(!regexPair(sample).includes('ptyManager.write('), 'the regex pair this replaced DID swallow the write - which is why it was replaced');
});

test('CALLEE CENSUS (section 10): every call that can write to an agent terminal is enumerated, with who it is', () => {
  calleeCensus(read);
});

// Dwight's four spellings of Enter, each as a NEW AUTOMATIC WRITER outside the owner. The
// point of the pair of assertions: the literal walk is BLIND to three of the four (which
// is why it is only a tripwire), and the callee census kills all four without ever
// reading the data.
const ENTER_SPELLINGS = [
  { name: "'\\x0d'", code: "ptyManager.write(id, '\\x0d', 'CONTROL');", walkSees: true },
  { name: "'\\u000d'", code: "ptyManager.write(id, '\\u000d', 'CONTROL');", walkSees: true },
  { name: 'String.fromCharCode(13)', code: "ptyManager.write(id, String.fromCharCode(13), 'CONTROL');", walkSees: true },
  { name: 'a named constant', code: "ptyManager.write(id, SUBMIT_KEY, 'CONTROL');", walkSees: false },
  { name: 'Enter on the end of a payload', code: "ptyManager.write(id, text + ENTER, 'CONTROL');", walkSees: false },
  { name: 'an aliased manager', code: "const sink = ptyManager; sink.write(id, SUBMIT_KEY, 'CONTROL');", walkSees: false }
];
for (const spelling of ENTER_SPELLINGS) {
  test(`CALLEE CENSUS mutant: a new automatic Enter spelled as ${spelling.name} dies at the census`, () => {
    const anchor = "ipcMain.handle('autoSubmit:submit', ";
    const real = read('src/main/index.ts');
    assert.equal(real.split(anchor).length - 1, 1, 'the mutant insertion point matches EXACTLY ONCE');
    const mutated = real.replace(anchor, () => `function rogueWake(id: string, text: string): void { ${spelling.code} }\n${anchor}`);
    const overlay = (f) => (f === 'src/main/index.ts' ? mutated : read(f));
    assert.equal(bareEnterWriters(overlay).some((w) => w.startsWith('src/main/index.ts:')), spelling.walkSees,
      `the literal walk ${spelling.walkSees ? 'sees' : 'is BLIND to'} this spelling - which is exactly why it is a tripwire and not the guarantee`);
    assert.throws(() => calleeCensus(overlay), (e) => e instanceof assert.AssertionError && /CALLEE CENSUS/.test(e.message),
      'and the callee census kills it without reading the data at all');
  });
}

test('the renderer cannot type programmatically: no chain, no order, no ticket, no raw submit', () => {
  const hive = read('src/renderer/src/hooks/useHive.ts');
  for (const gone of ['writeChains', 'waitForTerminalReady', 'readyPids', 'typeAndSubmit(', 'capacityBeginAutoDelivery',
    'capacityMarkAutoDeliveryWriting', 'capacitySettleAutoDelivery', 'function submitToPty', '.writePty(']) {
    assert.ok(!codeOnly(hive).includes(gone), `useHive.ts code no longer contains \`${gone}\``);
  }
  assert.equal(hive.split('window.cth.autoSubmit(').length - 1, 2,
    'exactly two asks of main: the boot-prompt helper and the queue drain');
  assert.match(hive, /admissionClass: next\.manual \? 'USER_RELEASED' : 'CAPACITY_GATED'/, 'send-now is a DECLARED class, not a fall-through');
  assert.match(hive, /admissionClass: 'BOOT_SEQUENCE'/);
  assert.match(hive, /requestId: `queue:\$\{srcId\}:\$\{next\.id\}`/, 'a queue item is asked under its OWN stable id: at most once');
  // The acknowledgement is reachable only from a COMMIT.
  assert.match(hive, /if \(outcome\.kind !== 'COMMITTED'\) throw new Error\(outcome\.kind\);/);
  // INTERFERED is held: it must not fall into the attempt counter that DROPS a message.
  const held = hive.indexOf("if (outcome.kind === 'INTERFERED') {");
  const counter = hive.indexOf('const attempts = (sendFailures[next.id] ?? 0) + 1;');
  assert.ok(held > 0 && counter > held, 'INTERFERED returns before the drop-after-N-failures counter');
  assert.ok(hive.slice(held, counter).includes('return { sent: false };'));

  const queue = read('src/renderer/src/hooks/queueDelivery.ts');
  assert.ok(!/typeAndSubmit|SubmitSteps|writeSubmit/.test(codeOnly(queue)), 'the renderer submit order is removed, not wrapped');
  const preload = read('src/preload/index.ts');
  for (const gone of ['capacity:beginAutoDelivery', 'capacity:markAutoDeliveryWriting', 'capacity:settleAutoDelivery', 'CapacityDeliveryGrant']) {
    assert.ok(!codeOnly(preload).includes(gone), `preload no longer exposes \`${gone}\``);
  }
  assert.match(preload, /ipcRenderer\.invoke\('autoSubmit:submit', req\)/);
});

test("main's pty:write REFUSES renderer-origin PROGRAMMATIC, before anything is written", () => {
  const index = read('src/main/index.ts');
  const handler = index.slice(index.indexOf("ipcMain.handle('pty:write'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  const refuse = body.indexOf("if (origin === 'PROGRAMMATIC') return { ok: false, error: 'origin not permitted on this channel' };");
  const write = body.indexOf('ptyManager.write(');
  assert.ok(refuse > 0 && write > refuse, 'the refusal sits BEFORE the only write in the handler');
  for (const gone of ["'capacity:beginAutoDelivery'", "'capacity:markAutoDeliveryWriting'", "'capacity:settleAutoDelivery'"]) {
    assert.ok(!index.includes(`ipcMain.handle(${gone}`), `${gone} is no longer handled`);
  }
});

test('the one door: autoSubmit:submit names an AGENT and a CLASS, never a PTY', () => {
  const index = read('src/main/index.ts');
  const handler = index.slice(index.indexOf("ipcMain.handle('autoSubmit:submit'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.ok(!/ptyId/.test(body), 'a renderer cannot name the terminal: main resolves it (design section 7)');
  assert.match(body, /\(ADMISSION_CLASSES as readonly string\[\]\)\.includes\(r\.admissionClass\)/, 'an unknown class is rejected, not defaulted');
  assert.match(body, /return automaticSubmit\.submit\(\{/);
});

test('the ticket machinery has NO production caller left (its removal is the stage-5.5 commit)', () => {
  // Declared transitional state, asserted rather than assumed: CapacityRuntime still
  // DEFINES begin/mark/settle/maySubmitNow, but nothing outside that file calls them.
  for (const f of walkSrc('src')) {
    if (f === 'src/main/capacityRuntime.ts') continue;
    const text = codeOnly(read(f));
    for (const dead of ['beginAutomaticDelivery(', 'markAutomaticDeliveryWriting(', 'settleAutomaticDelivery(', '.maySubmitNow(', '.holds(']) {
      assert.ok(!text.includes(dead), `${f} must not call ${dead}`);
    }
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
  for (const site of ['function releasePickerBlock(', 'export function clearTerminalDraft(']) {
    const at = pool.indexOf(site);
    assert.ok(at > 0 && pool.slice(at, pool.indexOf('\n}\n', at)).includes('reportPromptState(entry)'), `${site} re-derives the mirror`);
  }
  // The tick is a pool timer now (it used to start once and never stop; test/pool-timer.test.cjs).
  assert.match(pool, /const promptMirror = createPoolTimer\(\(\) => \{\s*for \(const entry of pool\.values\(\)\) reportPromptState\(entry\);/, 'the tick re-derives the mirror');
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
