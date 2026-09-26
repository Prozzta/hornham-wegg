/**
 * NATIVE-MEMORY sections 2 and 7: the derived index in one SQLite file (better-sqlite3 +
 * FTS5 + sqlite-vec). It is a CACHE of the Markdown sources: disposable, rebuilt by
 * re-embedding them, never imported from Chroma.
 *
 * Only the memory worker (a utility process) ever constructs this. Electron main never opens
 * the database, loads the extension or runs its SQL (spec section 3).
 *
 * Chunk-diff (Jim R7): a changed source keeps the rowid AND embedding of every chunk whose
 * content is unchanged; only new/changed chunks are embedded and inserted, vanished ones are
 * deleted, all in one transaction. Replace-by-source would rewrite every chunk of memory.md on
 * each append - the MINE-REGROWTH pattern - and a vec0 delete is not proven to reuse its slot.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import { sha256 } from './sources';
import type { Chunk } from './chunker';
import { EMBED_DIM } from './embedder';

export const SCHEMA_VERSION = 1;

export type Db = BetterSqlite3.Database;

export interface StoreOpenOptions {
  /** better-sqlite3's constructor (injected: the app's Electron-ABI build). */
  Database: new (file: string, opts?: Record<string, unknown>) => Db;
  /** The sqlite-vec loadable library, and the SHA-256 it must have (verified BEFORE load). */
  vecPath: string;
  vecSha256: string | null;
}

export interface SourceMeta {
  path: string;
  sha256: string;
  kind: string;
  wing: string;
  room: string;
  mtimeMs: number;
  bytes: number;
}

export interface DiffPlan {
  path: string;
  /** Existing chunks that survive, with the ordinal they take in the new text. */
  keep: Array<{ chunkId: number; ordinal: number }>;
  /** New chunk texts to embed and insert. */
  add: Chunk[];
  /** Existing chunk ids to delete. */
  remove: number[];
  /** Every chunk the source had when the plan was made, as "id:contentSha". A rowid alone is
   *  not an identity: SQLite reuses the highest deleted rowids, so after another change the
   *  same ids can name different chunks. */
  expect: string[];
}

export interface SearchOptions {
  query: string;
  queryVec: Float32Array | null;
  wing?: string | null;
  room?: string | null;
  sinceMs?: number | null;
  beforeMs?: number | null;
  k: number;
}

export interface SearchHit {
  chunkId: number;
  wing: string;
  room: string;
  source: string;
  content: string;
  cosineSim: number | null;
  bm25: number | null;
  score: number;
}

const f32 = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** A conservative FTS5 query: each word of letters/digits/_ quoted, OR-ed. Nothing of the
 *  user's text reaches FTS5 syntax (no operators, no column filters, no NEAR). */
export function ftsQuery(text: string): string | null {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1 || /\d/.test(t)).slice(0, 32);
  if (!terms.length) return null;
  return [...new Set(terms)].map((t) => `"${t}"`).join(' OR ');
}

/** Reciprocal-rank fusion over two ranked id lists; ties broken by the vector rank, then id. */
export function rrf(lexical: number[], vector: number[], k0 = 60): Array<{ id: number; score: number }> {
  const score = new Map<number, number>();
  const vrank = new Map<number, number>();
  lexical.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k0 + i + 1)));
  vector.forEach((id, i) => { score.set(id, (score.get(id) ?? 0) + 1 / (k0 + i + 1)); vrank.set(id, i); });
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score || (vrank.get(a.id) ?? 1e9) - (vrank.get(b.id) ?? 1e9) || a.id - b.id);
}

export class NativeMemoryStore {
  private constructor(readonly db: Db, readonly file: string) {}

