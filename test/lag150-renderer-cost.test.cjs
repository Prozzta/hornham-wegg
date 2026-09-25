'use strict';

/**
 * LAG-150: the installed 1.1.49 was still laggy after the main-thread fix. Measured with
 * per-process CPU on the live app and CDP on an isolated copy of the SAME build, the cost
 * was in the RENDERER and GPU, from two causes. These pin both.
 *
 *  1. The office floor drew at the display's refresh rate (165 fps measured), with the canvas
 *     at 2x or more of the device pixels. Idle floor: renderer ~18% + GPU ~14% of a core.
 *     Capped at 30 fps the same floor measured ~5% + ~2%.
 *  2. Every change to the height of the composer under a terminal resized the pty (the
 *     pending list appeared on a queued message and vanished on delivery: 19 -> 14 -> 19
 *     rows). Codex answers ANY grid change by replaying its whole transcript, about 90-280 KB
 *     for 120-360 lines of history and growing with it, all of it back through IPC and xterm.
 *
 * terminalPool.ts, PtyTerminalView.tsx and OfficeFloor.tsx cannot load under node (xterm,
 * Pixi's renderer and React DOM need a browser), so their USE of the rules is a static
 * tripwire. The rules themselves are pure modules and are run here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { createPtyResizeCoalescer, PTY_RESIZE_SETTLE_MS } =
  loadTs('src/renderer/src/components/ptyResizeCoalescer.ts');
const { FLOOR_MAX_FPS, applyFloorFrameBudget } =
  loadTs('src/renderer/src/scene/office/floorFrameBudget.ts');

/** A manual clock: timers fire only when the test advances time. */
function clock() {
  let now = 0;
  const timers = new Map();
  let seq = 0;
  return {
    host: {
      set: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
      clear: (id) => { timers.delete(id); }
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    get live() { return timers.size; }
  };
}

const g = (cols, rows) => ({ cols, rows });

function recorder() {
  const c = clock();
  const sent = [];
  const co = createPtyResizeCoalescer((grid) => sent.push(grid), c.host);
  return { c, sent, co };
}

// ─── 2. pty grid: the resize coalescer ────────────────────────────────────────

test('THE REPLAY: the queue list appearing and vanishing before it settles costs the pty NOTHING', () => {
  const { c, sent, co } = recorder();
  co.request(g(55, 19), g(55, 14));   // pending list appears
  c.advance(40);
  co.request(g(55, 14), g(55, 19));   // …and goes again
  c.advance(PTY_RESIZE_SETTLE_MS * 4);
  assert.deepEqual(sent, [], 'a grid that settles back where it started must never reach the pty');
  assert.equal(c.live, 0);
});

test('a real change still reaches the pty: exactly once, with the settled grid', () => {
  const { c, sent, co } = recorder();
  co.request(g(55, 19), g(55, 14));
  assert.deepEqual(sent, [], 'not before it settles');
  c.advance(PTY_RESIZE_SETTLE_MS);
  assert.deepEqual(sent, [g(55, 14)]);
});

test('a drag: forty fits in a row become ONE pty resize (was forty transcript replays)', () => {
  const { c, sent, co } = recorder();
  let cols = 80;
  for (let i = 0; i < 40; i++) { co.request(g(cols, 30), g(cols + 1, 30)); cols += 1; c.advance(16); }
  c.advance(PTY_RESIZE_SETTLE_MS);
  assert.deepEqual(sent, [g(120, 30)]);
});

test('bursts separated by a quiet period are separate resizes', () => {
  const { c, sent, co } = recorder();
  co.request(g(55, 19), g(55, 14)); c.advance(PTY_RESIZE_SETTLE_MS);
  co.request(g(55, 14), g(55, 19)); c.advance(PTY_RESIZE_SETTLE_MS);
  assert.deepEqual(sent, [g(55, 14), g(55, 19)]);
});

test('cancel drops a pending resize; flush sends it now', () => {
  const a = recorder();
  a.co.request(g(55, 19), g(60, 19)); a.co.cancel(); a.c.advance(1000);
  assert.deepEqual(a.sent, []);
  const b = recorder();
  b.co.request(g(55, 19), g(60, 19)); b.co.flush();
  assert.deepEqual(b.sent, [g(60, 19)]);
  assert.equal(b.co.pending, false);
});

test('WIRING: no renderer code resizes a pty except through the coalescer', () => {
  const pool = codeOnly(readSource('src/renderer/src/components/terminalPool.ts'));
  const view = codeOnly(readSource('src/renderer/src/components/PtyTerminalView.tsx'));
  const direct = (src) => (src.match(/window\.cth\.resizePty\(/g) || []).length;
  assert.equal(direct(view), 0, 'PtyTerminalView must go through requestPtyResize');
  assert.equal(direct(pool), 1, 'terminalPool: the ONE direct call is the coalescer\'s send');
  assert.match(pool, /createPtyResizeCoalescer\(\(g\) => \{ void window\.cth\.resizePty\(ptyId, g\.cols, g\.rows\); \}\)/);
  assert.ok((view.match(/requestPtyResize\(ptyId, before, /g) || []).length >= 2, 'fit + font-size paths');
  assert.match(pool, /requestPtyResize\(ptyId, before, /, 'reflowTerminal path');
});

test('LAYOUT: the pending list is OUT OF FLOW, so the queue cannot change the terminal grid', () => {
  const src = codeOnly(readSource('src/renderer/src/components/MessageQueueComposer.tsx'));
  const at = src.indexOf('data-queue-overlay');
  assert.ok(at > 0, 'the pending list is the overlay');
  const style = src.slice(at, src.indexOf('}}>', at));
  assert.match(style, /position: 'absolute'/, 'absolutely positioned: takes no height in the composer column');
  assert.match(style, /bottom: '100%'/, 'rising from the top edge of the composer, over the terminal');
  // …anchored to the composer itself, not to some ancestor further up.
  const root = src.slice(src.indexOf('return (\n    <div'), at);
  assert.match(root, /flexShrink: 0,\s*position: 'relative'/);
  // No other in-flow copy of the list survives.
  assert.equal((src.match(/queue\.map\(/g) || []).length, 1);
});

// ─── 1. the floor's frame budget ──────────────────────────────────────────────

test('the floor frame budget is applied to the ticker', () => {
  const ticker = { maxFPS: 0 };
  applyFloorFrameBudget(ticker);
  assert.equal(ticker.maxFPS, FLOOR_MAX_FPS);
  assert.ok(FLOOR_MAX_FPS > 0 && FLOOR_MAX_FPS <= 30);
  const floor = codeOnly(readSource('src/renderer/src/scene/office/OfficeFloor.tsx'));
  assert.match(floor, /app\.ticker\.add\(onTick\);\s*applyFloorFrameBudget\(app\.ticker\);/);
});

test('COST: under the REAL Pixi ticker at a 165 Hz display, the cap draws ~30 frames/s, not 165', async () => {
  const url = pathToFileURL(path.resolve(__dirname, '..', 'node_modules/pixi.js/lib/ticker/Ticker.mjs')).href;
  const { Ticker } = await import(url);
  const run = (cap) => {
    const t = new Ticker();
    t.autoStart = false;
    if (cap) applyFloorFrameBudget(t);
    let frames = 0, moved = 0;
    t.add((tk) => { frames++; moved += tk.deltaMS; });
    let now = 1000; t.lastTime = now; t._lastFrame = now;
    for (let i = 0; i < 165; i++) { now += 1000 / 165; t.update(now); }
    return { frames, moved };
  };
  const uncapped = run(false), capped = run(true);
  assert.ok(uncapped.frames >= 160, `uncapped draws every display frame (${uncapped.frames})`);
  assert.ok(capped.frames <= FLOOR_MAX_FPS + 1 && capped.frames >= FLOOR_MAX_FPS - 2, `capped ${capped.frames}`);
  // Skipped frames are not lost time: movement per second is the same, so walk speed is unchanged.
  assert.ok(Math.abs(capped.moved - uncapped.moved) < 1000 / FLOOR_MAX_FPS + 1, `${capped.moved} vs ${uncapped.moved}`);
});
