'use strict';

/**
 * ACTIVITY-LAG-151 (Jim's report, god's scope): the renderer's steady tax that grows with
 * activity, and the terminal memory that grows with Codex replays.
 *
 *  (1) updateAgent returns the SAME state for a patch that changes nothing, so no
 *      subscriber re-renders (was: a new `agents` array every call, a whole-App render).
 *  (2) the pty parser writes {status:'working'} only on the transition, not per chunk.
 *  (6) the write-only per-agent `feeds` (an unbounded O(n) copy per tool line, no reader)
 *      is gone.
 *  (5) scrollback per pooled terminal: 100,000 -> 10,000 lines.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const { runScenario } = require('./electron-harness/run.cjs');

const ROOT = path.resolve(__dirname, '..');
const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'activity-renders.tsx');
let run = null;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 120_000 }));

const { isNoOpAgentPatch } = loadTs('src/renderer/src/store/agentPatch.ts');

test('(1) isNoOpAgentPatch: equal values are a no-op, any real change is not', () => {
  const agents = [{ id: 'a', status: 'working', action: 'x', contextTokens: 5 }, { id: 'b', status: 'idle' }];
  assert.equal(isNoOpAgentPatch(agents, 'a', { status: 'working' }), true);
  assert.equal(isNoOpAgentPatch(agents, 'a', { status: 'working', contextTokens: 5 }), true);
  assert.equal(isNoOpAgentPatch(agents, 'a', {}), true, 'an empty patch changes nothing');
  assert.equal(isNoOpAgentPatch(agents, 'nope', { status: 'idle' }), true, 'no such agent: nothing to change');
  assert.equal(isNoOpAgentPatch(agents, 'a', { status: 'idle' }), false);
  assert.equal(isNoOpAgentPatch(agents, 'a', { status: 'working', action: 'y' }), false, 'ONE changed key is a change');
  assert.equal(isNoOpAgentPatch(agents, 'a', { carrying: undefined }), true, 'undefined over absent is no change');
  assert.equal(isNoOpAgentPatch(agents, 'a', { note: '' }), false, 'a new key with a value is a change');
  assert.equal(isNoOpAgentPatch([{ id: 'a', progress: NaN }], 'a', { progress: NaN }), true, 'Object.is: NaN equals NaN');
  assert.equal(isNoOpAgentPatch([{ id: 'a', v: 0 }], 'a', { v: -0 }), false, 'Object.is: +0 and -0 differ (strict, like React)');
});

test('RENDERED (1)+(2): no-op updates and running-turn chunks cost ZERO renders; real changes still render', async () => {
  const r = await result();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.noOpRenders, 0, `${r.N} no-op updateAgent calls must not re-render an agents subscriber (was ${r.N})`);
  assert.equal(r.parserRenders, 0, `${r.N} running chunks for a working agent must not re-render`);
  assert.equal(r.parserWrites, 0, 'the parser must not even write when the agent is already working (fix 2, independent of fix 1)');
  assert.equal(r.realChangeRenders, 1, 'a real change still renders exactly once (the probe is live)');
  assert.equal(r.transitionWrites, 1, 'an idle agent starting a turn: exactly ONE write, on the transition');
  assert.equal(r.statusAfter, 'working');
});

test('STATIC (1): updateAgent returns the unchanged state before building a new array', () => {
  const store = codeOnly(readSource('src/renderer/src/store/store.ts'));
  const at = store.indexOf('updateAgent: (id, patch) =>');
  const body = store.slice(at, at + 1500);
  const guard = body.indexOf('if (isNoOpAgentPatch(s.agents, id, patch)) return s;');
  const build = body.indexOf('const agents = s.agents.map(');
  assert.ok(guard > 0 && build > guard, 'the guard runs first');
});

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('CENSUS (6): no feeds / pushFeed anywhere in the renderer (it was write-only)', () => {
  const hits = [];
  for (const f of walk(path.join(ROOT, 'src/renderer'))) {
    const src = codeOnly(readSource(f));
    if (/\bpushFeed\b|\bfeeds\b/.test(src)) hits.push(path.relative(ROOT, f));
  }
  assert.deepEqual(hits, [], `found: ${hits.join(', ')}`);
});

test('(5) scrollback is 10,000 lines, and the pool uses the constant', () => {
  const { TERMINAL_SCROLLBACK_LINES } = loadTs('src/renderer/src/components/terminalScrollback.ts');
  assert.equal(TERMINAL_SCROLLBACK_LINES, 10_000);
  const pool = codeOnly(readSource('src/renderer/src/components/terminalPool.ts'));
  assert.match(pool, /scrollback: TERMINAL_SCROLLBACK_LINES,/);
  assert.doesNotMatch(pool, /scrollback:\s*\d/, 'no literal scrollback left in the pool');
});
