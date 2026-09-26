/**
 * NATIVE-MEMORY section 3: the engine that lives INSIDE the memory worker (a utility process).
 * It is the only owner of the SQLite connection, sqlite-vec, ONNX Runtime, the source watcher
 * and the write queue. Electron main never does any of that (Jim R1-R3).
 *
 * ONE serialized queue, by priority: search > wake-up/status > changed-source ingest > initial
 * backfill > compaction. Long work is cut into steps (a backfill embeds at most 8 chunks per
 * step and then yields), so a search that arrives mid-backfill waits for one step, not for
 * the backfill.
 */
import { readFileSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { chunkMarkdown, CHUNKER_VERSION, type Chunk } from './chunker';
import { discoverSources, ALLOW_LIST_VERSION, sha256, type Discovery, type SourceEntry } from './sources';
import { compactionDecision, NativeMemoryStore, type SearchHit } from './store';
import { formatSearch, formatStatus, formatWakeUp, WAKE_MAX_CHARS } from './format';

export const PRIORITY = { search: 0, wake: 1, status: 1, ingest: 2, backfill: 3, compact: 4 } as const;
/** Chunks embedded per queue step before yielding (spec section 3: <= 8). ONE: a search that
 *  arrives mid-backfill waits for at most one step. Measured with the shipped worker on the full
 *  hive copy, an 8-chunk step put the engine-side wait's p95 at 255 ms and a 4-chunk step (~100 ms)
 *  still put the END-TO-END p95 during a backfill at 304 ms (the shim's own start is ~110-150 ms),
 *  over the Human's 250 ms speed gate. A 1-chunk step is ~25 ms. */
export const EMBED_BATCH = 1;
/** A source changed on disk is ingested this long after its LAST change (spec: >= 2 s). */
export const SOURCE_DEBOUNCE_MS = 2_000;
/** Drop the model after this long without an embed (Jim R2: idle unload). */
export const MODEL_IDLE_UNLOAD_MS = 10 * 60_000;
/** A reconcile that re-stats every source runs at most this often (a watcher can drop events). */
export const RECONCILE_EVERY_MS = 10 * 60_000;

export interface EmbedderLike {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  unload(): Promise<void>;
  readonly loaded: boolean;
}

export interface EngineDeps {
  hiveRoot: string;
  store: NativeMemoryStore;
  embedder: EmbedderLike;
  countTokens: (text: string) => number;
  mode: () => string;
  now?: () => number;
  /** Non-recursive fs.watch; injected so tests can drive changes. Null = no watcher. */
  watch?: ((dir: string, onChange: (file: string) => void) => { close(): void }) | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (row: Record<string, unknown>) => void;
  /** Told when the idle timer drops the model (Jim N2: main then treats the next search as cold). */
  onModelUnload?: () => void;
  /** Idle time before the model is dropped (default MODEL_IDLE_UNLOAD_MS; the speed bench
   *  shortens it to measure model-cold). */
  idleUnloadMs?: number;
}

interface Task { priority: number; seq: number; run: () => Promise<void> }

export interface SearchArgs { query: string; wing?: string | null; room?: string | null; results?: number; since?: string | null; before?: string | null;
  /** The asking agent's own wing (from its MEMORY_TOKEN): never a filter, only a backfill hint. */
  caller?: string | null }
export interface EngineReply { exit: number; text: string; json?: unknown }

export class MemoryEngine {
  private queue: Task[] = [];
  private seq = 0;
  private running = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private debounce = new Map<string, unknown>();
  private watchers: Array<{ close(): void }> = [];
  private unloadTimer: unknown = null;
  private lastReconcileAt = 0;
  /** The backfill in progress (one at a time; a second caller waits for the same one). */
  private backfilling: Promise<{ discovery: Discovery; embedded: number; removed: number }> | null = null;
  /** Paths whose ingest failed, with the error (the migration report's "failed"). */
  readonly failed = new Map<string, string>();
  /** NATIVE-WAKEUP-EMPTY-INDEX (b): wings a caller asked about. A backfill in progress takes their
   *  sources NEXT (checked before every source), so an agent's own memory is indexed first even
   *  when the backfill had already started without it (e.g. at app start). */
  private readonly preferredWings = new Set<string>();

  /** Mark a caller's wing as wanted: the running (or next) backfill indexes it first. */
  preferWing(wing: string | null | undefined): void {
    if (typeof wing === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(wing)) this.preferredWings.add(wing);
  }
  stats = { embedded: 0, embedMs: 0, searches: 0 };

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  // — the queue —

  private enqueue<T>(priority: number, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ priority, seq: this.seq++, run: () => fn().then(resolve, reject) });
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const t = this.queue.shift();
    if (!t) return;
    this.running = true;
    void t.run().finally(() => {
      this.running = false;
      // Yield to the event loop between steps: incoming messages (a search) are queued first.
      this.setTimer(() => this.pump(), 0);
    });
  }

  /** Pending tasks by priority (diagnostics, tests). */
  queued(): number[] {
    return this.queue.map((t) => t.priority);
  }

  // — embedding —

  private async embed(texts: string[]): Promise<Float32Array[]> {
    const t0 = this.now();
    const v = await this.d.embedder.embed(texts);
    this.stats.embedded += texts.length;
    this.stats.embedMs += this.now() - t0;
    if (this.unloadTimer) this.clearTimer(this.unloadTimer);
    this.unloadTimer = this.setTimer(() => { this.unloadTimer = null; void this.d.embedder.unload(); this.d.onModelUnload?.(); }, this.d.idleUnloadMs ?? MODEL_IDLE_UNLOAD_MS);
    return v;
  }

  // — requests —

  search(a: SearchArgs): Promise<EngineReply> {
    // (b) The wing searched, else the caller's own, is wanted: index it first.
    this.preferWing(a.wing ?? a.caller ?? null);
    return this.enqueue(PRIORITY.search, async () => {
      this.stats.searches++;
      const sinceMs = a.since ? Date.parse(a.since) : null;
      const beforeMs = a.before ? Date.parse(a.before) : null;
      const [qv] = await this.embed([a.query]);
      const hits = this.d.store.search({ query: a.query, queryVec: qv, wing: a.wing ?? null, room: a.room ?? null, sinceMs, beforeMs, k: a.results ?? 5 });
      return { exit: 0, text: formatSearch(a.query, a, hits), json: hits.map(redactHit) };
    });
  }

  /** Raw hits (the parity replay and shadow diagnostics). */
  searchHits(a: SearchArgs): Promise<SearchHit[]> {
    return this.enqueue(PRIORITY.search, async () => {
      const [qv] = await this.embed([a.query]);
      return this.d.store.search({ query: a.query, queryVec: qv, wing: a.wing ?? null, room: a.room ?? null, k: a.results ?? 10 });
    });
  }

  wakeUp(wing: string | null): Promise<EngineReply> {
    // (b) A wake-up is the caller's (or an explicit) wing: index it first.
    this.preferWing(wing);
    return this.enqueue(PRIORITY.wake, async () => {
      let identity: string | null = null;
      if (wing && /^[A-Za-z0-9._-]+$/.test(wing)) {
        try { identity = readFileSync(join(this.d.hiveRoot, 'agents', wing, 'identity.md'), 'utf8'); } catch { identity = null; }
      }
      const entries = this.d.store.wakeUp(wing, WAKE_MAX_CHARS);
      return { exit: 0, text: formatWakeUp(identity, entries) };
    });
  }

  status(): Promise<EngineReply> {
    return this.enqueue(PRIORITY.status, async () => {
      const c = this.d.store.counts();
      const perWing = this.d.store.db.prepare('SELECT wing, count(*) AS chunks FROM chunks GROUP BY wing ORDER BY wing').all() as Array<{ wing: string; chunks: number }>;
      const s = { ...c, dbBytes: this.d.store.fileBytes(), perWing, mode: this.d.mode() };
      return { exit: 0, text: formatStatus(s), json: { ...s, embedded: this.stats.embedded, failed: this.failed.size, modelLoaded: this.d.embedder.loaded } };
    });
  }

  // — ingestion —

  private readSource(e: SourceEntry): { meta: { path: string; sha256: string; kind: string; wing: string; room: string; mtimeMs: number; bytes: number }; text: string } | null {
    try {
      const buf = readFileSync(e.abs);
      const st = statSync(e.abs);
      return { meta: { path: e.path, sha256: sha256(buf), kind: e.kind, wing: e.wing, room: e.room, mtimeMs: st.mtimeMs, bytes: buf.length }, text: buf.toString('utf8') };
    } catch (err) {
      this.failed.set(e.path, String((err as Error).message ?? err));
      return null;
    }
  }

  /** Chunk-diff one source into the index, embedding its new chunks EMBED_BATCH at a time
   *  (each batch its own queue step). `priority` separates a changed-source ingest from the
   *  initial backfill. Returns the number of chunks embedded. */
  private async ingestEntry(e: SourceEntry, priority: number): Promise<number> {
    const src = this.readSource(e);
    if (!src) return 0;
    if (this.d.store.sourceShas().get(e.path) === src.meta.sha256) return 0;
    const chunks = chunkMarkdown(src.text, this.d.countTokens);
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = this.d.store.planDiff(e.path, chunks);
      const vectors: Float32Array[] = [];
      for (let i = 0; i < plan.add.length; i += EMBED_BATCH) {
        const batch = plan.add.slice(i, i + EMBED_BATCH).map((c: Chunk) => c.content);
        vectors.push(...await this.enqueue(priority, () => this.embed(batch)));
      }
      const ok = await this.enqueue(priority, async () => this.d.store.applyDiff(src.meta, plan, vectors, this.now(), ALLOW_LIST_VERSION));
      if (ok) { this.failed.delete(e.path); return plan.add.length; }
    }
    this.failed.set(e.path, 'the source changed during two ingest attempts');
    return 0;
  }

  /** Reconcile the index with the allow-list: ingest new/changed sources, remove vanished ones.
   *  Resumable: a source is committed only when all its chunks are in, so an interrupted
   *  backfill just continues with the sources whose SHA does not match yet. */
  backfill(): Promise<{ discovery: Discovery; embedded: number; removed: number }> {
    if (this.backfilling) return this.backfilling;
    this.lastReconcileAt = this.now();
    this.d.store.setMeta('chunker_version', String(CHUNKER_VERSION));
    this.d.store.setMeta('allow_list_version', String(ALLOW_LIST_VERSION));
    const run = (async () => {
      const discovery = discoverSources(this.d.hiveRoot);
      let embedded = 0;
      let removed = 0;
      const wanted = new Set(discovery.eligible.map((e) => e.path));
      for (const path of this.d.store.sourceShas().keys()) {
        if (!wanted.has(path)) { await this.enqueue(PRIORITY.backfill, async () => this.d.store.removeSource(path)); removed++; }
      }
      // (b) Before EACH source, a preferred wing (a caller that asked meanwhile) goes first.
      const remaining = [...discovery.eligible];
      while (remaining.length) {
        const i = Math.max(0, remaining.findIndex((x) => this.preferredWings.has(x.wing)));
        const [e] = remaining.splice(i, 1);
        embedded += await this.ingestEntry(e, PRIORITY.backfill);
      }
      this.d.log?.({ kind: 'native-memory-backfill', eligible: discovery.eligible.length, embedded, removed, failed: this.failed.size });
      return { discovery, embedded, removed };
    })().finally(() => { this.backfilling = null; });
    this.backfilling = run;
    return run;
  }

  /** A watched file changed: debounce, then ingest just that source (or remove it). */
  sourceChanged(absPath: string): void {
    const prev = this.debounce.get(absPath);
    if (prev) this.clearTimer(prev);
    this.debounce.set(absPath, this.setTimer(() => {
      this.debounce.delete(absPath);
      const e = discoverSources(this.d.hiveRoot).eligible.find((x) => x.abs === absPath);
      if (e) { void this.ingestEntry(e, PRIORITY.ingest); return; }
      // Not eligible (or gone): if it was indexed, remove it.
      const rel = absPath.slice(this.d.hiveRoot.length + 1).split(/[\\/]/).join('/');
      if (this.d.store.sourceShas().has(rel)) void this.enqueue(PRIORITY.ingest, async () => this.d.store.removeSource(rel));
    }, SOURCE_DEBOUNCE_MS));
  }

  /** Watch the allow-list only, NON-recursively: the agents dir (new agents), each agent dir,
   *  and the hive root (the top-level list). */
  startWatching(): void {
    const w = this.d.watch === undefined ? defaultWatch : this.d.watch;
    if (!w) return;
    const on = (dir: string) => (file: string): void => {
      if (/\.md$/i.test(file)) this.sourceChanged(join(dir, file));
    };
    const agentsDir = join(this.d.hiveRoot, 'agents');
    const watched = new Set<string>();
    const watchAgent = (dir: string): void => {
      if (watched.has(dir)) return;
      watched.add(dir);
      try { this.watchers.push(w(dir, on(dir))); } catch { /* the reconcile covers it */ }
    };
    try { this.watchers.push(w(this.d.hiveRoot, on(this.d.hiveRoot))); } catch { /* ditto */ }
    try {
      this.watchers.push(w(agentsDir, (name) => { if (/^[A-Za-z0-9._-]+$/.test(name)) watchAgent(join(agentsDir, name)); }));
    } catch { /* no agents dir yet */ }
    for (const e of discoverSources(this.d.hiveRoot).eligible) {
      if (e.kind !== 'top-level') watchAgent(join(this.d.hiveRoot, ...e.path.split('/').slice(0, 2)));
    }
  }

  /** Idle tick: a periodic reconcile (a watcher can drop events), then compaction if due. */
  async idle(): Promise<void> {
    if (this.now() - this.lastReconcileAt >= RECONCILE_EVERY_MS) await this.backfill();
    await this.enqueue(PRIORITY.compact, async () => {
      this.d.store.checkpoint();
    });
  }

  /** The compaction decision for the current file (the worker performs the swap). */
  compactionDue(): 'none' | 'compact' | 'force' {
    const s = this.d.store;
    return compactionDecision(s.fileBytes(), s.liveEstimateBytes(), s.freelistRatio());
  }

  /**
   * Section 7 idle maintenance, as ONE compaction-priority queue step (so no search or ingest
   * runs across it): checkpoint, `VACUUM INTO` a same-volume staging file, verify it (integrity,
   * counts, generation), then close, keep the current file as the one retained prior, move the
   * staging file in, and reopen. Returns what happened.
   */
  compact(reopen: (file: string) => NativeMemoryStore, rename: (a: string, b: string) => void, remove: (f: string) => void, force = false): Promise<string> {
    return this.enqueue(PRIORITY.compact, async () => {
      const s = this.d.store;
      const decision = this.compactionDue();
      if (decision === 'none' && !force) return 'not-due';
      s.checkpoint();
      const staging = `${s.file}.compact-${this.now()}`;
      const opts = this.storeOpenOptions;
      if (!opts) return 'no-open-options';
      const v = s.vacuumInto(staging, opts);
      if (!v.ok) { try { remove(staging); } catch { /* best-effort */ } return `verify-failed:${v.why}`; }
      s.close();
      const prior = `${s.file}.prior`;
      try { remove(prior); } catch { /* none */ }
      for (const side of ['-wal', '-shm']) { try { remove(`${s.file}${side}`); } catch { /* none */ } }
      rename(s.file, prior);
      rename(staging, s.file);
      this.d.store = reopen(s.file);
      this.d.log?.({ kind: 'native-memory-compacted', decision });
      return `compacted:${decision}`;
    });
  }

  /** The live store (it changes across a compaction swap). */
  storeRef(): NativeMemoryStore {
    return this.d.store;
  }

  /** Set by the worker: how to open a staging copy for verification. */
  storeOpenOptions: import('./store').StoreOpenOptions | null = null;

  async close(): Promise<void> {
    for (const t of this.debounce.values()) this.clearTimer(t);
    this.debounce.clear();
    for (const w of this.watchers) { try { w.close(); } catch { /* gone */ } }
    this.watchers = [];
    if (this.unloadTimer) this.clearTimer(this.unloadTimer);
    await this.d.embedder.unload();
  }
}

function defaultWatch(dir: string, onChange: (file: string) => void): FSWatcher {
  return fsWatch(dir, { persistent: false }, (_ev, f) => { if (f) onChange(String(f)); });
}

/** Shadow diagnostics and JSON output carry no content: ids, sources, ranks, scores. */
export function redactHit(h: SearchHit): Record<string, unknown> {
  return { chunkId: h.chunkId, wing: h.wing, room: h.room, source: h.source, cosineSim: h.cosineSim, bm25: h.bm25 };
}
