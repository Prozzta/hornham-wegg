'use strict';

/**
 * COMPOSER-LAG-152 (Jim's report, god's scope F1 + F2): per-keystroke waste on two typing
 * surfaces.
 *
 *  F1  The Command Center Floor tab's dispatch box kept its draft in FloorTab, so every key
 *      re-rendered the whole dashboard. The draft now lives in a memoised DispatchBox.
 *  F2  The focus-mode private note called setAgentNote per key: a new `agents` array (a
 *      whole-App render) and a roster persistence write per key. The draft is now local and
 *      committed after a pause, on blur, on close and on quit, never lost.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readSource, codeOnly } = require('./read-source.cjs');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = (name) => path.join(__dirname, 'electron-harness', 'scenarios', name);
let f1 = null;
let f2 = null;
const dispatchRun = () => (f1 ??= runScenario(scenario('dispatch-box-renders.tsx'), { timeoutMs: 120_000 }));
const noteRun = () => (f2 ??= runScenario(scenario('note-draft-commits.tsx'), { timeoutMs: 120_000 }));

test('RENDERED F1: typing in the dispatch box re-renders NO part of the AGENTS dashboard', async () => {
  const r = await dispatchRun();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.ok(r.mountedReads > 0, 'the AGENTS render probe saw the mount');
  assert.equal(r.typingReads, 0, `${r.N} keys must not re-render the AGENTS section (the old FloorTab draft: one render per key)`);
  assert.equal(r.typed, 'x'.repeat(r.N), 'the box still takes every key');
  assert.ok(r.realChangeReads > 0, 'a real roster change still renders the AGENTS section (the probe is live)');
});

test('RENDERED F1: dispatch, the task-card seed and the issue assign still work as before', async () => {
  const r = await dispatchRun();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.sentBody, 'ship the fix\n\n(The human suggests Bob (a2) for this — your call as orchestrator.)');
  assert.equal(r.boxAfterSend, '', 'the box clears after a send');
  assert.equal(r.seedText, 'seeded task', 'a task-card assign fills the box');
  assert.equal(r.seedOwner, 'a1', 'a task-card assign leaves the chosen owner alone (as before)');
  assert.equal(r.foundAssign, true);
  assert.equal(r.issueText, 'GitHub Issue #7: Fix the thing\n\ndetails\n\nURL: https://x/7');
  assert.equal(r.issueOwner, '', 'an issue assign resets the owner to "Michael decides" (as before)');
});

test('STATIC F1: the dispatch draft is not FloorTab state', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CommandCenterPanel.tsx'));
  const floor = src.slice(src.indexOf('export function FloorTab('), src.indexOf('const DispatchBox = memo('));
  assert.ok(floor.length > 1000, 'FloorTab found, and DispatchBox after it');
  assert.doesNotMatch(floor, /useState[^;]*\bdispatchText\b|\[dispatchText,/, 'no dispatchText state in FloorTab');
  assert.match(floor, /<DispatchBox agents=\{agents\} seed=\{seed\} issueSeed=\{issueSeed\} \/>/);
  assert.match(src, /const DispatchBox = memo\(function DispatchBox\(/);
});

test('RENDERED F2: N fast keys write the roster ZERO times; the pause writes it ONCE', async () => {
  const r = await noteRun();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.initialValue, 'old', 'the editor opens on the saved note');
  assert.deepEqual(r.duringTyping, { persists: 0, agentsChanges: 0 }, `${r.N} keys: no roster write and no agents change while typing (was ${r.N} of each)`);
  assert.equal(r.noteDuringTyping, 'old');
  assert.deepEqual(r.afterPause, { persists: 1, agentsChanges: 1 }, 'exactly one commit after the pause');
  assert.equal(r.noteAfterPause, r.a);
});

test('RENDERED F2: the note is never lost: blur, close and quit each commit at once', async () => {
  const r = await noteRun();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.deepEqual(r.afterBlur, { persists: 1, agentsChanges: 1 }, 'blur commits without waiting');
  assert.equal(r.noteAfterBlur, r.b);
  assert.deepEqual(r.afterBlurPause, { persists: 1, agentsChanges: 1 }, 'and the debounce does not commit it a second time');
  assert.deepEqual(r.afterClose, { persists: 1, agentsChanges: 1 }, 'closing the editor commits without waiting');
  assert.equal(r.noteAfterClose, r.cText);
  assert.equal(r.reopenedValue, r.cText, 'reopening shows the saved note');
  assert.equal(r.noteAfterUnload, r.d, 'beforeunload commits the pending draft');
  assert.equal(r.lastFlushNote, r.d, 'and the LAST roster mirror write on quit carries it');
});

test('STATIC F2: the roster editor uses the committed draft, not a per-key setAgentNote', () => {
  const ft = codeOnly(readSource('src/renderer/src/components/FullscreenTerminal.tsx'));
  assert.match(ft, /<PrivateNoteTextarea\s+note=\{agent\.note \?\? ''\}\s+onCommit=\{onNoteChange\}/);
  assert.doesNotMatch(ft, /onChange=\{\(e\) => onNoteChange\(/, 'no per-key note commit left');
});
