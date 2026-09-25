'use strict';

/**
 * The inbox-wake STALL WATCHDOG. The 1.1.46 floor did not fail loudly — it failed
 * silently, which is why it took a rollback to notice. These pin the two properties that
 * make the watchdog worth having: it fires when the floor is genuinely deadlocked, and it
 * stays quiet for every ordinary refusal, because a watchdog nobody trusts is worse than
 * none at all.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WakeStallWatch, WAKE_STALL_AFTER_MS } = loadTs('src/main/wakeStall.ts');

const T = 1_000_000;

test('an unchanging refusal with mail waiting becomes a stall, exactly once', () => {
  const w = new WakeStallWatch();
  assert.equal(w.note('a', 'lifecycle-active', 2, T), null, 'the first refusal is just a refusal');
  assert.equal(w.note('a', 'lifecycle-active', 2, T + WAKE_STALL_AFTER_MS - 1), null, 'not yet');

  const stall = w.note('a', 'lifecycle-active', 2, T + WAKE_STALL_AFTER_MS);
  assert.ok(stall, 'past the threshold it is a deadlock');
  assert.equal(stall.why, 'lifecycle-active', 'and it names the guard responsible');
  assert.equal(stall.inboxIds, 2);
  assert.equal(stall.stalledMs, WAKE_STALL_AFTER_MS);

  // A stalled floor must not also flood its own log.
  assert.equal(w.note('a', 'lifecycle-active', 2, T + WAKE_STALL_AFTER_MS + 60_000), null, 'announced once');
});

test('this is the 1.1.46 failure, and it would have been audible within five minutes', () => {
  // The exact shape: a cold-booted agent, mail delivered, every beat refusing on the
  // same false-active lifecycle, forever.
  const w = new WakeStallWatch();
  let announced = null;
  for (let t = 0; t <= 15 * 60_000; t += 15_000) {           // the 15s beat, for 15 minutes
    const s = w.note('jim', 'lifecycle-active', 1, T + t);
    if (s) announced = s;
  }
  assert.ok(announced, 'fifteen minutes of identical refusals is not silent any more');
  assert.equal(announced.why, 'lifecycle-active');
  assert.ok(announced.stalledMs >= WAKE_STALL_AFTER_MS);
});

test('an empty inbox is the floor at rest, never a stall', () => {
  const w = new WakeStallWatch();
  for (let t = 0; t <= 30 * 60_000; t += 15_000) {
    assert.equal(w.note('a', 'no-pending-ids', 0, T + t), null);
  }
  assert.equal(w.watchingFor('a'), null, 'nothing is being watched');
});

test('an empty inbox is never a stall even when the REASON is not the empty-inbox one', () => {
  // The mail count is its own guard, not a shorthand for the 'no-pending-ids' reason.
  // A claim taken and then drained from disk leaves in-flight with nothing pending, and
  // an agent with no mail can never be stuck however the guards answer. Without this the
  // deliberate-reason list quietly covers for a missing count check.
  const w = new WakeStallWatch();
  for (const why of ['in-flight', 'lifecycle-active', 'boot-grace', 'no-pty', 'reconcile-cooldown']) {
    const w2 = new WakeStallWatch();
    for (let t = 0; t <= 30 * 60_000; t += 15_000) {
      assert.equal(w2.note('a', why, 0, T + t), null, `${why} with an empty inbox is not a stall`);
    }
    assert.equal(w2.watchingFor('a'), null, `${why}: nothing is being watched`);
  }
  assert.equal(w.watchingFor('a'), null);
});

test('states a human asked for stay quiet however long they last', () => {
  for (const why of ['paused', 'halted', 'auto-delivery-paused', 'held-interfered', 'hitl-hold']) {
    const w = new WakeStallWatch();
    for (let t = 0; t <= 30 * 60_000; t += 15_000) {
      assert.equal(w.note('a', why, 3, T + t), null, `${why} is deliberate, not stuck`);
    }
  }
});

test('a changing reason restarts the clock — the state machine is moving', () => {
  const w = new WakeStallWatch();
  w.note('a', 'boot-grace', 1, T);
  w.note('a', 'boot-grace', 1, T + WAKE_STALL_AFTER_MS - 1_000);
  // It moved on to a different guard: that is progress, and the new guard does not
  // inherit the old one's wait.
  assert.equal(w.note('a', 'reconcile-cooldown', 1, T + WAKE_STALL_AFTER_MS), null);
  assert.equal(w.watchingFor('a').why, 'reconcile-cooldown');
  assert.equal(w.watchingFor('a').since, T + WAKE_STALL_AFTER_MS, 'the clock restarted');
});

test('a wake that goes through clears the watch, and a later stall can fire again', () => {
  const w = new WakeStallWatch();
  w.note('a', 'lifecycle-active', 1, T);
  assert.ok(w.note('a', 'lifecycle-active', 1, T + WAKE_STALL_AFTER_MS), 'stalled');
  w.clear('a');                                   // the agent took a wake
  assert.equal(w.watchingFor('a'), null);

  const t2 = T + 60 * 60_000;
  w.note('a', 'lifecycle-active', 1, t2);
  assert.ok(w.note('a', 'lifecycle-active', 1, t2 + WAKE_STALL_AFTER_MS),
    'a NEW stall after a recovery is announced again');
});
