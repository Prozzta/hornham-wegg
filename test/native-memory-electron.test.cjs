'use strict';
/**
 * NATIVE-MEMORY: the store, the engine and the worker against the REAL shipped natives - the
 * app's Electron-ABI better-sqlite3, the pinned sqlite-vec DLL, onnxruntime-node and the bundled
 * MiniLM - by running test/native-memory/electron-harness.cjs under Electron as Node (no window).
 * Model-dependent scenarios skip when the model has not been provisioned
 * (scripts/fetch-memory-model.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
let ELECTRON = null;
try { ELECTRON = require('electron'); } catch { ELECTRON = null; }
const HAVE_ELECTRON = typeof ELECTRON === 'string' && fs.existsSync(ELECTRON);
const MODEL = path.join(REPO, 'resources', 'models', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx');
const HAVE_MODEL = fs.existsSync(MODEL);
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'native-memory-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));

function run(scenario) {
  const out = path.join(JAIL, `${scenario}.json`);
  const scratch = path.join(JAIL, scenario);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: JAIL, USERPROFILE: JAIL };
  const r = spawnSync(ELECTRON, [path.join(__dirname, 'native-memory', 'electron-harness.cjs'), scenario, out, scratch], { env, cwd: REPO, timeout: 600000, windowsHide: true });
  assert.ok(fs.existsSync(out), `harness wrote no result (status ${r.status}) ${String(r.stderr || '').slice(0, 400)}`);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(j.ok, true, j.error);
  return j;
}

test('STORE: the shipped better-sqlite3 opens the index in WAL with FKs, loads the pinned vec0, and REFUSES a DLL whose digest differs', { skip: !HAVE_ELECTRON }, () => {
  const j = run('schema');
  assert.equal(j.vec, 'v0.1.9');
  assert.equal(j.jm, 'wal');
  assert.equal(j.fk, 1);
  assert.equal(j.quick, true);
  assert.equal(j.refusedBadDigest, true, 'a changed extension is never loaded');
});

test('CHUNK-DIFF (Jim R7): an append embeds ONE chunk and keeps every other rowid; an edit re-embeds one; FTS and vec stay in step; removal empties both', { skip: !HAVE_ELECTRON }, () => {
  const j = run('chunkDiff');
  assert.equal(j.firstEmbedded, j.chunks);
  assert.equal(j.kept, j.chunks, 'every existing chunk kept its rowid and embedding');
  assert.equal(j.appendEmbedded, 1, 'an append embeds only the new chunk');
  assert.equal(j.editEmbedded, 1, 'an edit re-embeds only the changed chunk');
  assert.equal(j.ordinalsContiguous, true);
  assert.equal(j.counts.chunks, j.counts.vectors);
  assert.equal(j.ftsRows, j.counts.chunks);
  assert.deepEqual(j.ftsHit, ['agents/a1/memory.md']);
  assert.deepEqual(j.gone, { sources: 0, chunks: 0, vectors: 0, generation: j.gone.generation });
  assert.equal(j.ftsGone, 0, 'the FTS rows went with the chunks');
});

test('SEARCH: hybrid over both indexes; wing / room / date filters apply before fusion; hostile FTS input cannot throw or break the index; legacy text layout', { skip: !HAVE_ELECTRON }, () => {
  const j = run('search');
  assert.ok(j.all.length >= 3);
  assert.deepEqual([...new Set(j.wingB)], ['b2']);
  assert.deepEqual([...new Set(j.roomMem)], ['memory']);
  assert.equal(j.future, 0, 'a --since in the future matches nothing');
  assert.equal(j.hostileOk, true);
  assert.equal(j.stillThere, 4);
  assert.equal(j.exit, 0);
  assert.match(j.text, /^\n={60}\n {2}Results for: "kraken"\n={60}\n\n {2}\[1\] \S+ \/ \S+\n {6}Source: \S+\n {6}Match: {2}cosine_sim=-?[\d.]+ {2}bm25=[\d.]+\n\n/);
  assert.equal((j.text.match(/^ {2}\[\d\]/gm) || []).length, 2, '--results 2');
  assert.equal(j.fts, '"hello" OR "world" OR "near" OR "x_y" OR "7"', 'user text never reaches FTS5 syntax');
});

test('ONNX (spec section 3): lazy load, 384-d normalised, related > unrelated, and a vec0 insert + KNN with a BigInt rowid AFTER ONNX loaded (issue #270 regression)', { skip: !HAVE_ELECTRON || !HAVE_MODEL }, () => {
  const j = run('onnx');
  assert.equal(j.lazy, false, 'nothing loaded before the first embed');
  assert.equal(j.dim, 384);
  assert.ok(Math.abs(j.norm - 1) < 1e-5);
  assert.ok(j.simRelated > j.simUnrelated + 0.3, `${j.simRelated} vs ${j.simUnrelated}`);
  assert.deepEqual(j.knn.map((r) => r.rowid), [7]);
  assert.equal(j.unloaded, true, 'idle unload drops the session');
});

test('HEALTH (section 7): a corrupt index is quarantined (kept, renamed) and a fresh one opens', { skip: !HAVE_ELECTRON }, () => {
  const j = run('quarantine');
  assert.equal(j.quarantined, 'q.sqlite.corrupt-12345');
  assert.equal(j.kept, true);
  assert.equal(j.fresh, true);
});

test('COMPACTION (section 7): the policy thresholds; a forced VACUUM INTO + verify + swap keeps every row, keeps one prior file, and stays searchable', { skip: !HAVE_ELECTRON }, () => {
  const j = run('compact');
  assert.equal(j.notDue, 'not-due', 'not due -> nothing happens');
  assert.match(j.result, /^compacted:/);
  assert.deepEqual(j.countsAfter, j.countsBefore, 'rows, vectors and generation survive the swap');
  assert.ok(j.searchable > 0);
  assert.equal(j.prior, true, 'one prior DB retained');
  assert.deepEqual(j.policy, ['none', 'compact', 'force', 'compact']);
});

test('REGROWTH GATE (Jim R7): 200-entry memory.md + 1,000 appends stays <= 1.5x a fresh rebuild of the final state, with no compaction', { skip: !HAVE_ELECTRON }, () => {
  const j = run('regrowth');
  assert.equal(j.counts.chunks, j.freshCounts.chunks);
  assert.equal(j.embeddedDuringAppends, j.counts.chunks, 'every chunk embedded exactly once');
  assert.ok(j.ratio <= 1.5, `ratio ${j.ratio}`);
});

test('VEC0 SLOTS: 400 -> 20 -> 400 different chunks does not grow the file (vec0 0.1.9 reuses deleted slots); VACUUM INTO is the live size', { skip: !HAVE_ELECTRON }, () => {
  const j = run('vecChurn');
  assert.ok(j.c <= j.a * 1.1, `after churn ${j.c} vs first build ${j.a}`);
  assert.ok(j.vacuumInto <= j.live * 1.05);
});

test('WORKER: the real entry over a parent port - ready, backfill (joins the startup one), cold and warm search, wake-up contract, status, migration report, an expired request is not run, unknown op is exit 2, shutdown', { skip: !HAVE_ELECTRON || !HAVE_MODEL }, () => {
  const j = run('worker');
  assert.equal(j.ready, true);
  assert.equal(j.bf.json.eligible, 3);
  assert.equal(j.s1.exit, 0);
  assert.match(j.s1.text, /\[1\] andy \/ memory\n {6}Source: memory\.md/);
  assert.ok(j.s2src.includes('agents/jim/AUDIT.md'));
  assert.match(j.wake, /^Wake-up text \(~\d+ tokens\):\n={50}\n## L0 — IDENTITY\nYou are Andy, a builder\.\n\n## L1 — ESSENTIAL STORY\n\n\[memory\]\n {2}- ## 2026-09-26 - LOG-STALL/);
  assert.equal(j.status.chunks, 3);
  assert.equal(j.report.allowListVersion, 1);
  assert.deepEqual(j.report.excludedMd, []);
  assert.deepEqual(j.expired, { id: 7, ok: false, exit: 4, error: 'expired' });
  assert.equal(j.bad.exit, 2);
  assert.equal(j.down.ok, true);
});

test('GUARDS: a chunk-diff plan made before the chunks moved is refused and changes nothing; a VACUUM INTO copy whose counts differ is not accepted', { skip: !HAVE_ELECTRON }, () => {
  const j = run('guards');
  assert.equal(j.okB, true);
  assert.equal(j.okA, false, 'the stale plan is refused');
  assert.equal(j.unchangedByStalePlan, true);
  assert.deepEqual(j.vacuumBadCounts, { ok: false, why: 'counts' });
});

test('MODEL DIGEST: a model whose SHA-256 differs from the manifest is never loaded (the search fails, named)', { skip: !HAVE_ELECTRON || !HAVE_MODEL }, () => {
  const j = run('badModel');
  assert.equal(j.search.ok, false);
  assert.match(j.search.error, /model digest mismatch/);
});

test('ROLLBACK SAFETY (Human, via god): a worker\'s whole life (backfill, search, wake-up, status, a forced compaction) over a harness home that holds a palace leaves the palace byte-identical (files, SHA-256, mtimes, nothing added); the index lives outside it', { skip: !HAVE_ELECTRON || !HAVE_MODEL }, () => {
  const j = run('palaceUntouched');
  assert.equal(j.searchExit, 0);
  assert.match(j.compacted, /^compacted:/);
  assert.ok(j.files >= 5);
  assert.equal(j.identical, true, 'the palace tree is unchanged');
  assert.equal(j.dbOutsidePalace, true);
  assert.equal(j.hiveHasNoPalaceWrites, true);
});

test('ROLLBACK SAFETY (static): no native-memory module names the palace, mempalace config or chroma; the worker config has no palace field', () => {
  const dir = path.join(REPO, 'src', 'main', 'nativeMemory');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    // The one allowed mention: main compares a shim's --palace argument with the served palace
    // PATH (a string check, so an agent's --palace keeps working). Nothing opens it.
    const code = src.replace('const served = [this.d.hiveRoot(), this.d.palacePath()].filter((x): x is string => !!x);', '');
    assert.doesNotMatch(code, /palacePath\(\)|chroma|\.mempalace|mempalace_embedder/i, f);
  }
  const worker = fs.readFileSync(path.join(dir, 'worker.ts'), 'utf8');
  const cfg = /export interface WorkerConfig \{([\s\S]*?)\n\}/.exec(worker)[1];
  assert.doesNotMatch(cfg, /palace/i, 'the worker is never told where the palace is');
});
