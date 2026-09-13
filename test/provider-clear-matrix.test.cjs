'use strict';

/**
 * L0-TERMMATRIX — does the candidate clear control actually empty a REAL provider
 * TUI's input box, measured on a rendered screen?
 *
 * THE RULE THIS SERVES (Dwight section 17.3): the matrix must prove BOTH sides —
 * the control removes all automatic text, and it neither submits nor leaves a
 * sendable remainder — from the exact staged states production creates. A provider
 * without that proof is UNKNOWN, and UNKNOWN fails closed: automatic staged
 * submission is disabled for it BEFORE anything is staged. "Unmeasurable is UNKNOWN
 * evidence, not a residual that can be declared passing."
 *
 * HOW THE EVIDENCE WAS OBTAINED, because a matrix is worth exactly what its
 * fixtures are:
 *   - Real provider binaries over a real PTY, captured in my environment.
 *   - An ALREADY-TRUSTED cwd with the provider's real config, so NO CONSENT WAS
 *     GIVEN AND NONE WAS ASKED. Enter was never sent — not to a modal, not to a
 *     box. A provider whose first screen was not positively a composer was aborted
 *     WITHOUT A KEYSTROKE, which is why `agy` has no row: it opened on a trust
 *     dialog. ITS ABSENCE IS UNKNOWN, NOT A PASS.
 *   - Replayed rather than driven live. A capture is a fixture and re-runs
 *     identically where a live process does not, and the predicate reads xterm's
 *     buffer — the screen does not know what produced its bytes.
 *
 * WHAT IS STILL NOT SHOWN, stated so nobody infers it: the live-process half — an
 * Enter actually landing, and a real abort actually erasing in production — needs a
 * box where `node-pty` builds for Electron. It is UNKNOWN here rather than inferred.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = join(__dirname, 'electron-harness', 'scenarios', 'tui-clear-matrix.ts');

test('L0-TERMMATRIX: the clear control, measured per provider on a rendered screen', async () => {
  const r = await runScenario(scenario, { timeoutMs: 90_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);

  const providers = r.providers ?? {};
  const names = Object.keys(providers);
  assert.ok(names.length > 0, 'at least one provider reached a composer and was captured');

  for (const name of names) {
    const p = providers[name];
    assert.equal(p.opened, true, `${name}: both terminals really rendered`);

    // ── THE FINDING THIS MATRIX MADE BEFORE IT MEASURED ANYTHING ───────────────
    // `hasTerminalDraft` is `entry.inputDirty && promptLineHasText(...) !== false`,
    // and `inputDirty` is maintained ONLY by the renderer's `onData` — by KEYSTROKES
    // XTERM SAW. Automatically staged text arrives as PTY OUTPUT and never touches
    // that handler, so the product's own draft predicate is BLIND TO AUTOMATIC TEXT
    // BY CONSTRUCTION: it answers "no draft" whether the box holds our payload or
    // nothing at all. Verifying an abort with it would be a clean pass for the wrong
    // reason. Pinned here rather than worked around, because it is the first thing a
    // future reader will reach for.
    assert.equal(p.staged.hasDraft, false,
      `${name}: hasTerminalDraft is blind to automatically staged text — if this `
      + 'ever becomes true the predicate has changed and the abort design must be re-read');

    // ── THE PRECONDITION. The marker must be ON THE PROMPT ROW: the row at
    // baseY + cursorY is the one production reads, and text elsewhere on screen is
    // scrollback, not a draft. This is the arm a trust modal fails — it swallows the
    // keystrokes and paints nothing.
    assert.equal(p.staged.onPromptRow, true,
      `${name}: the staged marker is on the PROMPT ROW; row was `
      + `${JSON.stringify(p.staged.promptRow)}`);

    // ── THE CONTROL, from the same staged baseline. A harmless key must leave the
    // draft exactly where it was. If it does not, whatever the clear key "did" is a
    // repaint, and this provider's row is not evidence of anything.
    assert.equal(p.restaged.showsMark, true, `${name}: branch B really re-staged`);
    assert.equal(p.afterNoop.onPromptRow, true,
      `${name}: A HARMLESS KEY MUST NOT EMPTY THE BOX — if it does, the instrument is `
      + `measuring repaints rather than effects; row was ${JSON.stringify(p.afterNoop.promptRow)}`);

    // ── THE CANDIDATE. Both sides, as 17.3 requires: gone from the prompt row, and
    // gone from the screen — so the control neither left a sendable remainder nor
    // merely scrolled it out of the way.
    assert.equal(p.afterClear.onPromptRow, false,
      `${name}: the staged text is GONE from the prompt row after the clear; row was `
      + `${JSON.stringify(p.afterClear.promptRow)}`);
    assert.equal(p.afterClear.showsMark, false,
      `${name}: and gone from the screen — not merely pushed off the prompt row`);
  }
});
