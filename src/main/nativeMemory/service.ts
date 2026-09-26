/**
 * NATIVE-MEMORY sections 3, 6 and 8, the MAIN-process side. Electron-free: the worker fork,
 * the clock and the file reads are injected.
 *
 * What main does, and ALL it does (spec section 3: <= 2 ms p95 of synchronous work):
 *   - validate a request, look up the caller's token, and post one message to the worker;
 *   - resolve the reply, or a named degraded answer at the deadline (never block, never throw);
 *   - fork the worker LAZILY, on the first memory request (never on app start), and re-fork it
 *     after a crash with a bounded backoff.
 * It never opens the database, loads an extension, embeds, reads a source, or runs SQL.
 *
 * The feature flag (section 8) is `<hive>/memory-engine.json` { mode, reason, at }:
 *   legacy (default) | shadow | native | fallback-legacy
 * `legacy` changes nothing at all: no shim on PATH, no worker, no token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WorkerConfig } from './worker';

export type MemoryMode = 'legacy' | 'shadow' | 'native' | 'fallback-legacy';
export const MEMORY_MODES: readonly MemoryMode[] = ['legacy', 'shadow', 'native', 'fallback-legacy'];
export const MODE_FILE = 'memory-engine.json';

export function parseMode(raw: string | null): MemoryMode {
  if (!raw) return 'legacy';
  try {
    const m = (JSON.parse(raw) as { mode?: unknown }).mode;
    return MEMORY_MODES.includes(m as MemoryMode) ? (m as MemoryMode) : 'legacy';
  } catch {
    return 'legacy';
  }
}

/** CLI exit codes (section 6). */
export const EXIT = { ok: 0, usage: 2, unavailable: 3, degraded: 4, unauthorized: 5 } as const;

export const SEARCH_DEADLINE_WARM_MS = 250;
export const SEARCH_DEADLINE_COLD_MS = 2_000;
/** Crash restarts allowed in RESTART_WINDOW_MS before the worker is left down (answers exit 3). */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;

export interface WorkerHandle {
  postMessage(msg: unknown): void;
  on(ev: 'message', fn: (msg: unknown) => void): void;
  on(ev: 'exit', fn: (code: number) => void): void;
  kill(): boolean;
}

export interface Reply { ok: boolean; exit: number; text?: string; json?: unknown; error?: string }

export interface ServiceDeps {
  fork: () => WorkerHandle;
  config: () => WorkerConfig | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (row: Record<string, unknown>) => void;
}

export class NativeMemoryClient {
  private worker: WorkerHandle | null = null;
  private ready = false;
  private warm = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reply) => void; timer: unknown }>();
  private restarts: number[] = [];
  private down = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** Forked yet? (tests, status) */
  get forked(): boolean { return this.worker !== null; }

  private ensureWorker(): WorkerHandle | null {
    if (this.worker) return this.worker;
    if (this.down) return null;
    const cfg = this.d.config();
    if (!cfg) return null;
    const w = this.d.fork();
    this.worker = w;
    this.ready = false;
    this.warm = false;
    w.on('message', (msg) => this.onMessage(msg));
    w.on('exit', (code) => this.onExit(w, code));
    w.postMessage({ op: 'init', config: cfg });
    return w;
  }

  private onMessage(msg: unknown): void {
    const m = msg as { id?: number; event?: string } & Reply;
    if (m && m.event) {
      if (m.event === 'ready') this.ready = true;
      else this.d.log?.({ ...(m as unknown as Record<string, unknown>) });
      return;
    }
    if (!m || typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    this.clearTimer(p.timer);
    if (m.ok) this.warm = true;
    p.resolve({ ok: !!m.ok, exit: typeof m.exit === 'number' ? m.exit : m.ok ? EXIT.ok : EXIT.degraded, text: m.text, json: m.json, error: m.error });
  }

  private onExit(w: WorkerHandle, code: number): void {
    if (this.worker !== w) return;
    this.worker = null;
    this.ready = false;
    for (const [id, p] of this.pending) { this.clearTimer(p.timer); p.resolve({ ok: false, exit: EXIT.degraded, error: 'memory worker exited' }); this.pending.delete(id); }
    const t = this.now();
    this.restarts = this.restarts.filter((x) => t - x < RESTART_WINDOW_MS);
    this.restarts.push(t);
    if (this.restarts.length > MAX_RESTARTS) this.down = true;
    this.d.log?.({ kind: 'native-memory-worker-exit', code, restarts: this.restarts.length, down: this.down });
  }

  /** One request. Never throws and never waits past the deadline: at the deadline the caller
   *  gets a named degraded reply (exit 4) and the worker drops the stale request itself. */
  request(op: string, args: Record<string, unknown>, deadlineMs?: number): Promise<Reply> {
    const w = this.ensureWorker();
    if (!w) return Promise.resolve({ ok: false, exit: EXIT.unavailable, error: this.down ? 'memory worker is down (crashed repeatedly)' : 'native memory is not configured' });
    const budget = deadlineMs ?? (this.warm ? SEARCH_DEADLINE_WARM_MS : SEARCH_DEADLINE_COLD_MS);
    const id = this.nextId++;
    return new Promise<Reply>((resolve) => {
      const timer = this.setTimer(() => {
        if (!this.pending.delete(id)) return;
        resolve({ ok: false, exit: EXIT.degraded, error: `memory ${op} timed out after ${budget} ms` });
      }, budget);
      this.pending.set(id, { resolve, timer });
      w.postMessage({ id, op, args, deadline: this.now() + budget });
    });
  }

  /** Drain in-flight requests (bounded), then stop the worker. */
  async shutdown(graceMs = 2_000): Promise<void> {
    const w = this.worker;
    if (!w) return;
    await Promise.race([this.request('shutdown', {}, graceMs), new Promise((r) => this.setTimer(() => r(null), graceMs))]);
    try { w.kill(); } catch { /* gone */ }
    this.worker = null;
  }
}

