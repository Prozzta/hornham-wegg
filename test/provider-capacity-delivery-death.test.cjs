'use strict';

/**
 * L0-FIX8 / A15 — main could not tell a renderer death AFTER the submit keystroke
 * from one BEFORE it. Research `b4268520`, Dwight's section 13.
 *
 * THE DEFECT IS MISSING INFORMATION, NOT A MISSING CHECK. A deliverer that sent
 * Enter and then died left a ticket in exactly the state a deliverer that died
 * before writing anything left: minted, unsettled, silent. The expiry read both as
 * "never launched", returned the grant, and let a SECOND recovery turn be taken in
 * an epoch whose one turn a write that really did land had already spent. None of
 * that could be fixed by waiting longer or by checking harder, because main held no
 * fact that separated the two cases — so the repair records one.
 *
 * EVERY TEST BELOW IS PAIRED, AND THE PAIRING IS THE POINT. "No second turn after a
 * marked death" is satisfied just as well by a runtime that never grants a second
 * turn at all, and "the turn comes back" by one that never spends it. The arms are
 * therefore run against each other rather than against a remembered constant: what
 * is asserted is that the SAME sequence reaches DIFFERENT outcomes, and that the
 * only difference between the two runs is the recorded fact.
 *
 * L0-FIX9 — THE MARK WAS AN ANNOUNCEMENT AND IS NOW A PRECONDITION. Dwight found that
 * the deliverer discarded the mark's promise, so the submit keystroke could reach main
 * before the mark did and the two deaths collapsed back together. Measuring that the
 * transport happens to preserve the order answered a different question from whether
 * the code is entitled to assume it, so the repair removes the dependency: the mark now
 * ANSWERS, the deliverer awaits that answer, and it types only on `true`.
 *
 * WHAT THESE TESTS REACH AND WHAT THEY DO NOT, STATED HERE RATHER THAN IMPLIED. Main's
 * half — what the answer is for a live, reclaimed, settled or unknown ticket — is pinned
 * below and every case is reachable. THE DELIVERER'S OBEDIENCE TO THE ANSWER IS NOT:
 * awaiting before the write rather than after it, and refusing to type on `false`, are
 * renderer-side and no test in this suite can exercise them while renderer test
 * infrastructure is held. That gap is named in the commit message rather than papered
 * over — a test file that quietly covers the easy half reads exactly like one that
 * covers both.
 *
 * L0-STAGED — AND THE HALF THAT WAS UNPROVABLE IS NOW HALF PROVABLE. Dwight found that
 * a refusal withheld only the Enter: the message text had already been written into the
 * input box, where a retry could append to it and a human could send it by pressing
 * Enter. The repair is an ORDER — ask, then type — and an order is exactly the kind of
 * thing a pure sequencing unit can pin. `typeAndSubmit` therefore owns the order and is
 * driven here with fake effects, so "a refusal types NOTHING" is a real arm that fails
 * against the version that leaves the text there. What still cannot be reached from a
 * test is whether the renderer wires the real effects to it correctly.
 *
 * L0-TOCTOU — AND THE GATE WAS ANSWERING A QUESTION NOBODY ASKED. It checked only that
 * the ticket was still in `pending`, while the caller needed "may I spend a turn right
 * now". A ticket is minted before the terminal is waited for, before the payload is
 * typed and before the TUI pause, and in that interval the pool can go LIMITED or
 * RESERVE_ONLY - none of which removes the ticket. The gap became load-bearing at
 * exactly the moment the mark started being obeyed. It now re-asks ADMISSION'S OWN
 * question against the CURRENT projection, plus the four bindings a probe cannot see.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
// The renderer's submission sequence. Pure, effects injected, no DOM and no store —
// This is the house pattern, not new infrastructure: 15 suites under test/ already
// referenced a src/renderer path BEFORE this file existed (measured at bca135b7; 16
// including this one). The figure carried here first said "ten", which was read off a
// `grep | head -10` -- a pipe capped at ten cannot be evidence of ten. Re-derive it by
// search against a named revision, never by memory and never off a truncated pipe.
const { typeAndSubmit } = loadTs('src/renderer/src/hooks/queueDelivery.ts');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct-a:codex';
const RESET_5H = T0 + 3_600_000;

const win = (id, remaining, resetsAt = RESET_5H) => ({
  windowId: id, kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining, resetsAt
});

const obs = (over = {}) => ({
  poolKey: POOL, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s/a.jsonl', sourceSequence: 1,
  observedAt: T0, receivedAt: T0, windows: [win('five_hour', 80)],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

function rig() {
  let now = T0;
  let mono = 0;
  let seq = 0;
  const timers = new Map();
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  const runtime = new CapacityRuntime({
    deliver: () => {},
    now: () => now,
    setTimer: (fn, ms) => { const id = (seq += 1); timers.set(id, { fn, ms }); return { id, unref() { return this; } }; },
    clearTimer: (h) => { if (h && typeof h === 'object') timers.delete(h.id); }
  }, t);
  return {
    tracker: t, runtime,
    state: () => t.pool(POOL)?.state,
    fire: () => {
      assert.ok(timers.size, 'expected an armed timer');
      let pick = null;
      for (const [id, v] of timers) if (!pick || v.ms < pick.v.ms) pick = { id, v };
      timers.delete(pick.id);
      now += pick.v.ms;
      mono += pick.v.ms;
      pick.v.fn();
    },
    ticketTimers: () => [...timers.values()].filter((v) => v.ms === 30_000).length,
    /** The renderer is gone: nobody settles, and main's own TTL fires. */
    rendererDies: () => {
      for (const [id, v] of [...timers]) {
        if (v.ms === 30_000) { timers.delete(id); v.fn(); }
      }
    }
  };
}