  /** Open (creating) the index. Verifies the extension's SHA-256 before loading it. Throws on a
   *  digest mismatch: a changed DLL is never loaded. */
  static open(file: string, o: StoreOpenOptions): NativeMemoryStore {
    if (o.vecSha256) {
      const got = sha256(readFileSync(o.vecPath));
      if (got !== o.vecSha256) throw new Error(`native-memory: vec0 digest mismatch (${got})`);
    }
    const db = new o.Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');
      db.pragma(`journal_size_limit = ${8 * 1024 * 1024}`);
      db.loadExtension(o.vecPath);
      const s = new NativeMemoryStore(db, file);
      s.ensureSchema();
      return s;
    } catch (e) {
      // A corrupt file can fail AFTER the handle opened: close it, or the quarantine rename
      // that follows is EBUSY on Windows.
      try { db.close(); } catch { /* already closed */ }
      throw e;
    }
  }

  /** `PRAGMA quick_check`: true when the file is sound. */
  quickCheck(): boolean {
    try {
      const rows = this.db.pragma('quick_check') as Array<Record<string, string>>;
      return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
    } catch {
      return false;
    }
  }

  close(): void {
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* closing anyway */ }
    this.db.close();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources(
        source_id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, sha256 TEXT NOT NULL,
        allowed_kind TEXT NOT NULL, wing TEXT NOT NULL, room TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
        manifest_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(
        chunk_id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id),
        ordinal INTEGER NOT NULL, wing TEXT NOT NULL, room TEXT NOT NULL, content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL, filed_at INTEGER NOT NULL,
        UNIQUE(source_id, ordinal));
      CREATE INDEX IF NOT EXISTS chunks_wing_room ON chunks(wing, room);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, content='chunks', content_rowid='chunk_id');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_id, new.content); END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.chunk_id, old.content); END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.chunk_id, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_id, new.content); END;
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine);
      CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.setMetaIfAbsent('schema_version', String(SCHEMA_VERSION));
    this.setMetaIfAbsent('generation', '0');
  }

  meta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  private setMetaIfAbsent(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)').run(key, value);
  }

  /** The indexed sources: path -> sha256 (the reconcile's view). */
  sourceShas(): Map<string, string> {
    const rows = this.db.prepare('SELECT path, sha256 FROM sources').all() as Array<{ path: string; sha256: string }>;
    return new Map(rows.map((r) => [r.path, r.sha256]));
  }

  /** Plan a chunk-diff of `path` to `chunks`: match existing chunks by content SHA (as a
   *  multiset, in order), keep them, add the rest, remove what is left over. */
  planDiff(path: string, chunks: Chunk[]): DiffPlan {
    const existing = this.db.prepare('SELECT chunk_id, content_sha256 FROM chunks WHERE source_id = ? ORDER BY ordinal').all(path) as Array<{ chunk_id: number; content_sha256: string }>;
    const pool = new Map<string, number[]>();
    for (const e of existing) { const l = pool.get(e.content_sha256) ?? []; l.push(e.chunk_id); pool.set(e.content_sha256, l); }
    const keep: DiffPlan['keep'] = [];
    const add: Chunk[] = [];
    for (const c of chunks) {
      const l = pool.get(c.contentSha);
      if (l && l.length) keep.push({ chunkId: l.shift()!, ordinal: c.ordinal });
      else add.push(c);
    }
    const remove = [...pool.values()].flat();
    const expect = existing.map((e) => `${e.chunk_id}:${e.content_sha256}`).sort();
    return { path, keep, add, remove, expect };
  }

  /** Apply a plan with the embeddings of `plan.add` (same order), atomically. Returns false
   *  (and changes nothing) when the source's chunks moved since the plan was made. */
  applyDiff(meta: SourceMeta, plan: DiffPlan, embeddings: Float32Array[], nowMs: number, manifestVersion: number): boolean {
    if (embeddings.length !== plan.add.length) throw new Error('applyDiff: embeddings/add length mismatch');
    const tx = this.db.transaction((): boolean => {
      const cur = (this.db.prepare('SELECT chunk_id, content_sha256 FROM chunks WHERE source_id = ?').all(plan.path) as Array<{ chunk_id: number; content_sha256: string }>)
        .map((r) => `${r.chunk_id}:${r.content_sha256}`).sort();
      if (cur.length !== plan.expect.length || cur.some((x, i) => x !== plan.expect[i])) return false;
      this.db.prepare(`INSERT INTO sources(source_id, path, sha256, allowed_kind, wing, room, mtime_ms, bytes, indexed_at, manifest_version)
        VALUES (@p, @p, @sha, @kind, @wing, @room, @mtime, @bytes, @now, @mv)
        ON CONFLICT(source_id) DO UPDATE SET sha256 = excluded.sha256, allowed_kind = excluded.allowed_kind, wing = excluded.wing,
          room = excluded.room, mtime_ms = excluded.mtime_ms, bytes = excluded.bytes, indexed_at = excluded.indexed_at,
          manifest_version = excluded.manifest_version`)
        .run({ p: meta.path, sha: meta.sha256, kind: meta.kind, wing: meta.wing, room: meta.room, mtime: Math.round(meta.mtimeMs), bytes: meta.bytes, now: nowMs, mv: manifestVersion });
      const delChunk = this.db.prepare('DELETE FROM chunks WHERE chunk_id = ?');
      const delVec = this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?');
      for (const id of plan.remove) { delVec.run(BigInt(id)); delChunk.run(id); }
      // Two-phase renumber: park every kept chunk on a negative ordinal first, so moving one
      // onto an ordinal another still holds never trips UNIQUE(source_id, ordinal).
      const setOrd = this.db.prepare('UPDATE chunks SET ordinal = ?, wing = ?, room = ? WHERE chunk_id = ?');
      for (const k of plan.keep) setOrd.run(-1 - k.ordinal, meta.wing, meta.room, k.chunkId);
      for (const k of plan.keep) setOrd.run(k.ordinal, meta.wing, meta.room, k.chunkId);
      const ins = this.db.prepare('INSERT INTO chunks(source_id, ordinal, wing, room, content, content_sha256, filed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insVec = this.db.prepare('INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)');
      plan.add.forEach((c, i) => {
        const info = ins.run(meta.path, c.ordinal, meta.wing, meta.room, c.content, c.contentSha, Math.round(meta.mtimeMs));
        // BigInt rowid: the sqlite-vec + ONNX co-load regression (spec section 3, issue #270).
        insVec.run(BigInt(info.lastInsertRowid), f32(embeddings[i]));
      });
      this.bumpGeneration();
      return true;
    });
    return tx.immediate();
  }

  /** Remove a source and all its chunks from both indexes, atomically. */
  removeSource(path: string): void {
    this.db.transaction(() => {
      const ids = (this.db.prepare('SELECT chunk_id FROM chunks WHERE source_id = ?').all(path) as Array<{ chunk_id: number }>).map((r) => r.chunk_id);
      const delVec = this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?');
      for (const id of ids) delVec.run(BigInt(id));
      this.db.prepare('DELETE FROM chunks WHERE source_id = ?').run(path);
      this.db.prepare('DELETE FROM sources WHERE source_id = ?').run(path);
      this.bumpGeneration();
    }).immediate();
  }

  private bumpGeneration(): void {
    this.setMeta('generation', String(Number(this.meta('generation') ?? '0') + 1));
  }

  /** Hybrid search: FTS5 BM25 and cosine KNN, each over max(4k, 40) candidates, filtered by
   *  wing/room/date BEFORE fusion, fused by RRF. One read snapshot for the whole query. */
  search(o: SearchOptions): SearchHit[] {
    const k = Math.max(1, Math.min(100, Math.floor(o.k)));
    const cand = Math.max(4 * k, 40);
    const filt = ['(@wing IS NULL OR c.wing = @wing)', '(@room IS NULL OR c.room = @room)', '(@since IS NULL OR c.filed_at >= @since)', '(@before IS NULL OR c.filed_at < @before)'].join(' AND ');
    const params = { wing: o.wing ?? null, room: o.room ?? null, since: o.sinceMs ?? null, before: o.beforeMs ?? null };
    const filtered = params.wing !== null || params.room !== null || params.since !== null || params.before !== null;
    const read = this.db.transaction(() => {
      const fq = ftsQuery(o.query);
      const lex = fq
        ? (this.db.prepare(`SELECT c.chunk_id AS id, bm25(chunks_fts) AS s FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.rowid
            WHERE chunks_fts MATCH @q AND ${filt} ORDER BY s LIMIT @n`).all({ ...params, q: fq, n: cand }) as Array<{ id: number; s: number }>)
        : [];
      let vec: Array<{ id: number; d: number }> = [];
      if (o.queryVec) {
        const qv = f32(o.queryVec);
        vec = filtered
          // Filtered: an exact scan of the filtered rows (vec0 KNN cannot pre-filter by a joined column).
          ? this.db.prepare(`SELECT c.chunk_id AS id, vec_distance_cosine(v.embedding, @qv) AS d FROM chunks c JOIN chunks_vec v ON v.rowid = c.chunk_id
              WHERE ${filt} ORDER BY d LIMIT @n`).all({ ...params, qv, n: cand }) as Array<{ id: number; d: number }>
          : this.db.prepare('SELECT rowid AS id, distance AS d FROM chunks_vec WHERE embedding MATCH @qv AND k = @n ORDER BY distance').all({ qv, n: cand }) as Array<{ id: number; d: number }>;
      }
      const fused = rrf(lex.map((r) => r.id), vec.map((r) => r.id)).slice(0, k);
      const bm = new Map(lex.map((r) => [r.id, r.s]));
      const dist = new Map(vec.map((r) => [r.id, r.d]));
      const row = this.db.prepare('SELECT chunk_id, wing, room, source_id, content FROM chunks WHERE chunk_id = ?');
      return fused.map((f) => {
        const r = row.get(f.id) as { chunk_id: number; wing: string; room: string; source_id: string; content: string };
        const d = dist.get(f.id);
        const b = bm.get(f.id);
        return {
          chunkId: r.chunk_id, wing: r.wing, room: r.room, source: r.source_id, content: r.content,
          cosineSim: d === undefined ? null : 1 - d,
          bm25: b === undefined ? null : -b,
          score: f.score
        };
      });
    });
    return read.deferred();
  }

  /** Wake-up content (spec section 4 contract, NOT legacy overlap): for the wing, the newest
   *  entries of its memory.md, then its most recently filed other chunks, within `maxChars`. */
  wakeUp(wing: string | null, maxChars = 3200): Array<{ wing: string; room: string; source: string; content: string }> {
    const out: Array<{ wing: string; room: string; source: string; content: string }> = [];
    let used = 0;
    const take = (rows: Array<{ wing: string; room: string; source_id: string; content: string }>): void => {
      for (const r of rows) {
        const cost = r.content.length + 64;
        if (used + cost > maxChars) continue;
        out.push({ wing: r.wing, room: r.room, source: r.source_id, content: r.content });
        used += cost;
      }
    };
    const w = wing ?? null;
    // Newest memory.md entries first (the tail of the file is the newest).
    take(this.db.prepare(`SELECT wing, room, source_id, content FROM chunks WHERE room = 'memory' AND (@w IS NULL OR wing = @w)
      ORDER BY filed_at DESC, ordinal DESC LIMIT 12`).all({ w }) as Array<{ wing: string; room: string; source_id: string; content: string }>);
    // Then the most recently filed deliverable chunks.
    take(this.db.prepare(`SELECT wing, room, source_id, content FROM chunks WHERE room <> 'memory' AND (@w IS NULL OR wing = @w)
      ORDER BY filed_at DESC, ordinal ASC LIMIT 12`).all({ w }) as Array<{ wing: string; room: string; source_id: string; content: string }>);
    return out;
  }

  counts(): { sources: number; chunks: number; vectors: number; generation: number } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      sources: one('SELECT count(*) AS n FROM sources'),
      chunks: one('SELECT count(*) AS n FROM chunks'),
      vectors: one('SELECT count(*) AS n FROM chunks_vec'),
      generation: Number(this.meta('generation') ?? '0')
    };
  }

  /** Bytes the live content needs (pages in use), for the compaction policy. */
  liveEstimateBytes(): number {
    const page = Number(this.db.pragma('page_size', { simple: true }));
    const pages = Number(this.db.pragma('page_count', { simple: true }));
    const free = Number(this.db.pragma('freelist_count', { simple: true }));
    return (pages - free) * page;
  }

  fileBytes(): number {
    let n = 0;
    for (const f of [this.file, `${this.file}-wal`]) { try { n += statSync(f).size; } catch { /* absent */ } }
    return n;
  }

  freelistRatio(): number {
    const pages = Number(this.db.pragma('page_count', { simple: true }));
    const free = Number(this.db.pragma('freelist_count', { simple: true }));
    return pages ? free / pages : 0;
  }

  /** Idle maintenance step 1: checkpoint the WAL back to zero. */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** Idle maintenance step 2: `VACUUM INTO` a same-volume staging file and verify it. The swap
   *  is the worker's (it must drain readers and reopen). Returns the verified staging path. */
  vacuumInto(staging: string, o: StoreOpenOptions): { ok: boolean; why?: string } {
    if (existsSync(staging)) return { ok: false, why: 'staging exists' };
    const before = this.counts();
    this.db.prepare('VACUUM INTO ?').run(staging);
    const copy = NativeMemoryStore.open(staging, o);
    try {
      if (!copy.quickCheck()) return { ok: false, why: 'integrity' };
      const integrity = copy.db.pragma('integrity_check') as Array<Record<string, string>>;
      if (!(integrity.length === 1 && Object.values(integrity[0])[0] === 'ok')) return { ok: false, why: 'integrity' };
      const after = copy.counts();
      if (after.sources !== before.sources || after.chunks !== before.chunks || after.vectors !== before.vectors || after.generation !== before.generation) {
        return { ok: false, why: 'counts' };
      }
      return { ok: true };
    } finally {
      copy.db.close();
    }
  }
}

/** Section 7 (Jim R8): compact when the file is >= 2x the live estimate AND >= 16 MiB, or the
 *  freelist is >= 25%. Past 8x the live estimate it is a health event and the next idle
 *  maintenance is forced. */
export function compactionDecision(fileBytes: number, liveBytes: number, freelistRatio: number): 'none' | 'compact' | 'force' {
  const live = Math.max(1, liveBytes);
  if (fileBytes >= 8 * live && fileBytes >= 16 * 1024 * 1024) return 'force';
  if ((fileBytes >= 2 * live && fileBytes >= 16 * 1024 * 1024) || freelistRatio >= 0.25) return 'compact';
  return 'none';
}
