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
