/* Bounded private transcript tailer. It does no parsing and never writes data:
 * the main process remains the only admission/persistence owner. This sidecar is
 * deliberately dependency-free so electron-vite can copy it beside main. */
const { parentPort } = require('node:worker_threads');
const { existsSync, openSync, closeSync, readSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const CHUNK_BYTES = 64 * 1024;
const CATCHUP_BYTES_PER_TICK = 1 * 1024 * 1024;
const ROLLOUT_RESCAN_MS = 5_000;
let source = null;
const cursors = new Map();
let rolloutCache = { home: '', file: null, scannedAt: 0 };
let catchupBytes = 0;

function newestRollout(codexHome) {
  const now = Date.now();
  if (rolloutCache.home === codexHome && rolloutCache.file && existsSync(rolloutCache.file) && now - rolloutCache.scannedAt < ROLLOUT_RESCAN_MS) return rolloutCache.file;
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return null;
  const dirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
  let newest = null;
  for (const year of dirs(root)) for (const month of dirs(join(root, year))) for (const day of dirs(join(root, year, month))) {
    const dir = join(root, year, month, day);
    let names = []; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      try { const info = statSync(file); if (!newest || info.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: info.mtimeMs }; } catch { /* writer rotated */ }
    }
  }
  rolloutCache = { home: codexHome, file: newest && newest.file, scannedAt: now };
  return rolloutCache.file;
}

function tailOnce() {
  if (!source) return;
  const startedAt = performance.now();
  const file = source.provider === 'codex' ? newestRollout(source.codexHome) : source.file;
  if (!file) return;
  let info; try { info = statSync(file); } catch { return; }
  const prior = cursors.get(file);
  // A rollout discovered after source selection starts at its beginning so its
  // first Human turn is not lost. The initial file is seeded at EOF below.
  if (!prior) { cursors.clear(); cursors.set(file, { offset: 0, remainder: '' }); }
  const current = cursors.get(file);
  const offset = info.size < current.offset ? 0 : current.offset;
  const length = Math.min(CHUNK_BYTES, Math.max(0, info.size - offset));
  if (!length) return;
  const buffer = Buffer.allocUnsafe(length);
  let fd; try { fd = openSync(file, 'r'); readSync(fd, buffer, 0, length, offset); } catch { return; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  const all = current.remainder + buffer.toString('utf8');
  const lines = all.split('\n');
  const remainder = lines.pop() || '';
  cursors.set(file, { offset: offset + length, remainder });
  // Keep every complete line from this 64 KiB read, but bound each individual
  // structured-clone payload so a chatty transcript cannot monopolize main.
  const complete = lines.filter(Boolean);
  for (let i = 0; i < complete.length; i += 256) {
    parentPort.postMessage({ type: 'lines', agentId: source.agentId, provider: source.provider, lines: complete.slice(i, i + 256), batchMs: performance.now() - startedAt });
  }
  catchupBytes += length;
  // Drain a busy source promptly, but yield after 1 MiB so the worker never
  // monopolises its event loop. The next 500 ms tick continues any remainder.
  if (info.size > offset + length && catchupBytes < CATCHUP_BYTES_PER_TICK) setImmediate(tailOnce);
}

parentPort.on('message', (message) => {
  if (!message) return;
  // The production owner only sends `source`. `poll` makes the same bounded
  // tail operation directly measurable in the opt-in release-scale harness;
  // it never changes the selected source or bypasses its cursor semantics.
  if (message.type === 'poll') { catchupBytes = 0; tailOnce(); return; }
  if (message.type !== 'source') return;
  source = message.source && typeof message.source.agentId === 'string' ? message.source : null;
  cursors.clear(); catchupBytes = 0;
  // Existing startup history is not a new conversation. Seed its cursor at
  // EOF; only a rollout that appears after this selection is replayed from 0.
  const initial = source && (source.provider === 'codex' ? newestRollout(source.codexHome) : source.file);
  if (initial) {
    try { cursors.set(initial, { offset: statSync(initial).size, remainder: '' }); } catch { /* writer rotated */ }
  }
  tailOnce();
});
setInterval(() => { catchupBytes = 0; tailOnce(); }, 500).unref();
