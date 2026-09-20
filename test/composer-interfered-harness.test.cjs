'use strict';

/**
 * L0-FUSION stage 5.4d / 5.6 - THE COMPOSER, RENDERED. The production MessageQueueComposer
 * is mounted in a real Electron page against the production store; the only double is the
 * preload bridge. Clicks are TRUSTED input events sent through Chromium at the button's
 * rendered coordinates, and each click first checks that the button IS what is rendered
 * at that point - so a covered, off-screen or unrendered button cannot pass.
 *
 * Stage 5.6 (human ruling, option B): the single "resolved" is TWO actions - "send queued
 * message" and "already handled - drop" - and this file clicks both.
 *
 * What this is worth: what is on the page, and what a person's click does to the QUEUE and
 * what it TELLS main. It says nothing about what main then does (automatic-submit.test.cjs
 * pins the owner: no duplicate, exactly one delivery, every gate; delivery-hold.test.cjs
 * pins the handler).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'composer-interfered.tsx');
let run = null;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 120_000 }));
const ROW = (id, manual = false) => ({ id, manual });

test('INTERFERED is on the page as TWO explicit actions, with the duplicate risk on the button - and no "send now"', async () => {
  const r = await result();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  const i = r.interfered;
  assert.equal(i.shown, true, 'both "send queued message" and "already handled — drop" are rendered');
  assert.match(i.text, /held — someone typed into Alice's terminal while a message was being delivered/, 'the hint says what happened');
  assert.match(i.title, /Nothing was submitted and nothing was erased/, 'the person is told their text is intact');
  assert.match(i.title, /"send now" included/);
  assert.match(i.title, /does not time out/);
  assert.match(i.sendTitle, /sent TWICE/, 'THE DUPLICATE-DELIVERY RISK is on the rendered "send queued message" button itself');
  assert.match(i.dropTitle, /Only that one message is removed/);
  assert.equal(i.resolvedButtons, 0, 'the single ambiguous "resolved" is gone from the page');
  assert.deepEqual([i.axSend, i.axDrop], [1, 1], 'the ACCESSIBILITY TREE hands a screen reader both buttons, by name');
  assert.equal(i.heldTags, 1, 'exactly ONE row is flagged held: the one main names');
  assert.ok(i.text.indexOf('held — typed over, not submitted') < i.text.indexOf('a later message'), 'and it is the FIRST row (m1)');
  assert.equal(i.sendNowButtons, 0, 'NO "send now" while INTERFERED, even though a capacity hold is ALSO in force');
});

test('NOTHING BUT A CLICK resolves it: two poll cycles unattended change nothing', async () => {
  const { unattended } = await result();
  assert.ok(unattended.snapshotReads >= 3, `the composer really was polling main (${unattended.snapshotReads} reads)`);
  assert.equal(unattended.resolveCalls, 0, 'no effect, timer or poll ever called resolveInterference');
  assert.equal(unattended.stillShown, true, 'and the hold did not expire off the page');
});

test('"already handled — drop" when MAIN REFUSES: nothing is dropped', async () => {
  const { refused } = await result();
  assert.deepEqual(refused.calls, [['a1', 'ALREADY_HANDLED']], 'main was asked');
  assert.deepEqual(refused.rows, [ROW('m1'), ROW('m2'), ROW('m3')], 'and because it answered NO, the queue is untouched: a row is dropped only once main confirmed the release');
  assert.equal(refused.stillShown, true);
});

test('a TRUSTED click on "already handled — drop": main is told ALREADY_HANDLED, THAT row goes, and no other', async () => {
  const { dropped } = await result();
  assert.equal(dropped.click.hit, true, 'the button is what is actually rendered at the click point');
  assert.deepEqual(dropped.trusted, [true], 'one click event, isTrusted - Chromium input, not element.click()');
  assert.deepEqual(dropped.calls, [['a1', 'ALREADY_HANDLED']], 'exactly one call, this agent, THIS answer');
  assert.equal(dropped.gone, true);
  assert.deepEqual(dropped.rows, [ROW('m2'), ROW('m3')], 'the HELD item is dropped; the unrelated queued items are neither removed, released nor reordered');
});

test('a TRUSTED click on "send queued message": main is told SEND_AGAIN and the queue keeps the item', async () => {
  const { sentAgain } = await result();
  assert.equal(sentAgain.heldTagsOnM2, 1, 'the newly held row (m2) is the one flagged');
  assert.equal(sentAgain.click.hit, true);
  assert.deepEqual(sentAgain.trusted, [true]);
  assert.deepEqual(sentAgain.calls, [['a1', 'SEND_AGAIN']], 'exactly one call, THIS answer');
  assert.equal(sentAgain.gone, true);
  assert.deepEqual(sentAgain.rows, [ROW('m2'), ROW('m3')],
    'the item STAYS queued, unreleased and in place: re-delivery is main’s ordinary gated drain, not something the button does');
});

test('a held WAKE (not a queue item) is worded as what it is, flags no row, and resolving it touches no row', async () => {
  const { wake, wakeResolved } = await result();
  assert.deepEqual(wake.labels, [1, 1, 0, 0], '"let it retry" / "already handled" - and NOT "send queued message" / "drop": there is no queued message');
  assert.equal(wake.heldTags, 0, 'no queue row is flagged for a hold that is not a queue item');
  assert.match(wake.retryTitle, /start-up message is NOT re-sent/, 'it says what will not happen by itself');
  assert.deepEqual(wakeResolved.calls, [['a1', 'ALREADY_HANDLED']]);
  assert.deepEqual(wakeResolved.rows, [ROW('m2'), ROW('m3')], 'and the queue is exactly as it was');
});

test('what remains is the ENDLESS capacity hold: named, and "send now" is offered and works', async () => {
  const { capacity, released } = await result();
  assert.equal(capacity.offered, true);
  assert.match(capacity.text, /held — spent, reset passed, no refusal: nothing will lift this on its own — use "send now"/);
  assert.match(capacity.title, /NOTHING AUTOMATIC WILL RELEASE IT/);
  assert.equal(capacity.sendNowButtons, 2, '"send now" on every row under a capacity hold');
  assert.equal(capacity.heldTags, 0, 'no row is flagged held any more');
  assert.equal(released.click.hit, true);
  assert.deepEqual(released.trusted, [true]);
  assert.deepEqual(released.rows, [ROW('m3', true), ROW('m2')], 'the clicked row is released and moves to the front');
  assert.equal(released.resolveCalls, 0, 'and "send now" never touches resolveInterference');
});

test('no pool: the queue moves and is said to be OUTSIDE CAPACITY GATING - never available', async () => {
  const { noPool } = await result();
  assert.equal(noPool.noted, true);
  assert.match(noPool.text, /sending to Alice one-by-one… \(outside capacity gating\)/);
  assert.ok(!/\bavailable\b|\bhealthy\b/i.test(noPool.text), 'nothing on the page claims a measured all-clear');
  assert.equal(noPool.sendNowButtons, 0);
});