/**
 * Per-agent MEMORY_TOKEN (section 6, Jim fix 3): minted for EVERY spawned agent regardless of
 * provider, revoked when its PTY exits. The endpoint resolves the caller's wing from the token;
 * a request without a valid one is refused (exit 5). Stored by SHA-256, compared in constant
 * time, so the raw token never sits in a map key.
 */
export class MemoryTokens {
  private byHash = new Map<string, { agentId: string; hash: Buffer }>();
  private byAgent = new Map<string, string>();

  mint(agentId: string): string {
    this.revoke(agentId);
    const token = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(token).digest();
    this.byHash.set(hash.toString('hex'), { agentId, hash });
    this.byAgent.set(agentId, hash.toString('hex'));
    return token;
  }

  revoke(agentId: string): void {
    const h = this.byAgent.get(agentId);
    if (h) this.byHash.delete(h);
    this.byAgent.delete(agentId);
  }

  /** The agent a token belongs to, or null. */
  resolve(token: unknown): string | null {
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;
    const hash = createHash('sha256').update(token).digest();
    const e = this.byHash.get(hash.toString('hex'));
    if (!e || !timingSafeEqual(e.hash, hash)) return null;
    return e.agentId;
  }
}

export interface MemoryRequest { cmd?: unknown; args?: unknown; palace?: unknown }

const WING = /^[A-Za-z0-9._-]{1,120}$/;
const ISO = /^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]*)?$/;

/** Validate a shim request into a worker op (section 6 ranges). Pure. */
export function validateRequest(body: MemoryRequest, callerWing: string, servedPaths: readonly string[]): { op: string; args: Record<string, unknown> } | { exit: number; error: string } {
  const cmd = body.cmd;
  const a = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
  if (body.palace !== undefined && body.palace !== null && body.palace !== '') {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (typeof body.palace !== 'string' || !servedPaths.map(norm).includes(norm(body.palace))) {
      return { exit: EXIT.usage, error: '--palace names a palace this app does not serve' };
    }
  }
  const optWing = (v: unknown): string | null | { bad: true } => (v === undefined || v === null || v === '' ? null : typeof v === 'string' && WING.test(v) ? v : { bad: true });
  if (cmd === 'search') {
    const q = a.query;
    if (typeof q !== 'string' || !q.trim() || q.length > 2000) return { exit: EXIT.usage, error: 'search needs a QUERY (1-2000 characters)' };
    const wing = optWing(a.wing); const room = optWing(a.room);
    if (typeof wing === 'object' && wing) return { exit: EXIT.usage, error: 'bad --wing' };
    if (typeof room === 'object' && room) return { exit: EXIT.usage, error: 'bad --room' };
    const n = a.results === undefined ? 5 : Number(a.results);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { exit: EXIT.usage, error: '--results must be 1-100' };
    for (const k of ['since', 'before'] as const) {
      const v = a[k];
      if (v !== undefined && v !== null && (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v)))) return { exit: EXIT.usage, error: `--${k} must be an ISO date` };
    }
    return { op: 'search', args: { query: q, wing, room, results: n, since: a.since ?? null, before: a.before ?? null } };
  }
  if (cmd === 'wake-up') {
    const wing = optWing(a.wing);
    if (typeof wing === 'object' && wing) return { exit: EXIT.usage, error: 'bad --wing' };
    // Without --wing, wake-up is the CALLER's (Jim fix 3).
    return { op: 'wake-up', args: { wing: wing ?? callerWing } };
  }
  if (cmd === 'status') return { op: 'status', args: {} };
  if (cmd === 'shadow') {
    const q = a.query;
    if (typeof q !== 'string' || !q.trim() || q.length > 2000) return { exit: EXIT.usage, error: 'shadow needs a query' };
    return { op: 'hits', args: { query: q, wing: typeof a.wing === 'string' && WING.test(a.wing) ? a.wing : null, results: 10 } };
  }
  return { exit: EXIT.usage, error: `unsupported command ${String(cmd)}` };
}
