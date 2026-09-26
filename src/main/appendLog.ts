/**
 * LOG-STALL-AV (Jim, MAIL-AV-152; 1.1.53): the hive's append-only files (log.jsonl and
 * cost-ledger.jsonl), written through a KEPT-OPEN descriptor and rotated at a size cap.
 *
 * WHY. Every row used to be an appendFileSync: open, append, close, on Electron main. The
 * antivirus rescans the file on each open/close, and the cost grows with its size. Measured
 * under the live BitDefender: ~390-460 ms and ~0.9 scanner CPU-s per row on the 70 MB log,
 * ~30 rows per delivered message = seconds of frozen main and ~25 scanner CPU-s per message.
 * A write through a descriptor that stays open costs 0.01-0.06 ms and triggers no rescan.
 *
 * SYNCHRONOUS ON PURPOSE (writeSync on the open fd, not a write stream). The cost was the
 * open/close scan, not the synchronicity, so a kept-open fd removes it while keeping every
 * property the old append had: rows land in order, a reader (logTail, a test) sees a row the
 * moment appendLog returns, and a crash or quit loses nothing (no buffer to flush).
 *
 * KEEP-OPEN is what the APP turns on (HiveManager.keepAppendFilesOpen, set once in main). Off,
 * each row opens, writes and closes (the old cost, but on a rotated, bounded file): that is the
 * default so a library user or a test that deletes its hive folder is never blocked by a
 * descriptor it did not know was held (Windows cannot remove a directory with an open file).
 *
 * ROTATION bounds what any remaining scan (a reopen, a tail reader, a backup tool) can cost.
 * At the cap the live file is closed and renamed to `<base>.<stamp>.jsonl`; the next row
 * reopens a fresh live file. Rotated files are immutable. `keep` bounds how many are kept
 * (the oldest are deleted); the cost ledger keeps all (the lifetime cost is folded from it).
 * A pre-existing file already over the cap when first opened (today's 74 MB log) is rotated
 * to `<base>.legacy-<stamp>.jsonl`, which is NEVER deleted: that history is the Human's.
 */
import { closeSync, fstatSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Rotate a live append file at this size. */
export const APPEND_ROTATE_BYTES = 8 * 1024 * 1024;
/** Rotated log files kept (the legacy file is extra and never deleted). */
export const LOG_KEEP_ROTATED = 8;

export interface RotatedFile { path: string; stamp: number; legacy: boolean }

/** `<base>.jsonl` -> its rotated siblings, oldest first (the live file is not included). */
export function rotatedFiles(livePath: string): RotatedFile[] {
  const dir = dirname(livePath);
  const base = basename(livePath).replace(/\.jsonl$/, '');
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(legacy-)?(\\d+)\\.jsonl$`);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: RotatedFile[] = [];
  for (const n of names) {
    const m = re.exec(n);
    if (m) out.push({ path: join(dir, n), stamp: Number(m[2]), legacy: !!m[1] });
  }
  return out.sort((a, b) => a.stamp - b.stamp || (a.legacy === b.legacy ? 0 : a.legacy ? -1 : 1));
}

/** Every file of a rotated set in write order: rotated (oldest first), then the live one. */
export function filesInOrder(livePath: string): string[] {
  return [...rotatedFiles(livePath).map((r) => r.path), livePath];
}

export interface AppendFileOptions {
  capBytes?: number;
  /** Rotated files kept; Infinity keeps all. */
  keep?: number;
  now?: () => number;
  /** Keep the descriptor open between rows (the app); otherwise close after each row. */
  keepOpen?: boolean;
  /** For tests: count the opens (each one is what the antivirus scans). */
  onOpen?: () => void;
}

export class AppendFile {
  private fd: number | null = null;
  private size = 0;
  private firstOpen = true;
  /** After a rotation that could not rename (the file is busy), wait this far before retrying. */
  private nextRotateAt = 0;
  private readonly cap: number;
  private readonly keep: number;
  private readonly now: () => number;

  constructor(readonly path: string, private readonly opts: AppendFileOptions = {}) {
    this.cap = opts.capBytes ?? APPEND_ROTATE_BYTES;
    this.keep = opts.keep ?? LOG_KEEP_ROTATED;
    this.now = opts.now ?? Date.now;
  }

  /** Append one already-serialised line (must end in \n). Best-effort: never throws. */
  append(line: string): void {
    try {
      if (this.fd === null) this.open();
      if (this.fd === null) return;
      const n = writeSync(this.fd, line, null, 'utf8');
      this.size += n;
      if (this.size >= Math.max(this.cap, this.nextRotateAt)) this.rotate(false);
      else if (!this.opts.keepOpen) this.closeFd();
    } catch {
      // A failed write drops the descriptor; the next row reopens (and so recovers from a
      // file removed or replaced underneath us).
      this.closeFd();
    }
  }

  /** Close the descriptor (quit, a hive switch). The next append reopens. */
  close(): void {
    this.closeFd();
  }

  /** Is a descriptor held right now? (diagnostics, tests) */
  get isOpen(): boolean {
    return this.fd !== null;
  }

  private open(): void {
    this.fd = openSync(this.path, 'a');
    this.opts.onOpen?.();
    this.size = fstatSync(this.fd).size;
    this.nextRotateAt = 0;
    if (this.firstOpen) {
      this.firstOpen = false;
      // A file already over the cap at first open predates rotation: keep ALL of it, under a
      // name retention never deletes, and start a fresh live file.
      if (this.size >= this.cap) {
        this.rotate(true);
        if (this.fd === null) this.open();   // the row that triggered the open still lands
      }
    }
  }

  private rotate(legacy: boolean): void {
    this.closeFd();
    const stamp = this.now();
    const base = this.path.replace(/\.jsonl$/, '');
    const target = `${base}.${legacy ? 'legacy-' : ''}${stamp}.jsonl`;
    try {
      renameSync(this.path, target);
    } catch {
      // Busy (another process holds it without share-delete): keep appending, retry later.
      this.fd = openSync(this.path, 'a');
      this.opts.onOpen?.();
      this.size = fstatSync(this.fd).size;
      this.nextRotateAt = this.size + Math.ceil(this.cap / 8);
      return;
    }
    if (Number.isFinite(this.keep)) this.prune();
  }

  private prune(): void {
    const rotated = rotatedFiles(this.path).filter((r) => !r.legacy);
    for (const r of rotated.slice(0, Math.max(0, rotated.length - this.keep))) {
      try { rmSync(r.path, { force: true }); } catch { /* next rotation retries */ }
    }
  }

  private closeFd(): void {
    if (this.fd === null) return;
    try { closeSync(this.fd); } catch { /* already gone */ }
    this.fd = null;
  }
}
