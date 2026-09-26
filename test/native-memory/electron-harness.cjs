'use strict';
/*
 * NATIVE-MEMORY store/engine/worker scenarios, run UNDER ELECTRON AS NODE (ELECTRON_RUN_AS_NODE=1)
 * because the app's better-sqlite3 is built for Electron's ABI - the real shipped addon, with
 * the real sqlite-vec DLL and the real onnxruntime-node. No window, no app: a script.
 *
 *   electron.exe electron-harness.cjs <scenario> <out.json> <scratch dir>
 *
 * Writes { ok, ...facts } or { ok:false, error } to out.json (never stdout: Electron's stdout is
 * not reliable on Windows). test/native-memory-electron.test.cjs asserts on it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [scenario, outFile, scratch] = process.argv.slice(2);
const REPO = path.resolve(__dirname, '..', '..');
process.chdir(REPO);
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
const Database = require('better-sqlite3');
const ort = require('onnxruntime-node');
const sqliteVec = require('sqlite-vec');
const { NativeMemoryStore, ftsQuery, compactionDecision } = loadTs('src/main/nativeMemory/store.ts');
const { chunkMarkdown } = loadTs('src/main/nativeMemory/chunker.ts');
const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');
const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = loadTs('src/main/nativeMemory/wordpiece.ts');
const { OnnxEmbedder } = loadTs('src/main/nativeMemory/embedder.ts');
const { runWorker, openOrQuarantine } = loadTs('src/main/nativeMemory/worker.ts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
const MODEL_DIR = path.join(REPO, 'resources', 'models', MANIFEST.model.dir);
const HAVE_MODEL = fs.existsSync(path.join(MODEL_DIR, 'onnx', 'model.onnx'));
const vecPath = sqliteVec.getLoadablePath();
const vecSha = crypto.createHash('sha256').update(fs.readFileSync(vecPath)).digest('hex');
const openOpts = { Database, vecPath, vecSha256: vecSha };

/** A deterministic fake embedder: a normalised hash vector (the size gates do not need meaning). */
function fakeEmbedder() {
  const e = { loaded: true, calls: 0, texts: 0 };
  e.embed = async (texts) => {
    e.calls++; e.texts += texts.length;
    return texts.map((t) => {
      const v = new Float32Array(384);
      const h = crypto.createHash('sha512').update(t).digest();
      for (let i = 0; i < 384; i++) v[i] = (h[i % 64] - 127.5) / 127.5 + (i % 7) * 0.001;
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
      for (let i = 0; i < 384; i++) v[i] /= n;
      return v;
    });
  };
  e.unload = async () => {};
  return e;
}
const words = (t) => t.split(/\s+/).filter(Boolean).length;   // a cheap token counter for store tests

function hive(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return dir;
}
function engineFor(root, dbFile, embedder, extra = {}) {
  const store = NativeMemoryStore.open(dbFile, openOpts);
  const eng = new MemoryEngine({ hiveRoot: root, store, embedder, countTokens: words, mode: () => 'native', watch: null, setTimer: (fn) => setImmediate(fn), clearTimer: () => {}, ...extra });
  eng.storeOpenOptions = openOpts;
  return { store, eng };
}
const memoryMd = (n, extra = '') => Array.from({ length: n }, (_, i) => `## 2026-09-${String(1 + (i % 28)).padStart(2, '0')} entry ${i}\n- fact number ${i} about widget ${i % 13} and the gizmo protocol ${extra}`).join('\n\n') + '\n';

const S = {};

S.schema = async () => {
  const s = NativeMemoryStore.open(path.join(scratch, 'a.sqlite'), openOpts);
  const vec = s.db.prepare('select vec_version() v').get().v;
  const jm = s.db.pragma('journal_mode', { simple: true });
  const fk = s.db.pragma('foreign_keys', { simple: true });
  const ok = s.quickCheck();
  s.close();
  // a wrong digest is refused BEFORE load
  let refused = false;
  try { NativeMemoryStore.open(path.join(scratch, 'b.sqlite'), { ...openOpts, vecSha256: '00'.repeat(32) }); } catch (e) { refused = /digest mismatch/.test(String(e)); }
  return { vec, jm, fk, quick: ok, refusedBadDigest: refused };
};

