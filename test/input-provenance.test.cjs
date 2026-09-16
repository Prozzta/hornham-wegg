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

/** Every .ts/.tsx file under a source subtree - so a census cannot be evaded by adding
 *  a NEW file the test did not name (Dwight 23.4). Returns repo-relative POSIX paths. */
function walk(rel) {
  const abs = path.join(__dirname, '..', rel);
  const out = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel + '/' + ent.name;
    if (ent.isDirectory()) out.push(...walk(childRel));
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(childRel);
  }
  return out;
}

/** Every `.writePty(` call in `text`, each returned as its balanced-paren argument
 *  substring - so a MULTILINE call is read whole rather than by its first line. */
function writePtyCalls(text) {
  const calls = [];
  const re = /\.writePty\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    calls.push(text.slice(m.index, i).replace(/\s+/g, ' '));
  }
  return calls;
}

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

test('SOURCE CENSUS: every writePty call in the WHOLE renderer tree declares an origin', () => {
  // Exhaustive over src/renderer, not three named files, and balanced-paren so a
  // multiline call is read whole. This is a census of the CURRENT tree's call sites
  // (Dwight 23.4) - it proves no present renderer writePty omits an origin, not future
  // call-graph closure. A new caller anywhere under src/renderer is included the moment
  // it exists; a wrapper that hides `.writePty(` behind another name is the residual
  // this census does not chase, and the claim is bounded to that.
  const calls = [];
  for (const f of walk('src/renderer')) for (const c of writePtyCalls(src(f))) calls.push({ f, c });
  assert.ok(calls.length >= 8, `expected at least the eight known calls, found ${calls.length}`);
  for (const { f, c } of calls) {
    assert.match(c, /, ?'(HUMAN|CONTROL|PROGRAMMATIC)'\)$|, ?classifyOutbound\([^)]*\)\)$/,
      `${f}: ${c} does not end in a declared origin`);
  }
  // And no renderer file reaches the raw IPC channel directly, bypassing the typed wrapper.
  for (const f of walk('src/renderer')) {
    assert.doesNotMatch(src(f), /ipcRenderer[\s\S]{0,40}pty:write/, `${f} must not invoke pty:write directly`);
  }
});

test('SOURCE CENSUS: the PROGRAMMATIC literal appears ONLY in the two allowed owners, tree-wide', () => {
  // Enumerate every src/*.ts(x) file containing the literal and assert the SET is exactly
  // the two automatic owners - so a new main/renderer file using it is caught, not just a
  // wrong count in pre-named files (Dwight 23.4). The shared type definition names the
  // union member and is allowed; call sites are not.
  const owners = { 'src/renderer/src/hooks/useHive.ts': 2, 'src/main/index.ts': 2 };
  const allowedDefs = new Set(['src/shared/inputOrigin.ts']);
  const found = {};
  for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('src/shared')]) {
    const n = (src(f).match(/'PROGRAMMATIC'/g) || []).length;
    if (n) found[f] = n;
  }
  for (const f of Object.keys(found)) {
    assert.ok(f in owners || allowedDefs.has(f), `${f} uses 'PROGRAMMATIC' but is neither an allowed owner nor the type def`);
  }
  for (const [f, n] of Object.entries(owners)) {
    assert.equal(found[f], n, `${f} should hold exactly ${n} PROGRAMMATIC call sites, found ${found[f] ?? 0}`);
  }
});

test('the held-window discriminator and the self-test matchers are exact', () => {
  const { isTerminalReply, SELFTEST_ARROW_RIGHT } = loadTs('src/renderer/src/components/inputOrigin.ts');
  // A protocol reply begins with ESC; composition output never does (its only C0 is DEL).
  for (const reply of ['\x1b[0n', '\x1b[6;12R', '\x1b[?1;2c', '\x1b]11;rgb:0/0/0\x1b\\'])
    assert.equal(isTerminalReply(reply), true, JSON.stringify(reply));
  for (const human of ['あ', 'abc', '\x7f', 'x', ' '])
    assert.equal(isTerminalReply(human), false, JSON.stringify(human));
  // The keyboard half consumes ONLY its exact expected byte, so an unrelated reply cannot
  // satisfy it (Dwight 23.1).
  for (const yes of ['\x1b[C', '\x1bOC']) assert.match(yes, SELFTEST_ARROW_RIGHT);
  for (const no of ['\x1b[D', '\x1b[6;1R', 'x', '\x1b[C ']) assert.doesNotMatch(no, SELFTEST_ARROW_RIGHT);
});

