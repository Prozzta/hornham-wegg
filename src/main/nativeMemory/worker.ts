/**
 * NATIVE-MEMORY section 3: the memory worker's entry point. Electron main forks this with
 * `utilityProcess.fork` LAZILY (on the first memory request; see client.ts). It owns every
 * piece of the engine; main only relays short messages.
 *
 * Protocol (both directions structured-clone messages on the parent port):
 *   main -> worker  { id, op, args, deadline }      op: search | wake-up | status | backfill |
 *                                                        report | hits | compact | shutdown
 *   worker -> main  { id, ok, exit, text?, json?, error? }   and  { event, ...fields }
 * A request whose deadline passed while it waited in the queue is answered `expired` without
 * running: the caller already gave up on it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { constants as osConstants, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { OnnxEmbedder, type OrtLike } from './embedder';
import { MemoryEngine } from './engine';
import { NativeMemoryStore, type StoreOpenOptions } from './store';
import { discoverSources, sha256 } from './sources';
import { AppendFile } from '../appendLog';
import { classifyQuery } from './service';
import { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } from './wordpiece';

export interface WorkerConfig {
  hiveRoot: string;
  dbFile: string;
  modelDir: string;
  /** Expected SHA-256 of `<modelDir>/onnx/model.onnx` (checked before the first load). */
  modelSha256: string | null;
  vecPath: string;
  vecSha256: string | null;
  modeFile: string;
}

export interface Port {
  on(ev: 'message', fn: (e: { data: unknown }) => void): void;
  postMessage(msg: unknown): void;
}

export interface WorkerMessage { id: number; op: string; args?: Record<string, unknown>; deadline?: number }

export function readMode(modeFile: string): string {
  try {
    const m = JSON.parse(readFileSync(modeFile, 'utf8')) as { mode?: unknown };
    return typeof m.mode === 'string' ? m.mode : 'legacy';
  } catch {
    return 'legacy';
  }
}

/** Open the store; a file that fails `quick_check` is quarantined and a fresh one created
 *  (it is a cache: the backfill rebuilds it from the Markdown). */
export function openOrQuarantine(file: string, o: StoreOpenOptions, now = Date.now()): { store: NativeMemoryStore; quarantined: string | null } {
  mkdirSync(dirname(file), { recursive: true });
  let quarantined: string | null = null;
  if (existsSync(file)) {
    let ok = false;
    try { const s = NativeMemoryStore.open(file, o); ok = s.quickCheck(); if (ok) return { store: s, quarantined }; s.db.close(); } catch { ok = false; }
    quarantined = `${file}.corrupt-${now}`;
    renameSync(file, quarantined);
    for (const side of ['-wal', '-shm']) { try { rmSync(`${file}${side}`, { force: true }); } catch { /* none */ } }
  }
  return { store: NativeMemoryStore.open(file, o), quarantined };
}

