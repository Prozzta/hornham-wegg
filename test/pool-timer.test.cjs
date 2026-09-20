'use strict';

/**
 * The prompt mirror's timer exists only while there is a terminal to mirror.
 *
 * Oscar's L0 efficiency assessment (2026-09-20): `promptMirrorTimer` in terminalPool started
 * with the first terminal and NEVER stopped - 7,200 empty callbacks an hour over an empty
 * pool. The rule now lives in src/renderer/src/components/poolTimer.ts, pure and with its
 * timers injected, so it is tested here under node: ABSENT at 0, PRESENT at 1, EXACTLY ONE
 * at N. terminalPool.ts itself cannot load under node (xterm needs a DOM), so ITS use of the
 * rule is a static tripwire - a literal shape and no more.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const SRC = 'src/renderer/src/components/poolTimer.ts';
const REAL = loadTs(SRC);

/** A timer host that COUNTS: what is live right now, and everything ever set or cleared. */
function host() {
  const h = { live: new Set(), set: 0, cleared: 0, ticks: [] };
  h.api = {
    set: (fn, ms) => { const id = { fn, ms }; h.live.add(id); h.set += 1; return id; },
    clear: (id) => { if (h.live.delete(id)) h.cleared += 1; }
  };
  return h;
}

const K = {};

K.absentAtZeroPresentAtOneExactlyOneAtN = (mod) => {
  const h = host();
  let ticks = 0;
  const timer = mod.createPoolTimer(() => { ticks += 1; }, 500, h.api);
  assert.deepEqual([h.live.size, timer.running], [0, false], 'ABSENT before there is anything to serve');
  timer.sync(0);
  assert.equal(h.live.size, 0, 'ABSENT AT 0: an empty pool arms no timer');
  timer.sync(1);
  assert.deepEqual([h.live.size, timer.running], [1, true], 'PRESENT AT 1');
  for (const n of [2, 3, 17, 3, 1]) { timer.sync(n); assert.equal(h.live.size, 1, `EXACTLY ONE AT N (${n}): growing or shrinking the pool never adds a second timer`); }
  assert.equal(h.set, 1, 'and only one was ever armed across all of that');
  assert.equal([...h.live][0].ms, 500, 'at the period it was given');
  [...h.live][0].fn(); assert.equal(ticks, 1, 'and it is the caller’s tick');
};

K.theLastOneOutStopsItAndTheNextOneInRestartsIt = (mod) => {
  const h = host();
  const timer = mod.createPoolTimer(() => {}, 500, h.api);
  timer.sync(2); timer.sync(1);
  timer.sync(0);
  assert.deepEqual([h.live.size, h.cleared, timer.running], [0, 1, false], 'THE TIMER STOPS WHEN THE POOL EMPTIES - no callbacks over nothing');
  timer.sync(0);
  assert.equal(h.cleared, 1, 'stopping twice clears once');
  timer.sync(1);
  assert.deepEqual([h.live.size, h.set, timer.running], [1, 2, true], 'AND RESTARTS with the next terminal');
  timer.sync(0); timer.sync(4);
  assert.deepEqual([h.live.size, h.set, h.cleared], [1, 3, 2], 'any number of times, never leaving a stray timer behind');
};

for (const [name, killer] of Object.entries(K)) test(`pool timer: ${name}`, () => killer(REAL));

test('STATIC: terminalPool.ts syncs the mirror timer wherever the pool’s size changes, and arms no interval of its own for it', () => {
  const pool = codeOnly(readSource('src/renderer/src/components/terminalPool.ts'), 'terminalPool.ts');
  assert.equal(pool.split('pool.set(').length - 1, 1, 'the pool grows in ONE place');
  assert.equal(pool.split('pool.delete(').length - 1, 1, 'and shrinks in ONE place');
  assert.match(pool, /pool\.delete\(ptyId\);\s*promptMirror\.sync\(pool\.size\);/, 'the shrink is followed at once by a sync - this is the line that was missing');
  const grow = pool.indexOf('pool.set('); const synced = pool.indexOf('promptMirror.sync(pool.size);', grow);
  assert.ok(synced > grow && synced - grow < 2500, 'and the grow is followed by a sync in the same function');
  assert.match(pool, /const promptMirror = createPoolTimer\(\(\) => \{\s*for \(const entry of pool\.values\(\)\) reportPromptState\(entry\);\s*\}, PROMPT_MIRROR_TICK_MS\);/, 'ONE global timer for the whole pool, as Oscar measured it');
  assert.ok(!/promptMirrorTimer|startPromptMirror/.test(pool), 'the start-once-never-stop timer is gone, not kept beside the new one');
});

const MUTANTS = [
  { name: 'the timer never stops (the defect Oscar found)',
    edits: [['      else if (size <= 0 && handle !== null) { host.clear(handle); handle = null; }', '      else if (false) { host.clear(handle); handle = null; }']],
    killer: 'theLastOneOutStopsItAndTheNextOneInRestartsIt', dies: /THE TIMER STOPS WHEN THE POOL EMPTIES/ },
  { name: 'a timer per terminal',
    edits: [['      if (size > 0 && handle === null) handle = host.set(tick, ms);', '      if (size > 0) handle = host.set(tick, ms);']],
    killer: 'absentAtZeroPresentAtOneExactlyOneAtN', dies: /EXACTLY ONE AT N/ },
  { name: 'armed over an empty pool',
    edits: [['      if (size > 0 && handle === null) handle = host.set(tick, ms);', '      if (handle === null) handle = host.set(tick, ms);']],
    killer: 'absentAtZeroPresentAtOneExactlyOneAtN', dies: /ABSENT AT 0/ },
  { name: 'stopped but never restartable',
    edits: [['{ host.clear(handle); handle = null; }', '{ host.clear(handle); }']],
    killer: 'theLastOneOutStopsItAndTheNextOneInRestartsIt', dies: /THE TIMER STOPS WHEN THE POOL EMPTIES|AND RESTARTS with the next terminal/ }
];
const MUTANT_DIR = path.join(__dirname, '.mutants-pool-timer');

test('MUTANT CENSUS: every mutant applies exactly once, and dies at the assertion that names its guarantee', async (t) => {
  const source = readSource(SRC);
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, mutant] of MUTANTS.entries()) {
      await t.test(`mutant: ${mutant.name}`, () => {
        K[mutant.killer](REAL);
        let text = source;
        for (const [from, to] of mutant.edits) {
          assert.equal(text.split(from).length - 1, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE`);
          text = text.replace(from, () => to);
        }
        const file = path.join(MUTANT_DIR, `m${i}.ts`);
        fs.writeFileSync(file, text, 'utf8');
        const mod = loadTs(path.relative(path.resolve(__dirname, '..'), file));
        let died = null;
        try { K[mutant.killer](mod); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong assertion`);
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});
