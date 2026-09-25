'use strict';

/**
 * GATE-2 — the cold-boot lifecycle hole that deadlocked the packaged 1.1.46 floor.
 *
 * A fresh agent's CLI fires SessionStart on boot. 1.1.46 counted that as proof of an
 * ACTIVE turn, so an agent that then sat at its prompt — never prompted, so never able
 * to emit a Stop — was labelled active forever. Event wakes need recorded idle, and D3
 * lets PTY quiescence stand in only for an UNKNOWN lifecycle, so BOTH paths refused every
 * wake for the life of the process. The renderer's 4s inbox poll had covered this in
 * 1.1.45 regardless of lifecycle, and C3 deleted it: no producer was left.
 *
 * These drive the REAL order — the one input no existing wake test ever drove — and they
 * must fail on the 1.1.46 mapping and pass on the fixed one. The second half is the other
 * side of the same fix: a turn that actually started still stays unclaimable through a long
 * silent tool, so D3 is preserved rather than traded away.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  WorkerWakeWatchdog,
  WORKER_WAKE_IDLE_MS,
  WORKER_WAKE_BOOT_GRACE_MS
} = loadTs('src/main/workerWake.ts');

const BOOT = 5_000_000;
const PTY = 'pty-newbie';
const AGENT = 'newbie';

/** The packaged boot sequence, up to the moment the agent is parked at its prompt. */
function coldBooted() {
  const c = new WorkerWakeWatchdog();
  c.noteSpawn(PTY, BOOT, AGENT);          // respawn reconciliation spawns the agent
  c.noteHook(AGENT, 'SessionStart', undefined, BOOT + 2_000); // its CLI boots
  return c;
}

/** Facts for an agent whose PTY last printed its banner at `lastOutputAt`. */
const facts = (lastOutputAt) => ({
  agentId: AGENT, ptyId: PTY, lastOutputAt,
  autoDeliveryPaused: false, paused: false, halted: false, inhibited: false
});

test('GATE-2: a cold-booted agent that was never prompted is claimable once its mail lands', () => {
  const c = coldBooted();
  // SessionStart alone must NOT assert a turn is running: nothing has been submitted.
  assert.notEqual(c.state(AGENT).lifecycle, 'active',
    'SessionStart is a session boundary, not proof of an active turn');

  // Boot grace elapses and the PTY goes quiet past the quiescence window.
  const lastOut = BOOT + 3_000;
  const now = lastOut + WORKER_WAKE_BOOT_GRACE_MS + WORKER_WAKE_IDLE_MS + 1_000;
  assert.ok(now - BOOT > WORKER_WAKE_BOOT_GRACE_MS, 'past boot grace');

  c.noteDelivery(AGENT, 'msg-1');

  // The 15s reconciliation beat is the path that must rescue this agent.
  const claim = c.claim(facts(lastOut), 'reconcile', 'reconcile', now);
  assert.ok(claim, `the beat must claim a booted, unprompted, quiescent agent (refused: ${c.whyNoClaim(AGENT)})`);
  assert.deepEqual([...claim.ids], ['msg-1']);

  // Exactly one: the claim is in flight, so the next beat takes nothing.
  assert.equal(c.claim(facts(lastOut), 'reconcile', 'reconcile', now + 15_000), null);
  assert.equal(c.whyNoClaim(AGENT), 'in-flight');
});

test('GATE-2: the rescued wake commits, and the turn it starts makes the agent active', () => {
  const c = coldBooted();
  const lastOut = BOOT + 3_000;
  const now = lastOut + WORKER_WAKE_BOOT_GRACE_MS + WORKER_WAKE_IDLE_MS + 1_000;
  c.noteDelivery(AGENT, 'msg-1');
  const claim = c.claim(facts(lastOut), 'reconcile', 'reconcile', now);
  assert.ok(claim);
  c.settle(claim, 'COMMITTED');
  assert.equal(c.state(AGENT).lifecycle, 'active', 'a committed wake started a turn');
  assert.deepEqual(c.state(AGENT).announced, ['msg-1'], 'announced only after COMMITTED');
});

test('GATE-2: D3 intact — a turn that really started is never claimed on silence', () => {
  const c = coldBooted();
  // The agent was prompted: this IS an active turn, whatever the PTY does next.
  c.noteHook(AGENT, 'UserPromptSubmit', undefined, BOOT + 10_000);
  c.noteHook(AGENT, 'PreToolUse', undefined, BOOT + 11_000);
  assert.equal(c.state(AGENT).lifecycle, 'active');

  const lastOut = BOOT + 12_000;
  c.noteDelivery(AGENT, 'msg-mid-turn');

  // A silent tool, build or network wait outlasting half an hour is still a live turn.
  // Every window here is past boot grace AND past quiescence, so the ONLY thing refusing
  // the claim is the active lifecycle — that is what D3 is.
  for (const after of [WORKER_WAKE_BOOT_GRACE_MS + WORKER_WAKE_IDLE_MS + 1_000, 5 * 60_000, 30 * 60_000]) {
    const now = lastOut + after;
    assert.equal(c.claim(facts(lastOut), 'reconcile', 'reconcile', now), null,
      `no reconcile claim ${after}ms into a silent tool`);
    assert.equal(c.whyNoClaim(AGENT), 'lifecycle-active');
    assert.equal(c.claim(facts(lastOut), 'delivery', 'event', now), null, 'and no event claim either');
  }

  // Only the agent saying it finished releases the wake.
  const now = lastOut + 30 * 60_000;
  c.noteHook(AGENT, 'Stop', undefined, now);
  const claim = c.claim(facts(lastOut), 'hook', 'event', now);
  assert.ok(claim, 'Stop releases it');
  assert.deepEqual([...claim.ids], ['msg-mid-turn']);
});

test('GATE-2: boot grace still holds the cold-booted agent during its boot sequence', () => {
  const c = coldBooted();
  c.noteDelivery(AGENT, 'msg-1');
  // Quiescent, but still inside the boot window: the agent is mid-boot, not idle.
  const lastOut = BOOT + 1_000;
  const now = BOOT + WORKER_WAKE_BOOT_GRACE_MS - 1_000;
  assert.equal(c.claim(facts(lastOut), 'reconcile', 'reconcile', now), null);
  assert.equal(c.whyNoClaim(AGENT), 'boot-grace');
});

test('GATE-2: SessionStart still clears a stale active label (a new session moots the old turn)', () => {
  const c = new WorkerWakeWatchdog();
  c.noteSpawn(PTY, BOOT, AGENT);
  c.noteHook(AGENT, 'UserPromptSubmit', undefined, BOOT + 1_000);
  assert.equal(c.state(AGENT).lifecycle, 'active');
  // A fresh session means that turn is gone — the label must not survive it, or a
  // --resume'd agent inherits the same deadlock the cold boot had.
  c.noteHook(AGENT, 'SessionStart', undefined, BOOT + 2_000);
  assert.notEqual(c.state(AGENT).lifecycle, 'active');

  c.noteDelivery(AGENT, 'msg-1');
  const lastOut = BOOT + 3_000;
  const now = lastOut + WORKER_WAKE_BOOT_GRACE_MS + WORKER_WAKE_IDLE_MS + 1_000;
  assert.ok(c.claim(facts(lastOut), 'reconcile', 'reconcile', now),
    `a re-sessioned agent is reachable again (refused: ${c.whyNoClaim(AGENT)})`);
});
