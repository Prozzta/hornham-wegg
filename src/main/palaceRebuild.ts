/** Safe, testable half of a palace compaction.  The caller creates and verifies
 * the staged palace; this module only decides whether bloat warrants work and
 * performs the two reversible renames. */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HNSW_DIMENSIONS = 384;
export const BLOAT_RATIO = 10;

/**
 * The per-collection SQLite row counts from `mempalace repair-status`.
 *
 * MemPalace 3.7.1 prints one block per collection (verified on a copy of the live palace):
 *
 *     [drawers]
 *       sqlite count:   3,317
 *       hnsw count:     3,319
 *     [closets]
 *       sqlite count:   478
 *
 * The SQLite count is the ground truth a from-sqlite rebuild copies. The HNSW count
 * legitimately lags right after a rebuild (unflushed), so it is never compared. A report
 * with no recognisable count is not permission to rebuild (null).
 */
export function repairStatusCounts(output: string): Record<string, number> | null {
  const counts: Record<string, number> = {};
  let section: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const header = /^\s*\[([\w.-]+)\]\s*$/.exec(line);
    if (header) { section = header[1]; continue; }
    const m = /^\s*sqlite count:\s*([\d,]+)\s*$/i.exec(line);
    if (m && section) {
      const n = Number(m[1].replace(/,/g, ''));
      if (!Number.isSafeInteger(n)) return null;
      counts[section] = n;
    }
  }
  return Object.keys(counts).length ? counts : null;
}

/** Total rows across collections: the bloat ratio is computed against every HNSW
 *  segment's data_level0.bin together. Null when the report is unreadable. */
export function repairStatusEmbeddingCount(output: string): number | null {
  const counts = repairStatusCounts(output);
  if (!counts) return null;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return total > 0 ? total : null;
}

/** The staged palace must hold exactly the rows the live one did, per collection. */
export function sameCollectionCounts(a: Record<string, number> | null, b: Record<string, number> | null): boolean {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length > 0 && ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
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
      const path = join(palace, name, 'data_level0.bin');
      try { return total + statSync(path).size; } catch { return total; }
    }, 0);
  } catch { return 0; }
}

export const EMBEDDER_RECORD = 'mempalace_embedder.json';

/** Copy the live palace's embedder record into the staged one when the staged palace has
 *  none and every collection in the record names `model` (the model the rebuild used).
 *  Returns whether it copied. */
export function carryEmbedderRecord(palace: string, staged: string, model: string): boolean {
  const from = join(palace, EMBEDDER_RECORD);
  const to = join(staged, EMBEDDER_RECORD);
  try {
    if (!existsSync(from) || existsSync(to)) return false;
    const text = readFileSync(from, 'utf8');
    const record = JSON.parse(text) as Record<string, { model_name?: unknown }>;
    const entries = Object.values(record ?? {});
    if (!entries.length || !entries.every((e) => e && e.model_name === model)) return false;
    writeFileSync(to, text, 'utf8');
    return true;
  } catch { return false; }
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
