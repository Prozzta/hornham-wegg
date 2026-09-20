'use strict';

/**
 * L0-FUSION stage 5.1 — the ONE main-owned programmatic submit transaction, proven
 * main-only: `src/main/automaticSubmit.ts`, every effect injected, a virtual clock.
 *
 * HOW THIS FILE IS BUILT, because it decides what a green run means. Every guarantee is
 * a KILLER: a function that takes the MODULE UNDER TEST and throws a named assertion.
 * Each killer runs twice:
 *   1. against the real module, as an ordinary test — it must pass;
 *   2. against a MUTANT of the module, in the census at the bottom — it must FAIL, at
 *      the assertion that names the guarantee the mutant removed.
 * A mutant is a source edit applied to a temporary copy. Every edit must match its
 * target EXACTLY ONCE or the census fails before it runs anything: a mutation that did
 * not apply would otherwise "survive" as a green test of the original — a check that
 * cannot fail. The proofs must kill the wrong implementations, not demonstrate the
 * right one (design of record, section 9.2).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const SRC = path.resolve(__dirname, '..', 'src/main/automaticSubmit.ts');
const REAL = loadTs('src/main/automaticSubmit.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

// ─── The world: a fake PTY, capacity, screen and clock ────────────────────────────────

const CAPACITY = {
  AVAILABLE: { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE },
  LIMITED: { verdict: 'REFUSE', reason: ADMISSION_REASON.LIMITED },
  NO_POOL: { verdict: 'UNKNOWN_NOT_INFERRED_SAFE', reason: ADMISSION_REASON.NO_POOL },
  NO_STATE: { verdict: 'UNKNOWN_NOT_INFERRED_SAFE', reason: ADMISSION_REASON.NO_STATE },
  STALE: { verdict: 'UNKNOWN_NOT_INFERRED_SAFE', reason: ADMISSION_REASON.UNKNOWN },
  NOVEL_UNKNOWN: { verdict: 'UNKNOWN_NOT_INFERRED_SAFE', reason: 'SOME_FUTURE_UNKNOWN' }
};

function world(over = {}) {
  const w = {
    vt: 0, timers: [], seq: 0,
    /** Every byte the OWNER wrote, in order. Human writes are not in here. */
    writes: [],
    /** Pin-6 record: what capacity said at the instant each Enter / clear went out. */
    record: [],
    gen: 0, inc: { n: 1 }, picker: false,
    eligible: { eligible: true },
    cap: { kind: 'VERIFIED', clearControl: '\x15', settleMs: 300 },
    ready: ['READY'],
    capacity: 'AVAILABLE',
    revalidations: 0, admits: 0, readyAsks: 0, confirmed: [], cancelled: [],
    prompt: '', scrollback: [], clearBehaviour: 'erases', showsStagedText: true,
    reads: 0, onRead: null, oracle: 'answers',
    outcomes: [],
    onRevalidate: null,
    ...over
  };
  w.at = (ms, fn) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); };
  w.human = (text) => { w.gen += 1; w.prompt += text; };
  w.decisionFor = (agentId, workClass) => ({
    ...CAPACITY[w.capacity], poolKey: 'pool', state: null, workClass, limitEpochAt: null,
    grantId: null, _agent: agentId
  });
  w.deps = {
    resolvePty: (agentId) => (agentId === 'nobody' ? null : `pty-${agentId}`),
    incarnation: () => w.inc,
    humanGeneration: () => (w.inc === undefined ? undefined : w.gen),
    write: (ptyId, data) => {
      if (w.writeFails && w.writeFails(data)) return { ok: false, error: 'simulated write failure' };
      w.writes.push(data);
      if (data === '\r') { w.record.push(`enter:${w.capacity}`); w.prompt = ''; }
      else if (data === w.cap.clearControl) {
        w.record.push(`abort:${w.capacity}`);
        if (w.clearBehaviour === 'erases') w.prompt = '';
        else if (w.clearBehaviour === 'moves') { w.scrollback.push(w.prompt); w.prompt = ''; }
        /* 'ignored': nothing happens */
      } else if (w.showsStagedText) w.prompt += data;
      return { ok: true };
    },
    terminalReady: () => { w.readyAsks += 1; return w.ready.length > 1 ? w.ready.shift() : w.ready[0]; },
    eligibility: () => w.eligible,
    pickerLatched: () => w.picker,
    abortCapability: () => w.cap,
    readScreen: (ptyId, needle) => {
      w.reads += 1;
      if (w.onRead) w.onRead(w.reads);
      if (w.oracle === 'silent') return new Promise(() => { /* never */ });
      if (w.oracle === 'rejects') return Promise.reject(new Error('renderer gone'));
      const count = [...w.scrollback, w.prompt].filter((row) => row.includes(needle)).length;
      return Promise.resolve({ onPromptRow: w.prompt.includes(needle), screenCount: count });
    },
    capacity: {
      admit: (agentId, workClass) => { w.admits += 1; return w.decisionFor(agentId, workClass); },
      revalidate: () => {
        w.revalidations += 1;
        const answer = CAPACITY[w.capacity];
        if (w.onRevalidate) w.onRevalidate(w.revalidations);
        return answer;
      },
      confirmLaunch: (d) => w.confirmed.push(d),
      cancelGrant: (d) => w.cancelled.push(d)
    },
    unknownPolicy: over.unknownPolicy,
    now: () => w.vt,
    setTimer: (fn, ms) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); return w.seq; },
    onOutcome: (r) => w.outcomes.push(r)
  };
  return w;
}

const immediate = () => new Promise((r) => setImmediate(r));

/** Drive the virtual clock until `promise` settles. Timers fire in (time, insertion)
 *  order, with the event loop drained between each so a yield really is a yield. */