/** Drive the pool into RECOVERING through the production path. */
function recovering(r) {
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', obs({
    observedAt: T0 + 1_000, receivedAt: T0 + 1_000,
    providerReachedType: 'rate_limit_reached',
    windows: [win('five_hour', 0)]
  }));
  assert.equal(r.state(), 'LIMITED');
  for (let i = 0; i < 12 && r.state() !== 'RECOVERING'; i += 1) r.fire();
  assert.equal(r.state(), 'RECOVERING', 'the rig reached the state the counterexample needs');
}

/**
 * One automatic delivery on a RECOVERING pool, killed at a chosen instant.
 * `markedWriting` is the ONLY thing that differs between the two arms.
 */
function deathDuringDelivery(markedWriting) {
  const r = rig();
  recovering(r);
  const grant = r.runtime.beginAutomaticDelivery('jim');
  assert.equal(grant.ok, true, 'precondition: the epoch really does grant one turn');
  if (markedWriting) r.runtime.markAutomaticDeliveryWriting(grant.ticket);
  r.rendererDies();
  return r.runtime.beginAutomaticDelivery('jim');
}

// ═══════════════════════════════════════════════════════════════════════════
// A15 — the two deaths, and that they are told apart
// ═══════════════════════════════════════════════════════════════════════════

test('A15: a death AFTER the submit keystroke does NOT hand out a second recovery turn', () => {
  // The Enter landed; the agent is already working on that instruction. Granting
  // again here is the duplicate send, and it is the failure nobody sees or undoes.
  const second = deathDuringDelivery(true);
  assert.equal(second.ok, false,
    'the write may have landed, so the epoch turn is SPENT — this returned ok:true before L0-FIX8');
  assert.equal(second.reason, ADMISSION_REASON.RECOVERING_SPENT,
    'and refused for the right reason: the turn was taken, not the pool re-limited');
});

test('A15: a death BEFORE the write DOES return the turn — the expiry still does its old job', () => {
  // The pair. Nothing was typed, so nothing was spent, and holding the grant here
  // would cost a delivery window for a renderer that merely closed its window.
  const second = deathDuringDelivery(false);
  assert.equal(second.ok, true,
    'an unmarked ticket is the abandoned-before-launch case, and it is unchanged');
});