S.chunkDiff = async () => {
  const root = hive(path.join(scratch, 'h'), { 'agents/a1/memory.md': memoryMd(30) });
  const emb = fakeEmbedder();
  const { store, eng } = engineFor(root, path.join(scratch, 'cd.sqlite'), emb);
  await eng.backfill();
  const before = store.db.prepare('select chunk_id, content_sha256 from chunks order by ordinal').all();
  const vecBefore = store.counts().vectors;
  const firstEmbedded = emb.texts;
  // APPEND one entry
  fs.appendFileSync(path.join(root, 'agents/a1/memory.md'), '\n## 2026-09-29 entry new\n- appended fact about the frobnicator\n');
  await eng.backfill();
  const after = store.db.prepare('select chunk_id, content_sha256 from chunks order by ordinal').all();
  const kept = before.filter((b) => after.some((a) => a.chunk_id === b.chunk_id && a.content_sha256 === b.content_sha256)).length;
  const appendEmbedded = emb.texts - firstEmbedded;
  // EDIT one early section
  const t = fs.readFileSync(path.join(root, 'agents/a1/memory.md'), 'utf8').replace('fact number 3 about', 'fact number 3 (edited) about');
  fs.writeFileSync(path.join(root, 'agents/a1/memory.md'), t);
  const e0 = emb.texts;
  await eng.backfill();
  const editEmbedded = emb.texts - e0;
  const final = store.db.prepare('select chunk_id, ordinal from chunks order by ordinal').all();
  const ordinalsContiguous = final.every((r, i) => r.ordinal === i);
  // FTS and vec stay in step with chunks
  const c = store.counts();
  const ftsRows = store.db.prepare("select count(*) n from chunks_fts").get().n;
  const hit = store.search({ query: 'frobnicator', queryVec: null, k: 3 });
  // REMOVE the source
  fs.rmSync(path.join(root, 'agents/a1/memory.md'));
  await eng.backfill();
  const gone = store.counts();
  const ftsGone = store.db.prepare("select count(*) n from chunks_fts where chunks_fts match '\"frobnicator\"'").get().n;
  store.close();
  return { chunks: before.length, vecBefore, firstEmbedded, kept, appendEmbedded, editEmbedded, ordinalsContiguous, counts: c, ftsRows, ftsHit: hit.map((h) => h.source), gone, ftsGone };
};

S.search = async () => {
  const root = hive(path.join(scratch, 'hs'), {
    'agents/a1/memory.md': '## notes\nthe kraken release uses rotation of logs\n\n## more\nbananas are yellow',
    'agents/b2/memory.md': '## notes\nkraken is also mentioned by b2 in passing',
    'agents/b2/DESIGN.md': '# Design\nthe kraken design doc'
  });
  const emb = fakeEmbedder();
  const { store, eng } = engineFor(root, path.join(scratch, 's.sqlite'), emb);
  await eng.backfill();
  const [qv] = await emb.embed(['kraken']);
  const all = store.search({ query: 'kraken', queryVec: qv, k: 10 });
  const wingB = store.search({ query: 'kraken', queryVec: qv, wing: 'b2', k: 10 });
  const roomMem = store.search({ query: 'kraken', queryVec: qv, room: 'memory', k: 10 });
  const future = store.search({ query: 'kraken', queryVec: qv, sinceMs: Date.now() + 86400000, k: 10 });
  // hostile FTS input must neither throw nor match everything
  const hostile = ['"', 'kraken OR', 'NEAR(a b)', 'a* -b', "'); drop table chunks; --", 'col:val', '^', '((', ''];
  const hostileOk = hostile.every((q) => { try { store.search({ query: q, queryVec: null, k: 5 }); return true; } catch { return false; } });
  const stillThere = store.counts().chunks;
  const r = await eng.search({ query: 'kraken', results: 2 });
  store.close();
  return { all: all.map((h) => `${h.wing}/${h.room}`), wingB: wingB.map((h) => h.wing), roomMem: roomMem.map((h) => h.room), future: future.length, hostileOk, stillThere, text: r.text, exit: r.exit, fts: ftsQuery('Hello, "world" NEAR x_y 7') };
};

