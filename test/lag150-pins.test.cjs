'use strict';

/**
 * LAG-150 release pins (god, PERF-150-RELEASE). Test-only: each one pins a property of
 * e9259430 / be9e0e51 that the earlier tests covered only in part, and each was run against
 * a mutant that it kills.
 *
 *  N1  No pty resize anywhere in the WHOLE renderer tree bypasses the coalescer: a census
 *      of every file under src/renderer, not only the two files that call it today.
 *  N2  Disposing a terminal cancels its pending resize BEFORE the entry leaves the pool, and
 *      drops the coalescer, so a late resize cannot land on a reused ptyId.
 *  R1  Batching never reorders output against a control message about the same pty: data A,
 *      data B (buffered), control C must arrive A B C, never A C B. The batch window is at
 *      most 16 ms, and a buffered tail is delivered inside it in real time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

test('N1: across ALL of src/renderer, the only direct pty resize is the coalescer\'s send', () => {
  const files = walk(path.join(ROOT, 'src/renderer'));
  assert.ok(files.length > 50, `census walked ${files.length} files`);
  const hits = [];
  for (const f of files) {
    const src = codeOnly(readSource(f));
    // Any spelling of the call: window.cth.resizePty(, cth.resizePty(, cth?.resizePty(, ['resizePty'].
    const re = /\bresizePty\b\s*(\?\.)?\s*\(|\[\s*['"]resizePty['"]\s*\]/g;
    let m;
    while ((m = re.exec(src))) hits.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${src.slice(0, m.index).split('\n').length}`);
  }
  assert.equal(hits.length, 1, `direct resizePty calls: ${hits.join(', ')}`);
  assert.match(hits[0], /^src\/renderer\/src\/components\/terminalPool\.ts:/);
  const pool = codeOnly(readSource('src/renderer/src/components/terminalPool.ts'));
  const line = pool.split('\n')[+hits[0].split(':')[1] - 1];
  assert.match(line, /createPtyResizeCoalescer\(\(g\) => \{ void window\.cth\.resizePty\(ptyId, g\.cols, g\.rows\); \}\)/,
    'and that one call IS the coalescer\'s send');
});

test('N2: dispose cancels the pending resize before the entry leaves the pool, and forgets the coalescer', () => {
  const pool = codeOnly(readSource('src/renderer/src/components/terminalPool.ts'));
  const start = pool.indexOf('export function disposeTerminal(');
  const body = pool.slice(start, pool.indexOf('\n}\n', start));
  const cancel = body.indexOf('resizeCoalescers.get(ptyId)?.cancel();');
  const forget = body.indexOf('resizeCoalescers.delete(ptyId);');
  const leave = body.indexOf('pool.delete(ptyId);');
  assert.ok(cancel > 0, 'dispose cancels the pending resize');
  assert.ok(forget > cancel, 'then forgets the coalescer, so a reused ptyId starts clean');
  assert.ok(leave > forget, 'both before the entry leaves the pool');
  // And the cancel really means "never sent": the coalescer's own contract, run.
  const { createPtyResizeCoalescer } = loadTs('src/renderer/src/components/ptyResizeCoalescer.ts');
  const timers = new Map(); let seq = 0; const sent = [];
  const c = createPtyResizeCoalescer((g) => sent.push(g), { set: (fn) => { timers.set(++seq, fn); return seq; }, clear: (h) => timers.delete(h) });
  c.request({ cols: 80, rows: 24 }, { cols: 80, rows: 30 });
  c.cancel();
  for (const fn of timers.values()) fn();
  assert.deepEqual(sent, [], 'a cancelled resize never reaches the pty');
});

function manager() {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const { createPtyDataBatcher } = loadTs('src/main/ptyDataBatcher.ts');
  const pm = new PtyManager();
  const log = [];
  const owner = { isDestroyed: () => false, send: (ch, p) => log.push(ch === 'pty:data:t1' ? p : `<${ch}>`) };
  const session = { id: 't1', cwd: '', command: '', owner, lastOutputAt: 0, hasOutput: false,
    humanInputGeneration: 0, proc: { write: () => {} } };
  session.out = createPtyDataBatcher((d) => pm.safeSend('pty:data:t1', d, session.owner));
  pm.sessions.set('t1', session);
  return { pm, session, log };
}

test('R1: data A, data B, control C arrive A B C, never A C B', () => {
  const { pm, session, log } = manager();
  pm.deliverData('t1', session, 'A');                        // leading edge: sent at once
  pm.deliverData('t1', session, 'B');                        // inside the window: buffered
  pm.sendToOwner('t1', 'autoSubmit:readScreen', { needle: 'B' }); // C
  assert.deepEqual(log, ['A', 'B', '<autoSubmit:readScreen>']);
});

test('R1: the batch window is at most 16 ms, and a buffered tail is really delivered (no stranded bytes)', async () => {
  const { PTY_BATCH_MS } = loadTs('src/main/ptyDataBatcher.ts');
  assert.ok(PTY_BATCH_MS > 0 && PTY_BATCH_MS <= 16, `window ${PTY_BATCH_MS} ms`);
  const { pm, session, log } = manager();
  pm.deliverData('t1', session, 'head');
  pm.deliverData('t1', session, 'tail');
  const t0 = Date.now();
  while (log.length < 2 && Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 1));
  const took = Date.now() - t0;
  assert.deepEqual(log, ['head', 'tail']);
  // Only that the REAL timer fires: the <=16 ms bound is the constant above (and is run on an
  // injected clock in lag150-pty-batching). Wall-clock here is Windows timer granularity
  // (~15.6 ms ticks: 33-36 ms measured under load), so a tight bound would be a flaky pin.
  assert.ok(took < 250, `tail delivered after ${took} ms`);
});
