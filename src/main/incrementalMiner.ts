/**
 * Small, dependency-free policy helpers for the memory miner.  Keeping these
 * out of memory.ts makes the important part of the miner testable without an
 * Electron process or a real MemPalace installation.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MINE_STATE_FILE = '.mempalace-mine-state.json';

export interface MemoryFingerprint {
  mtimeMs: number;
  size: number;
  sha256: string;
  /** Completion timestamp. It caps vector delete/reinsert churn per file. */
  minedAt?: number;
}

export interface MineState {
  version: 1;
  entries: Record<string, MemoryFingerprint>;
}

export interface PendingMine {
  fingerprint: MemoryFingerprint;
  quietUntil: number;
}

export const emptyMineState = (): MineState => ({ version: 1, entries: {} });
export const mineStatePath = (home: string): string => join(home, 'hive', MINE_STATE_FILE);

/** A stable content fingerprint prevents a timestamp-only touch from invoking
 * the embedder, including immediately after an app restart. */
export function fingerprintMemory(path: string): MemoryFingerprint | null {
  try {
    const stat = statSync(path);
    const body = readFileSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size, sha256: createHash('sha256').update(body).digest('hex') };
  } catch { return null; }
}

export function sameFingerprint(a: MemoryFingerprint | undefined, b: MemoryFingerprint | null): boolean {
  return !!a && !!b && a.size === b.size && a.sha256 === b.sha256;
}

export function loadMineState(home: string): MineState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mineStatePath(home), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyMineState();
    const raw = parsed as Partial<MineState>;
    if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return emptyMineState();
    return { version: 1, entries: raw.entries };
  } catch { return emptyMineState(); }
}

/** Replace, never truncate-in-place: a power loss retains the prior good map. */
export function saveMineState(home: string, state: MineState): void {
  const target = mineStatePath(home);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), 'utf8');
    renameSync(temp, target);
  } catch {
    try { if (existsSync(temp)) renameSync(temp, `${temp}.failed`); } catch { /* best effort */ }
  }
}

/** Registry is the authority for a retained-but-closed agent.  A malformed or
 * unavailable registry is deliberately fail-open: an active memory must not be
 * silently lost merely because a concurrent atomic registry write is in flight. */
export function archivedAgentIds(home: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'hive', 'registry.json'), 'utf8')) as {
      agents?: Record<string, { archived?: boolean }>;
    };
    return new Set(Object.entries(parsed.agents ?? {}).filter(([, agent]) => agent?.archived).map(([id]) => id));
  } catch { return new Set(); }
}

/** Coalesce a noisy sequence of writes.  Each new fingerprint pushes the
 * deadline out; a mature entry is removed by the caller only after successful
 * daemon completion. */
export function queueChangedMemory(
  pending: Map<string, PendingMine>,
  id: string,
  fingerprint: MemoryFingerprint,
  now: number,
  quietMs: number
): void {
  const existing = pending.get(id);
  if (!existing || !sameFingerprint(existing.fingerprint, fingerprint)) {
    pending.set(id, { fingerprint, quietUntil: now + quietMs });
  }
}

export function readyMineIds(pending: Map<string, PendingMine>, now: number): string[] {
  return [...pending.entries()]
    .filter(([, item]) => item.quietUntil <= now)
    .map(([id]) => id)
    .sort();
}