test('A15: the two deaths reach DIFFERENT outcomes, and the recorded fact is the only difference', () => {
  // THE DISCRIMINATING FORM. Each arm alone is satisfied by a runtime that always
  // refuses or always grants; run together, the same sequence must diverge — and it
  // can only diverge on the one call that separates the two runs.
  const after = deathDuringDelivery(true);
  const before = deathDuringDelivery(false);
  assert.notEqual(after.ok, before.ok,
    'if both arms agree, this proves NOTHING about A15: main is still blind to the write');
  assert.equal(before.ok, true, 'and they diverge in the direction the defect names');
  assert.equal(after.ok, false, 'not merely in some direction');
});

// ═══════════════════════════════════════════════════════════════════════════
// What the mark is NOT
// ═══════════════════════════════════════════════════════════════════════════

test('A15: a LIVE report of a failed write beats the inference drawn from silence', () => {
  // The renderer marked, then the PTY write failed, then it said so. It is alive and
  // answering: honouring the mark over the answer would turn every failed write into
  // a permanently swallowed turn, which is the opposite defect.
  const r = rig();
  recovering(r);
  const grant = r.runtime.beginAutomaticDelivery('jim');
  r.runtime.markAutomaticDeliveryWriting(grant.ticket);
  r.runtime.settleAutomaticDelivery(grant.ticket, false);
  assert.equal(r.runtime.beginAutomaticDelivery('jim').ok, true,
    'a mark governs the SILENT case only; an answer that arrives still decides');
});

test('A15: a mark is not a confirm — on its own it spends nothing and closes nothing', () => {
  // Marking must not become a back door to confirmLaunch. While the ticket is still
  // outstanding the grant is held by the TICKET, exactly as before, and settling it
  // as failed gives it back.
  const r = rig();
  recovering(r);
  const grant = r.runtime.beginAutomaticDelivery('jim');
  r.runtime.markAutomaticDeliveryWriting(grant.ticket);
  assert.equal(r.ticketTimers(), 1, 'still outstanding: the mark did not close the ticket');
  r.runtime.settleAutomaticDelivery(grant.ticket, false);
  assert.equal(r.ticketTimers(), 0, 'and the settle is what closed it');
});

test('A15: a mark for a RECLAIMED ticket cannot reach the reservation that replaced it', () => {
  // The late-answer race, in the new channel. An expired ticket is somebody else's
  // grant now, and a mark that attached to it would spend a turn its owner is using.
  const r = rig();
  recovering(r);
  const orphan = r.runtime.beginAutomaticDelivery('jim');
  r.rendererDies();
  const fresh = r.runtime.beginAutomaticDelivery('jim');
  assert.equal(fresh.ok, true, 'precondition: the abandoned turn came back');

  assert.equal(r.runtime.markAutomaticDeliveryWriting(orphan.ticket), false,
    'and it says so: a reclaimed ticket REFUSES, which is what stops the deliverer typing');
  assert.equal(r.runtime.markAutomaticDeliveryWriting('cap-no-such-ticket'), false,
    'so does a ticket that never existed');
  r.runtime.settleAutomaticDelivery(fresh.ticket, false);
  assert.equal(r.runtime.beginAutomaticDelivery('jim').ok, true,
    'the stale marks touched nothing: the live ticket settled as failed and gave its turn back');
});

// ═══════════════════════════════════════════════════════════════════════════
// The same fact, read everywhere it is read
// ═══════════════════════════════════════════════════════════════════════════

