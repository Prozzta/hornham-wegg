/**
 * NATIVE-MEMORY speed gate (Jim, MEMORY-154-AUDIT Addendum 2): a WINDOWLESS bench host.
 *
 *   "Munder Difflin.exe" --native-memory-bench=<dir>
 *
 * Like the gate-2 smoke, index.ts sees the flag before anything reads userData, points userData at
 * a fresh temp folder and skips the whole bootstrap; no window is created. This then serves ONLY
 * the memory route, through the SAME main-side code the app uses (NativeMemoryWiring: token, mode,
 * validation, the NativeMemoryClient deadlines, the real utilityProcess worker), on a loopback
 * HTTP server standing in for the broker's `/memory/<token>` route, so an external driver can time
 * what an agent waits for: the wrapper on PATH -> the shim -> this -> the worker -> the answer.
 *
 * <dir>/bench-config.json: { "hiveRoot": "<a COPY of the hive Markdown>", "idleUnloadMs"?: n, "dbFile"?: "<index
 * file that outlives one host run, for worker-cold after a restart>" }
 * writes <dir>/host.json { url, token, pid } when ready; stops when <dir>/stop appears (or after
 * 20 minutes), then writes <dir>/host-result.json (main event-loop delay, requests) and exits.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NativeMemoryWiring } from './mainWiring';

export const BENCH_FLAG = '--native-memory-bench=';
const CAP_MS = 20 * 60_000;

export function benchTarget(argv: readonly string[]): string | null {
  const a = argv.find((x) => x.startsWith(BENCH_FLAG));
  return a ? a.slice(BENCH_FLAG.length) || null : null;
}

export async function runMemoryBenchHost(dir: string, makeWiring: (hiveRoot: string, baseUrl: () => string | null, idleUnloadMs: number | null, dbFile: string | null) => NativeMemoryWiring): Promise<void> {
  const cfg = JSON.parse(readFileSync(join(dir, 'bench-config.json'), 'utf8')) as { hiveRoot: string; idleUnloadMs?: number; dbFile?: string };
  let base: string | null = null;
  const wiring = makeWiring(cfg.hiveRoot, () => base, typeof cfg.idleUnloadMs === 'number' ? cfg.idleUnloadMs : null, typeof cfg.dbFile === 'string' ? cfg.dbFile : null);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const m = /^\/memory\/([0-9a-f]{32})$/.exec(req.url ?? '');
    if (!m || req.method !== 'POST') { req.resume(); res.writeHead(404); res.end(); return; }
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      requests++;
      let body: unknown = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = null; }
      void wiring.handle(m[1], body).then((r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body ?? {})); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/memory`;
  const token = wiring.tokens.mint('bench-agent');
  writeFileSync(join(dir, 'host.json'), JSON.stringify({ url: base, token, pid: process.pid }));
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => { if (existsSync(join(dir, 'stop')) || Date.now() - t0 > CAP_MS) { clearInterval(iv); resolve(); } }, 200);
  });
  loop.disable();
  const ms = (ns: number): number => Math.round((ns / 1e6) * 100) / 100;
  await wiring.shutdown().catch(() => undefined);
  server.close();
  writeFileSync(join(dir, 'host-result.json'), JSON.stringify({ requests, eventLoopDelayMs: { p50: ms(loop.percentile(50)), p95: ms(loop.percentile(95)), p99: ms(loop.percentile(99)), max: ms(loop.max), mean: ms(loop.mean) }, uptimeMs: Date.now() - t0 }));
}
