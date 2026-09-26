/**
 * NATIVE-MEMORY: the Electron glue in main. Everything here is short and synchronous or a
 * message post; the engine itself is in the utility process (worker.ts).
 *
 *   mode()        the persisted feature flag (default `legacy`: this module then does NOTHING:
 *                 no worker, no token, no PATH change, no endpoint)
 *   spawnEnv(id)  what an agent's spawn gets past `legacy`: MEMORY_TOKEN, the endpoint, the hive
 *                 root, the legacy CLI's path, and PATH with the shim dir first
 *   handle(...)   the HookServer `/memory/<token>` handler
 *   agentExited   revoke the agent's token
 *   shutdown()    drain and stop the worker (quit)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { classifyQuery, EXIT, MemoryTokens, MODE_FILE, NativeMemoryClient, parseMode, reviewCaptureActive, validateRequest, type MemoryMode, type WorkerHandle } from './service';
import type { WorkerConfig } from './worker';

export interface RuntimeManifest {
  model: { dir: string; onnxSha256: string; tokenizerSha256: string };
  vec0: Record<string, { package: string; file: string; sha256: string }>;
}

export interface WiringDeps {
  hiveRoot: () => string | null;
  palacePath: () => string | null;
  userData: string;
  /** resources dir: packaged `process.resourcesPath`, dev the repo's `resources/`. */
  resourcesDir: string;
  /** The built worker entry (out/main/memoryWorker.js). */
  workerEntry: string;
  fork: (entry: string) => WorkerHandle;
  memoryBaseUrl: () => string | null;
  legacyBin: () => string | null;
  writeShim: (shimScript: string) => string | null;
  log: (row: Record<string, unknown>) => void;
  /** The sqlite-vec loadable library's path on the REAL filesystem (asar-unpacked), resolved by
   *  sqlite-vec's own `getLoadablePath()` - a path lookup only; main never loads it. The
   *  packager nests the platform package under sqlite-vec, so a top-level lookup would miss it. */
  vecLoadablePath: () => string | null;
}

/** The DB is per hive root (Jim R7): two hives, or dev and stable, never share wings. */
export function dbFileFor(userData: string, hiveRoot: string): string {
  const key = createHash('sha256').update(hiveRoot.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);
  return join(userData, 'memory', `${key}.sqlite`);
}

export class NativeMemoryWiring {
  readonly tokens = new MemoryTokens();
  readonly client: NativeMemoryClient;
  private manifest: RuntimeManifest | null = null;

  constructor(private readonly d: WiringDeps) {
    this.client = new NativeMemoryClient({ fork: () => d.fork(d.workerEntry), config: () => this.workerConfig(), log: d.log });
  }

  private modeRaw(): string | null {
    const root = this.d.hiveRoot();
    if (!root) return null;
    try { return readFileSync(join(root, MODE_FILE), 'utf8'); } catch { return null; }
  }

  mode(): MemoryMode {
    return parseMode(this.modeRaw());
  }

  private runtimeManifest(): RuntimeManifest | null {
    if (this.manifest) return this.manifest;
    try {
      this.manifest = JSON.parse(readFileSync(join(this.d.resourcesDir, 'models', 'native-memory-manifest.json'), 'utf8')) as RuntimeManifest;
    } catch {
      this.manifest = null;
    }
    return this.manifest;
  }

  /** The worker's config, or null when the runtime pieces are missing (then requests answer
   *  exit 3 and nothing is forked). Path computation only: nothing is loaded here. */
  workerConfig(): WorkerConfig | null {
    const root = this.d.hiveRoot();
    return root ? this.workerConfigFor(root, dbFileFor(this.d.userData, root)) : null;
  }

  /** The same, for an explicit hive root and index file (the gate-2 smoke's scratch hive). */
  workerConfigFor(root: string, dbFile: string): WorkerConfig | null {
    const m = this.runtimeManifest();
    if (!m) return null;
    const plat = `${process.platform}-${process.arch}`;
    const v = m.vec0[plat];
    if (!v) return null;
    const vecPath = this.d.vecLoadablePath();
    if (!vecPath) return null;
    const modelDir = join(this.d.resourcesDir, 'models', m.model.dir);
    if (!existsSync(vecPath) || !existsSync(join(modelDir, 'onnx', 'model.onnx'))) return null;
    return {
      hiveRoot: root,
      dbFile,
      modelDir,
      modelSha256: m.model.onnxSha256,
      vecPath,
      vecSha256: v.sha256,
      modeFile: join(root, MODE_FILE)
    };
  }

