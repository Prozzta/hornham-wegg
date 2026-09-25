/** Safe, testable half of a palace compaction.  The caller creates and verifies
 * the staged palace; this module only decides whether bloat warrants work and
 * performs the two reversible renames. */
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs';

export const HNSW_DIMENSIONS = 384;
export const BLOAT_RATIO = 10;

/** MemPalace repair-status deliberately prints a human-readable report.  Accept
 * both its current `SQLite: N` form and future `sqlite=N` variants; a report we
 * cannot understand is not permission to rebuild. */
export function repairStatusEmbeddingCount(output: string): number | null {
  const match = output.match(/sqlite(?:\s+(?:drawer|embedding)s?)?\s*[:=]\s*([\d,]+)/i);
  if (!match) return null;
  const count = Number(match[1].replace(/,/g, ''));
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

export function rebuildNeeded(indexBytes: number, embeddingCount: number): boolean {
  if (!Number.isFinite(indexBytes) || !Number.isFinite(embeddingCount) || embeddingCount <= 0) return false;
  return indexBytes > BLOAT_RATIO * embeddingCount * HNSW_DIMENSIONS * 4;
}

export function dataLevel0Bytes(palace: string): number {
  try {
    // Chroma puts the HNSW data below a UUID directory.  There may be more than
    // one segment; the caller sums their data_level0.bin files separately when
    // it has a richer scanner.  This conservative primary segment check keeps
    // the policy harmless if a palace layout changes.
    return readdirSync(palace).reduce((total, name) => {
      const path = `${palace}\\${name}\\data_level0.bin`;
      try { return total + statSync(path).size; } catch { return total; }
    }, 0);
  } catch { return 0; }
}

/** Swap only fully-built staging output.  The previous palace is retained at
 * `backup`; if the second rename fails the first rename is immediately undone. */
export function swapStagedPalace(palace: string, staged: string, backup: string): boolean {
  if (!existsSync(palace) || !existsSync(staged) || existsSync(backup)) return false;
  try {
    renameSync(palace, backup);
    try {
      renameSync(staged, palace);
      return true;
    } catch {
      try { renameSync(backup, palace); } catch { /* preserve the backup for recovery */ }
      return false;
    }
  } catch { return false; }
}
