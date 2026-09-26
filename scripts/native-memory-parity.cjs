'use strict';
/*
 * NATIVE-MEMORY gate 4, the replay half (spec section 4, Jim R5). Runs every sampled real query
 * against BOTH engines on COPIES and writes:
 *   <out>/parity-public.json   per query: legacy and native top-10 (source, wing, chunk hash),
 *                              latencies, overlap, no-match / stale flags. NO query or chunk text:
 *                              this is the file that may be committed or shared.
 *   <private>/label-sheet.json the shuffled UNION of both top-10s per query, engine-blind, WITH
 *                              text, for the independent labellers (0/1/2). Access-controlled.
 *   <private>/label-key.json   which engine returned which item at which rank (never shown to a
 *                              labeller); scripts/native-memory-parity-stats.cjs joins it back.
 *
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/native-memory-parity.cjs --queries <queries-private.json>
 *     --db <migrated index> --hive <hive copy> --legacy-palace <palace copy> --out <dir> --private <dir>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const Q = arg('--queries'); const DB = arg('--db'); const HIVE = arg('--hive'); const PALACE = arg('--legacy-palace'); const OUT = arg('--out'); const PRIV = arg('--private');
const LEGACY_BIN = arg('--legacy-bin') || 'mempalace';
const REPO = path.resolve(__dirname, '..');
process.chdir(REPO);
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
const Database = require('better-sqlite3');
const ort = require('onnxruntime-node');
const sqliteVec = require('sqlite-vec');
const { NativeMemoryStore } = loadTs('src/main/nativeMemory/store.ts');
const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');
const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = loadTs('src/main/nativeMemory/wordpiece.ts');
const { OnnxEmbedder } = loadTs('src/main/nativeMemory/embedder.ts');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
const modelDir = path.join(REPO, 'resources', 'models', manifest.model.dir);
const h = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Parse the legacy CLI's search text (searcher.py layout) into ranked hits with their text. */
function parseLegacy(text) {
  const hits = [];
  // The legacy CLI writes CRLF on Windows.
  const blocks = text.replace(/\r\n/g, '\n').split(/\n {2}-{56}\n/);
  for (const b of blocks) {
    const m = /\n? {2}\[(\d+)\] (\S+) \/ (\S+)\n {6}Source: (.+)\n {6}Match: {2}(\S+)_sim=(\S+) {2}bm25=(\S+)\n\n([\s\S]*)$/.exec(b);
    if (!m) continue;
    const body = m[8].split('\n').map((l) => l.replace(/^ {6}/, '')).join('\n').trim();
    hits.push({ rank: Number(m[1]), wing: m[2], room: m[3], source: m[4].trim(), sim: Number(m[6]), bm25: Number(m[7]), text: body });
  }
  return hits;
}

