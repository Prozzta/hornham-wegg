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
  return capacityGateOf(probed, probed.poolKey ? r.tracker.pool(probed.poolKey)?.freshness ?? null : null);
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

test('UNNAMED CASE (c): stale after a NUMERICALLY SPENT window holds - and nothing ends it, even after its known reset', async () => {
  // REPORTED, NOT DECIDED. A window at exactly zero WITHOUT a provider refusal is
  // RESERVE_ONLY: no limit epoch is opened, so there is no RECOVERING hint to fire when the
  // window's known reset passes. Once stale it is STALE_AFTER_UNHEALTHY and rule 5 holds
  // it; the ruling names no exit for it, and none is invented here.
  const r = rig();
  r.runtime.ingest('jim', obs({ windows: [win(0)] }));
  assert.equal(r.state(), 'RESERVE_ONLY');
  assert.equal(r.tracker.pool(POOL).limitEpochAt, null, 'no refusal, so no epoch');
  elapse(r, L0_SEM_POLICY.liveTtlMs + 1_000);
  assert.equal(gateFor(r, 'jim').evidence, 'STALE_AFTER_UNHEALTHY');
  assert.equal((await r.settle(wake(r, 'w1'))).kind, 'REFUSED');
  elapse(r, RESET_AT - r.now + 60_000);
  assert.equal(r.state(), 'UNKNOWN', 'the known reset has PASSED and the tracker still says UNKNOWN - there is no epoch to hint');
  assert.equal(gateFor(r, 'jim').evidence, 'STALE_AFTER_UNHEALTHY');
  assert.equal((await r.settle(wake(r, 'w2'))).kind, 'REFUSED', 'STILL HELD: this is the deadlock class, and it is the human\u2019s to rule on');
});

test('UNNAMED CASE (c): stale after a refusal with NO known reset time holds with no exit', async () => {
  const r = rig();
  r.runtime.ingest('jim', obs());
  r.runtime.ingest('jim', limited(r, 2, { windows: [{ ...win(0), resetsAt: null }] }));
  assert.equal(r.state(), 'LIMITED');
  elapse(r, 7 * 24 * 60 * 60 * 1000);
  assert.equal(r.state(), 'LIMITED', 'a week on: no reset boundary was ever known, so no RECOVERING hint can fire');
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
  assert.match(body, /capacityGateOf\(probed, probed\.poolKey \? providerCapacity\.tracker\.pool\(probed\.poolKey\)\?\.freshness \?\? null : null\)/,
    'the pool\u2019s own published freshness chooses between labels; it never changes `holds`');
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
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

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

test('EXHAUSTIVE CENSUS: a bare Enter is WRITTEN in exactly two places, and one is a declared private PTY', () => {
  // The design's closing claim (section 10): "no current automatic caller uses raw Enter,
  // by exhaustive call-graph". Every source file, not a named list. A line that WRITES a
  // lone carriage return is a programmatic submit; comparisons against '\r' are not.
  const writers = [];
  for (const f of walkSrc('src')) {
    read(f).split('\n').forEach((line, i) => {
      if (/(write|writePty|safeWrite)\w*\([^)]*['"`]\\r['"`]\s*\)/.test(line)) writers.push(`${f}:${i + 1}`);
    });
  }
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