async function settle(w, promise) {
  let done = false; let value;
  promise.then((v) => { done = true; value = v; });
  for (let i = 0; i < 5000; i += 1) {
    await immediate();
    if (done) return value;
    if (!w.timers.length) throw new Error('stuck: outcome unsettled and no timer is pending');
    w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = w.timers.shift();
    w.vt = Math.max(w.vt, next.at);
    next.fn();
  }
  throw new Error('did not settle');
}

const req = (over = {}) => ({
  requestId: 'r1', agentId: 'alice', admissionClass: 'CAPACITY_GATED', text: 'read your inbox now', ...over
});
const owner = (mod, w) => new mod.AutomaticSubmitOwner(w.deps);
const enters = (w) => w.writes.filter((d) => d === '\r').length;

// ─── Killers ──────────────────────────────────────────────────────────────────────────

const K = {};

K.commitsInOrder = async (mod) => {
  const w = world();
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.deepEqual(out, { kind: 'COMMITTED' }, 'a clean gated submission COMMITS');
  assert.deepEqual(w.writes, ['read your inbox now', '\r'], 'payload first, then Enter, and nothing else');
  assert.equal(w.confirmed.length, 1, 'the launch is confirmed exactly once, in-section');
  assert.equal(w.cancelled.length, 0, 'and no grant is returned on a COMMIT');
};

K.gapIsHonoured = async (mod) => {
  const w = world();
  let enterAt = null;
  const write = w.deps.write;
  w.deps.write = (p, d) => { if (d === '\r') enterAt = w.vt; return write(p, d); };
  await settle(w, owner(mod, w).submit(req()));
  assert.equal(enterAt, mod.GAP_MS, 'the Enter goes out one GAP after the payload, not in the same chunk');
};

K.criticalSectionNeverYields = async (mod) => {
  // DWIGHT'S PIN-6 SCHEDULE. Capacity is AVAILABLE when the final check reads it, and an
  // observation flips it to LIMITED in the FIRST YIELD after that read. If anything
  // yields between the check and the Enter, the Enter goes out under LIMITED.
  const w = world();
  w.onRevalidate = (n) => { if (n === 2) queueMicrotask(() => { w.capacity = 'LIMITED'; }); };
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.ok(!w.record.includes('enter:LIMITED'),
    'NO YIELD between the final check and the Enter: the record must never read enter:LIMITED');
  assert.deepEqual(w.record, ['enter:AVAILABLE'], 'the Enter went out under the capacity the check saw');
  assert.equal(out.kind, 'COMMITTED');
};

K.lateRefusalAborts = async (mod) => {
  const w = world();
  w.at(50, () => { w.capacity = 'LIMITED'; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.deepEqual(w.record, ['abort:LIMITED'], 'a LATE refusal records abort:LIMITED and never an Enter');
  assert.equal(out.kind, 'ABORTED', 'late refusal, nobody typed, erase verified => ABORTED');
  assert.equal(enters(w), 0, 'ABORT writes no Enter');
  assert.equal(w.cancelled.length, 1, 'the grant goes back so the item can retry');
  assert.equal(owner(mod, w).inhibition('pty-alice'), null);
};

K.abortInhibitsNothing = async (mod) => {
  const w = world();
  w.at(50, () => { w.capacity = 'LIMITED'; });
  const o = owner(mod, w);
  await settle(w, o.submit(req()));
  assert.equal(o.inhibition('pty-alice'), null, 'a verified ABORT leaves the PTY open for the retry');
};

K.preStageHumanIsRefusalNotInterference = async (mod) => {
  const w = world({ ready: ['WAIT', 'READY'] });
  w.at(50, () => w.human('hello'));
  const o = owner(mod, w);
  const out = await settle(w, o.submit(req()));
  assert.deepEqual(w.writes, [], 'PRE-STAGE human input: NOTHING is typed — no residue');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'HUMAN_INPUT_BEFORE_STAGE' },
    'PRE-STAGE human input is a side-effect-free REFUSAL, never INTERFERED');
  assert.equal(o.inhibition('pty-alice'), null, 'PRE-STAGE human input inhibits NOTHING');
  assert.equal(w.cancelled.length, 1, 'and the grant is returned for re-admission');
  assert.equal(w.prompt, 'hello', 'the human text is untouched');
};

K.postStageHumanIsInterfered = async (mod) => {
  const w = world();
  w.at(50, () => w.human(' my own words'));
  const o = owner(mod, w);
  const out = await settle(w, o.submit(req()));
  assert.equal(out.kind, 'INTERFERED', 'POST-STAGE human input => INTERFERED');
  assert.equal(out.reason, 'HUMAN_INPUT_AFTER_STAGE');
  assert.deepEqual(w.writes, ['read your inbox now'],
    'INTERFERED writes NOTHING after the payload: no Enter, no clear, no overwrite, no retry');
  assert.equal(w.prompt, 'read your inbox now my own words', "THE USER'S TEXT SURVIVES INTERFERED");
  assert.ok(o.inhibition('pty-alice'), 'further automatic delivery on that PTY is inhibited');
  assert.equal(w.confirmed.length, 0, 'no launch is confirmed');
};

K.inhibitionHoldsUntilAHumanResolves = async (mod) => {
  const w = world();
  w.at(50, () => w.human('x'));
  const o = owner(mod, w);
  await settle(w, o.submit(req()));
  w.vt += 24 * 60 * 60 * 1000;
  const again = await settle(w, o.submit(req({ requestId: 'r2' })));
  assert.deepEqual(again, { kind: 'REFUSED', reason: 'PTY_INHIBITED' },
    'an INTERFERED PTY refuses automatic delivery — and NO timer ever lifts it');
  const manual = await settle(w, o.submit(req({ requestId: 'r3', admissionClass: 'USER_RELEASED' })));
  assert.deepEqual(manual, { kind: 'REFUSED', reason: 'PTY_INHIBITED' }, 'for every class');
  assert.equal(o.resolveInterference('pty-alice'), true);
  const after = await settle(w, o.submit(req({ requestId: 'r4' })));
  assert.equal(after.kind, 'COMMITTED', 'only an explicit human resolution lifts it');
};