  /** Env for a spawning agent. `legacy`: nothing at all (zero behaviour change). */
  spawnEnv(agentId: string, basePath: string | undefined): Record<string, string> {
    if (this.mode() === 'legacy') return {};
    const root = this.d.hiveRoot();
    const url = this.d.memoryBaseUrl();
    const shimDir = this.d.writeShim(join(this.d.resourcesDir, 'mempalace-shim.cjs'));
    if (!root || !shimDir) return {};
    const env: Record<string, string> = {
      MEMORY_TOKEN: this.tokens.mint(agentId),
      MUNDER_HIVE_ROOT: root,
      MUNDER_LEGACY_MEMPALACE: this.d.legacyBin() ?? '',
      PATH: basePath ? `${shimDir}${delimiter}${basePath}` : shimDir
    };
    if (url) env.MUNDER_MEMORY_URL = url;
    return env;
  }

  agentExited(agentId: string): void {
    this.tokens.revoke(agentId);
  }

  /** The `/memory/<token>` handler. */
  async handle(token: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const agentId = this.tokens.resolve(token);
    if (!agentId) return { status: 403, body: { exit: EXIT.unauthorized, error: 'unauthorized' } };
    const mode = this.mode();
    if (mode === 'legacy' || mode === 'fallback-legacy') return { status: 200, body: { exit: EXIT.unavailable, error: `native memory is off (mode ${mode})` } };
    const served = [this.d.hiveRoot(), this.d.palacePath()].filter((x): x is string => !!x);
    const v = validateRequest((body ?? {}) as Record<string, unknown>, agentId, served);
    if ('exit' in v) return { status: 200, body: { exit: v.exit, error: v.error } };
    if (v.op === 'hits') {
      // Shadow: compare with the legacy ranking the shim saw; store ONLY a redacted row (plus,
      // inside an opt-in review window, the worker's private review file: see reviewCaptureActive).
      const review = mode === 'shadow' && reviewCaptureActive(this.modeRaw());
      const r = await this.client.request('hits', { ...v.args, review, agent: agentId }, 2_000);
      const b = (body ?? {}) as { args?: { legacyMs?: number } };
      const legacy = (v.args.legacy as Array<{ rank: number; source: string; wing: string }>) ?? [];
      const native = Array.isArray(r.json) ? (r.json as Array<{ source: string; wing: string }>) : [];
      const lset = new Set(legacy.map((x) => `${x.wing}|${String(x.source).split('/').pop()}`));
      const overlap = native.filter((x) => lset.has(`${x.wing}|${x.source.split('/').pop()}`)).length;
      this.d.log({
        kind: 'native-memory-shadow', agent: agentId,
        queryHash: createHash('sha256').update(String(v.args.query)).digest('hex').slice(0, 16),
        // Gate 6 needs per-cohort n: the cohort from the query's shape, no-match from the outcome.
        cohort: legacy.length === 0 ? 'no-match' : classifyQuery(String(v.args.query), (v.args.wing as string | null) ?? null),
        legacyN: legacy.length, nativeN: native.length, overlapSources: overlap,
        // Ranked, redacted: hashes of wing|source, so gate 6 can compute overlap / rank agreement.
        legacyRanked: legacy.map((x) => createHash('sha256').update(`${x.wing}|${String(x.source).split('/').pop()}`).digest('hex').slice(0, 12)),
        nativeRanked: native.map((x) => createHash('sha256').update(`${x.wing}|${x.source.split('/').pop()}`).digest('hex').slice(0, 12)),
        reviewCaptured: review,
        legacyMs: typeof b.args?.legacyMs === 'number' ? b.args.legacyMs : null, nativeOk: r.ok, nativeError: r.error ?? null
      });
      return { status: 200, body: { exit: EXIT.ok } };
    }
    const r = await this.client.request(v.op, v.args, v.op === 'search' ? undefined : 2_000);
    return { status: 200, body: { exit: r.exit, text: r.text, json: r.json, error: r.error } };
  }

  shutdown(): Promise<void> {
    return this.client.shutdown();
  }
}

/** A path inside app.asar, mapped to its asar-unpacked copy (a DLL cannot load from the archive). */
export function toUnpacked(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
