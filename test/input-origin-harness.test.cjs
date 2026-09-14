'use strict';

/**
 * L0-FUSION stage 4 - input provenance on a REAL xterm in a real Electron renderer.
 *
 * Everything here is read at the one place the fact leaves the renderer: the origin
 * argument of `writePty`, recorded by a bridge stub. So each assertion is about what
 * main would have been told, not about an internal flag.
 *
 * The self-test arm is the one to read twice. It proves the reconstruction's ordering
 * assumption holds on THIS build - and that the test itself put NOT ONE BYTE on the wire.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = join(__dirname, 'electron-harness', 'scenarios', 'input-origin.ts');

test('INPUT ORIGIN on a rendered terminal: regimes, exclusions, programmatic paste, self-test, mirror', async () => {
  const r = await runScenario(scenario, { timeoutMs: 60_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.opened, true, 'the terminal was really opened');

  // The self-test ran, passed, and leaked nothing to the pty.
  assert.equal(r.selfTest, 'pass', 'the startup self-test proves the reconstruction on this build');
  assert.equal(r.selfTestLeakedBytes, 0, 'NOT ONE BYTE from the self-test reached writePty');

  // Same-tick regime: a keyboard event classifies HUMAN and the window is shut a tick later.
  assert.equal(r.keyboard.origin, 'HUMAN', `keyboard -> HUMAN (data ${JSON.stringify(r.keyboard.data)})`);
  assert.equal(r.keyboardWindowClosed, true, 'and the same-tick window closed in a microtask');

  // Constraint (i), by construction: xterm flags both of these wasUserInput=true internally.
  assert.equal(r.programmaticInput, 'CONTROL', 'term.input() with no DOM event is CONTROL');
  assert.equal(r.programmaticPaste, 'CONTROL', 'programmatic Terminal.paste() is CONTROL, whatever xterm thinks');
  assert.equal(r.markedPaste, 'HUMAN', 'the same paste, marked at code we own, is HUMAN');

  // Protocol replies never ride a human window.
  assert.equal(r.dsrReply.origin, 'CONTROL', `a DSR reply is CONTROL (data ${JSON.stringify(r.dsrReply.data)})`);

  // Focus is excluded by name - measured necessity, claude has focus reporting on.
  assert.equal(r.focusReport, 'CONTROL', 'a focus report emitted inside a focus dispatch is CONTROL');

  // BLOCKER 1 (Dwight 23.2): a protocol reply INSIDE a held IME window is CONTROL, not
  // HUMAN, and does not consume or extend the window - a human byte after it is still HUMAN.
  assert.equal(r.heldOpenBeforeReply, true, 'the composition event really opened a held window');
  assert.equal(r.replyInHeld, 'CONTROL', 'a DSR/CPR reply inside the held drain is CONTROL, never HUMAN');
  assert.equal(r.humanAfterReplyInHeld, 'HUMAN', 'and the reply did not destroy the held window for real input');

  // Held regime: composition data on a LATER tick is still HUMAN, to the last byte...
  assert.equal(r.compositionNextTick, 'HUMAN', 'constraint (iii): composition data on the next tick is HUMAN');
  assert.equal(r.compositionSecondByte, 'HUMAN', 'and so is the second byte of the burst');
  // ...and the drain does close.
  assert.equal(r.afterDrain.origin, 'CONTROL', `after ${r.afterDrain.drainMs}ms of quiet the held window is shut`);

  // The mirror follows the TUI both ways, from xterm's own modes.
  assert.equal(r.mirror.afterOn, 'vt200', 'DECSET 1000 -> xterm says vt200 -> main is told');
  assert.equal(r.mirror.afterOff, 'none', 'DECRST 1000 -> none -> main is told again (re-entrant)');
  assert.equal(r.mirror.xtermNow, 'none');
  assert.ok(r.mirror.reports >= 2, 'at least one report per change');

  // BLOCKER 4 (Dwight 23.3): same-id respawn re-establishes provenance; a rejected report retries.
  assert.equal(r.selfTestResetImmediate, 'unknown', 'a reset returns the entry to unproven at once');
  assert.equal(r.selfTestAfterReset, 'pass', 'and the self-test re-runs to pass for the new incarnation');
  assert.ok(r.reportsAfterReset >= 1, 'a fresh state is reported after the reset, not the stale cache');
  assert.equal(r.lastReportSelfTest, 'pass', 'and the last post-reset report carries the proven state');
  assert.equal(r.retryLanded, true, 'a report main rejected once was retried on backoff and accepted');
});
