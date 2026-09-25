'use strict';

/**
 * L0-UI-B5 — the authorised Electron renderer harness, and the one observation
 * `L0-TERMMATRIX` is blocked on.
 *
 * THE QUESTION, IN god's WORDS: can the harness observe "the input box is empty AND
 * nothing was submitted" for a real provider TUI? Andy's falsifier half works with
 * node-pty alone; the POSITIVE half needs a rendered screen, because
 * `promptLineHasText` returns `null` — "not evidence of anything" — unless the
 * terminal has actually been RENDERED. Since the acquire-time detached attach that
 * property is `entry.everAttached`, set on first attach, and NOT `entry.opened`:
 * every pooled terminal is now opened at acquire, into a host no view has shown, so
 * `opened` no longer distinguishes a screen that exists from one that never has.
 *
 * THESE TESTS LAUNCH A REAL ELECTRON PROCESS. That costs a few seconds and is the
 * whole point: jsdom has no layout engine, so every geometry- or render-dependent
 * reading it produced would be a plausible number that nothing measured.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, runIpcOrder } = require('./electron-harness/run.cjs');

const scenario = (name) => join(__dirname, 'electron-harness', 'scenarios', `${name}.ts`);

test('HARNESS: a real rendered screen can tell an empty prompt box from a full one', async () => {
  const r = await runScenario(scenario('terminal-draft'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);

  // The harness really rendered: a terminal that was opened, measured a cell and
  // sized itself against the window rather than reporting a default nobody set.
  assert.equal(r.opened, true, 'the terminal was really opened');
  assert.ok(r.cols > 0 && r.rows > 0, 'and really measured a grid');

  // THE POSITIVE HALF. Keystrokes were pressed, so the keystroke model says there
  // is a draft; the TUI swallowed them, so the box is empty. The rendered screen
  // overrules the count, which is exactly the reading that needs a screen.
  assert.equal(r.emptyBox.inputDirty, true, 'the keystroke model believes there is a draft');
  assert.match(r.emptyBox.promptRow, /^\S?\s*❯\s*\S?$/u, 'and the rendered prompt row is chrome only');
  assert.equal(r.emptyBox.hasDraft, false, 'EMPTY BOX AND NOTHING SUBMITTED — observable');

  // And it discriminates, rather than answering "empty" to everything.
  assert.ok(r.filledBox.promptRow.includes('write the report'), 'the text really reached the screen');
  assert.equal(r.filledBox.hasDraft, true, 'a real draft still blocks');
});

test('HARNESS: without a rendered screen the same question cannot be answered', async () => {
  // WHY THE HARNESS IS REQUIRED RATHER THAN CONVENIENT. This is the state every
  // node-only route is stuck in: the predicate returns "don't know", falls back to
  // the keystroke count, and reports a draft that is not on screen. It is the
  // phantom-draft bug, and no assertion made without a renderer can see past it.
  const r = await runScenario(scenario('terminal-draft'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true);
  // Since the acquire-time detached attach this terminal IS opened - that is the point of
  // that stage - but it has still never been rendered, which is what the question needs.
  // The claim this test exists for is unchanged and is the second assertion: with no screen
  // to read, the predicate falls back to the keystroke model and keeps the block.
  assert.equal(r.unopened.opened, true, 'opened at acquire, into a host no view has shown');
  assert.equal(r.unopened.everAttached, false, 'but never attached, so never rendered');
  assert.equal(r.unopened.hasDraft, true, 'and the answer is the keystroke model, not the screen');
});

test('HARNESS: the echo window still refuses to clear a block', async () => {
  // The conservative asymmetry survives the harness: inside ECHO_GRACE_MS the
  // screen is showing the past, so it may not clear anything. A harness that made
  // this read "empty" would be manufacturing permission to type over a user.
  const r = await runScenario(scenario('terminal-draft'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true);
  assert.equal(r.insideEchoGrace.hasDraft, true, 'too soon after a keystroke to be evidence');
});

test('HARNESS: the scenario drove production code, not a copy of it', async () => {
  // A harness that reimplemented the predicate would prove nothing about the app.
  // The bridge stub records what the REAL onData handler sent, so a non-zero count
  // is evidence that production keystroke handling ran.
  const r = await runScenario(scenario('terminal-draft'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true);
  assert.ok(r.bridgeWrites > 0, 'the production onData handler ran and wrote to the bridge');
});

test('HARNESS: the A15 IPC-ordering experiment is reproducible, all three phases', async () => {
  // THE POINT IS THE INSTRUMENT, NOT THIS RUN. The published result is 7,060 trials
  // with zero counterexamples, measured on a harness that was never committed - so
  // the figure was true and unreproducible, which is how a measurement decays into
  // a claim. Small counts here keep the suite fast; the full figure is one command:
  //   node test/electron-harness/run-ipc-order.cjs --phase1 2000 --phase2 5000 --phase3 60
  const r = await runIpcOrder({ phase1: 200, phase2: 500, phase3: 5 });
  assert.equal(r.ok, true, `experiment failed: ${r.error ?? ''}`);

  // Printed rather than assumed, as the original note insisted.
  assert.ok(r.build.electron && r.build.chrome && r.build.node, 'the build triple is reported');

  const { production_shape, nothing_awaited, renderer_crashes } = r.phases;
  for (const [name, phase] of Object.entries(r.phases)) {
    // THE ONE COUNTEREXAMPLE THAT COSTS SOMETHING: a write main accepted with no
    // record of the mark that should have preceded it. "Neither arrived" is the
    // safe direction and is counted separately rather than folded in here.
    assert.equal(phase.writeWithoutMark, 0, `${name}: a write arrived without its mark`);
  }
  assert.equal(production_shape.writeAfterMark, 200, 'every production-shape pair ordered');
  assert.equal(nothing_awaited.writeAfterMark, 500, 'and every pair with nothing awaited');
  // Phase 3 is the only one that loses a renderer, so it is the only one that tests
  // what A15 worries about. Rounds may legitimately land as "neither".
  assert.equal(renderer_crashes.writeWithoutMark, 0, 'no crash round lost only its mark');
  assert.equal(
    renderer_crashes.writeAfterMark + renderer_crashes.neither, 5,
    'every crash round landed in one of the two safe outcomes'
  );
});

test('HARNESS: it supports the READS C2.11 #14 needs — and #14 is still unobservable', async () => {
  // THIS IS NOT #14 EVIDENCE AND MUST NEVER BE CITED AS ANY. #14 is about a
  // weekly-blocked capacity strip, and THERE IS NO CAPACITY STRIP IN THE RENDERER.
  // Building one is L0-UI, which is held. So #14 is blocked by an absent SUBJECT,
  // not by a missing instrument, and this test exists to establish exactly that
  // split: the instrument is ready, the component is not.
  const r = await runScenario(scenario('render-capabilities'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);

  // DOM cardinality.
  assert.equal(r.dom.xtermMounted, 1, 'the real component mounted exactly once');

  // COMPUTED STYLE — the reason jsdom was excluded. These are values a layout
  // engine produced: a resolved px size, a resolved rgb colour, and real geometry.
  assert.match(r.computedStyle.fontSizePx, /^\d+(\.\d+)?px$/u, 'font size resolved to px');
  assert.equal(r.computedStyle.colorIsResolvedRgb, true, 'colour resolved to rgb');
  assert.equal(r.computedStyle.laidOut, true, 'the element has real width and height');

  // ACCESSIBILITY TREE, as the platform computes it rather than as markup implies.
  assert.equal(r.accessibility.available, true, 'the accessibility tree is readable');
  assert.ok(r.accessibility.nodes > 0, 'and is populated');

  // RESPONSIVE — the real window resized and the real component reflowed.
  assert.equal(r.responsive.reflowed, true, 'a narrower window really reflowed the component');
  assert.ok(r.responsive.colsAtMinWidth < r.responsive.colsAtFullWidth);

  // AND THE TRAP THIS RUN FOUND, PINNED SO IT CANNOT BE REDISCOVERED THE HARD WAY.
  // xterm paints into a <canvas>, so its rendered text is not in the DOM: a #14
  // duplicate-token scan written against `innerText` would report "no duplicates"
  // for a canvas surface no matter how many times a token was drawn. A clean pass
  // for the wrong reason. For such a surface the accessibility tree is the source.
  assert.equal(r.duplicateScan.domTextIsEmptyBecauseCanvas, true,
    'canvas-rendered text is absent from the DOM');
  assert.ok(r.duplicateScan.accessibleTokens > 0,
    'but IS present in the accessibility tree, which is where a scan must read');
});

test('HARNESS: the measurement is refused unless the screen is POSITIVELY a composer', async () => {
  // PAID FOR BY A VOID RUN, AND THEN CORRECTED BY A SECOND FINDING. The first
  // version of this detector enumerated the trust modals it knew about and measured
  // anything else. Andy's capture showed there are at least FOUR non-composer
  // states rather than one — which you land on depends on whether the CWD or the
  // CONFIG is fresh — but the count is not the argument.
  //
  // THE ARGUMENT IS THAT A DETECTOR WHICH ENUMERATES WHAT TO REFUSE FAILS OPEN ON
  // EVERYTHING IT HAS NOT MET, so the list is always one screen behind the
  // installer. Inverted to refuse by default and admit only what is recognised.
  const r = await runScenario(scenario('tui-preconditions'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);

  for (const [name, s] of Object.entries(r.nonComposer)) {
    assert.equal(s.measurable, false, `${name}: not a composer, so not measurable`);
    // THE COST OF SKIPPING THE PRECONDITION, visible rather than argued: a naive
    // read reports "the box is empty and nothing was submitted" against a screen
    // that has no box at all. Every row of the void run looked like this one.
    assert.equal(s.naiveHasDraft, false, `${name}: a naive read would have passed on it`);
  }

  // And it does not refuse everything, which would be the cheap way to pass above.
  assert.equal(r.composer.emptyMeasurable, true, 'an empty composer IS measurable');
  assert.equal(r.composer.filledMeasurable, true, 'and so is one with text in it');
});

test('HARNESS: a screen nobody enumerated is refused too — the detector fails closed', async () => {
  // THE ARM THAT MATTERS, and the only one that distinguishes the two designs: a
  // blocklist passes every test built from the screens it was written against. This
  // fixture is a made-up dialog nobody has ever met.
  //
  // WHAT FAILING OPEN COSTS HERE IS NOT A VOID ROW. Andy's driver met the
  // Antigravity consent screen, where Enter accepts a Terms of Service and a
  // data-collection agreement ON THE HUMAN'S BEHALF — and a measurement means
  // pressing keys. A wrong refusal costs a re-run; a wrong admission presses Enter
  // on a contract. Those are not the same mistake.
  const r = await runScenario(scenario('tui-preconditions'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true);
  assert.equal(r.nonComposer['a screen nobody has met'].measurable, false,
    'an unknown screen is refused because it is not recognised, not because it is listed');
  assert.equal(r.nonComposer['agy consent'].measurable, false,
    'and so is the consent screen, where Enter accepts a ToS');
});

test('HARNESS: nothing in production blocks automation while any of these owns the screen', async () => {
  // A PRODUCTION FINDING, REPORTED NOT PATCHED. `opensInteractiveTerminalUi` matches
  // what the USER TYPED against a set of bare slash-commands; every screen here is
  // opened by the PROGRAM, so no input passes through that check and the picker
  // block cannot latch. Invisible to the automation seam BY CONSTRUCTION.
  //
  // This establishes the PRECONDITION for the swallowed-text hazard — that the app
  // believes it is safe to type while a modal is up. It does not show the Enter
  // answering the modal; that needs a live TUI, which this environment cannot spawn.
  // Stating the weaker claim because it is the one measured.
  const r = await runScenario(scenario('tui-preconditions'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true);
  for (const [name, s] of Object.entries(r.nonComposer)) {
    assert.equal(s.automationBlock, null, `${name}: the automation seam sees no reason to wait`);
  }
});

test('HARNESS: a reaction with no control is a repaint, and is caught as one', async () => {
  // Codex answers Ctrl-U with exactly the same bytes it answers a harmless arrow
  // key with: a repaint frame, not a clear. Without a control key that reaction
  // reads as a pass — "a falsifier with no control passes on everything".
  const r = await runScenario(scenario('tui-preconditions'), { timeoutMs: 60_000 });
  assert.equal(r.ok, true);
  assert.equal(r.control.ctrlUChanged, true, 'the screen moved after Ctrl-U');
  assert.equal(r.control.arrowChanged, true, 'and moved identically after a key that should do nothing');
  assert.equal(r.control.identicalReaction, true, 'the two reactions are the same frame');
  assert.equal(r.control.verdict, 'REPAINT_NOT_EFFECT', 'so what was observed is not an effect');
});
