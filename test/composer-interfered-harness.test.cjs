'use strict';

/**
 * L0-FUSION stage 5.4d - THE COMPOSER, RENDERED. The production MessageQueueComposer is
 * mounted in a real Electron page against the production store; the only double is the
 * preload bridge. Clicks are TRUSTED input events sent through Chromium at the button's
 * rendered coordinates, and each click first checks that the button IS what is rendered
 * at that point - so a covered, off-screen or unrendered button cannot pass.
 *
 * What this is worth: what is on the page, and what a person's click does. It says
 * nothing about main's side of the IPC (delivery-hold.test.cjs pins the handler;
 * automatic-submit-harness.test.cjs runs the real owner).
 *
 * WHAT IS DELIBERATELY NOT PINNED: what happens to the held message AFTER "resolved". That
 * question (resume / two explicit actions / never resend) is with the human; this file
 * pins only that the click itself changes no queue row, which is true of every option.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'composer-interfered.tsx');
let run = null;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 90_000 }));

test('INTERFERED is on the page: why, which message, one action - and no "send now"', async () => {
  const r = await result();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  const i = r.interfered;
  assert.equal(i.shown, true);
  assert.match(i.text, /held — someone typed into Alice's terminal while a message was being delivered/, 'the hint says what happened');
  assert.match(i.title, /Nothing was submitted and nothing was erased/, 'the person is told their text is intact');
  assert.match(i.title, /"send now" included/, 'and that send-now will not get past it');
  assert.match(i.title, /does not time out/);
  assert.equal(i.resolvedButtons, 1, 'exactly one "resolved" button');
  assert.equal(i.axResolved, 1, 'and the ACCESSIBILITY TREE hands a screen reader a button named "resolved"');
  assert.equal(i.heldTags, 1, 'exactly ONE row is flagged held: the one main names, not its neighbour');
  assert.ok(i.text.indexOf('held — typed over, not submitted') < i.text.indexOf('a later message'), 'and it is the FIRST row (m1)');
  assert.equal(i.sendNowButtons, 0, 'NO "send now" while INTERFERED, even though a capacity hold is ALSO in force - main would refuse it');
});

test('NOTHING BUT A CLICK resolves it: two poll cycles unattended change nothing', async () => {
  const { unattended } = await result();
  assert.ok(unattended.snapshotReads >= 3, `the composer really was polling main (${unattended.snapshotReads} reads) - otherwise "nothing happened" proves nothing`);
  assert.equal(unattended.resolveCalls, 0, 'no effect, timer or poll ever called resolveInterference');
  assert.equal(unattended.stillShown, true, 'and the hold did not expire off the page');
});

test('a REAL, TRUSTED click on the RENDERED button resolves it - once, for this agent', async () => {
  const { clicked } = await result();
  assert.equal(clicked.click.hit, true, 'the button is what is actually rendered at the click point');
  assert.deepEqual(clicked.trusted, [true], 'one click event, isTrusted - Chromium input, not element.click()');
  assert.deepEqual(clicked.resolveCalls, ['a1'], 'resolveInterference was called exactly once, with this agent');
  assert.equal(clicked.gone, true, 'and the button left the page once main said the hold was gone');
  assert.deepEqual(clicked.rows, [{ id: 'm1', manual: false }, { id: 'm2', manual: false }],
    'the click itself removed nothing, released nothing and reordered nothing');
});

test('what remains is the ENDLESS capacity hold: named, and "send now" is offered and works', async () => {
  const { capacity, released } = await result();
  assert.equal(capacity.offered, true);
  assert.match(capacity.text, /held — spent, reset passed, no refusal: nothing will lift this on its own — use "send now"/,
    'the hint ITSELF names the state in god’s words and the way out');
  assert.match(capacity.title, /NOTHING AUTOMATIC WILL RELEASE IT/);
  assert.equal(capacity.sendNowButtons, 2, '"send now" on every row under a capacity hold (it used to exist only under the floor pause)');
  assert.equal(capacity.heldTags, 0, 'no row is flagged held any more');
  assert.equal(released.click.hit, true);
  assert.deepEqual(released.trusted, [true]);
  assert.deepEqual(released.rows, [{ id: 'm2', manual: true }, { id: 'm1', manual: false }], 'the clicked row is released and moves to the front');
  assert.equal(released.resolveCalls, 1, 'and "send now" never touches resolveInterference');
});

test('no pool: the queue moves and is said to be OUTSIDE CAPACITY GATING - never available', async () => {
  const { noPool } = await result();
  assert.equal(noPool.noted, true);
  assert.match(noPool.text, /sending to Alice one-by-one… \(outside capacity gating\)/);
  assert.ok(!/\bavailable\b|\bhealthy\b/i.test(noPool.text), 'nothing on the page claims a measured all-clear');
  assert.equal(noPool.sendNowButtons, 0, 'nothing is held, so nothing offers an override');
});
