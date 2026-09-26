'use strict';

/**
 * CODEX-REDRAW-151: nothing around a terminal may change its size when agent STATE changes.
 *
 * Codex (0.154) replays its whole transcript on ANY change of rows or cols, so every sibling
 * of the terminal that grows or shrinks with state is a replay trigger. Measured on the
 * shipped 1.1.50 (isolated instance, a fake Codex logging every grid change): each
 * AgentControlStrip click cost TWO full replays (its 1.8 s confirmation line wrapped onto
 * 2-3 lines in the sidebar, 17 -> 14 -> 17 rows), and the "stopping after this step" span
 * wrapped and cost one more each way.
 *
 * Two layers:
 *  1. RENDERED (electron harness): the production AgentControlStrip and MessageQueueComposer
 *     around a terminal stand-in, 420 px wide as the default sidebar, driven through every
 *     state with trusted clicks. The stand-in's height must not move by a single pixel.
 *  2. STATIC census over the three terminal columns: every conditional render in the chrome
 *     that shares the terminal's column is either inside a zero-height transient anchor or
 *     a single fixed line, so a new one cannot slip in unnoticed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'terminal-chrome-grid.tsx');
let run = null;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 120_000 }));

test('RENDERED: the terminal keeps its exact height through every control and composer state', async () => {
  const r = await result();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  const base = r.steps[0];
  assert.equal(base.step, 'baseline');
  assert.ok(base.height > 100, `the stand-in really fills the column (${base.height}px)`);
  const moved = r.steps.filter((s) => s.height !== base.height);
  assert.deepEqual(moved, [], 'every step must leave the terminal exactly as tall as the baseline: '
    + r.steps.map((s) => `${s.step}=${s.height}`).join(', '));
  assert.ok(r.steps.length >= 9, `all states were driven (${r.steps.length} steps)`);
});

test('STATIC: the control strip flash and status text cannot grow the strip', () => {
  const src = codeOnly(readSource('src/renderer/src/components/AgentControlStrip.tsx'));
  // The flash lives inside a zero-height anchor that is ALWAYS rendered.
  const anchor = src.indexOf('data-transient-anchor');
  assert.ok(anchor > 0, 'a transient anchor exists');
  assert.match(src.slice(anchor, anchor + 80), /position: 'relative', height: 0/);
  const noteAt = src.indexOf('{note && (');
  assert.ok(noteAt > anchor, 'the note renders INSIDE the anchor');
  assert.match(src.slice(noteAt, noteAt + 200), /position: 'absolute'/);
  // No in-flow {note && <span ...>} survives.
  assert.doesNotMatch(src, /\{note && <span/);
  // Every status span is one non-wrapping line.
  for (const key of ['snap?.autoDeliveryPaused', 'snap?.halted', '!!snap?.pendingSteers']) {
    const at = src.indexOf(`{${key} &&`);
    assert.ok(at > 0, `${key} rendered`);
    assert.match(src.slice(at, at + 220), /\.\.\.STATUS_TEXT/, `${key} uses the one-line style`);
  }
  assert.match(src, /const STATUS_TEXT: CSSProperties = \{[^}]*whiteSpace: 'nowrap'[^}]*overflow: 'hidden'[^}]*textOverflow: 'ellipsis'/);
});

test('STATIC: AgentDetailPanel error banner and the composer chrome are grid-stable', () => {
  const panel = codeOnly(readSource('src/renderer/src/components/AgentDetailPanel.tsx'));
  const a = panel.indexOf('data-transient-anchor');
  const e = panel.indexOf('{openTerminalError && (');
  assert.ok(a > 0 && e > a && e - a < 200, 'openTerminalError renders inside a zero-height anchor');
  assert.match(panel.slice(e, e + 200), /position: 'absolute'/);

  const comp = codeOnly(readSource('src/renderer/src/components/MessageQueueComposer.tsx'));
  const row = comp.indexOf('data-fixed-row');
  assert.ok(row > 0, 'the composer header is a fixed row');
  assert.match(comp.slice(row, row + 200), /height: 18, minHeight: 18[^}]*overflow: 'hidden'/);
  const ff = comp.indexOf('{ffHint && (');
  const ffAnchor = comp.lastIndexOf('data-transient-anchor', ff);
  assert.ok(ffAnchor > 0 && ff - ffAnchor < 200, 'the Free Flow hint renders inside a zero-height anchor');
  assert.match(comp.slice(ff, ff + 200), /position: 'absolute'/);
  // The pending list stays the LAG-150 overlay.
  assert.match(comp, /data-queue-overlay[\s\S]{0,80}position: 'absolute'/);
});

// ─── R-1 (Jim's audit of 6f6aa2e0): the floating error must not trap clicks, and must clear ───
const errScenario = path.join(__dirname, 'electron-harness', 'scenarios', 'detail-panel-error-overlay.tsx');
let errRun = null;
const errResult = () => (errRun ??= runScenario(errScenario, { timeoutMs: 120_000 }));

test('RENDERED R-1: a failed "open terminal" floats its error WITHOUT taking the operator controls\' clicks, and clears', async () => {
  const r = await errResult();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.foundOpenButton, true);
  assert.equal(r.alertShown, true, 'the error is shown');
  assert.equal(r.alertPointerEvents, 'none', 'the floating error never takes the pointer');
  assert.equal(r.tipCarriesError, true, 'the full error text is readable from the button tip');
  assert.ok(r.buttonsDuring.length >= 4, `the control buttons were probed (${r.buttonsDuring.length})`);
  const trapped = r.buttonsDuring.filter((b) => b.hits.some((h) => h !== 'button'));
  assert.deepEqual(trapped, [], 'top, centre and bottom of every control still hit the control itself');
  assert.equal(r.tabsDuring, r.tabsBefore, 'the terminal area did not move while the error showed (no grid change)');
  assert.equal(r.alertShownAfter, false, 'the error clears with the button state, not on the next attempt');
  assert.equal(r.tabsAfter, r.tabsBefore);
  // D3: the thrown path (openTerminalAt rejects) shows, stays click-through, and clears too.
  assert.equal(r.thrownAlertShown, true, 'a thrown failure shows the error as well');
  assert.deepEqual(r.thrownButtons.filter((b) => b.hits.some((h) => h !== 'button')), [], 'and does not trap the controls');
  assert.equal(r.thrownAlertShownAfter, false, 'and clears after 4 s like the ok:false path');
});
