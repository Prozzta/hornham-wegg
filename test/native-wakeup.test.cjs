'use strict';
/**
 * NATIVE-WAKEUP-EMPTY-INDEX (1.1.55; god andynwe, decision a+b). On the first native start,
 * Phyllis's task-start `mempalace wake-up` met an EMPTY index ("## L1 - No memories yet."):
 * hers was the first memory request, so it forked the worker and only then did the backfill
 * begin (~85-100 s).
 *  (a) In NATIVE mode, main forks the worker (whose below-normal startup backfill fills the
 *      index) 30 s after the first window finished loading (the spec's lazy rule), not at the
 *      first request. Legacy keeps its zero-startup-work contract.
 *  (b) The backfill takes a requesting caller's own wing first, even when it was already running
 *      (the app-start backfill of (a) has no caller): the engine keeps the wings callers asked
 *      about and consults them before every source.
 * Plain Node: fake store/embedder/worker. HOME is jailed and asserted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'native-wakeup-'));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME jailed');
test.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');
const { validateRequest } = loadTs('src/main/nativeMemory/service.ts');
const { NativeMemoryWiring } = loadTs('src/main/nativeMemory/mainWiring.ts');
const REPO = path.resolve(__dirname, '..');
const words = (t) => t.split(/\s+/).filter(Boolean).length;
let n = 0;
function hive(files) {
  const root = path.join(JAIL, `h${n++}`);
  for (const [rel, text] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  return root;
}
const THREE = { 'agents/a1/memory.md': '# a1\none', 'agents/a2/memory.md': '# a2\ntwo', 'agents/a3/memory.md': '# a3\nthree' };

/** A fake store that records the ORDER sources are committed in; `onApply` runs after each. */
function recordingStore(onApply) {
  const shas = new Map(); const order = [];
  return {
    order,
    setMeta() {}, sourceShas: () => shas, removeSource() {},
    planDiff: (p, chunks) => ({ path: p, keep: [], add: chunks, remove: [] }),
    applyDiff: (meta) => { shas.set(meta.path, meta.sha256); order.push(meta.path); onApply?.(meta.path); return true; },
    wakeUp: () => [], search: () => []
  };
}
function engineFor(root, store) {
  return new MemoryEngine({ hiveRoot: root, store, embedder: { loaded: true, embed: async (t) => t.map(() => new Float32Array(384)), unload: async () => {} },
    countTokens: words, mode: () => 'native', watch: null, setTimer: (fn, ms) => (ms === 0 ? setImmediate(fn) : { ms }), clearTimer: () => {} });
}

test('(b) a caller\'s wake-up MID-BACKFILL makes its wing the NEXT source indexed, although the backfill was already running without it', async () => {
  const root = hive(THREE);
  let eng;
  const store = recordingStore((p) => { if (p === 'agents/a1/memory.md') void eng.wakeUp('a3'); });
  eng = engineFor(root, store);
  await eng.backfill();
  assert.deepEqual(store.order, ['agents/a1/memory.md', 'agents/a3/memory.md', 'agents/a2/memory.md']);
});

test('(b) a search with no --wing prefers the CALLER\'s own wing (a hint only, never a filter)', async () => {
  const root = hive(THREE);
  let eng;
  const store = recordingStore((p) => { if (p === 'agents/a1/memory.md') void eng.search({ query: 'q', caller: 'a3' }); });
  eng = engineFor(root, store);
  await eng.backfill();
  assert.deepEqual(store.order, ['agents/a1/memory.md', 'agents/a3/memory.md', 'agents/a2/memory.md']);
});

test('(b) without a caller the backfill keeps its natural order; a bad wing name is ignored', async () => {
  const root = hive(THREE);
  const store = recordingStore();
  const eng = engineFor(root, store);
  eng.preferWing('../etc'); eng.preferWing(''); eng.preferWing(null);
  await eng.backfill();
  assert.deepEqual(store.order, ['agents/a1/memory.md', 'agents/a2/memory.md', 'agents/a3/memory.md']);
});

