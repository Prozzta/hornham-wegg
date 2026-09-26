'use strict';
/*
 * NATIVE-MEMORY gate 3: a full COPY-ONLY migration + its report (spec section 1).
 *
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/native-memory-migrate.cjs \
 *     --hive <copy of the hive> --db <new index file> --out <report dir> [--legacy-palace <palace COPY>]
 *
 * Re-embeds the allow-listed Markdown of the (copied) hive with the bundled model at the worker's
 * settings (2 intra-op threads, 8-chunk batches), and writes:
 *   migration-report.json  counts (discovered / eligible / excluded-by-rule / unreadable /
 *                          chunked / embedded / failed), the allow-list version, every excluded
 *                          .md by path, the manifest (path, SHA-256, mtime, bytes), the chunker and
 *                          embedder identity, timing, RSS, DB size
 *   legacy-scope.json      (with --legacy-palace) which legacy source files the native index
 *                          keeps and which it drops, by class: the intentional MINE-SCOPE change
 * It opens the legacy palace READ-ONLY (a copy is expected), and never touches a live hive.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const HIVE = arg('--hive'); const DB = arg('--db'); const OUT = arg('--out'); const LEGACY = arg('--legacy-palace');
if (!HIVE || !DB || !OUT) { console.error('usage: --hive <copy> --db <file> --out <dir> [--legacy-palace <copy>]'); process.exit(2); }
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
const { CHUNKER_VERSION, CHUNK_MAX_TOKENS } = loadTs('src/main/nativeMemory/chunker.ts');
const { discoverSources } = loadTs('src/main/nativeMemory/sources.ts');

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
const modelDir = path.join(REPO, 'resources', 'models', manifest.model.dir);
const vecPath = sqliteVec.getLoadablePath();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  const store = NativeMemoryStore.open(DB, { Database, vecPath, vecSha256: sha(fs.readFileSync(vecPath)) });
  const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'))));
  const emb = new OnnxEmbedder(path.join(modelDir, 'onnx', 'model.onnx'), tok, ort, { intraOpNumThreads: 2 });
  const eng = new MemoryEngine({ hiveRoot: HIVE, store, embedder: emb, countTokens: (t) => tok.count(t), mode: () => 'migration', watch: null });
  let rssPeak = 0;
  const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 100);
  const rssBefore = process.memoryUsage().rss;
  const t0 = Date.now();
  const r = await eng.backfill();
  const ms = Date.now() - t0;
  clearInterval(sampler);
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  store.checkpoint();
  const counts = store.counts();
  const buildId = crypto.randomBytes(8).toString('hex');
  store.setMeta('build_id', buildId);
  store.setMeta('embedder', `${manifest.model.source}#${manifest.model.onnxSha256}`);
  store.setMeta('dim', '384');
  const sources = store.db.prepare('SELECT path, sha256, allowed_kind AS kind, wing, room, mtime_ms AS mtimeMs, bytes, (SELECT count(*) FROM chunks c WHERE c.source_id = s.source_id) AS chunks FROM sources s ORDER BY path').all();
  const d = r.discovery;
  const report = {
    kind: 'native-memory-migration-report', hive: 'copy', allowListVersion: d.allowListVersion,
    counts: { discovered: d.counts.discovered, eligible: d.counts.eligible, excludedByRule: d.counts.excludedByRule, unreadable: d.counts.unreadable, chunked: counts.chunks, embedded: r.embedded, failed: eng.failed.size, vectors: counts.vectors },
    failed: [...eng.failed.entries()],
    excludedMd: d.excludedMd,
    rejectedConfig: d.rejectedConfig,
    chunker: { version: CHUNKER_VERSION, maxTokens: CHUNK_MAX_TOKENS },
    embedder: { model: manifest.model.source, variant: manifest.model.variant, onnxSha256: manifest.model.onnxSha256, dim: 384, intraOpNumThreads: 2, batch: 8, loadMs: emb.loadMs },
    buildId,
    timing: { backfillMs: ms, perChunkMs: r.embedded ? ms / r.embedded : null, embedMs: eng.stats.embedMs },
    rss: { beforeMB: +(rssBefore / 1048576).toFixed(1), peakMB: +(rssPeak / 1048576).toFixed(1) },
    dbBytes: store.fileBytes(),
    manifest: sources
  };
  fs.writeFileSync(path.join(OUT, 'migration-report.json'), JSON.stringify(report, null, 1));
  if (LEGACY) {
    const l = new Database(path.join(LEGACY, 'chroma.sqlite3'), { readonly: true, fileMustExist: true });
    const rows = l.prepare("SELECT string_value AS src, count(*) AS n FROM embedding_metadata WHERE key = 'source_file' GROUP BY string_value").all();
    l.close();
    const keep = new Set(sources.map((s) => s.path));
    const rel = (p) => { const n = p.replace(/\\/g, '/'); const i = n.indexOf('/hive/'); return i >= 0 ? n.slice(i + 6) : n; };
    const cls = (p) => (/\/memory\.md$/i.test(p) ? 'memory.md' : /^agents\/[^/]+\/[^/]+\.md$/i.test(p) ? 'direct .md' : /\.md$/i.test(p) ? 'nested .md' : /\.(json|jsonl|csv)$/i.test(p) ? 'data' : 'other');
    const by = {};
    for (const r2 of rows) {
      const p = rel(r2.src); const c = cls(p); const k = keep.has(p) ? 'kept' : 'dropped';
      by[c] = by[c] || { kept: { files: 0, chunks: 0 }, dropped: { files: 0, chunks: 0 } };
      by[c][k].files++; by[c][k].chunks += r2.n;
    }
    const droppedMd = rows.map((r2) => rel(r2.src)).filter((p) => /\.md$/i.test(p) && !keep.has(p)).sort();
    fs.writeFileSync(path.join(OUT, 'legacy-scope.json'), JSON.stringify({ legacySourceFiles: rows.length, legacyChunks: rows.reduce((s, x) => s + x.n, 0), byClass: by, droppedMd }, null, 1));
  }
  store.close();
  await emb.unload();
  console.log(JSON.stringify({ ok: true, counts: report.counts, ms, dbBytes: report.dbBytes, rss: report.rss }));
  process.exit(0);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