test('A15: stopping the runtime reads the mark too — a shutdown is not new evidence', () => {
  const marked = rig();
  recovering(marked);
  const held = marked.runtime.beginAutomaticDelivery('jim');
  marked.runtime.markAutomaticDeliveryWriting(held.ticket);
  marked.runtime.stop();
  assert.equal(marked.ticketTimers(), 0, 'stop still disarms the expiry rather than leaving it to fire');
  assert.equal(marked.runtime.beginAutomaticDelivery('jim').ok, false,
    'the write may have landed before we stopped, so the turn stays spent');

  const unmarked = rig();
  recovering(unmarked);
  unmarked.runtime.beginAutomaticDelivery('jim');
  unmarked.runtime.stop();
  assert.equal(unmarked.runtime.beginAutomaticDelivery('jim').ok, true,
    'and an unmarked ticket is still returned, exactly as before');
});

test('A15: on an AVAILABLE pool the fix refuses nothing — it is a gate, not a throttle', () => {
  // The broadest pair. A runtime that read every mark as "spent" for every pool
  // would pass every assertion above and stop a healthy floor sending anything.
  const r = rig();
  r.runtime.ingest('jim', obs());
  assert.equal(r.state(), 'AVAILABLE');
  for (let i = 0; i < 5; i += 1) {
    const g = r.runtime.beginAutomaticDelivery('jim');
    assert.equal(g.ok, true, `delivery ${i} authorised`);
    r.runtime.markAutomaticDeliveryWriting(g.ticket);
    r.rendererDies();
  }
  assert.equal(r.runtime.beginAutomaticDelivery('jim').ok, true,
    'five marked deaths on a healthy pool cost it nothing');
});

// ═══════════════════════════════════════════════════════════════════════════
// L0-FIX9 — the mark answers, and the answer is the precondition
// ═══════════════════════════════════════════════════════════════════════════

test('L0-FIX9: a LIVE ticket is granted permission to type — the gate is not a blanket refusal', () => {
  // The both-sides pair for every refusal below, and it is not decoration: a mark that
  // answered false for everything would satisfy all of them and stop the floor sending
  // anything at all, because the deliverer types only on true.
  const r = rig();
  recovering(r);
  const grant = r.runtime.beginAutomaticDelivery('jim');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), true,
    'main holds this ticket, so the submit keystroke is authorised');
});

test('L0-FIX9: a ticket main has already SETTLED refuses — its reservation is gone', () => {
  // The hazard the old fire-and-forget mark could not even report. A deliverer that woke
  // up late and typed against a closed ticket would be sending with nothing reserving it.
  const r = rig();
  recovering(r);
  const grant = r.runtime.beginAutomaticDelivery('jim');
  r.runtime.settleAutomaticDelivery(grant.ticket, false);
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), false,
    'settled is closed: no reservation, so no authorised keystroke');
});

test('L0-FIX9: a ticket main EXPIRED refuses, and the refusal does not disturb its successor', () => {
  const r = rig();
  recovering(r);
  const orphan = r.runtime.beginAutomaticDelivery('jim');
  r.rendererDies();
  const fresh = r.runtime.beginAutomaticDelivery('jim');
  assert.equal(fresh.ok, true, 'precondition: the abandoned turn came back');

  assert.equal(r.runtime.markAutomaticDeliveryWriting(orphan.ticket), false,
    'the expired ticket is refused');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(fresh.ticket), true,
    'and the live one that replaced it is still granted — a refusal is local to its ticket');
});

test('L0-FIX9: granting permission twice is granting it once — idempotent, and it spends nothing', () => {
  // A deliverer may legitimately ask again (a retried chain, a re-entered write). Two
  // grants must not become two spends, and must not close the ticket either.
  const r = rig();
  recovering(r);
  const grant = r.runtime.beginAutomaticDelivery('jim');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), true);
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), true, 'asked twice, granted twice');
  assert.equal(r.ticketTimers(), 1, 'and still outstanding: a grant is not a settle');

  r.runtime.settleAutomaticDelivery(grant.ticket, false);
  assert.equal(r.runtime.beginAutomaticDelivery('jim').ok, true,
    'two grants cost exactly what one costs, which is nothing');
});