(async () => {
  const queries = JSON.parse(fs.readFileSync(Q, 'utf8'));
  fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(PRIV, { recursive: true });
  const vecPath = sqliteVec.getLoadablePath();
  const store = NativeMemoryStore.open(DB, { Database, vecPath, vecSha256: null });
  const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'))));
  const emb = new OnnxEmbedder(path.join(modelDir, 'onnx', 'model.onnx'), tok, ort, { intraOpNumThreads: 2 });
  const eng = new MemoryEngine({ hiveRoot: HIVE, store, embedder: emb, countTokens: (t) => tok.count(t), mode: () => 'parity', watch: null });
  // Classify each legacy hit (spec: an intentional MINE-SCOPE loss is labelled excluded, not an
  // unexplained regression): the palace copy knows its full source path; the LIVE hive is only
  // stat-ed (read-only) to tell a removed file from one the allow-list excludes.
  const LIVE = arg('--live-hive');
  const { discoverSources } = loadTs('src/main/nativeMemory/sources.ts');
  const eligible = new Set(discoverSources(HIVE).eligible.map((e) => e.path));
  const lp = new Database(path.join(PALACE, 'chroma.sqlite3'), { readonly: true, fileMustExist: true });
  const legacyPaths = lp.prepare("SELECT DISTINCT m.string_value AS src, w.string_value AS wing FROM embedding_metadata m JOIN embedding_metadata w ON w.id = m.id AND w.key = 'wing' WHERE m.key = 'source_file'").all();
  lp.close();
  const relOf = (src) => { const n = src.replace(/\\/g, '/'); const i = n.indexOf('/hive/'); return i >= 0 ? n.slice(i + 6) : n; };
  const classify = (x) => {
    const cands = legacyPaths.filter((r) => r.wing === x.wing && relOf(r.src).split('/').pop() === x.source).map((r) => relOf(r.src));
    if (cands.some((c) => eligible.has(c))) return 'in-scope';
    if (LIVE && cands.some((c) => fs.existsSync(path.join(LIVE, ...c.split('/'))))) return 'excluded';
    return 'removed';
  };
  const pub = []; const sheet = []; const key = [];
  let first = true;
  for (const q of queries) {
    const args = ['--palace', PALACE, 'search', q.query, '--results', '10', ...(q.wing ? ['--wing', q.wing] : [])];
    const t0 = Date.now();
    const r = spawnSync(LEGACY_BIN, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, MEMPALACE_PALACE_PATH: PALACE } });
    const legacyMs = Date.now() - t0;
    const legacy = parseLegacy(String(r.stdout || ''));
    const t1 = Date.now();
    const nat = await eng.searchHits({ query: q.query, wing: q.wing, results: 10 });
    const nativeMs = Date.now() - t1;
    const nativeCold = first; first = false;
    // CONTAMINATION GUARD: a query file that was mined (or indexed) would find itself. Refuse.
    const deny = /PARITY-INTENTS|parity-queries|parity2|(phyllis|dwight|oscar)-queries|queries(-all|-merged|-private)*\.json/i;
    const tainted = [...legacy.map((x) => x.source), ...nat.map((x) => x.source)].filter((s) => deny.test(s));
    if (tainted.length) throw new Error(`contaminated: a hit came from the query set itself (${tainted.join(', ')})`);
    const L = legacy.map((x) => ({ source: x.source, wing: x.wing, chunk: h(x.text) }));
    const N = nat.map((x) => ({ source: x.source.split('/').pop(), wing: x.wing, chunk: h(x.content.trim()) }));
    const lset = new Set(L.map((x) => `${x.wing}|${x.source}`));
    const overlapSources = N.filter((x) => lset.has(`${x.wing}|${x.source}`)).length;
    const cls = legacy.map((x) => classify(x));
    const excluded = cls.map((c, i) => (c === 'excluded' ? legacy[i].rank : null)).filter((x) => x !== null);
    const removed = cls.map((c, i) => (c === 'removed' ? legacy[i].rank : null)).filter((x) => x !== null);
    pub.push({ qid: q.qid, hash: q.hash, agent: q.agent, cohort: legacy.length === 0 ? 'no-match' : removed.length ? `${q.cohort}+stale` : q.cohort, legacyExit: r.status, legacyMs, nativeMs, nativeCold, legacyN: L.length, nativeN: N.length, overlapSources, legacyExcludedRanks: excluded, legacyRemovedRanks: removed, legacy: L.map((x, i) => ({ ...x, scope: cls[i] })), native: N });
    // The engine-blind union for the labellers: dedupe identical chunks (same source + text).
    const items = new Map();
    legacy.forEach((x) => { const k = `${x.source}|${h(x.text)}`; const it = items.get(k) || { source: x.source, wing: x.wing, text: x.text, legacyRank: null, nativeRank: null }; it.legacyRank = x.rank; items.set(k, it); });
    nat.forEach((x, i) => { const src = x.source.split('/').pop(); const k = `${src}|${h(x.content.trim())}`; const it = items.get(k) || { source: src, wing: x.wing, text: x.content.trim(), legacyRank: null, nativeRank: null }; it.nativeRank = i + 1; items.set(k, it); });
    const list = [...items.values()];
    const seed = crypto.createHash('sha256').update(q.hash).digest();
    list.sort((a, b) => h(seed.toString('hex') + a.source + a.text).localeCompare(h(seed.toString('hex') + b.source + b.text)));
    sheet.push({ qid: q.qid, query: q.query, wing: q.wing, items: list.map((it, i) => ({ item: `${q.qid}-${String(i + 1).padStart(2, '0')}`, source: it.source, wing: it.wing, text: it.text, label: null })) });
    key.push({ qid: q.qid, cohort: pub.at(-1).cohort, items: list.map((it, i) => ({ item: `${q.qid}-${String(i + 1).padStart(2, '0')}`, legacyRank: it.legacyRank, nativeRank: it.nativeRank })) });
  }
  fs.writeFileSync(path.join(OUT, 'parity-public.json'), JSON.stringify({ generatedAt: new Date().toISOString(), queries: pub.length, results: pub }, null, 1));
  fs.writeFileSync(path.join(PRIV, 'label-sheet.json'), JSON.stringify({ instructions: 'For each query, label EVERY item 0 (not relevant), 1 (partly relevant) or 2 (relevant) for what the asking agent needed. Items are shuffled and engine-blind. Fill "label".', queries: sheet }, null, 1));
  fs.writeFileSync(path.join(PRIV, 'label-key.json'), JSON.stringify(key, null, 1));
  store.close(); await emb.unload();
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  console.log(JSON.stringify({ queries: pub.length, legacyMedianMs: med(pub.map((x) => x.legacyMs)), nativeMedianMs: med(pub.filter((x) => !x.nativeCold).map((x) => x.nativeMs)), nativeColdMs: pub.find((x) => x.nativeCold)?.nativeMs, meanOverlap: pub.reduce((s, x) => s + x.overlapSources, 0) / pub.length, noMatch: pub.filter((x) => x.cohort === 'no-match').length }));
  process.exit(0);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
