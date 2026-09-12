/**
 * Codex capacity, read from the rollout the agent is already writing.
 *
 * WHY THIS SOURCE. Codex stamps its current rate-limit snapshot onto the
 * `token_count` event of every turn, inside the session rollout under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. Reading it costs one tail read
 * of a file the agent wrote anyway: no provider request, no app-server call, no
 * probe traffic, and no credential. The authenticated `account/rateLimits/read` is
 * a better snapshot but it is a real network operation, so it belongs at a reset
 * boundary rather than on a hook.
 *
 * WHAT IT COSTS, AND THE TWO GUARDS THAT KEEP IT SMALL.
 *   - Locating the newest rollout means walking three levels of dated directories,
 *     so the resolved path is CACHED and only re-resolved when the caller says a
 *     session boundary happened or the cached file disappears.
 *   - A cached file is `stat`ed and only read when its mtime has ADVANCED. An
 *     unchanged file is not reopened, so an idle agent costs one stat.
 * Only the last few kilobytes are read. A rollout grows without bound and the
 * newest snapshot is always at the end.
 *
 * This module never reads, resolves or reports credential material. It touches
 * exactly one thing in a Codex home: the session rollout.
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { CapacityObservation } from '../shared/providerCapacity';
import { normalizeCodexRateLimits } from './capacityNormalize';
import { codexAccountScope } from './capacityScope';

/** The newest snapshot sits at the end of the file; this is generous for one event. */
const TAIL_BYTES = 64 * 1024;

interface HomeCache {
  file: string | null;
  mtimeMs: number;
}

/** Newest `rollout-*.jsonl` under `<home>/sessions`, by mtime. */
function findNewestRollout(codexHome: string): string | null {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return null;
  let newest: { file: string; mtimeMs: number } | null = null;
  // sessions/YYYY/MM/DD/rollout-*.jsonl — a fixed three-level shape, walked
  // explicitly rather than recursively so a stray directory cannot turn this into
  // an unbounded scan of someone's home.
  const dirs = (p: string): string[] => {
    try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return []; }
  };
  for (const y of dirs(root)) {
    for (const m of dirs(join(root, y))) {
      for (const d of dirs(join(root, y, m))) {
        const dayDir = join(root, y, m, d);
        let names: string[] = [];
        try { names = readdirSync(dayDir); } catch { continue; }
        for (const name of names) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const file = join(dayDir, name);
          try {
            const st = statSync(file);
            if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: st.mtimeMs };
          } catch { /* vanished mid-walk */ }
        }
      }
    }
  }
  return newest?.file ?? null;
}

/** Read the last `TAIL_BYTES` of a file as text, without loading the whole rollout. */
function readTail(file: string, bytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* noop */ } }
  }
}

/** The last rate-limit snapshot in a rollout tail, with the event's own timestamp. */
export function latestRateLimitsInTail(tail: string): { rateLimits: unknown; observedAt: number | null } | null {
  const lines = tail.split('\n');
  // Backwards: the newest snapshot wins, and the first line of a tail is usually a
  // fragment of a longer line, which simply fails to parse and is skipped.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || !line.includes('rate_limits')) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (typeof obj !== 'object' || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const payload = (typeof rec.payload === 'object' && rec.payload !== null)
      ? rec.payload as Record<string, unknown>
      : null;
    const rateLimits = payload?.rate_limits ?? rec.rate_limits;
    if (!rateLimits) continue;
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    return { rateLimits, observedAt: Number.isFinite(ts) ? ts : null };
  }
  return null;
}

/**
 * Stateful reader over a set of Codex homes. One instance lives in main; the state
 * it holds is only the per-home cache described at the top of the file.
 */
export class CodexRolloutCapacitySource {
  private cache = new Map<string, HomeCache>();

  constructor(private readonly scopeOf: (home: string) => string = codexAccountScope) {}

  /**
   * Observe one Codex home. Returns null when there is nothing NEW to report —
   * which is the common case and is deliberately cheap.
   *
   * `rescan` forces re-resolution of the newest rollout file; the caller passes it
   * at a session boundary, when a new file is the whole point.
   */
  observe(codexHome: string, opts: { rescan?: boolean; now?: number } = {}): CapacityObservation | null {
    const now = opts.now ?? Date.now();
    let entry = this.cache.get(codexHome);
    if (!entry || opts.rescan || !entry.file || !existsSync(entry.file)) {
      const file = findNewestRollout(codexHome);
      entry = { file, mtimeMs: 0 };
      this.cache.set(codexHome, entry);
    }
    if (!entry.file) return null;

    let mtimeMs: number;
    try { mtimeMs = statSync(entry.file).mtimeMs; } catch { entry.file = null; return null; }
    // Unchanged file: nothing was appended, so there is nothing new to read. This is
    // the guard that keeps an idle agent at one stat per hook boundary.
    if (mtimeMs <= entry.mtimeMs) return null;
    entry.mtimeMs = mtimeMs;

    const found = latestRateLimitsInTail(readTail(entry.file));
    if (!found) return null;
    return normalizeCodexRateLimits({
      rateLimits: found.rateLimits,
      accountScope: this.scopeOf(codexHome),
      // The event's own timestamp, not now: a rollout copy is authoritative at the
      // time it was written, and the tracker orders readings by that.
      observedAt: found.observedAt,
      receivedAt: now,
      source: 'codex-rollout'
    });
  }

  /** Drop a home's cache — used when an agent is removed. */
  forget(codexHome: string): void {
    this.cache.delete(codexHome);
  }
}
