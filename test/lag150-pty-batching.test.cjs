'use strict';

/**
 * LAG-150 F3: pty output reaches the renderer in few IPC messages, not one per conpty chunk.
 *
 * Measured on 1.1.49: a 3.26 MB burst (a Codex transcript replay) arrived as 20,683
 * `pty:data` messages - conpty hands node-pty ~170-byte chunks and main forwarded each one -
 * with main at 20% of a core for the burst and a renderer `term.write` per message. The rule
 * lives in src/main/ptyDataBatcher.ts (pure, timers injected); PtyManager's use of it is run
 * through a hand-built session (no node-pty spawn), the input-provenance.test.cjs pattern.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { createPtyDataBatcher, PTY_BATCH_MS, PTY_BATCH_MAX_BYTES } = loadTs('src/main/ptyDataBatcher.ts');

function clock() {
  let now = 1000;
  const timers = new Map();
  let seq = 0;
  return {
    host: {
      set: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
      clear: (id) => { timers.delete(id); },
      now: () => now
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    }
  };
}

/** A replay-shaped burst: `n` chunks of ~170 bytes, as conpty delivers them. */
const burst = (n) => Array.from({ length: n }, (_, i) => `\x1b[3${i % 7 + 1}m• history line ${i} ${'x'.repeat(140)}\x1b[0m\r\n`);

test('THE BURST: 1,810 conpty chunks inside one window become a handful of messages, byte-identical', () => {
  const c = clock();
  const sent = [];
  const b = createPtyDataBatcher((d) => sent.push(d), c.host);
  const chunks = burst(1810);
  for (const ch of chunks) b.push(ch);
  c.advance(PTY_BATCH_MS);
  const bytes = chunks.join('');
  assert.equal(sent.join(''), bytes, 'nothing dropped, split, reordered or re-encoded');
  assert.ok(sent.length <= 2 + Math.ceil(bytes.length / PTY_BATCH_MAX_BYTES), `${sent.length} messages for 1,810 chunks`);
});

test('a keystroke echo after quiet is sent AT ONCE, not after the window', () => {
  const c = clock();
  const sent = [];
  const b = createPtyDataBatcher((d) => sent.push(d), c.host);
  b.push('a');
  assert.deepEqual(sent, ['a'], 'leading edge: no added latency on an idle pty');
  c.advance(500);
  b.push('b');
  assert.deepEqual(sent, ['a', 'b']);
});

test('output inside the window waits for it; the next quiet chunk is immediate again', () => {
  const c = clock();
  const sent = [];
  const b = createPtyDataBatcher((d) => sent.push(d), c.host);
  b.push('1'); b.push('2'); b.push('3');
  assert.deepEqual(sent, ['1']);
  c.advance(PTY_BATCH_MS);
  assert.deepEqual(sent, ['1', '23']);
  c.advance(PTY_BATCH_MS * 10);
  b.push('4');
  assert.deepEqual(sent, ['1', '23', '4']);
});

test('a huge burst still STREAMS: no message exceeds the byte bound by more than one chunk', () => {
  const c = clock();
  const sent = [];
  const b = createPtyDataBatcher((d) => sent.push(d), c.host);
  const chunks = burst(20000);
  for (const ch of chunks) b.push(ch);
  c.advance(PTY_BATCH_MS);
  assert.equal(sent.join(''), chunks.join(''));
  for (const m of sent) assert.ok(m.length < PTY_BATCH_MAX_BYTES + 200, `message of ${m.length}`);
  assert.ok(sent.length < 80, `3.4 MB in ${sent.length} messages (was 20,000)`);
});

test('flush delivers what is buffered now, and leaves nothing pending', () => {
  const c = clock();
  const sent = [];
  const b = createPtyDataBatcher((d) => sent.push(d), c.host);
  b.push('x'); b.push('y'); b.push('z');
  b.flush();
  assert.deepEqual(sent, ['x', 'yz']);
  assert.equal(b.buffered, 0);
  c.advance(1000);
  assert.deepEqual(sent, ['x', 'yz'], 'the cancelled timer does not send again');
});

// ─── PtyManager: the wiring, through a hand-built session ─────────────────────

function managerWithSession() {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const { createPtyDataBatcher: mk } = loadTs('src/main/ptyDataBatcher.ts');
  const pm = new PtyManager();
  const log = [];
  const owner = { isDestroyed: () => false, send: (ch, p) => log.push([ch, p]) };
  const session = { id: 't1', cwd: '', command: '', owner, lastOutputAt: 0, hasOutput: false,
    humanInputGeneration: 0, proc: { write: () => {} } };
  session.out = mk((d) => pm.safeSend('pty:data:t1', d, session.owner));
  pm.sessions.set('t1', session);
  return { pm, session, log };
}

test('PtyManager: a burst through deliverData is coalesced and byte-identical', async () => {
  const { pm, session, log } = managerWithSession();
  const chunks = burst(1810);
  for (const ch of chunks) pm.deliverData('t1', session, ch);
  await new Promise((r) => setTimeout(r, PTY_BATCH_MS * 4));
  const data = log.filter(([ch]) => ch === 'pty:data:t1').map(([, p]) => p);
  assert.equal(data.join(''), chunks.join(''));
  assert.ok(data.length <= 10, `${data.length} IPC messages for 1,810 chunks (1.1.49: 1,810)`);
  assert.equal(session.hasOutput, true);
});

test('PtyManager: a screen read is ordered AFTER every byte main already received', () => {
  const { pm, session, log } = managerWithSession();
  pm.deliverData('t1', session, 'first ');
  pm.deliverData('t1', session, 'NEEDLE');           // buffered, inside the window
  pm.sendToOwner('t1', 'autoSubmit:readScreen', { needle: 'NEEDLE' });
  assert.deepEqual(log.map(([ch]) => ch), ['pty:data:t1', 'pty:data:t1', 'autoSubmit:readScreen']);
  assert.equal(log.slice(0, 2).map(([, p]) => p).join(''), 'first NEEDLE');
});

test('PtyManager: output from a reclaimed id is still dropped', () => {
  const { pm, session, log } = managerWithSession();
  pm.sessions.delete('t1');
  pm.deliverData('t1', session, 'stale');
  assert.deepEqual(log, []);
});

test('WIRING: every pty:data send goes through the batcher; exit and kill flush first', () => {
  const src = codeOnly(readSource('src/main/pty.ts'));
  const dataSends = src.match(/safeSend\(`pty:data:\$\{[^}]+\}`/g) || [];
  assert.equal(dataSends.length, 2, 'the batcher\'s send, and the test-only fallback in deliverData');
  assert.match(src, /session\.out = createPtyDataBatcher\(\(data\) => this\.safeSend\(`pty:data:\$\{opts\.id\}`, data, session\.owner\)\)/);
  assert.match(src, /proc\.onData\(\(data\) => this\.deliverData\(opts\.id, session, data\)\)/);
  assert.match(src, /session\.out\?\.flush\(\);\s*this\.safeSend\(`pty:exit:\$\{opts\.id\}`/, 'exit notice after the last bytes');
  assert.match(src, /s\.out\?\.flush\(\);\s*const pid = s\.proc\.pid;\s*s\.proc\.kill\(\);/, 'kill flushes before the id can be reclaimed');
});