K.inhibitionDiesWithItsIncarnation = async (mod) => {
  const w = world();
  w.at(50, () => w.human('x'));
  const o = owner(mod, w);
  await settle(w, o.submit(req()));
  w.inc = { n: 2 }; w.gen = 0; w.prompt = '';
  const out = await settle(w, o.submit(req({ requestId: 'r2' })));
  assert.equal(out.kind, 'COMMITTED', 'a respawned terminal has a clean prompt and inherits no inhibition');
};

K.abortRecomparesBeforeTheDestructiveWrite = async (mod) => {
  // Nobody typed during the gap, so COMMIT sees a late refusal and routes to ABORT. The
  // human types WHILE ABORT IS READING THE SCREEN — after the commit check, before the
  // clear. The clear must not go out: it would destroy their text.
  const w = world();
  w.at(50, () => { w.capacity = 'LIMITED'; });
  w.onRead = (n) => { if (n === 1) w.human(' typed during the abort'); };
  const o = owner(mod, w);
  const out = await settle(w, o.submit(req()));
  assert.ok(!w.writes.includes('\x15'),
    'ABORT re-compares humanStage IMMEDIATELY before the clear: a human write since STAGE means NO destructive clear');
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(w.prompt, 'read your inbox now typed during the abort', "the human's text is preserved");
};

K.abortIsOnlyReachedWithNoHumanInput = async (mod) => {
  // The mirror image of "the user's text survives": ABORT is BY CONSTRUCTION the branch
  // where nobody typed. Asserted so the branch name cannot drift back onto INTERFERED.
  const w = world();
  w.at(50, () => { w.capacity = 'LIMITED'; });
  const genAtStage = w.gen;
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.equal(out.kind, 'ABORTED');
  assert.equal(w.gen, genAtStage, 'ABORTED is only ever reached with NO human input since STAGE');
};

K.eraseNeedsPromptRowGone = async (mod) => {
  const w = world({ clearBehaviour: 'ignored' });
  w.at(50, () => { w.capacity = 'LIMITED'; });
  const o = owner(mod, w);
  const out = await settle(w, o.submit(req()));
  assert.equal(out.kind, 'INTERFERED', 'a clear the TUI IGNORED is not an erase: held, never settled CANCELLED');
  assert.equal(out.reason, 'ERASE_NOT_VERIFIED');
  assert.ok(o.inhibition('pty-alice'));
};