test('the CPR half is a NONCE-correlated DECRQM query, matched exactly (god fix-round-3 / Phyllis Rank 1)', () => {
  const { makeNonce, selftestQuery, selftestReply } = loadTs('src/renderer/src/components/inputOrigin.ts');
  // The query is ANSI DECRQM for a nonce (no `?` prefix), and the reply xterm 5.5.0 echoes for
  // an unrecognised mode is `ESC[<nonce>;0$y` - the nonce verbatim, so the reply is provably ours.
  for (let i = 0; i < 200; i++) {
    const n = makeNonce();
    assert.ok(Number.isInteger(n) && n >= 100000 && n <= 999999, 'nonce is a 6-digit integer: ' + n);
    assert.equal(selftestQuery(n), '\x1b[' + n + '$p', 'ANSI DECRQM, no DEC-private ? prefix');
    assert.equal(selftestReply(n), '\x1b[' + n + ';0$y', 'the exact echoed reply we match');
  }
  // Distinct nonces across calls (probabilistic - a fixed nonce would be a real defect).
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(makeNonce());
  assert.ok(seen.size > 1, 'makeNonce is not constant');
});

test('the CPR self-test consumes ONLY its own exact nonce reply (Dwight 24.2, nonce form)', () => {
  const { makeNonceCorrelatedProbe, selftestReply } = loadTs('src/renderer/src/components/inputOrigin.ts');
  const expected = selftestReply(424242);
  let result;
  const probe = makeNonceCorrelatedProbe(expected, (origin) => { result = origin; });
  // Preload the collision: foreign replies of every shape arrive, INCLUDING a DECRQM reply for
  // a DIFFERENT nonce. None equals our expected reply, so all flow to the pty and none resolves.
  for (const foreign of ['\x1b[3;3R', '\x1b[?1;2c', '\x1b[999999;0$y', '\x1b[0n', 'x'])
    assert.equal(probe('CONTROL', foreign), false, 'a foreign reply flows through: ' + JSON.stringify(foreign));
  assert.equal(result, undefined, 'and none of them resolves the self-test');
  // OUR exact nonce reply -> consumed (never sent), and its origin decides pass.
  assert.equal(probe('CONTROL', expected), true, 'our own nonce reply is consumed');
  assert.equal(result, 'CONTROL', 'and its origin (CONTROL) is what decides pass');
  // A shape-only probe (match any CPR / any $y) would have swallowed the foreign bytes above
  // and resolved on one of them - this test is red against it.
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
  // The guard moved with the acquire-time detached attach: it is now the once-guard of
  // openTerminalOnce, called from acquireTerminal (detached) and again from
  // attachTerminal. What it pins is unchanged and still load-bearing - a second open()
  // recreates term.element and orphans the provenance listeners silently - so this test
  // follows the guard rather than the old location.
  const pool = src('src/renderer/src/components/terminalPool.ts');
  const fnStart = pool.indexOf('function openTerminalOnce(');
  assert.ok(fnStart > 0, 'the open-once guard exists');
  const inside = pool.slice(fnStart, pool.indexOf('\n}\n', fnStart));
  assert.match(inside, /if \(entry\.opened\) return;/, 'it opens at most once');
  assert.match(inside, /entry\.term\.open\(entry\.host\)/);
  assert.match(inside, /attachInputOrigin\(entry\.ptyId, entry\.term\)/,
    'the attach sits inside the guard, after open()');
  assert.ok(inside.indexOf('entry.term.open(') < inside.indexOf('attachInputOrigin('),
    'open() really comes first - xterm builds term.element/textarea inside it');
  assert.equal((pool.match(/attachInputOrigin\(/g) || []).length, 1, 'exactly one attach site');
  // The reason must sit AT the guard, not only in a decision record.
  const doc = pool.slice(Math.max(0, fnStart - 1400), fnStart);
  assert.match(doc, /LOAD-BEARING FOR INPUT PROVENANCE/, 'and the guard says why, AT the guard');
});

test('the acquire-time open is at acquire, and its one-column cost is priced AT that site', () => {
  // The human accepted ONE GRID COLUMN for opening detached, and the instruction that came
  // with the ruling was that the cost must live at the attach site, not only on a card:
  // "a priced cost that lives only in a decision record becomes an unexplained bug report
  // six months later". This pins that it is still there, with the measurement in it.
  const pool = src('src/renderer/src/components/terminalPool.ts');
  const acq = pool.slice(pool.indexOf('export function acquireTerminal('), pool.indexOf('export function isTerminalAutomationSafe('));
  assert.match(acq, /openTerminalOnce\(entry\);/, 'acquire opens the terminal');
  assert.match(acq, /Viewport\.ts:70/, 'the cost names where xterm measures the scrollbar once');
  assert.match(acq, /15px/, 'and the fallback it takes when detached');
  assert.ok(acq.indexOf('ACQUIRE-TIME DETACHED ATTACH') < acq.indexOf('openTerminalOnce(entry);'),
    'the price is stated AT the call, above it');
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
