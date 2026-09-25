'use strict';
/**
 * The 1.1.49 log storm: the reconcile breadcrumb de-duplication that suppressed NOTHING.
 *
 * These pin the actual defect, not the general idea of de-duplication. The 1.1.48 version
 * keyed on `stage:agentId` while SIGNING `cause`, and two cadences (the renderer's 4s
 * inbox hint, the 15s reconcile beat) both emit with mode:'reconcile'. Interleaved, each
 * row's signature differed from the one before, so every row logged - 0 suppressions in
 * 14,717 consecutive `facts` rows on the live floor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { newBreadcrumbMemory, shouldLogBreadcrumb, breadcrumbSignature, forgetBreadcrumbs } =
  loadTs('src/main/wakeBreadcrumb.ts');

/** An idle agent's `facts` row: nothing pending, nothing blocking, only idleMs moving. */
const idleFacts = (cause, idleMs) => ({
  agentId: 'andy-1', cause, mode: 'reconcile',
  inboxIds: 0, pty: 'pty-andy-1', idleMs,
  paused: false, halted: false, autoDeliveryPaused: false, inhibited: false
});

test('THE STORM: two cadences alternating no longer bust each other (0 of 14717 -> 1 each)', () => {
  const mem = newBreadcrumbMemory();
  let logged = 0;
  // Exactly the live sequence: renderer, reconcile, renderer, reconcile… idle throughout,
  // with the idle age climbing the way it really does.
  for (let i = 0; i < 500; i++) {
    const cause = i % 2 === 0 ? 'renderer' : 'reconcile';
    if (shouldLogBreadcrumb(mem, 'facts', idleFacts(cause, 400000 + i * 1000))) logged++;
  }
  assert.equal(logged, 2,
    'an idle agent must log ONE row per cadence, not one per tick - this is the storm itself');
});

test('the killing detail: cause is in the KEY, so one cadence cannot invalidate the other', () => {
  const mem = newBreadcrumbMemory();
  assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('renderer', 1000)), true, 'first renderer row');
  assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 2000)), true, 'first reconcile row');
  // The 1.1.48 code failed HERE: the reconcile row above had overwritten the renderer
  // entry, so this returned true and kept returning true forever.
  assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('renderer', 3000)), false,
    'the renderer cadence must still recognise ITS OWN last row after the beat interleaved');
  assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 4000)), false,
    'and the beat must still recognise its own');
});

test('a REAL transition still logs - suppression must never hide a change', () => {
  const mem = newBreadcrumbMemory();
  shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 1000));
  assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 2000)), false, 'still idle');

  const withMail = { ...idleFacts('reconcile', 3000), inboxIds: 2 };
  assert.equal(shouldLogBreadcrumb(mem, 'facts', withMail), true,
    'mail arriving is a transition and MUST be logged');

  const paused = { ...idleFacts('reconcile', 4000), paused: true };
  assert.equal(shouldLogBreadcrumb(mem, 'facts', paused), true, 'a blocking state change must be logged');
});

test('idleMs alone is never a change (it moves every tick and means nothing on its own)', () => {
  const mem = newBreadcrumbMemory();
  assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 1)), true);
  for (let i = 0; i < 50; i++) {
    assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 1000 * i)), false,
      'a moving idle age must not defeat suppression');
  }
});

test('EVENT-path rows are never suppressed - every real wake keeps its breadcrumb', () => {
  const mem = newBreadcrumbMemory();
  const delivery = { agentId: 'andy-1', cause: 'delivery', mode: 'event', inboxIds: 1 };
  for (let i = 0; i < 10; i++) {
    assert.equal(shouldLogBreadcrumb(mem, 'enter', delivery), true,
      'an event-mode row must log EVERY time, identical or not');
  }
});

test('agents and stages are independent - one busy agent cannot unmute another', () => {
  const mem = newBreadcrumbMemory();
  shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 1000));
  const other = { ...idleFacts('reconcile', 1000), agentId: 'jim-1' };
  assert.equal(shouldLogBreadcrumb(mem, 'facts', other), true, 'a different agent is a different slot');
  assert.equal(shouldLogBreadcrumb(mem, 'no-claim', idleFacts('reconcile', 1000)), true,
    'a different stage is a different slot');
  assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 9000)), false,
    'and the original slot is still suppressed');
});

test('the signature does not depend on key ORDER (a refactor must not silently unmute it)', () => {
  const a = { agentId: 'x', cause: 'reconcile', mode: 'reconcile', inboxIds: 0, paused: false };
  const b = { paused: false, inboxIds: 0, mode: 'reconcile', cause: 'reconcile', agentId: 'x' };
  assert.equal(breadcrumbSignature(a), breadcrumbSignature(b),
    'same fields in a different order must sign the same, or reordering a call site turns dedup off');
});

test('forgetting an agent clears only its slots', () => {
  const mem = newBreadcrumbMemory();
  shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 1));
  shouldLogBreadcrumb(mem, 'facts', { ...idleFacts('reconcile', 1), agentId: 'jim-1' });
  forgetBreadcrumbs(mem, 'andy-1');
  assert.equal(shouldLogBreadcrumb(mem, 'facts', idleFacts('reconcile', 2)), true, 'andy was forgotten');
  assert.equal(shouldLogBreadcrumb(mem, 'facts', { ...idleFacts('reconcile', 2), agentId: 'jim-1' }), false,
    'jim was not');
});