K.eraseNeedsScreenGone = async (mod) => {
  const w = world({ clearBehaviour: 'moves' });
  w.at(50, () => { w.capacity = 'LIMITED'; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.equal(out.kind, 'INTERFERED',
    'text that merely MOVED off the prompt row is not erased: the screen half is required too');
  assert.equal(out.reason, 'ERASE_NOT_VERIFIED');
};

K.eraseNeedsPositiveControl = async (mod) => {
  // A TUI that renders a paste as a placeholder never shows our needle. "Not found
  // afterwards" would then verify on a screen that never showed it: a pass that cannot fail.
  const w = world({ showsStagedText: false });
  w.at(50, () => { w.capacity = 'LIMITED'; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.ok(!w.writes.includes('\x15'), 'no clear is issued for text the oracle could not first SEE');
  assert.equal(out.kind, 'INTERFERED', 'the erase oracle must first SEE the staged text, or its absence proves nothing');
  assert.equal(out.reason, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE');
};

K.silentOracleIsNotAnErase = async (mod) => {
  for (const oracle of ['silent', 'rejects']) {
    const w = world({ oracle });
    w.at(50, () => { w.capacity = 'LIMITED'; });
    const out = await settle(w, owner(mod, w).submit(req()));
    assert.equal(out.kind, 'INTERFERED', `an oracle that ${oracle} resolves to INTERFERED, never to ABORTED`);
  }
};

K.repeatedTextInScrollbackStillVerifies = async (mod) => {
  // The same nudge text is usually already on screen from the last delivery. A bare
  // "absent from the screen" test would then hold every abort forever; the differential
  // count is what keeps the screen half both strict and usable.
  const w = world({ scrollback: ['> read your inbox now'] });
  w.at(50, () => { w.capacity = 'LIMITED'; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.equal(out.kind, 'ABORTED', 'an older copy in scrollback does not block a verified erase');
};

K.pickerInGapIsInterfered = async (mod) => {
  const w = world();
  w.at(50, () => { w.picker = true; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.equal(enters(w), 0, 'a picker latched after STAGE: NO Enter into it');
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'PICKER_LATCHED_AFTER_STAGE');
};

K.pickerBeforeStageRefuses = async (mod) => {
  for (const admissionClass of mod.ADMISSION_CLASSES) {
    const w = world({ picker: true });
    const out = await settle(w, owner(mod, w).submit(req({ admissionClass })));
    assert.deepEqual(w.writes, [], `${admissionClass}: a latched picker before STAGE means NOTHING is typed`);
    assert.deepEqual(out, { kind: 'REFUSED', reason: 'PICKER_LATCHED' });
  }
};

K.unknownPickerFailsClosedForGatedOnly = async (mod) => {
  const w = world({ picker: undefined });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.deepEqual(w.writes, [], 'gated + picker state UNKNOWN: nothing typed');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'PICKER_UNKNOWN' });
  const w2 = world({ picker: undefined });
  const boot = await settle(w2, owner(mod, w2).submit(req({ admissionClass: 'BOOT_SEQUENCE' })));
  assert.equal(boot.kind, 'COMMITTED', 'a declared bypass class is not refused for an unmirrored picker');
};

K.abortCapabilityFailsClosedAtReady = async (mod) => {
  const w = world({ cap: { kind: 'UNKNOWN' } });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.deepEqual(w.writes, [],
    'NO verified abort capability: automatic staging is disabled BEFORE any payload is staged');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'PROVIDER_ABORT_UNVERIFIED' });
  assert.equal(w.cancelled.length, 1, 'and the admission grant is returned');
};

K.capabilityUnknownNeverInheritsCapacityProceed = async (mod) => {
  // Two different unknowns. Capacity UNKNOWN proceeds under the provisional policy;
  // capability UNKNOWN must not ride along with it.
  const w = world({ cap: { kind: 'UNKNOWN' }, capacity: 'NO_STATE' });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.deepEqual(w.writes, [], 'capability UNKNOWN refuses even when capacity UNKNOWN proceeds');
  assert.equal(out.reason, 'PROVIDER_ABORT_UNVERIFIED');
};

K.provenanceFailsClosedAtReady = async (mod) => {
  for (const reason of ['NO_STATE', 'UNATTACHED', 'SELFTEST_UNKNOWN', 'SELFTEST_FAILED', 'MOUSE_TRACKING']) {
    const w = world({ eligible: { eligible: false, reason } });
    const out = await settle(w, owner(mod, w).submit(req()));
    assert.deepEqual(w.writes, [], `${reason}: unproven provenance means NOTHING is typed`);
    assert.deepEqual(out, { kind: 'REFUSED', reason: 'PROVENANCE_INELIGIBLE', detail: reason });
  }
};

K.provenanceIsReReadImmediatelyBeforeStage = async (mod) => {
  // Eligible at READY, mouse tracking turns on during the readiness wait. RUNTIME AND
  // RE-ENTRANT: the answer at READY is not evidence about the moment of the write.
  const w = world({ ready: ['WAIT', 'READY'] });
  w.at(50, () => { w.eligible = { eligible: false, reason: 'MOUSE_TRACKING' }; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.deepEqual(w.writes, [], 'eligibility is re-read IMMEDIATELY before STAGE, not inherited from READY');
  assert.equal(out.reason, 'PROVENANCE_INELIGIBLE');
};

K.provenanceLostInGapIsInterfered = async (mod) => {
  const w = world();
  w.at(50, () => { w.eligible = { eligible: false, reason: 'MOUSE_TRACKING' }; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.equal(enters(w), 0, 'mouse tracking turned on in the GAP: "nobody typed" is no longer provable, so NO Enter');
  assert.ok(!w.writes.includes('\x15'), 'and no clear either');
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'PROVENANCE_LOST_AFTER_STAGE');
};

K.respawnInGapNeverReceivesTheEnter = async (mod) => {
  // The replacement incarnation's counter starts at 0 — coincidentally EQUAL to the
  // humanStage captured on the dead one. Equality of two numbers from two terminals is
  // not evidence; the incarnation is what scopes the generation.
  const w = world();
  w.at(50, () => { w.inc = { n: 2 }; w.gen = 0; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.equal(enters(w), 0, 'A GENERATION IS SCOPED TO ONE INCARNATION: no Enter into a replacement terminal');
  assert.deepEqual(out, { kind: 'FAILED', reason: 'PTY_REPLACED_AFTER_STAGE' });
  assert.equal(w.cancelled.length, 1);
};

K.unknownPolicyIsAppliedByNameAtAdmit = async (mod) => {
  for (const [state, evidence] of [['NO_POOL', 'NO_POOL'], ['NO_STATE', 'NO_STATE'], ['STALE', 'STALE_STATE']]) {
    const proceed = world({ capacity: state });
    assert.equal((await settle(proceed, owner(mod, proceed).submit(req()))).kind, 'COMMITTED',
      `${evidence}: the provisional policy proceeds`);
    const hold = world({ capacity: state, unknownPolicy: { ...mod.PROVISIONAL_UNKNOWN_POLICY, [evidence]: 'HOLD' } });
    const out = await settle(hold, owner(mod, hold).submit(req()));
    assert.deepEqual(hold.writes, [], `${evidence}: a HOLD policy types nothing`);
    // Pre-STAGE revalidation would ALSO catch this, which is exactly how an inequality
    // left at ADMIT hides: same outcome, one readiness wait and one held grant later.
    assert.equal(hold.readyAsks, 0, `${evidence}: the policy is applied AT ADMIT, before READY is ever asked`);
    assert.deepEqual(out, { kind: 'REFUSED', reason: 'CAPACITY_HOLD', detail: `UNKNOWN:${evidence}` },
      `ADMIT applies the NAMED UNKNOWN policy for ${evidence}, not an inequality against REFUSE`);
  }
};

K.unknownPolicyIsAppliedBeforeStage = async (mod) => {
  const w = world({ ready: ['WAIT', 'READY'], unknownPolicy: { NO_POOL: 'PROCEED', NO_STATE: 'PROCEED', STALE_STATE: 'HOLD' } });
  w.at(50, () => { w.capacity = 'STALE'; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.deepEqual(w.writes, [], 'PRE-STAGE revalidation applies the NAMED UNKNOWN policy: nothing typed');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'CAPACITY_HOLD', detail: 'UNKNOWN:STALE_STATE' });
};

K.unknownPolicyIsAppliedAtCommit = async (mod) => {
  const w = world({ unknownPolicy: { NO_POOL: 'PROCEED', NO_STATE: 'PROCEED', STALE_STATE: 'HOLD' } });
  w.at(50, () => { w.capacity = 'STALE'; });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.equal(enters(w), 0, 'FINAL revalidation applies the NAMED UNKNOWN policy: a HOLD writes no Enter');
  assert.equal(out.kind, 'ABORTED');
};

K.unclassifiedUnknownHolds = async (mod) => {
  const r = mod.resolveAdmission(CAPACITY.NOVEL_UNKNOWN, mod.PROVISIONAL_UNKNOWN_POLICY);
  assert.equal(r.action, 'HOLD', 'an UNKNOWN whose reason is not classified is a missing fact, never permission');
};

K.bypassIsDeclaredNotInherited = async (mod) => {
  for (const admissionClass of ['USER_RELEASED', 'BOOT_SEQUENCE']) {
    const w = world({ capacity: 'LIMITED', cap: { kind: 'UNKNOWN' }, eligible: { eligible: false, reason: 'NO_STATE' } });
    const out = await settle(w, owner(mod, w).submit(req({ admissionClass })));
    assert.equal(out.kind, 'COMMITTED', `${admissionClass} is a DECLARED bypass of capacity and the READY gate`);
    assert.equal(w.admits + w.revalidations, 0, `${admissionClass} never asks capacity at all`);
  }
  const w = world({ capacity: 'LIMITED' });
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.deepEqual(w.writes, [], 'CAPACITY_GATED under a LIMITED pool types nothing');
  assert.equal(out.reason, 'CAPACITY_HOLD', 'the gated class cannot fall through to a bypass');
};

K.bypassClassesStillGoInterfered = async (mod) => {
  const w = world();
  w.at(50, () => w.human('wait'));
  const out = await settle(w, owner(mod, w).submit(req({ admissionClass: 'USER_RELEASED' })));
  assert.equal(enters(w), 0, 'a bypass class still gets the final revalidation: no Enter over a human');
  assert.equal(out.kind, 'INTERFERED');
};

K.onePtyOneOrder = async (mod) => {
  const w = world();
  const o = owner(mod, w);
  const a = o.submit(req({ requestId: 'a', text: 'first message', admissionClass: 'BOOT_SEQUENCE' }));
  const b = o.submit(req({ requestId: 'b', text: 'second message' }));
  const c = o.submit(req({ requestId: 'c', text: 'third message', admissionClass: 'USER_RELEASED' }));
  await settle(w, Promise.all([a, b, c]));
  assert.deepEqual(w.writes, ['first message', '\r', 'second message', '\r', 'third message', '\r'],
    'EVERY class serializes through ONE owner per PTY: text and Enter never interleave');
};

K.settleHoldsTheNextSubmission = async (mod) => {
  const w = world();
  const stamps = [];
  const write = w.deps.write;
  w.deps.write = (p, d) => { stamps.push([d, w.vt]); return write(p, d); };
  const o = owner(mod, w);
  const a = o.submit(req({ requestId: 'a', text: 'first message', settleMs: 900 }));
  const b = o.submit(req({ requestId: 'b', text: 'second message' }));
  await settle(w, Promise.all([a, b]));
  const firstEnter = stamps.find(([d]) => d === '\r')[1];
  const secondPayload = stamps.find(([d]) => d === 'second message')[1];
  assert.ok(secondPayload - firstEnter >= 900, 'the PTY is held through the post-COMMIT settle');
};

K.differentPtysDoNotBlockEachOther = async (mod) => {
  const w = world({ ready: ['WAIT', 'WAIT', 'WAIT', 'READY'] });
  const o = owner(mod, w);
  const a = o.submit(req({ requestId: 'a', agentId: 'alice' }));
  const b = o.submit(req({ requestId: 'b', agentId: 'bob' }));
  await settle(w, Promise.all([a, b]));
  assert.equal(enters(w), 2);
};

K.replayAfterCommitWritesNoSecondEnter = async (mod) => {
  const w = world();
  const o = owner(mod, w);
  const first = await settle(w, o.submit(req()));
  const replay = await settle(w, o.submit(req()));
  assert.deepEqual(replay, first, 'a replay of the same request returns the recorded outcome');
  assert.equal(enters(w), 1, 'A REPLAY AFTER COMMIT WRITES NO SECOND ENTER');
};

K.replayInFlightSharesOneTransaction = async (mod) => {
  const w = world();
  const o = owner(mod, w);
  const a = o.submit(req()); const b = o.submit(req());
  await settle(w, Promise.all([a, b]));
  assert.equal(enters(w), 1, 'a replay while in flight joins the one transaction');
};

K.mismatchedReplayRejects = async (mod) => {
  for (const change of [{ text: 'a different payload' }, { agentId: 'bob' }, { admissionClass: 'USER_RELEASED' }]) {
    const w = world();
    const o = owner(mod, w);
    await settle(w, o.submit(req()));
    const out = await settle(w, o.submit(req(change)));
    assert.deepEqual(out, { kind: 'REJECTED', reason: 'ID_BINDING_MISMATCH' },
      `the id BINDS IMMUTABLY: the same id with a different ${Object.keys(change)[0]} REJECTS, it does not return the prior success`);
    assert.equal(enters(w), 1);
  }
};

K.enterFailureReturnsTheGrantAndHolds = async (mod) => {
  const w = world();
  w.writeFails = (d) => d === '\r';
  const o = owner(mod, w);
  const out = await settle(w, o.submit(req()));
  assert.equal(w.confirmed.length, 0, 'a failed Enter is NOT a launch');
  assert.equal(w.cancelled.length, 1, 'false/throw => cancelGrant, settled in-section');
  assert.equal(out.kind, 'INTERFERED', 'our text is still on a live prompt: held, not retried');
  assert.equal(out.reason, 'ENTER_WRITE_FAILED');
};

K.stageFailureTypesNothingAndReturnsTheGrant = async (mod) => {
  const w = world();
  w.writeFails = () => true;
  const out = await settle(w, owner(mod, w).submit(req()));
  assert.equal(out.kind, 'REFUSED'); assert.equal(out.reason, 'STAGE_WRITE_FAILED');
  assert.equal(w.cancelled.length, 1);
};

K.noPtyAndNotReady = async (mod) => {
  const w = world();
  assert.deepEqual(await settle(w, owner(mod, w).submit(req({ agentId: 'nobody' }))), { kind: 'REFUSED', reason: 'NO_PTY' });
  const w2 = world({ ready: ['GONE'] });
  assert.equal((await settle(w2, owner(mod, w2).submit(req()))).reason, 'PTY_GONE');
  const w3 = world({ ready: ['WAIT'] });
  const out = await settle(w3, owner(mod, w3).submit(req()));
  assert.equal(out.reason, 'TERMINAL_NOT_READY');
  assert.deepEqual(w3.writes, []);
  assert.equal(w3.cancelled.length, 1, 'a readiness timeout returns the grant');
};

K.multiLineIsBracketedAndSingleLineIsRaw = async (mod) => {
  assert.equal(mod.payloadFor('one line'), 'one line');
  assert.equal(mod.payloadFor('two\nlines'), '\x1b[200~two\nlines\x1b[201~');
  assert.equal(mod.needleFor('\n   \n  hello world, this is long\nmore'), 'hello world, thi');
  assert.equal(mod.needleFor('ok'), null, 'a needle too short to be evidence is no needle');
};

K.ownerNeverWritesThroughTheHumanIngress = async (mod) => {
  const w = world();
  const before = w.gen;
  await settle(w, owner(mod, w).submit(req()));
  assert.equal(w.gen, before, 'the owner staging and Enter never advance the human generation');
};

for (const [name, killer] of Object.entries(K)) test(`owner: ${name}`, () => killer(REAL));

// ─── The critical section, read as SOURCE ─────────────────────────────────────────────

function commitSectionSource(source) {
  const start = source.indexOf('export function commitSection(');
  const asyncStart = source.indexOf('export async function commitSection(');
  assert.ok(start >= 0 && asyncStart < 0, 'commitSection is a plain synchronous function');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start);
  return source.slice(start, end);
}

test('the COMMIT critical section contains no yielding construct (section 2 prohibition list)', () => {
  const body = commitSectionSource(fs.readFileSync(SRC, 'utf8'));
  for (const banned of ['await', '.then', 'setTimeout', 'setImmediate', 'queueMicrotask', 'async', 'import(', 'Promise', 'setTimer', 'readScreen']) {
    assert.ok(!body.includes(banned), `commitSection must not contain \`${banned}\``);
  }
  const check = body.indexOf('revalidate(');
  const enter = body.indexOf("'\\r'");
  const settleAt = body.indexOf('confirmLaunch(');
  assert.ok(check > 0 && enter > check && settleAt > enter, 'check -> Enter -> settle, in that order, in one function');
});

// ─── THE MUTANT CENSUS ────────────────────────────────────────────────────────────────

const MUTANTS = [
  { name: 'an await between the final check and the Enter',
    edits: [
      ['export function commitSection(s: Staged, deps: OwnerDeps): CommitVerdict {', 'export async function commitSection(s: Staged, deps: OwnerDeps): Promise<CommitVerdict> {'],
      ["  const entered = safeWrite(deps, s.ptyId, '\\r');", "  await null;\n  const entered = safeWrite(deps, s.ptyId, '\\r');"]
    ],
    killer: 'criticalSectionNeverYields', dies: /never read enter:LIMITED/ },
  { name: 'the two baselines collapsed into one',
    edits: [
      ["    if (deps.humanGeneration(ptyId) !== humanAdmit) return this.refuse(decision, 'HUMAN_INPUT_BEFORE_STAGE');\n", ''],
      ['    const humanStage = deps.humanGeneration(ptyId);', '    const humanStage = humanAdmit;']
    ],
    killer: 'preStageHumanIsRefusalNotInterference', dies: /NOTHING is typed/ },
  { name: 'a pre-STAGE human write punished with an inhibition',
    edits: [["    if (deps.humanGeneration(ptyId) !== humanAdmit) return this.refuse(decision, 'HUMAN_INPUT_BEFORE_STAGE');",
      "    if (deps.humanGeneration(ptyId) !== humanAdmit) { this.inhibited.set(ptyId, { requestId: req.requestId, reason: 'HUMAN_INPUT_AFTER_STAGE', at: deps.now(), incarnation }); return this.refuse(decision, 'HUMAN_INPUT_BEFORE_STAGE'); }"]],
    killer: 'preStageHumanIsRefusalNotInterference', dies: /inhibits NOTHING/ },
  { name: 'the post-STAGE comparison removed from the critical section',
    edits: [["  if (deps.humanGeneration(s.ptyId) !== s.humanStage) {\n    return { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' };\n  }\n", '']],
    killer: 'postStageHumanIsInterfered', dies: /POST-STAGE human input => INTERFERED/ },
  { name: 'INTERFERED that clears the line',
    edits: [['    this.inhibited.set(s.ptyId, {', "    safeWrite(this.deps, s.ptyId, '\\x15');\n    this.inhibited.set(s.ptyId, {"]],
    killer: 'postStageHumanIsInterfered', dies: /INTERFERED writes NOTHING/ },
  { name: 'INTERFERED that presses Enter anyway',
    edits: [['    this.inhibited.set(s.ptyId, {', "    safeWrite(this.deps, s.ptyId, '\\r');\n    this.inhibited.set(s.ptyId, {"]],
    killer: 'postStageHumanIsInterfered', dies: /INTERFERED writes NOTHING/ },
  { name: 'INTERFERED that does not inhibit the PTY',
    edits: [["    this.inhibited.set(s.ptyId, { requestId: s.req.requestId, reason, at: this.deps.now(), incarnation: s.incarnation });\n", '']],
    killer: 'postStageHumanIsInterfered', dies: /further automatic delivery on that PTY is inhibited/ },
  { name: 'an inhibition that expires on a timer',
    edits: [['    if (this.deps.incarnation(ptyId) !== held.incarnation) {', '    if (this.deps.now() - held.at > 60_000 || this.deps.incarnation(ptyId) !== held.incarnation) {']],
    killer: 'inhibitionHoldsUntilAHumanResolves', dies: /NO timer ever lifts it/ },
  { name: 'ABORT that inherits the commit check instead of re-comparing',
    edits: [["    const blocked = postStageGuard(s, deps);\n    if (blocked) {\n      if (blocked.kind === 'FAILED')", "    const blocked = null as CommitVerdict | null;\n    if (blocked) {\n      if (blocked.kind === 'FAILED')"]],
    killer: 'abortRecomparesBeforeTheDestructiveWrite', dies: /NO destructive clear/ },
  { name: 'erase verified on the screen half alone',
    edits: [['    if (!after || after.onPromptRow || after.screenCount >= before.screenCount) {', '    if (!after || (after.screenCount >= before.screenCount && false) || false) {']],
    killer: 'eraseNeedsPromptRowGone', dies: /IGNORED is not an erase/ },
  { name: 'erase verified on the prompt-row half alone',
    edits: [['    if (!after || after.onPromptRow || after.screenCount >= before.screenCount) {', '    if (!after || after.onPromptRow) {']],
    killer: 'eraseNeedsScreenGone', dies: /merely MOVED/ },
  { name: 'erase verified without first seeing the staged text',
    edits: [['    if (!before || !before.onPromptRow || before.screenCount < 1) {', '    if (!before) {'],
      ['after.screenCount >= before.screenCount) {', 'after.screenCount > before.screenCount) {']],
    killer: 'eraseNeedsPositiveControl', dies: /no clear is issued|must first SEE/ },
  { name: 'a silent oracle read as a clean screen',
    edits: [['      this.deps.setTimer(() => finish(null), SCREEN_ORACLE_TIMEOUT_MS);', '      this.deps.setTimer(() => finish({ onPromptRow: false, screenCount: 0 }), SCREEN_ORACLE_TIMEOUT_MS);'],
      ['    if (!before || !before.onPromptRow || before.screenCount < 1) {', '    if (!before) {'],
      ['after.screenCount >= before.screenCount) {', 'after.screenCount > before.screenCount) {']],
    killer: 'silentOracleIsNotAnErase', dies: /resolves to INTERFERED/ },
  { name: 'the picker latch not read inside the critical section',
    edits: [["  if (picker === true) return { kind: 'INTERFERED', reason: 'PICKER_LATCHED_AFTER_STAGE' };\n", '']],
    killer: 'pickerInGapIsInterfered', dies: /NO Enter into it/ },
  { name: 'the picker latch not read before STAGE',
    edits: [["    if (picker === true) return this.refuse(decision, 'PICKER_LATCHED');\n", '']],
    killer: 'pickerBeforeStageRefuses', dies: /NOTHING is typed/ },
  { name: 'an unmirrored picker treated as closed',
    edits: [["      if (picker === undefined) return this.refuse(decision, 'PICKER_UNKNOWN');\n", '']],
    killer: 'unknownPickerFailsClosedForGatedOnly', dies: /picker state UNKNOWN/ },
  { name: 'the abort-capability gate removed from READY',
    edits: [["      if (deps.abortCapability(req.agentId).kind !== 'VERIFIED') return this.refuse(decision, 'PROVIDER_ABORT_UNVERIFIED');\n", '']],
    killer: 'abortCapabilityFailsClosedAtReady', dies: /BEFORE any payload is staged/ },
  { name: 'capability UNKNOWN resolved through the capacity UNKNOWN policy',
    edits: [["      if (deps.abortCapability(req.agentId).kind !== 'VERIFIED') return this.refuse(decision, 'PROVIDER_ABORT_UNVERIFIED');",
      "      if (deps.abortCapability(req.agentId).kind !== 'VERIFIED' && policy.NO_STATE !== 'PROCEED') return this.refuse(decision, 'PROVIDER_ABORT_UNVERIFIED');"]],
    killer: 'capabilityUnknownNeverInheritsCapacityProceed', dies: /capability UNKNOWN refuses/ },
  { name: 'the provenance gate removed from READY and STAGE',
    edits: [["      const e = deps.eligibility(ptyId);\n      if (!e.eligible) return this.refuse(decision, 'PROVENANCE_INELIGIBLE', e.reason);\n    }\n    const started", "    }\n    const started"],
      ["      const e = deps.eligibility(ptyId);\n      if (!e.eligible) return this.refuse(decision, 'PROVENANCE_INELIGIBLE', e.reason);\n      const claim", '      const claim']],
    killer: 'provenanceFailsClosedAtReady', dies: /unproven provenance means NOTHING is typed/ },
  { name: 'provenance asked once at READY and cached',
    edits: [["      const e = deps.eligibility(ptyId);\n      if (!e.eligible) return this.refuse(decision, 'PROVENANCE_INELIGIBLE', e.reason);\n      const claim", '      const claim']],
    killer: 'provenanceIsReReadImmediatelyBeforeStage', dies: /re-read IMMEDIATELY before STAGE/ },
  { name: 'provenance not re-read inside the critical section',
    edits: [["    const e = deps.eligibility(s.ptyId);\n    if (!e.eligible) return { kind: 'INTERFERED', reason: 'PROVENANCE_LOST_AFTER_STAGE', detail: e.reason };\n", '']],
    killer: 'provenanceLostInGapIsInterfered', dies: /no longer provable, so NO Enter/ },
  { name: 'a generation shared across PTY incarnations',
    edits: [["  if (live !== s.incarnation) return { kind: 'FAILED', reason: 'PTY_REPLACED_AFTER_STAGE' };\n", '']],
    killer: 'respawnInGapNeverReceivesTheEnter', dies: /SCOPED TO ONE INCARNATION/ },
  { name: 'the inequality restored at ADMIT',
    edits: [["      const admitted = resolveAdmission(decision, policy);\n      if (admitted.action !== 'PROCEED')", "      const admitted = { action: decision.verdict !== 'REFUSE' ? 'PROCEED' : 'HOLD', basis: decision.reason };\n      if (admitted.action !== 'PROCEED')"]],
    killer: 'unknownPolicyIsAppliedByNameAtAdmit', dies: /applied AT ADMIT, before READY is ever asked/ },
  { name: 'the inequality restored before STAGE',
    edits: [["      const again = resolveAdmission(deps.capacity.revalidate(claim), policy);", "      const again = { action: deps.capacity.revalidate(claim).verdict !== 'REFUSE' ? 'PROCEED' : 'HOLD', basis: 'x' };"]],
    killer: 'unknownPolicyIsAppliedBeforeStage', dies: /PRE-STAGE revalidation applies the NAMED UNKNOWN policy/ },
  { name: 'the inequality restored at final COMMIT revalidation',
    edits: [["    const now = resolveAdmission(deps.capacity.revalidate(claim), deps.unknownPolicy ?? PROVISIONAL_UNKNOWN_POLICY);", "    const now = { action: deps.capacity.revalidate(claim).verdict !== 'REFUSE' ? 'PROCEED' : 'HOLD', basis: 'x' };"]],
    killer: 'unknownPolicyIsAppliedAtCommit', dies: /FINAL revalidation applies the NAMED UNKNOWN policy/ },
  { name: 'final revalidation removed (the admission decision trusted at the Enter)',
    edits: [["    if (now.action !== 'PROCEED') return { kind: 'LATE_REFUSAL', basis: now.basis };\n", '']],
    killer: 'lateRefusalAborts', dies: /records abort:LIMITED and never an Enter/ },
  { name: 'an unclassified UNKNOWN allowed through',
    edits: [["      if (!evidence) return { action: 'HOLD', basis: `UNCLASSIFIED_UNKNOWN:${decision.reason}` };", "      if (!evidence) return { action: 'PROCEED', basis: `UNCLASSIFIED_UNKNOWN:${decision.reason}` };"]],
    killer: 'unclassifiedUnknownHolds', dies: /missing fact, never permission/ },
  { name: 'every class treated as a bypass',
    edits: [["  return cls === 'CAPACITY_GATED';", '  return false;']],
    killer: 'bypassIsDeclaredNotInherited', dies: /CAPACITY_GATED under a LIMITED pool types nothing/ },
  { name: 'a bypass class that skips the final revalidation',
    edits: [["  const blocked = postStageGuard(s, deps);\n  if (blocked) return blocked;\n  if (s.decision) {", "  const blocked = s.decision ? postStageGuard(s, deps) : null;\n  if (blocked) return blocked;\n  if (s.decision) {"]],
    killer: 'bypassClassesStillGoInterfered', dies: /no Enter over a human/ },
  { name: 'no per-PTY serialization',
    edits: [['    const prev = this.chains.get(ptyId) ?? Promise.resolve();', '    const prev = Promise.resolve();']],
    killer: 'onePtyOneOrder', dies: /text and Enter never interleave/ },
  { name: 'the next submission not held through the settle',
    edits: [["      outcome.kind === 'COMMITTED' ? this.sleep(req.settleMs ?? SETTLE_MS) : undefined);", '      undefined);']],
    killer: 'settleHoldsTheNextSubmission', dies: /held through the post-COMMIT settle/ },
  { name: 'a replay re-runs the transaction',
    edits: [['    if (prior) {', '    if (prior && false) {']],
    killer: 'replayAfterCommitWritesNoSecondEnter', dies: /NO SECOND ENTER/ },
  { name: 'a mismatched replay handed the prior success',
    edits: [["      return same ? prior.promise : Promise.resolve({ kind: 'REJECTED', reason: 'ID_BINDING_MISMATCH' });", '      return prior.promise;']],
    killer: 'mismatchedReplayRejects', dies: /BINDS IMMUTABLY/ },
  { name: 'a failed Enter confirmed as a launch',
    edits: [['    if (entered.ok) deps.capacity.confirmLaunch(s.decision);\n    else deps.capacity.cancelGrant(s.decision);', '    deps.capacity.confirmLaunch(s.decision);']],
    killer: 'enterFailureReturnsTheGrantAndHolds', dies: /a failed Enter is NOT a launch/ },
  { name: 'the Enter sent in the same chunk as the payload',
    edits: [['    await this.sleep(GAP_MS);', '    await this.sleep(0);']],
    killer: 'gapIsHonoured', dies: /one GAP after the payload/ }
];

const MUTANT_DIR = path.join(__dirname, '.mutants');

function buildMutant(index, mutant, source) {
  let text = source;
  for (const [from, to] of mutant.edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 70))}`);
    text = text.replace(from, () => to);
  }
  assert.notEqual(text, source);
  // The copy lives two directories away from src/main, so its one relative import moves.
  text = text.replace("from './capacityAdmission'", "from '../../src/main/capacityAdmission'");
  const file = path.join(MUTANT_DIR, `m${index}.ts`);
  fs.writeFileSync(file, text, 'utf8');
  return loadTs(path.relative(path.resolve(__dirname, '..'), file));
}

test('MUTANT CENSUS: every mutant applies, and dies at the assertion that names its guarantee', async (t) => {
  const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, mutant] of MUTANTS.entries()) {
      await t.test(`mutant: ${mutant.name}`, async () => {
        assert.ok(K[mutant.killer], `killer ${mutant.killer} exists`);
        await K[mutant.killer](REAL); // the killer must PASS on the real module...
        const mod = buildMutant(i, mutant, source);
        let died = null;
        try { await K[mutant.killer](mod); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
        // ...and die on the mutant AT THE NAMED ASSERTION, not from a crash: "the scenario
        // threw" is not a diagnosis of which property was lost.
        assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong assertion`);
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});