test('L0-FIX9: the ANSWER and the RECORD are the same act — a granted ticket is a marked ticket', () => {
  // The join between the two halves of the fix, and the one a reader would otherwise have
  // to take on trust: it would be possible to answer `true` and record nothing, which
  // reads correctly at the call site and restores the original A15 defect underneath.
  const granted = rig();
  recovering(granted);
  const a = granted.runtime.beginAutomaticDelivery('jim');
  assert.equal(granted.runtime.markAutomaticDeliveryWriting(a.ticket), true);
  granted.rendererDies();
  assert.equal(granted.runtime.beginAutomaticDelivery('jim').ok, false,
    'permission granted means the write may have landed, so the expiry holds the turn');

  const never = rig();
  recovering(never);
  never.runtime.beginAutomaticDelivery('jim');
  never.rendererDies();
  assert.equal(never.runtime.beginAutomaticDelivery('jim').ok, true,
    'and a ticket that never asked is still the abandoned-before-launch case');
});

// ═══════════════════════════════════════════════════════════════════════════
// L0-STAGED — a refusal must leave nothing sendable behind
// ═══════════════════════════════════════════════════════════════════════════

/** Records what was typed, in order, so the ORDER can be asserted and not just the set. */
function typist(over = {}) {
  const log = [];
  const io = {
    maySubmit: over.maySubmit ?? (async () => { log.push('ask'); return true; }),
    writePayload: async () => { log.push('payload'); return over.payload ?? { ok: true }; },
    pause: async () => { log.push('pause'); },
    writeSubmit: async () => { log.push('submit'); return over.submit ?? { ok: true }; }
  };
  if (over.noGate) delete io.maySubmit;
  return { log, io };
}

test('L0-STAGED: a REFUSED submission types nothing at all — not even the payload', async () => {
  // THE DISCRIMINATOR. Against the shipped-then-fixed version that wrote the payload
  // first and withheld only the Enter, this arm fails: `payload` is in the log, the
  // message is staged in the box, and a human pressing Enter sends what capacity just
  // refused. A refusal that leaves sendable text did not refuse.
  const t = typist({ maySubmit: async () => { return false; } });
  await assert.rejects(
    () => typeAndSubmit('pty-1', t.io),
    /capacity refused the submit keystroke/,
    'a refusal is an error, not a silent no-op'
  );
  assert.deepEqual(t.log, [], 'NOTHING was written: no payload staged, so there is nothing to send');
});

test('L0-STAGED: a GRANTED submission types, in order — the gate is not a blanket refusal', async () => {
  // The pair, and it is load-bearing: "types nothing when refused" is satisfied just as
  // well by a function that never types anything, which would stop the floor entirely.
  const t = typist();
  await typeAndSubmit('pty-1', t.io);
  assert.deepEqual(t.log, ['ask', 'payload', 'pause', 'submit'],
    'asked FIRST, then staged, then the TUI pause, then the keystroke');
});

test('L0-STAGED: a gate that REJECTS types nothing either — a failure is not a yes', async () => {
  // The named wrong fix, in its other form: treating a transport failure as permission.
  // Nothing may be staged on an answer that never arrived.
  const boom = new Error('ipc went away');
  const t = typist({ maySubmit: async () => { throw boom; } });
  await assert.rejects(() => typeAndSubmit('pty-1', t.io), /ipc went away/);
  assert.deepEqual(t.log, [], 'a rejection stages nothing, exactly as a false does');
});

test('L0-STAGED: repeated refusals leave nothing for a retry to append to', async () => {
  // Dwight\u2019s second route: a retry that appends to text the previous attempt staged,
  // building one oversized line out of several messages. With nothing staged there is
  // nothing to append to, and that is a property of the order rather than of a cleanup.
  const t = typist({ maySubmit: async () => false });
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(() => typeAndSubmit('pty-1', t.io), /capacity refused/);
  }
  assert.deepEqual(t.log, [], 'four refused attempts, zero characters staged');
});