S.onnx = async () => {
  if (!HAVE_MODEL) return { skipped: 'no model provisioned' };
  const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'tokenizer.json'), 'utf8'))));
  const emb = new OnnxEmbedder(path.join(MODEL_DIR, 'onnx', 'model.onnx'), tok, ort, { intraOpNumThreads: 2 });
  const lazy = emb.loaded;
  const t0 = Date.now();
  const [a, b, c] = await emb.embed(['log rotation for the antivirus', 'rotating the log files so the scanner is cheap', 'a banana is a yellow fruit']);
  const loadAndFirst = Date.now() - t0;
  const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
  // The ONNX co-load regression: create + insert + KNN a vec0 row AFTER ONNX loaded, BigInt rowid.
  const s = NativeMemoryStore.open(path.join(scratch, 'o.sqlite'), openOpts);
  s.db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)').run(BigInt(7), Buffer.from(a.buffer));
  const knn = s.db.prepare('select rowid, distance from chunks_vec where embedding match ? and k = 1').all(Buffer.from(b.buffer));
  s.close();
  const w0 = Date.now(); await emb.embed(['warm query']); const warm = Date.now() - w0;
  await emb.unload();
  return { lazy, dim: a.length, norm: Math.sqrt(dot(a, a)), simRelated: dot(a, b), simUnrelated: dot(a, c), knn, loadAndFirstMs: loadAndFirst, warmMs: warm, loadMs: emb.loadMs, unloaded: !emb.loaded };
};

S.quarantine = async () => {
  const f = path.join(scratch, 'q.sqlite');
  fs.writeFileSync(f, Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(8192)]));
  const { store, quarantined } = openOrQuarantine(f, openOpts, 12345);
  const fresh = store.quickCheck() && store.counts().chunks === 0;
  store.close();
  return { quarantined: quarantined && path.basename(quarantined), fresh, kept: fs.existsSync(`${f}.corrupt-12345`) };
};

S.compact = async () => {
  const root = hive(path.join(scratch, 'hc'), { 'agents/a1/memory.md': memoryMd(400) });
  const emb = fakeEmbedder();
  const dbFile = path.join(scratch, 'c.sqlite');
  const { store, eng } = engineFor(root, dbFile, emb);
  await eng.backfill();
  // delete most of it: a big freelist
  fs.writeFileSync(path.join(root, 'agents/a1/memory.md'), memoryMd(20));
  await eng.backfill();
  const decision = eng.compactionDue();
  const bytesBefore = store.fileBytes();
  const countsBefore = store.counts();
  const notDue = await eng.compact((f) => NativeMemoryStore.open(f, openOpts), fs.renameSync, (f) => fs.rmSync(f, { force: true }));
  const r = await eng.compact((f) => NativeMemoryStore.open(f, openOpts), fs.renameSync, (f) => fs.rmSync(f, { force: true }), true);
  const s2 = eng.storeRef();
  const countsAfter = s2.counts();
  const bytesAfter = s2.fileBytes();
  const searchable = s2.search({ query: 'widget', queryVec: null, k: 3 }).length;
  const prior = fs.existsSync(`${dbFile}.prior`);
  s2.close();
  return { decision, notDue, result: r, bytesBefore, bytesAfter, countsBefore, countsAfter, searchable, prior, policy: [compactionDecision(10e6, 9e6, 0.1), compactionDecision(40e6, 10e6, 0.1), compactionDecision(100e6, 10e6, 0), compactionDecision(1e6, 0.5e6, 0.3)] };
};

