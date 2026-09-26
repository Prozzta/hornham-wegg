/* Bounded private transcript tailer. It does no parsing and never writes data:
 * the main process remains the only admission/persistence owner. This sidecar is
 * deliberately dependency-free so electron-vite can copy it beside main. */
const { parentPort } = require('node:worker_threads');
const { existsSync, openSync, closeSync, readSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const CHUNK_BYTES = 64 * 1024;
let source = null;
const cursors = new Map();

function newestRollout(codexHome) {
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
  return newest && newest.file;
}

function tailOnce() {
  if (!source) return;
  const file = source.provider === 'codex' ? newestRollout(source.codexHome) : source.file;
  if (!file) return;
  let info; try { info = statSync(file); } catch { return; }
  const prior = cursors.get(file);
  // A newly selected file begins at EOF: persisted Talk is the historical view;
  // replaying an entire provider transcript after reader restart could re-admit
  // an unrelated, matching Human line.
  if (!prior) { cursors.clear(); cursors.set(file, { offset: info.size, remainder: '' }); return; }
  const offset = info.size < prior.offset ? 0 : prior.offset;
  const length = Math.min(CHUNK_BYTES, Math.max(0, info.size - offset));
  if (!length) return;
  const buffer = Buffer.allocUnsafe(length);
  let fd; try { fd = openSync(file, 'r'); readSync(fd, buffer, 0, length, offset); } catch { return; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  const all = prior.remainder + buffer.toString('utf8');
  const lines = all.split('\n');
  const remainder = lines.pop() || '';
  cursors.set(file, { offset: offset + length, remainder });
  // Keep every complete line from this 64 KiB read, but bound each individual
  // structured-clone payload so a chatty transcript cannot monopolize main.
  const complete = lines.filter(Boolean);
  for (let i = 0; i < complete.length; i += 256) {
    parentPort.postMessage({ type: 'lines', agentId: source.agentId, provider: source.provider, lines: complete.slice(i, i + 256) });
  }
}

parentPort.on('message', (message) => {
  if (!message || message.type !== 'source') return;
  source = message.source && typeof message.source.agentId === 'string' ? message.source : null;
  cursors.clear();
  tailOnce();
});
setInterval(tailOnce, 500).unref();
