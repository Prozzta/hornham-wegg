'use strict';

/**
 * L0-FUSION stage 4 - input provenance, the PURE half and the CALL-GRAPH half.
 *
 * What a unit test can prove here, and what it cannot, stated up front so a green run
 * is not read as more than it is:
 *
 *   PROVES  the wire type refuses anything that is not one of the three origins; the
 *           eligibility predicate's whole truth table, including that it is fail-closed
 *           on absence and re-entrant on a mode change; the mirror validator refuses a
 *           malformed report; and - by reading the source, the way
 *           command-name-validation.test.cjs pins its three sites - that EVERY renderer
 *           `writePty` call declares an origin, that PROGRAMMATIC has exactly the callers
 *           the design allows, that the IPC handler consults the validator, that
 *           `attachInputOrigin` sits inside the `open()` guard, and that focus/blur are in
 *           no listened-to list.
 *
 *   DOES NOT PROVE  anything about a real xterm: the two closing regimes, the drain,
 *           the self-test, the mouse-mode mirror. Those need a rendered terminal and live
 *           in test/input-origin-harness.test.cjs. A unit test that calls increment()
 *           directly proves only the counter - the human's own words - so the generation
 *           test below drives PtyManager.write() through a fake session, not a counter.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { isInputOrigin, INPUT_ORIGINS } = loadTs('src/shared/inputOrigin.ts');
const {
  automaticDeliveryEligibility, isTerminalInputState, sameInputState
} = loadTs('src/shared/inputProvenance.ts');

const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ─── the wire type ──────────────────────────────────────────────────────────

test('the wire origin is exactly three values and nothing else passes', () => {
  assert.deepEqual([...INPUT_ORIGINS].sort(), ['CONTROL', 'HUMAN', 'PROGRAMMATIC']);
  for (const ok of INPUT_ORIGINS) assert.equal(isInputOrigin(ok), true, ok);
  // Every plausible mistake a caller could make. `undefined` is the important one:
  // an OMITTED origin must be refused at the boundary, not defaulted to CONTROL.
  for (const bad of [undefined, null, '', 'human', 'Human', 'USER', 'control', true, 1, {}, [], 'HUMAN ']) {
    assert.equal(isInputOrigin(bad), false, `refuses ${JSON.stringify(bad)}`);
  }
});

// ─── the predicate, whole truth table ───────────────────────────────────────

const GOOD = { mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'pass' };

test('eligibility fails CLOSED on absence: no mirror is UNKNOWN, and UNKNOWN is ineligible', () => {
  assert.deepEqual(automaticDeliveryEligibility(undefined), { eligible: false, reason: 'NO_STATE' });
  assert.deepEqual(automaticDeliveryEligibility(null), { eligible: false, reason: 'NO_STATE' });
});

test('eligibility refuses each missing precondition by NAME, in evidence order', () => {
  assert.deepEqual(automaticDeliveryEligibility({ ...GOOD, inputOriginAttached: false }),
    { eligible: false, reason: 'UNATTACHED' });
  assert.deepEqual(automaticDeliveryEligibility({ ...GOOD, selfTest: 'unknown' }),
    { eligible: false, reason: 'SELFTEST_UNKNOWN' });
  assert.deepEqual(automaticDeliveryEligibility({ ...GOOD, selfTest: 'fail' }),
    { eligible: false, reason: 'SELFTEST_FAILED' });
  for (const mode of ['x10', 'vt200', 'drag', 'any']) {
    assert.deepEqual(automaticDeliveryEligibility({ ...GOOD, mouseTrackingMode: mode }),
      { eligible: false, reason: 'MOUSE_TRACKING', detail: mode }, mode);
  }
  assert.deepEqual(automaticDeliveryEligibility(GOOD), { eligible: true });
});

test('eligibility is RE-ENTRANT: the same terminal flips with its mode and flips back', () => {
  // The human's amendment: a TUI can enable tracking after arming and disable it later.
  // The predicate carries no memory, so the answer follows the state on every call.
  const live = { ...GOOD };
  assert.equal(automaticDeliveryEligibility(live).eligible, true);
  live.mouseTrackingMode = 'drag';
  assert.equal(automaticDeliveryEligibility(live).eligible, false);
  live.mouseTrackingMode = 'none';
  assert.equal(automaticDeliveryEligibility(live).eligible, true);
});

test('a mutant that ignores attachment or the self-test is killed', () => {
  // Attached-but-unproven and unattached-but-"proven" are both ineligible. A version
  // that only looks at the mouse mode passes the mode tests and fails these two.
  assert.equal(automaticDeliveryEligibility({ ...GOOD, selfTest: 'unknown' }).eligible, false);
  assert.equal(automaticDeliveryEligibility({ ...GOOD, inputOriginAttached: false, selfTest: 'pass' }).eligible, false);
});

// ─── the mirror validator ───────────────────────────────────────────────────

test('the mirror validator refuses a malformed report rather than storing it', () => {
  assert.equal(isTerminalInputState(GOOD), true);
  for (const bad of [
    undefined, null, 'none', 42,
    { ...GOOD, mouseTrackingMode: 'on' },
    { ...GOOD, mouseTrackingMode: undefined },
    { ...GOOD, inputOriginAttached: 'yes' },
    { ...GOOD, selfTest: 'passed' },
    { mouseTrackingMode: 'none', inputOriginAttached: true }
  ]) assert.equal(isTerminalInputState(bad), false, JSON.stringify(bad));
});

test('sameInputState is structural, so the renderer reports on change only', () => {
  assert.equal(sameInputState(GOOD, { ...GOOD }), true);
  assert.equal(sameInputState(undefined, GOOD), false);
  assert.equal(sameInputState(GOOD, { ...GOOD, selfTest: 'unknown' }), false);
  assert.equal(sameInputState(GOOD, { ...GOOD, mouseTrackingMode: 'any' }), false);
});

// ─── the generation: through write(), not through a counter ────────────────

test('PtyManager.write advances the human generation ONLY for HUMAN and ONLY on an accepted write', () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  // Reach the private map the way a fake pty would arrive: one live session whose
  // proc.write we control. No node-pty spawn; the property under test is the
  // ordering inside write(), not the pipe.
  let throwNext = false;
  const written = [];
  pm.sessions.set('t1', {
    id: 't1', cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true,
    humanInputGeneration: 0,
    proc: { write: (d) => { if (throwNext) throw new Error('pipe closed'); written.push(d); } }
  });

  assert.equal(pm.humanInputGeneration('t1'), 0);
  assert.deepEqual(pm.write('t1', 'a', 'CONTROL'), { ok: true });
  assert.deepEqual(pm.write('t1', 'b', 'PROGRAMMATIC'), { ok: true });
  assert.equal(pm.humanInputGeneration('t1'), 0, 'CONTROL and PROGRAMMATIC never advance it');

  assert.deepEqual(pm.write('t1', 'c', 'HUMAN'), { ok: true });
  assert.equal(pm.humanInputGeneration('t1'), 1, 'HUMAN advances it');

  throwNext = true;
  assert.equal(pm.write('t1', 'd', 'HUMAN').ok, false);
  assert.equal(pm.humanInputGeneration('t1'), 1,
    'a REFUSED human write must not count - the advance is after proc.write, in the same try');
  throwNext = false;

  assert.equal(pm.write('nope', 'e', 'HUMAN').ok, false);
  assert.equal(pm.humanInputGeneration('nope'), undefined, 'a dead pty has no generation, not zero');
  assert.deepEqual(written, ['a', 'b', 'c'], 'exactly the accepted bytes reached the pipe');
});

test('the generation is per-session and dies with the session', () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  const mk = (id) => ({ id, cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true,
    humanInputGeneration: 0, proc: { write: () => {} } });
  pm.sessions.set('a', mk('a'));
  pm.sessions.set('b', mk('b'));
  pm.write('a', 'x', 'HUMAN');
  assert.equal(pm.humanInputGeneration('a'), 1);
  assert.equal(pm.humanInputGeneration('b'), 0, 'a human on one pty is not a human on another');
  pm.sessions.delete('a');
  assert.equal(pm.humanInputGeneration('a'), undefined, 'gone with the incarnation, never inherited');
});

// ─── the call graph, read from the source ───────────────────────────────────

test('EVERY renderer writePty call declares an origin - none can omit it', () => {
  const files = [
    'src/renderer/src/components/terminalPool.ts',
    'src/renderer/src/components/PtyTerminalView.tsx',
    'src/renderer/src/hooks/useHive.ts'
  ];
  // Per LINE, not per regex-captured argument list: two of the CONTROL writes carry a
  // template literal with a ';' inside it, which a lazy [^;] capture cuts short. The
  // first version of this test did exactly that and counted six of eight - right to be
  // strict about the count, wrong about how it read the source.
  const calls = [];
  for (const f of files) {
    for (const raw of src(f).split('\n')) {
      const line = raw.trim();
      if (line.includes('window.cth.writePty(') && !line.startsWith('//') && !line.startsWith('*')) {
        calls.push({ f, line });
      }
    }
  }
  assert.equal(calls.length, 8, `found ${calls.length} writePty calls; the design has exactly eight:\n`
    + calls.map((c) => c.f + ': ' + c.line).join('\n'));
  for (const c of calls) {
    // Either a literal origin or the classifier - never two bare arguments.
    assert.match(c.line, /'(HUMAN|CONTROL|PROGRAMMATIC)'\)|classifyOutbound\(/,
      `${c.f}: ${c.line} does not declare an origin`);
  }
});

test('PROGRAMMATIC has exactly the callers the design allows: the two automatic owners', () => {
  const renderer = src('src/renderer/src/hooks/useHive.ts');
  const main = src('src/main/index.ts');
  const others = ['src/renderer/src/components/terminalPool.ts', 'src/renderer/src/components/PtyTerminalView.tsx']
    .map(src).join('\n');
  assert.equal((renderer.match(/'PROGRAMMATIC'/g) || []).length, 2, 'useHive: payload and Enter');
  assert.equal((main.match(/'PROGRAMMATIC'/g) || []).length, 2, 'main: nudge text and Enter');
  assert.equal((others.match(/'PROGRAMMATIC'/g) || []).length, 0, 'nowhere else in the renderer');
});

test('the IPC boundary consults the validators, and refuses rather than defaults', () => {
  const main = src('src/main/index.ts');
  const write = main.slice(main.indexOf("ipcMain.handle('pty:write'"), main.indexOf("ipcMain.handle('pty:inputState'"));
  assert.match(write, /if \(!isInputOrigin\(origin\)\) return \{ ok: false, error: 'invalid origin' \}/);
  assert.doesNotMatch(write, /origin \?\?|origin \|\||= 'CONTROL'/, 'no default origin at the boundary');
  const state = main.slice(main.indexOf("ipcMain.handle('pty:inputState'"), main.indexOf("ipcMain.handle('pty:automaticDeliveryEligibility'"));
  assert.match(state, /if \(!isTerminalInputState\(state\)\) return \{ ok: false, error: 'invalid input state' \}/);
});

test('attachInputOrigin is called INSIDE the open() guard and nowhere else', () => {
  const pool = src('src/renderer/src/components/terminalPool.ts');
  const guardStart = pool.indexOf('if (!entry.opened) {');
  const guardEnd = pool.indexOf('\n  }\n', guardStart);
  const inside = pool.slice(guardStart, guardEnd);
  assert.match(inside, /entry\.term\.open\(entry\.host\)/);
  assert.match(inside, /attachInputOrigin\(entry\.ptyId, entry\.term\)/,
    'the attach sits inside the guard, after open()');
  assert.equal((pool.match(/attachInputOrigin\(/g) || []).length, 1, 'exactly one attach site');
  assert.match(inside, /LOAD-BEARING FOR INPUT PROVENANCE/, 'and the guard says why, AT the guard');
});

test('focus and blur are excluded by name and appear in no listened-to list', () => {
  const { SAME_TICK_EVENTS, HELD_EVENTS, EXCLUDED_EVENTS } = loadTs('src/renderer/src/components/inputOrigin.ts');
  assert.deepEqual([...EXCLUDED_EVENTS], ['focus', 'blur']);
  for (const e of EXCLUDED_EVENTS) {
    assert.equal(SAME_TICK_EVENTS.includes(e), false, `${e} not same-tick`);
    assert.equal(HELD_EVENTS.includes(e), false, `${e} not held`);
  }
  // And nothing addEventListener()s them anywhere in the module.
  const mod = src('src/renderer/src/components/inputOrigin.ts');
  assert.doesNotMatch(mod, /addEventListener\(\s*'(focus|blur)'/);
});

test('the provenance module reads no private xterm state and never touches wasUserInput', () => {
  const mod = src('src/renderer/src/components/inputOrigin.ts');
  assert.doesNotMatch(mod, /_core\b|coreService|_onUserInput|onUserInput/, 'R1: public surface only');
  assert.doesNotMatch(mod, /hasTerminalDraft|inputDirty/, 'the prohibited oracles are not consulted');
});