test('(b) validateRequest: a search carries the token\'s caller wing as `caller` (never as the `wing` filter); a wake-up stays the caller\'s wing', () => {
  const s = validateRequest({ cmd: 'search', args: { query: 'x' } }, 'phyllis-mu11xldm', []);
  assert.equal(s.args.caller, 'phyllis-mu11xldm');
  assert.equal(s.args.wing, null, 'no filter');
  assert.equal(validateRequest({ cmd: 'search', args: { query: 'x', wing: 'jim' } }, 'phyllis-mu11xldm', []).args.wing, 'jim');
  assert.equal(validateRequest({ cmd: 'wake-up', args: {} }, 'phyllis-mu11xldm', []).args.wing, 'phyllis-mu11xldm');
});

function fakeWorker() {
  const w = { posted: [], handlers: { message: [], exit: [] } };
  w.postMessage = (m) => w.posted.push(m); w.on = (ev, fn) => w.handlers[ev].push(fn); w.kill = () => true;
  return w;
}
function wiring(root) {
  const logs = []; const workers = [];
  const w = new NativeMemoryWiring({ hiveRoot: () => root, palacePath: () => null, userData: path.join(root, 'ud'), resourcesDir: path.join(root, 'res'), workerEntry: 'w.js',
    fork: () => { const x = fakeWorker(); workers.push(x); return x; }, memoryBaseUrl: () => null, legacyBin: () => null, writeShim: () => null, log: (r) => logs.push(r), vecLoadablePath: () => null });
  w.workerConfig = () => ({ hiveRoot: root });
  return { w, logs, workers };
}

test('(a) prewarm forks the worker ONLY in native mode (its startup backfill then runs); idempotent; legacy/shadow/fallback-legacy/no file fork nothing', () => {
  const native = wiring(hive({ 'memory-engine.json': '{"mode":"native"}', ...THREE }));
  assert.equal(native.w.prewarm(), true);
  assert.equal(native.workers.length, 1);
  assert.equal(native.workers[0].posted[0].op, 'init', 'forked with its config (the worker backfills at startup)');
  assert.equal(native.w.prewarm(), true);
  assert.equal(native.workers.length, 1, 'idempotent: one worker');
  assert.deepEqual(native.logs.filter((r) => r.kind === 'native-memory-prewarm').map((r) => r.forked), [true, true]);
  for (const mode of ['legacy', 'shadow', 'fallback-legacy', null]) {
    const x = wiring(hive(mode ? { 'memory-engine.json': JSON.stringify({ mode }) } : {}));
    assert.equal(x.w.prewarm(), false, String(mode));
    assert.equal(x.workers.length, 0, `${mode}: nothing forked (zero startup work)`);
  }
});

