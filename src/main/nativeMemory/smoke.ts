/**
 * NATIVE-MEMORY gate 2: the INSTALLED-ARTIFACT utility-process smoke (spec section 5.3, Jim R6).
 *
 *   "Munder Difflin.exe" --native-memory-smoke=<result.json>
 *
 * index.ts sees the flag before anything reads userData, points userData at a fresh temp folder
 * (so no config, no hive, nothing of the user's is opened), skips the whole bootstrap and never
 * creates a window. Then this forks the REAL memory worker through `utilityProcess.fork` - the
 * shipped better-sqlite3, vec0.dll, onnxruntime and model, from the installed layout - over a
 * scratch hive, and has it: ingest one memory.md (ONNX loads first, then vec0 rows are written
 * with BigInt rowids: the co-load regression), search it, and report its status. The result is
 * written to the FILE (Electron's stdout is not evidence on Windows), then the app exits.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerHandle } from './service';
import type { WorkerConfig } from './worker';

export const SMOKE_FLAG = '--native-memory-smoke=';

export function smokeTarget(argv: readonly string[]): string | null {
  const a = argv.find((x) => x.startsWith(SMOKE_FLAG));
  return a ? a.slice(SMOKE_FLAG.length) || null : null;
}

export interface SmokeDeps {
  fork: () => WorkerHandle;
  /** Worker config for a given hive root (NativeMemoryWiring.workerConfig, re-pointed). */
  configFor: (hiveRoot: string, dbFile: string) => WorkerConfig | null;
  appVersion: string;
  packaged: boolean;
}

export async function runMemorySmoke(outFile: string, d: SmokeDeps): Promise<boolean> {
  const t0 = Date.now();
  const result: Record<string, unknown> = { kind: 'native-memory-smoke', appVersion: d.appVersion, packaged: d.packaged, utilityProcess: true, pid: process.pid };
  let ok = false;
  let w: WorkerHandle | null = null;
  try {
    const scratch = mkdtempSync(join(tmpdir(), 'munder-memory-smoke-'));
    const agent = join(scratch, 'hive', 'agents', 'smoke');
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'memory.md'), '## 2026-09-26 smoke\n- the native memory engine indexed this line inside a utility process\n');
    const cfg = d.configFor(join(scratch, 'hive'), join(scratch, 'index.sqlite'));
    if (!cfg) throw new Error('no worker config: the model, manifest or vec0 is missing from the install');
    result.config = { modelDir: cfg.modelDir, vecPath: cfg.vecPath, modelSha256: cfg.modelSha256, vecSha256: cfg.vecSha256 };
    w = d.fork();
    const pending = new Map<number, (m: Record<string, unknown>) => void>();
    let ready!: () => void;
    const readyP = new Promise<void>((r) => { ready = r; });
    const logs: unknown[] = [];
    w.on('message', (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.event === 'ready') ready();
      else if (m.event) logs.push(m);
      else if (typeof m.id === 'number') pending.get(m.id)?.(m);
    });
    let exitCode: number | null = null;
    w.on('exit', (c) => { exitCode = c; });
    const ask = (id: number, op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${op} timed out`)), 120_000);
        pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        w!.postMessage({ id, op, args, deadline: Date.now() + 120_000 });
      });
    w.postMessage({ op: 'init', config: cfg });
    await Promise.race([readyP, new Promise((_r, rej) => setTimeout(() => rej(new Error('worker never became ready')), 60_000))]);
    result.readyMs = Date.now() - t0;
    const bf = await ask(1, 'backfill');
    const s = await ask(2, 'search', { query: 'indexed inside a utility process', results: 1 });
    const st = await ask(3, 'status');
    result.backfill = bf.json;
    result.search = { exit: s.exit, firstLine: typeof s.text === 'string' ? s.text.split('\n').find((l) => l.includes('[1]')) ?? null : null };
    result.status = st.json;
    result.workerLogs = logs;
    await ask(4, 'shutdown').catch(() => undefined);
    result.workerExit = exitCode;
    ok = s.exit === 0 && typeof s.text === 'string' && s.text.includes('smoke / memory');
  } catch (e) {
    result.error = String((e as Error)?.stack ?? e);
  } finally {
    try { w?.kill(); } catch { /* gone */ }
  }
  result.ok = ok;
  result.totalMs = Date.now() - t0;
  writeFileSync(outFile, JSON.stringify(result, null, 1));
  return ok;
}
