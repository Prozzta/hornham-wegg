'use strict';

/**
 * L0-FUSION acquire-time detached attach - on a REAL xterm in a real Electron renderer.
 *
 * THE STAGE'S CLAIM: input provenance is wired for every ACQUIRED terminal, not only for
 * the ones a view has shown. The terminal under test here is never attached until the
 * second arm, so every assertion in the first arm is about a terminal that, before this
 * stage, would have had no element, no listeners and no self-test at all.
 *
 * As in the stage-4 harness, the facts are read where they leave the renderer: the origin
 * argument of `writePty` and the payload of `reportTerminalInputState`, both recorded by a
 * bridge stub. So these are the facts main would receive, not internal flags.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = join(__dirname, 'electron-harness', 'scenarios', 'acquire-attach.ts');

test('ACQUIRE-TIME DETACHED ATTACH: an unviewed terminal has full input provenance', async () => {
  const r = await runScenario(scenario, { timeoutMs: 60_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);

  // ── The terminal is open, and provenance is wired, WITHOUT any view. ──
  assert.equal(r.openedAtAcquire, true, 'xterm is open()ed at acquire time');
  assert.equal(r.hostDetachedAtAcquire, true, 'and its host is genuinely OUT of the document');
  assert.equal(r.provenanceAttachedAtAcquire, true, 'the input-origin DOM half is attached at acquire');
  assert.equal(r.hasTextareaAtAcquire, true, 'xterm built its helper textarea (open() really ran)');

  // ── The self-test proves the reconstruction on a terminal that is still detached. ──
  assert.equal(r.selfTestWhileDetached, 'pass', 'the startup self-test runs and PASSES while detached');
  assert.equal(r.selfTestLeakedBytes, 0, 'NOT ONE BYTE of the self-test reached writePty');
  assert.equal(r.stillDetachedAfterSelfTest, true, 'the terminal was never attached to achieve that');

  // ── What MAIN is told. This is what the eligibility predicate consumes. ──
  assert.equal(r.reportedAttached, true, 'main is told inputOriginAttached:true for an unviewed terminal');
  assert.equal(r.reportedSelfTest, 'pass', 'and that its self-test passed');

  // ── Classification works detached, in both directions. ──
  assert.equal(r.detachedKeyOrigin, 'HUMAN',
    `a keystroke on the detached textarea is HUMAN (data ${JSON.stringify(r.detachedKeyData)})`);
  assert.equal(r.windowClosedBeforeReply, true,
    'the human window really was shut before the reply - otherwise CONTROL proves nothing');
  assert.equal(r.detachedReplyOrigin, 'CONTROL', 'a protocol reply while detached is still CONTROL');

  // ── Attaching must NOT re-open: a second open() orphans the provenance listeners. ──
  assert.equal(r.elementSameAfterAttach, true, 'attach did not recreate term.element (no second open)');
  assert.equal(r.generationUnchangedByAttach, true, 'attach did not re-establish provenance');
  assert.equal(r.noExtraListenerOnAttach, true, 'attach added no second input-origin listener');
  assert.equal(r.hostConnectedAfterAttach, true, 'the host really is in the document after attach');
  assert.equal(r.attachedKeyOrigin, 'HUMAN', 'a keystroke after attach is still HUMAN');
  assert.equal(r.attachedKeyEmissions, 1, 'and is emitted exactly ONCE - no duplicated listener');

  // Sanity only. The one-column cost of opening detached is priced at the attach site in
  // terminalPool.ts and measured side-by-side in the detached-open scenario; it is
  // deliberately NOT asserted here, because the delta is the platform's scrollbar width.
  assert.ok(r.colsAfterFit > 0 && r.rowsAfterFit > 0,
    `the attached terminal fits to a real grid (${r.colsAfterFit}x${r.rowsAfterFit})`);
});
