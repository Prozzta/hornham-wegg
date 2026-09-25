'use strict';

/**
 * L0-FUSION stage 5.4c - the fused transaction against a REAL xterm, in a real Electron
 * renderer. The scenario (electron-harness/scenarios/auto-submit-fusion.ts) states exactly
 * what is real and what is a double; read its header before trusting anything here.
 *
 * In short: the production owner, the production wiring, the production broker, the
 * production terminalPool / inputOrigin / xterm and real timers are all real. The PTY
 * process, pty.ts's generation accounting (node-pty cannot load in a page) and capacity
 * are doubles. So this is evidence that the facts the owner decides on really arrive from
 * a rendered terminal - and it is NOT evidence about pty.ts, about a real provider TUI
 * (provider-clear-matrix.test.cjs replays those) or about the IPC channel names.
 *
 * NO SOURCE MUTANTS RUN HERE: a mutant of terminalPool or inputOrigin would have to be
 * bundled in place of the production file. Instead EVERY ARM HAS A PAIRED CONTROL that
 * differs in exactly the fact under test and ends the other way, so no outcome can be the
 * scenario's default; and the hand mutants that were run against a scratch checkout are
 * named in the commit that added this file.
 *
 * One scenario run, several tests: a real Electron process costs seconds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'auto-submit-fusion.ts');
let run = null;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 90_000 }));

test('the scenario ran, every terminal rendered, and both mirrors ARRIVED through the production path', async () => {
  const r = await result();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.gapMs, 140, 'the gap is the production 140ms, in real time');
  for (const arm of ['ctl', 'int', 'cpr', 'abt', 'abn', 'drf']) assert.equal(r[arm].ready, true, `${arm}: input-state mirror, prompt mirror and self-test all arrived`);
  assert.deepEqual(r.ctl.inputState, { mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'pass' },
    'eligibility is decided on the REAL mirrored input state');
  assert.deepEqual(r.ctl.promptBlocksBefore, [null], 'the prompt mirror reported a FREE prompt (null), which is news and not silence');
});

test('ctl - nobody types: text, then Enter, exactly once (the baseline every arm is paired with)', async () => {
  const { ctl } = await result();
  assert.deepEqual(ctl.outcome, { kind: 'COMMITTED' });
  assert.deepEqual(ctl.ownerWrites, ['control message one', '\r']);
  assert.deepEqual(ctl.submitted, ['control message one']);
});

test('int - A GENUINE KEYDOWN AFTER STAGE: INTERFERED, no Enter, no clear, and the human text is still on the prompt row', async () => {
  const { int } = await result();
  assert.deepEqual(int.humanBytes, ['x'], 'the real keydown left the renderer declared HUMAN - classified by the production inputOrigin, not by this test');
  assert.deepEqual(int.outcome, { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' });
  assert.deepEqual(int.writesAtOutcome, ['interfered message two'], 'the owner wrote its payload and NOTHING after it: no Enter, no Ctrl-U, no retry');
  assert.deepEqual(int.submitted, [], 'nothing was submitted to the TUI');
  assert.equal(int.promptRow, '> interfered message twox', 'THE RENDERED PROMPT ROW still holds the staged text AND the human’s key');
  assert.deepEqual(int.oracle, { onPromptRow: true, screenCount: 1 });
});

test('int - the hold: every class refused, no timer, and a human resolution types nothing and licenses nothing', async () => {
  const { int } = await result();
  assert.deepEqual(int.again, { kind: 'REFUSED', reason: 'PTY_INHIBITED' }, 'automatic delivery is refused');
  assert.deepEqual(int.manual, { kind: 'REFUSED', reason: 'PTY_INHIBITED' }, 'and so is "send now" - which is why the composer never offers it while INTERFERED');
  assert.deepEqual([int.bare, int.stillHeld], [false, true], 'a bare "resolved" is NOT a resolution: refused, and the hold stays (option B has no default)');
  assert.equal(int.resolved, true, '"send queued message" releases it');
  assert.equal(int.lineAfterResolve, int.lineBeforeResolve, 'resolving typed nothing and cleared nothing');
  assert.equal(int.inhibitedAtEnd, false, 'the inhibition ended with the human’s resolution');
  assert.deepEqual(int.afterResolve, { kind: 'REFUSED', reason: 'PROMPT_DRAFT' },
    'and the next automatic delivery STILL refuses to type over the human’s text: the real prompt mirror says draft');
  assert.deepEqual(int.ownerWritesAtEnd, ['interfered message two'], 'across all of it the owner never wrote again');
});

test('cpr - a cursor-position reply in the gap is CONTROL, not a person: no INTERFERED (paired with int)', async () => {
  const { cpr } = await result();
  assert.ok(cpr.replyAt > cpr.payloadAt && cpr.replyAt < cpr.enterAt,
    `xterm’s CPR reply really landed BETWEEN the payload and the Enter (${cpr.payloadAt} < ${cpr.replyAt} < ${cpr.enterAt}) - otherwise this arm proves nothing`);
  assert.equal(cpr.replyOrigin, 'CONTROL', 'the production classifier declared it CONTROL');
  assert.equal(cpr.generation, 0, 'so the human generation never moved');
  assert.deepEqual(cpr.outcome, { kind: 'COMMITTED' });
  assert.deepEqual(cpr.submitted, ['cpr message three']);
});

test('abt - a late refusal: Ctrl-U, and the erase VERIFIED ON THE RENDERED SCREEN through the real broker and responder', async () => {
  const { abt } = await result();
  assert.deepEqual(abt.outcome, { kind: 'ABORTED', detail: 'LIMITED' });
  assert.deepEqual(abt.ownerWrites, ['late refusal abt four', '\x15'], 'payload, then the measured clear - and never an Enter');
  assert.deepEqual(abt.submitted, []);
  assert.equal(abt.screenAnswers, 2, 'the differential oracle asked the renderer twice: before and after the clear');
  assert.equal(abt.promptRow, '> ', 'the rendered prompt row is empty again');
  assert.equal(abt.inhibited, false, 'a verified abort leaves no hold');
});

test('abn - the SAME late refusal on a TUI that ignores Ctrl-U: never claimed as an abort (paired with abt)', async () => {
  const { abn } = await result();
  assert.deepEqual(abn.outcome, { kind: 'INTERFERED', reason: 'ERASE_NOT_VERIFIED', detail: 'row=true count=1/1' },
    'the screen still shows the text, so the owner says so instead of reporting ABORTED');
  assert.deepEqual(abn.ownerWrites, ['late refusal abn four', '\x15'], 'no Enter, no second clear, no retry');
  assert.deepEqual(abn.submitted, []);
  assert.equal(abn.promptRow, '> late refusal abn four', 'the text is left where it is for a person');
  assert.equal(abn.inhibited, true);
});

test('drf - THE PROMPT MIRROR END TO END: a human draft is mirrored and automatic delivery types nothing (paired with ctl)', async () => {
  const { drf } = await result();
  assert.equal(drf.mirrored, true, 'the production mirror reported the draft');
  assert.deepEqual(drf.promptBlocks, [null, 'draft'], 'free at first, then draft once real keys were typed');
  assert.deepEqual(drf.outcome, { kind: 'REFUSED', reason: 'PROMPT_DRAFT' }, 'refused for the DRAFT (human quiet time had already passed)');
  assert.deepEqual(drf.ownerWrites, [], 'NOTHING was typed onto the human’s line');
  assert.equal(drf.promptRow, '> hi', 'and their text is untouched on the rendered row');
});