test('(a) WIRING: index.ts prewarms once, 30 s after the first window finished loading (the spec\'s lazy floor), and the worker still backfills at its startup', () => {
  const idx = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /const NATIVE_MEMORY_PREWARM_DELAY_MS = 30_000;/);
  assert.match(idx, /createWindow\(\);\s*(\/\/[^\n]*\n\s*)*mainWindow\?\.webContents\.once\('did-finish-load', \(\) => \{\s*const t = setTimeout\(\(\) => \{ try \{ nativeMemory\.prewarm\(\); \}[^\n]*\}, NATIVE_MEMORY_PREWARM_DELAY_MS\);/);
  const worker = fs.readFileSync(path.join(REPO, 'src', 'main', 'nativeMemory', 'worker.ts'), 'utf8');
  assert.match(worker, /void engine\.backfill\(\)\.catch/, 'the forked worker backfills at startup');
});

// ── N1 (Jim, god andyn1wait): a wake-up waits (bounded) for its caller's own wing ─────────

const { WAKE_WAIT_MS } = loadTs('src/main/nativeMemory/engine.ts');
const { WAKE_UP_DEADLINE_MS, SEARCH_DEADLINE_COLD_MS } = loadTs('src/main/nativeMemory/service.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake store that answers wakeUp from what the backfill has COMMITTED (per wing). */
function committingStore() {
  const shas = new Map(); const committed = [];
  return {
    committed,
    setMeta() {}, sourceShas: () => shas, removeSource() {},
    planDiff: (p, chunks) => ({ path: p, keep: [], add: chunks, remove: [] }),
    applyDiff: (meta, plan) => { shas.set(meta.path, meta.sha256); for (const c of plan.add) committed.push({ wing: meta.wing, room: meta.room, source: meta.path, content: c.content }); return true; },
    wakeUp: (wing) => committed.filter((c) => !wing || c.wing === wing), search: () => []
  };
}
function slowEngine(root, store, { embedMs = 30, wakeWaitMs } = {}) {
  return new MemoryEngine({ hiveRoot: root, store, embedder: { loaded: true, embed: async (t) => { await sleep(embedMs); return t.map(() => new Float32Array(384)); }, unload: async () => {} },
    // Real timers, UNREF'd: the model's idle-unload timer (minutes) must not keep the test process alive.
    countTokens: words, mode: () => 'native', watch: null, setTimer: (fn, ms) => (ms === 0 ? setImmediate(fn) : setTimeout(fn, ms).unref()), clearTimer: (t) => clearTimeout(t), ...(wakeWaitMs ? { wakeWaitMs } : {}) });
}

test('N1: on a FILLING index a wake-up waits for its OWN wing and answers with its notes, well inside the bound', async () => {
  const root = hive({ 'agents/a1/memory.md': '# a1\nalpha notes', 'agents/a2/memory.md': '# a2\nbeta notes', 'agents/a3/memory.md': '# a3\nGAMMA OWN NOTES' });
  const store = committingStore();
  const eng = slowEngine(root, store);
  const bf = eng.backfill();
  const t0 = Date.now();
  const r = await eng.wakeUp('a3');
  const ms = Date.now() - t0;
  assert.match(r.text, /GAMMA OWN NOTES/, 'its own notes, not "No memories yet"');
  assert.ok(ms < WAKE_WAIT_MS, `answered in ${ms} ms`);
  await bf;
});

test('N1: when its wing cannot finish in time, the wake-up still answers at about the BOUND (with whatever exists)', async () => {
  const big = Array.from({ length: 40 }, (_, i) => `## part ${i}\n${'word '.repeat(150)}`).join('\n\n');
  const root = hive({ 'agents/a1/memory.md': big, 'agents/a3/memory.md': `# a3\n${big}` });
  const store = committingStore();
  const eng = slowEngine(root, store, { embedMs: 40, wakeWaitMs: 300 });
  const bf = eng.backfill();
  const t0 = Date.now();
  const r = await eng.wakeUp('a3');
  const ms = Date.now() - t0;
  assert.ok(ms >= 250 && ms < 1500, `bounded: ${ms} ms`);
  assert.equal(r.exit, 0);
  await bf;
});

test('N1: a SEARCH never waits for a wing; and with no backfill running a wake-up does not wait at all', async () => {
  const big = Array.from({ length: 40 }, (_, i) => `## part ${i}\n${'word '.repeat(150)}`).join('\n\n');
  const root = hive({ 'agents/a3/memory.md': big });
  const store = committingStore();
  const eng = slowEngine(root, store, { embedMs: 40, wakeWaitMs: 2000 });
  const bf = eng.backfill();
  const t0 = Date.now();
  await eng.search({ query: 'q', caller: 'a3' });
  assert.ok(Date.now() - t0 < 1000, 'a search does not wait for the wing');
  await bf;
  const t1 = Date.now();
  await eng.wakeUp('a3');
  assert.ok(Date.now() - t1 < 200, 'nothing pending: immediate');
});

test('N1: main\'s wake-up deadline covers the wait + the cold budget, and mainWiring uses it for wake-up only', () => {
  assert.ok(WAKE_UP_DEADLINE_MS >= WAKE_WAIT_MS + SEARCH_DEADLINE_COLD_MS, `${WAKE_UP_DEADLINE_MS} >= ${WAKE_WAIT_MS} + ${SEARCH_DEADLINE_COLD_MS}`);
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'nativeMemory', 'mainWiring.ts'), 'utf8');
  assert.match(src, /v\.op === 'search' \? undefined : v\.op === 'wake-up' \? WAKE_UP_DEADLINE_MS : 2_000/);
});

test('B4 (Jim, optional pin): a bad wing name is never recorded as preferred', () => {
  const eng = engineFor(hive(THREE), recordingStore());
  for (const bad of ['../etc', 'a b', '', null, undefined, 'x'.repeat(121)]) eng.preferWing(bad);
  assert.equal(eng.preferredWings.size, 0);
  eng.preferWing('a3');
  assert.deepEqual([...eng.preferredWings], ['a3']);
});