export async function runWorker(cfg: WorkerConfig, port: Port, deps: { Database: StoreOpenOptions['Database']; ort: OrtLike }): Promise<void> {
  // Below-normal priority: the backfill must not compete with the renderer and the PTYs (R1).
  try { setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: carry on */ }
  const openOpts: StoreOpenOptions = { Database: deps.Database, vecPath: cfg.vecPath, vecSha256: cfg.vecSha256 };
  const { store, quarantined } = openOrQuarantine(cfg.dbFile, openOpts);
  const tokenizer = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(readFileSync(join(cfg.modelDir, 'tokenizer.json'), 'utf8'))));
  const modelPath = join(cfg.modelDir, 'onnx', 'model.onnx');
  let modelVerified = cfg.modelSha256 === null;
  const verifiedOrt: OrtLike = {
    Tensor: deps.ort.Tensor,
    InferenceSession: {
      create: async (p, opts) => {
        if (!modelVerified) {
          const got = sha256(readFileSync(p));
          if (got !== cfg.modelSha256) throw new Error(`native-memory: model digest mismatch (${got})`);
          modelVerified = true;
        }
        return deps.ort.InferenceSession.create(p, opts);
      }
    }
  };
  const embedder = new OnnxEmbedder(modelPath, tokenizer, verifiedOrt, { intraOpNumThreads: 2 });
  const engine = new MemoryEngine({
    hiveRoot: cfg.hiveRoot, store, embedder, countTokens: (t) => tokenizer.count(t), mode: () => readMode(cfg.modeFile),
    log: (row) => port.postMessage({ event: 'log', ...row }),
    onModelUnload: () => port.postMessage({ event: 'model-unloaded' })
  });
  engine.storeOpenOptions = openOpts;
  if (quarantined) port.postMessage({ event: 'log', kind: 'native-memory-quarantined', file: quarantined });
  port.postMessage({ event: 'ready' });

  const reply = (id: number, r: Record<string, unknown>): void => port.postMessage({ id, ...r });
  // Gate-6 review capture (opt-in window, see service.reviewCaptureActive): beside the index in
  // userData, never in the hive. Kept open like the hive log (no rescan per row), rotated at 8 MB.
  const reviewFile = new AppendFile(`${cfg.dbFile}.shadow-review.jsonl`, { keep: Infinity });
  port.on('message', (e) => {
    const m = e.data as WorkerMessage;
    if (!m || typeof m.id !== 'number' || typeof m.op !== 'string') return;
    const a = m.args ?? {};
    const expired = (): boolean => typeof m.deadline === 'number' && Date.now() > m.deadline;
    const guard = <T>(p: Promise<T>, map: (v: T) => Record<string, unknown>): void => {
      p.then((v) => reply(m.id, expired() ? { ok: false, exit: 4, error: 'expired' } : { ok: true, ...map(v) }),
        (err) => reply(m.id, { ok: false, exit: 4, error: String((err as Error)?.message ?? err) }));
    };
    switch (m.op) {
      case 'search':
        guard(engine.search({ query: String(a.query ?? ''), wing: (a.wing as string) ?? null, room: (a.room as string) ?? null, results: Number(a.results ?? 5), since: (a.since as string) ?? null, before: (a.before as string) ?? null }), (r) => ({ exit: r.exit, text: r.text, json: r.json }));
        break;
      case 'hits':
        guard(engine.searchHits({ query: String(a.query ?? ''), wing: (a.wing as string) ?? null, results: Number(a.results ?? 10) }), (h) => {
          const json = h.map((x) => ({ chunkId: x.chunkId, wing: x.wing, room: x.room, source: x.source, cosineSim: x.cosineSim, bm25: x.bm25, contentSha: sha256(x.content) }));
          if (a.review === true) {
            const legacy = Array.isArray(a.legacy) ? a.legacy : [];
            const q = String(a.query ?? '');
            reviewFile.append(JSON.stringify({
              at: new Date().toISOString(), agent: a.agent ?? null, query: q, wing: a.wing ?? null,
              cohort: legacy.length === 0 ? 'no-match' : classifyQuery(q, (a.wing as string) ?? null),
              legacy, native: h.map((x, i) => ({ rank: i + 1, wing: x.wing, room: x.room, source: x.source, chunkId: x.chunkId, text: x.content }))
            }) + '\n');
          }
          return { exit: 0, json };
        });
        break;
      case 'wake-up':
        guard(engine.wakeUp((a.wing as string) ?? null), (r) => ({ exit: r.exit, text: r.text }));
        break;
      case 'status':
        guard(engine.status(), (r) => ({ exit: r.exit, text: r.text, json: r.json }));
        break;
      case 'backfill':
        guard(engine.backfill(), (r) => ({ exit: 0, json: { eligible: r.discovery.eligible.length, embedded: r.embedded, removed: r.removed } }));
        break;
      case 'report': {
        const d = discoverSources(cfg.hiveRoot);
        guard(engine.status(), (s) => ({ exit: 0, json: { allowListVersion: d.allowListVersion, counts: d.counts, excludedMd: d.excludedMd, rejectedConfig: d.rejectedConfig, failed: [...engine.failed.entries()], index: s.json } }));
        break;
      }
      case 'compact':
        guard(engine.compact((f) => openOrQuarantine(f, openOpts).store, renameSync, (f) => rmSync(f, { force: true })), (r) => ({ exit: 0, json: { result: r } }));
        break;
      case 'shutdown':
        try { reviewFile.close(); } catch { /* closed */ }
        void engine.close().then(() => { try { engine.storeRef().close(); } catch { /* closed */ } reply(m.id, { ok: true, exit: 0 }); });
        break;
      default:
        reply(m.id, { ok: false, exit: 2, error: `unknown op ${m.op}` });
    }
  });

  engine.startWatching();
  // Initial migration / reconcile in the background (resumable), then an idle loop.
  void engine.backfill().catch((err) => port.postMessage({ event: 'log', kind: 'native-memory-backfill-failed', error: String(err) }));
  setInterval(() => {
    if (engine.queued().length) return;
    void engine.idle().then(() => (engine.compactionDue() !== 'none'
      ? engine.compact((f) => openOrQuarantine(f, openOpts).store, renameSync, (f) => rmSync(f, { force: true })).then((r) => port.postMessage({ event: 'log', kind: 'native-memory-maintenance', result: r }))
      : undefined)).catch(() => { /* next tick */ });
  }, 60_000).unref?.();
}

/** Utility-process entry: `process.parentPort` exists only there. The config arrives as the
 *  first message (so no path is ever parsed from argv). */
const parentPort = (process as unknown as { parentPort?: Port }).parentPort;
if (parentPort) {
  let started = false;
  parentPort.on('message', (e) => {
    const m = e.data as { op?: string; config?: WorkerConfig };
    if (started || m?.op !== 'init' || !m.config) return;
    started = true;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ort = require('onnxruntime-node');
    void runWorker(m.config, parentPort, { Database, ort }).catch((err) => parentPort.postMessage({ event: 'fatal', error: String((err as Error)?.stack ?? err) }));
  });
}