test('L0-STAGED: a submission with NO ticket still types — a manual send is not gated', async () => {
  // Both-sides again, on the other axis. `manual` sends hold no reservation and must be
  // unaffected; a fix that gated them would silently stop the human escape hatch.
  const t = typist({ noGate: true });
  await typeAndSubmit('pty-1', t.io);
  assert.deepEqual(t.log, ['payload', 'pause', 'submit'], 'no gate asked, and it typed');
});

test('L0-STAGED: a failed payload write does not press Enter on text that is not there', async () => {
  // Pre-existing behaviour, re-asserted because the refactor could have lost it: the
  // submit keystroke must never follow a stage that did not land, or the Enter answers
  // whatever prompt the terminal happens to be showing.
  const t = typist({ payload: { ok: false, error: 'no pty: pty-1' } });
  await assert.rejects(() => typeAndSubmit('pty-1', t.io), /no pty: pty-1/);
  assert.deepEqual(t.log, ['ask', 'payload'], 'it stopped at the failed stage');
});

// ═══════════════════════════════════════════════════════════════════════════
// L0-TOCTOU — revalidate at the keystroke, against the projection of the moment
// ═══════════════════════════════════════════════════════════════════════════

/** A healthy pool with one ticket outstanding, ready to have the world change under it. */
function ticketOnHealthyPool(target = null) {
  const r = rig();
  r.runtime.ingest('jim', obs());
  assert.equal(r.state(), 'AVAILABLE', 'precondition: the delivery was admitted on a healthy pool');
  const grant = r.runtime.beginAutomaticDelivery('jim', 'ORDINARY_TURN', target);
  assert.equal(grant.ok, true, 'precondition: the ticket was minted');
  return { r, grant };
}

test('L0-TOCTOU: a pool that goes LIMITED after the ticket was minted REFUSES the keystroke', () => {
  // THE ARM THE FOUR-LINE MARK FAILS. Nothing about the ticket changed - it is still in
  // `pending`, still unsettled, still the same object - so the old check said yes and the
  // delivery typed into a pool that had since been refused outright. The window is real:
  // minting happens before waitForTerminalReady, before the payload write, before the
  // 140 ms pause.
  const { r, grant } = ticketOnHealthyPool();
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), true,
    'precondition: while the pool is healthy the keystroke is authorised');

  r.runtime.ingest('jim', obs({
    observedAt: T0 + 1_000, receivedAt: T0 + 1_000,
    providerReachedType: 'rate_limit_reached', windows: [win('five_hour', 0)]
  }));
  assert.equal(r.state(), 'LIMITED', 'the pool really did move');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), false,
    'a ticket minted on a healthy pool authorises NOTHING once that pool is LIMITED');
});

test('L0-TOCTOU: a pool that goes RESERVE_ONLY refuses an ORDINARY turn the same way', () => {
  // The other suppression, and not the same code path: RESERVE_ONLY refuses ordinary work
  // while still allowing a closure turn, so a revalidation that only looked for LIMITED
  // would pass this and let a spent window be typed into.
  const { r, grant } = ticketOnHealthyPool();
  r.runtime.ingest('jim', obs({
    observedAt: T0 + 1_000, receivedAt: T0 + 1_000, windows: [win('five_hour', 0)]
  }));
  assert.equal(r.state(), 'RESERVE_ONLY', 'a fresh numeric zero without attribution');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), false,
    'ordinary work is suppressed, so this keystroke is not authorised');
});

test('L0-TOCTOU: an agent whose readings have moved to ANOTHER pool is not this decision\'s agent', () => {
  // The mapping is recorded from readings that actually arrive, so it can move under a
  // ticket. Both pools here are healthy - the point is not that the new pool refuses, it
  // is that the decision was taken about a pool this agent no longer draws on.
  const { r, grant } = ticketOnHealthyPool();
  r.runtime.ingest('jim', obs({
    poolKey: 'codex:acct-b:codex', accountScope: 'acct-b',
    observedAt: T0 + 1_000, receivedAt: T0 + 1_000
  }));
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), false,
    'the grant was for the pool the agent HAD, and it is not transferable to the one it has now');
});