S.regrowth = async () => {
  // Jim R7 gate: 200-entry memory.md, then 1,000 appends. The DB must stay <= 1.5x a fresh
  // rebuild of the final state, with NO compaction run.
  const root = hive(path.join(scratch, 'hr'), { 'agents/a1/memory.md': memoryMd(200) });
  const emb = fakeEmbedder();
  const { store, eng } = engineFor(root, path.join(scratch, 'r.sqlite'), emb);
  await eng.backfill();
  const md = path.join(root, 'agents/a1/memory.md');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    fs.appendFileSync(md, `\n## 2026-10-01 append ${i}\n- appended fact ${i} regarding sprocket ${i % 17}\n`);
    await eng.backfill();
  }
  const ms = Date.now() - t0;
  store.checkpoint();
  const grown = store.fileBytes();
  const embeddedDuringAppends = emb.texts;
  const counts = store.counts();
  store.close();
  const root2 = hive(path.join(scratch, 'hr2'), { 'agents/a1/memory.md': fs.readFileSync(md, 'utf8') });
  const { store: fresh, eng: e2 } = engineFor(root2, path.join(scratch, 'r2.sqlite'), fakeEmbedder());
  await e2.backfill();
  fresh.checkpoint();
  const freshBytes = fresh.fileBytes();
  const freshCounts = fresh.counts();
  fresh.close();
  return { grown, freshBytes, ratio: grown / freshBytes, counts, freshCounts, embeddedDuringAppends, ms };
};

S.guards = async () => {
  // (a) a chunk-diff plan made before the source's chunks moved is REFUSED (and changes nothing)
  const root = hive(path.join(scratch, 'hg'), { 'agents/a1/memory.md': memoryMd(5) });
  const emb = fakeEmbedder();
  const { store, eng } = engineFor(root, path.join(scratch, 'g.sqlite'), emb);
  await eng.backfill();
  const chunksA = chunkMarkdown(memoryMd(5, 'A'), words);
  const chunksB = chunkMarkdown(memoryMd(5, 'B'), words);
  const meta = { path: 'agents/a1/memory.md', sha256: 'x', kind: 'memory', wing: 'a1', room: 'memory', mtimeMs: 1, bytes: 1 };
  const planA = store.planDiff(meta.path, chunksA);
  const planB = store.planDiff(meta.path, chunksB);
  const okB = store.applyDiff({ ...meta, sha256: 'b' }, planB, await emb.embed(planB.add.map((c) => c.content)), 2, 1);
  const before = store.db.prepare('select group_concat(content_sha256) s from chunks').get().s;
  const okA = store.applyDiff({ ...meta, sha256: 'a' }, planA, await emb.embed(planA.add.map((c) => c.content)), 3, 1);
  const after = store.db.prepare('select group_concat(content_sha256) s from chunks').get().s;
  // (b) a VACUUM INTO copy whose counts differ is NOT accepted
  const realCounts = NativeMemoryStore.prototype.counts;
  NativeMemoryStore.prototype.counts = function () { const c = realCounts.call(this); return /\.bad-staging$/.test(this.file) ? { ...c, chunks: c.chunks + 1 } : c; };
  let v;
  try { v = store.vacuumInto(path.join(scratch, 'g.bad-staging'), openOpts); } finally { NativeMemoryStore.prototype.counts = realCounts; }
  store.close();
  return { okB, okA, unchangedByStalePlan: before === after, vacuumBadCounts: v };
};

