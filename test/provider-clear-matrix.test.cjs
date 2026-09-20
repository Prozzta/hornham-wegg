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
 *     WITHOUT A KEYSTROKE, which is why `agy` had no row at first: it opened on a trust
 *     dialog, and ABSENCE IS UNKNOWN, NOT A PASS. Its row was added only after the HUMAN
 *     trusted one scratch folder by hand and the same tool was re-run (see the scenario).
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

    // ── L0-FUSION §9.3 DIMENSION 5, PINNED AS AN ASSERTION ──────────────────
    // A public-only human-input adapter CANNOT see mouse-origin input: xterm's drag
    // and release reports (CoreMouseService.ts:284) and alt-click cursor movement
    // (SelectionService.ts:711) both fire from DOCUMENT-level listeners, outside
    // term.element. The only safe response is to refuse to arm automatic delivery
    // while mouse tracking is live — so whether these TUIs enable it decides whether
    // that refusal is occasional or permanent.
    // MEASURED HERE FROM XTERM'S OWN `modes`, not from a regex over DECSET bytes.
    // If a provider ever starts enabling mouse tracking, THIS BREAKS AND SAYS SO,
    // because the feasibility answer changes rather than merely getting worse.
    assert.equal(p.modes.atBoot.mouseTrackingMode, 'none',
      `${name}: mouse tracking is OFF at boot — if this is ever anything but 'none', `
      + 'a public-only input adapter must refuse to arm on this provider and the '
      + '§9.3 determination has to be re-read');
    assert.equal(p.modes.atEnd.mouseTrackingMode, 'none',
      `${name}: mouse tracking is still off after staging and clearing — one reading `
      + 'at boot cannot tell "never" from "not yet", so it is read twice');

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

    // ── L0-FUSION STAGE 5.4c: THE PRODUCTION ERASE ORACLE, ON THE REAL CAPTURES ──────
    // Everything above is the scenario's OWN reading of the screen. The submit owner
    // does not ask the scenario; it asks `readScreenForNeedle` (terminalPool.ts), twice
    // around a clear, and applies ONE rule (automaticSubmit.ts): before must be on the
    // prompt row with count >= 1; after must be OFF the prompt row AND counted FEWER
    // times. These arms run that function on this provider's real rendered capture and
    // apply that rule written out here, so "the oracle works on claude / codex /
    // antigravity" is a measurement and not an inference from a fake TUI.
    const o = p.oracle;
    assert.deepEqual(o.staged && o.staged.onPromptRow, true, `${name}: the production oracle SEES the staged text on the prompt row: ${JSON.stringify(o.staged)}`);
    assert.equal(o.staged.screenCount, o.stagedScreenCount, `${name}: and counts the rows the independent reading counts`);
    assert.ok(o.staged.screenCount >= 1, `${name}: the owner's "before" precondition holds`);
    const erased = (before, after) => !!before && before.onPromptRow && before.screenCount >= 1
      && !!after && !after.onPromptRow && after.screenCount < before.screenCount;
    assert.equal(erased(o.staged, o.afterClear), true,
      `${name}: AFTER THE MEASURED CLEAR the owner's rule says ERASED: ${JSON.stringify([o.staged, o.afterClear])}`);
    assert.equal(erased(o.staged, o.afterNoop), false,
      `${name}: AFTER A HARMLESS KEY the owner's rule says NOT ERASED - it would hold the prompt as INTERFERED rather than claim an abort: ${JSON.stringify([o.staged, o.afterNoop])}`);
    assert.deepEqual(o.absent, { onPromptRow: false, screenCount: 0 }, `${name}: text that was never staged is found nowhere`);
    assert.equal(o.emptyNeedle, null, `${name}: an empty needle is NO reading - never "found everywhere"`);
  }
});