test('L0-TOCTOU: a grant is bound to ONE terminal - naming another, or none, is refused', () => {
  // Dwight\u2019s separate point: a handler that trusts a caller-supplied ptyId could spend
  // agent A\u2019s reservation on agent B\u2019s prompt. The binding is made when the ticket is
  // minted, which is the only moment main knows it is not being told.
  const { r, grant } = ticketOnHealthyPool('pty-A');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket, 'pty-B'), false,
    'another terminal cannot spend this grant');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), false,
    'and neither can a keystroke that declines to say which terminal it is for');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket, 'pty-A'), true,
    'the terminal it was minted for is still authorised - the binding is a match, not a ban');
});

test('L0-TOCTOU: a RECOVERING ticket is NOT refused by its own reservation', () => {
  // THE CARVE-OUT, AND IT IS THE PAIR EVERY REFUSAL ABOVE NEEDS. Re-probing a RECOVERING
  // pool whose single turn THIS ticket reserved answers REFUSE / RECOVERING_SPENT. A
  // revalidation that read that as a refusal would abort every recovery delivery it had
  // just legitimately granted - the guard mistaking its own reservation for a stranger\u2019s -
  // and would pass every other test in this section.
  const r = rig();
  recovering(r);
  const grant = r.runtime.beginAutomaticDelivery('jim');
  assert.equal(grant.ok, true, 'precondition: the epoch granted its one turn to this ticket');
  assert.equal(r.runtime.holds('jim'), true,
    'and the probe DOES refuse right now - that is exactly why a naive revalidation breaks');
  assert.equal(r.runtime.markAutomaticDeliveryWriting(grant.ticket), true,
    'the pool refuses everyone ELSE because of this ticket; that is not a refusal of it');
});

// ═══════════════════════════════════════════════════════════════════════════
// L0-WAKE — the OTHER automatic submit path, asking the same question
// ═══════════════════════════════════════════════════════════════════════════

// L0-FUSION stage 5: the wake path no longer has a submission sequence OF ITS OWN to
// test here. `submitWorkerNudge` - the private ask -> text -> delay -> Enter order five
// tests in this section pinned - is deleted; the wake beat submits CAPACITY_GATED work to
// the one main-owned submit transaction. Each of those five guarantees (a refused wake
// types nothing; a permitted wake types in order; an ungated caller is not refused; a
// failed text write never presses Enter; a throwing Enter is not a launch) is re-asserted
// against the path that actually runs, in test/automatic-submit-wiring.test.cjs, together
// with the one the old order could not give: a limit arriving INSIDE the gap.

test('L0-WAKE: the shared check answers for a claim that holds NO ticket', () => {
  // The wake path has no ticket - it holds its decision in-process. The check is the
  // SAME one the renderer delivery reaches through `markAutomaticDeliveryWriting`, so a
  // second copy cannot drift from it, and a future single submit transaction inherits it.
  const r = rig();
  r.runtime.ingest('jim', obs());
  const decision = r.runtime.admit('jim');
  assert.equal(decision.verdict, 'ALLOW', 'precondition: admitted on a healthy pool');
  const claim = { decision, agentId: 'jim', workClass: 'ORDINARY_TURN', target: 'pty-A' };
  assert.equal(r.runtime.maySubmitNow(claim, 'pty-A'), true, 'still permitted while nothing has changed');

  r.runtime.ingest('jim', obs({
    observedAt: T0 + 1_000, receivedAt: T0 + 1_000,
    providerReachedType: 'rate_limit_reached', windows: [win('five_hour', 0)]
  }));
  assert.equal(r.state(), 'LIMITED', 'the pool moved after the decision was taken');
  assert.equal(r.runtime.maySubmitNow(claim, 'pty-A'), false,
    'a decision taken before the limit authorises nothing after it');
  assert.equal(r.runtime.maySubmitNow(claim, 'pty-B'), false,
    'and it was never transferable to another terminal either');
});