S.palaceUntouched = async () => {
  // ROLLBACK SAFETY (Human, via god): the native engine never deletes, moves or mutates the
  // MemPalace store. A harness home with a palace beside the hive (the live layout: <home>/hive,
  // <home>/palace); the worker runs its whole life (backfill, search, wake-up, status, a FORCED
  // compaction, shutdown); the palace tree must be identical afterwards: the same files, bytes,
  // SHA-256 and mtimes, and nothing added.
  if (!HAVE_MODEL) return { skipped: 'no model provisioned' };
  const home = path.join(scratch, 'home');
  hive(path.join(home, 'hive'), { 'agents/a1/memory.md': memoryMd(30), 'agents/a1/identity.md': 'You are A1.' });
  const palace = path.join(home, 'palace');
  const put = (rel, buf) => { const p = path.join(palace, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };
  put('chroma.sqlite3', crypto.randomBytes(64 * 1024));
  put('mempalace_embedder.json', '{"model":"minilm"}');
  put('22acf1f6-5ec3-4a67-a1c1-bc875d043bd4/data_level0.bin', crypto.randomBytes(32 * 1024));
  put('22acf1f6-5ec3-4a67-a1c1-bc875d043bd4/header.bin', crypto.randomBytes(100));
  const old = Date.now() - 86400000;
  const snap = () => {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { out[path.relative(palace, p) + '/'] = 'dir'; walk(p); } else { const b = fs.readFileSync(p); out[path.relative(palace, p)] = `${b.length}:${crypto.createHash('sha256').update(b).digest('hex')}:${fs.statSync(p).mtimeMs}`; } } };
    walk(palace);
    return out;
  };
  for (const f of Object.keys(snap())) if (!f.endsWith('/')) fs.utimesSync(path.join(palace, f), old / 1000, old / 1000);
  const before = snap();
  const userData = path.join(scratch, 'userData');
  const listeners = []; const sent = [];
  const port = { on: (_e, fn) => listeners.push(fn), postMessage: (m) => sent.push(m) };
  const dbFile = path.join(userData, 'memory', 'x.sqlite');
  await runWorker({ hiveRoot: path.join(home, 'hive'), dbFile, modelDir: MODEL_DIR, modelSha256: MANIFEST.model.onnxSha256, vecPath, vecSha256: vecSha, modeFile: path.join(home, 'hive', 'memory-engine.json') }, port, { Database, ort });
  const ask = (id, op, args) => new Promise((resolve) => { const t = setInterval(() => { const r = sent.find((m) => m.id === id); if (r) { clearInterval(t); resolve(r); } }, 20); for (const l of listeners) l({ data: { id, op, args } }); });
  await ask(1, 'backfill', {});
  const s = await ask(2, 'search', { query: 'widget gizmo', results: 3 });
  await ask(3, 'wake-up', { wing: 'a1' });
  await ask(4, 'status', {});
  // a forced compaction through the engine (the worker only compacts when due)
  const { NativeMemoryStore: NMS } = loadTs('src/main/nativeMemory/store.ts');
  await ask(5, 'shutdown', {});
  const store = NMS.open(dbFile, openOpts);
  const { eng } = { eng: new MemoryEngine({ hiveRoot: path.join(home, 'hive'), store, embedder: fakeEmbedder(), countTokens: words, mode: () => 'native', watch: null, setTimer: (fn) => setImmediate(fn), clearTimer: () => {} }) };
  eng.storeOpenOptions = openOpts;
  const compacted = await eng.compact((f) => NMS.open(f, openOpts), fs.renameSync, (f) => fs.rmSync(f, { force: true }), true);
  eng.storeRef().close();
  const after = snap();
  const inPalace = (p) => path.resolve(p).toLowerCase().startsWith(path.resolve(palace).toLowerCase() + path.sep);
  return { searchExit: s.exit, compacted, identical: JSON.stringify(before) === JSON.stringify(after), files: Object.keys(before).length, dbOutsidePalace: !inPalace(dbFile), hiveHasNoPalaceWrites: !fs.readdirSync(palace).some((n) => /sqlite|native|memory-engine/.test(n) && !['chroma.sqlite3'].includes(n)) };
};

S.badModel = async () => {
  if (!HAVE_MODEL) return { skipped: 'no model provisioned' };
  const root = hive(path.join(scratch, 'hb'), { 'agents/a1/memory.md': '## x\n- y\n' });
  const listeners = []; const sent = [];
  const port = { on: (_e, fn) => listeners.push(fn), postMessage: (m) => sent.push(m) };
  const cfg = { hiveRoot: root, dbFile: path.join(scratch, 'b', 'db.sqlite'), modelDir: MODEL_DIR, modelSha256: '00'.repeat(32), vecPath, vecSha256: vecSha, modeFile: path.join(root, 'm.json') };
  await runWorker(cfg, port, { Database, ort });
  const ask = (id, op, args) => new Promise((resolve) => { const t = setInterval(() => { const r = sent.find((m) => m.id === id); if (r) { clearInterval(t); resolve(r); } }, 20); for (const l of listeners) l({ data: { id, op, args } }); });
  const s = await ask(1, 'search', { query: 'y', results: 1 });
  await ask(2, 'shutdown', {});
  return { search: s };
};

S.vecChurn = async () => {
  // Does vec0 reuse deleted slots, and does VACUUM INTO shrink it? (spec: "delete-slot reuse
  // is unproven"). 400 chunks -> 20 -> 400 DIFFERENT chunks, sizes after each step.
  const root = hive(path.join(scratch, 'hv'), { 'agents/a1/memory.md': memoryMd(400) });
  const emb = fakeEmbedder();
  const dbFile = path.join(scratch, 'v.sqlite');
  const { store, eng } = engineFor(root, dbFile, emb);
  const size = () => { store.checkpoint(); return store.fileBytes(); };
  await eng.backfill(); const a = size();
  fs.writeFileSync(path.join(root, 'agents/a1/memory.md'), memoryMd(20)); await eng.backfill(); const b = size();
  fs.writeFileSync(path.join(root, 'agents/a1/memory.md'), memoryMd(400, 'variant-two')); await eng.backfill(); const c = size();
  const chunkRows = store.db.prepare("select count(*) n from chunks_vec_chunks").get().n;
  const staging = path.join(scratch, 'v.vacuum.sqlite');
  store.db.prepare('VACUUM INTO ?').run(staging);
  const d = fs.statSync(staging).size;
  const live = store.liveEstimateBytes();
  const counts = store.counts();
  store.close();
  return { a, b, c, vacuumInto: d, live, chunkRows, counts, freelist: null };
};

S.worker = async () => {
  if (!HAVE_MODEL) return { skipped: 'no model provisioned' };
  // The real worker entry, over a fake parent port: init -> ready -> requests, real everything.
  const root = hive(path.join(scratch, 'hw'), {
    'agents/andy/memory.md': '## 2026-09-26\n- LOG-STALL: the log is kept open and rotated at 8 MB\n',
    'agents/andy/identity.md': 'You are Andy, a builder.',
    'agents/jim/AUDIT.md': '# Audit\nThe gate passed: kept-open append p50 0.01 ms.'
  });
  const listeners = [];
  const sent = [];
  const port = { on: (_e, fn) => listeners.push(fn), postMessage: (m) => sent.push(m) };
  const cfg = { hiveRoot: root, dbFile: path.join(scratch, 'w', 'db.sqlite'), modelDir: MODEL_DIR, modelSha256: MANIFEST.model.onnxSha256, vecPath, vecSha256: vecSha, modeFile: path.join(root, 'memory-engine.json') };
  await runWorker(cfg, port, { Database, ort });
  const ask = (id, op, args, deadline) => new Promise((resolve) => {
    const t = setInterval(() => { const r = sent.find((m) => m.id === id); if (r) { clearInterval(t); resolve(r); } }, 20);
    for (const l of listeners) l({ data: { id, op, args, deadline } });
  });
  const ready = sent.some((m) => m.event === 'ready');
  const bf = await ask(1, 'backfill', {});
  const t0 = Date.now(); const s1 = await ask(2, 'search', { query: 'log kept open rotation', results: 3 }); const cold = Date.now() - t0;
  const t1 = Date.now(); const s2 = await ask(3, 'search', { query: 'gate passed append', results: 3 }); const warm = Date.now() - t1;
  const wk = await ask(4, 'wake-up', { wing: 'andy' });
  const st = await ask(5, 'status', {});
  const rep = await ask(6, 'report', {});
  const exp = await ask(7, 'status', {}, Date.now() - 1);
  const bad = await ask(8, 'nope', {});
  const down = await ask(9, 'shutdown', {});
  return { ready, bf, s1: { exit: s1.exit, text: s1.text }, cold, warm, s2src: (s2.json || []).map((h) => h.source), wake: wk.text, status: st.json, report: rep.json, expired: exp, bad, down, logs: sent.filter((m) => m.event === 'log').map((m) => m.kind) };
};

(async () => {
  let out;
  try {
    fs.mkdirSync(scratch, { recursive: true });
    if (!S[scenario]) throw new Error(`unknown scenario ${scenario}`);
    out = { ok: true, ...(await S[scenario]()) };
  } catch (e) {
    out = { ok: false, error: String(e && e.stack ? e.stack : e) };
  }
  fs.writeFileSync(outFile, JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  process.exit(0);
})();
