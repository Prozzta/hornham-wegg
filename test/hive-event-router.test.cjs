'use strict';

/**
 * Pre-M1 event-wake bridge, commit 1 — the HYBRID router and the delivery edge
 * (plan: agents/dwight-mu32ztys/floor-self-advance-PLAN.md, test plan A).
 *
 * The router runtime is injected: watchers, the immediate queue and the reconciliation
 * interval are all fakes, so each test proves exactly which path moved a file. The files
 * stay authoritative: a watch callback carries nothing and only asks for one scan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function fakeRuntime() {
  const watchers = new Map();     // dir -> { hint, closed, handlers }
  const immediates = [];
  const intervals = [];
  return {
    watchers, immediates, intervals,
    runtime: {
      watch: (dir, onHint) => {
        const w = {
          dir, hint: onHint, closed: false, handlers: {},
          close() { this.closed = true; },
          on(ev, cb) { this.handlers[ev] = cb; return this; }
        };
        watchers.set(dir, w);
        return w;
      },
      setImmediate: (fn) => { immediates.push(fn); },
      setInterval: (fn, ms) => { const h = { fn, ms, cleared: false }; intervals.push(h); return h; },
      clearInterval: (h) => { h.cleared = true; }
    },
    flush() { while (immediates.length) immediates.shift()(); },
    live(dir) { const w = watchers.get(dir); return w && !w.closed ? w : null; }
  };
}

async function floor(t, { emit } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-event-router-'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const rt = fakeRuntime();
  const hive = new HiveManager(() => home, emit, rt.runtime);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const deliveries = [];
  hive.setDeliveryObserver((d) => deliveries.push(d));
  const outbox = (id) => path.join(home, 'hive', 'agents', id, 'outbox');
  const inbox = (id) => path.join(home, 'hive', 'agents', id, 'inbox');
  const write = (from, msg) => fs.writeFileSync(path.join(outbox(from), `${msg.id}.json`), JSON.stringify(msg));
  const jsons = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return { home, hive, rt, deliveries, outbox, inbox, write, jsons };
}
const msg = (id, to, extra = {}) => ({ id, to, act: 'inform', subject: `s-${id}`, body: 'b', ...extra });

test('A1 TIMER-FREE: a watch hint alone routes an outbox file and fires the delivery observer once', async (t) => {
  const f = await floor(t);
  f.hive.startRouter();
  assert.equal(f.rt.intervals.length, 1, 'the reconciliation interval is captured, never fired');
  f.write('jim-1', msg('m1', 'god-1'));
  f.rt.live(f.outbox('jim-1')).hint();
  f.rt.flush();
  assert.deepEqual(f.jsons(f.outbox('jim-1')), [], 'moved out of the outbox');
  assert.ok(fs.existsSync(path.join(f.outbox('jim-1'), '.sent', 'm1.json')), 'archived to .sent');
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm1.json')), 'written to the recipient inbox');
  assert.deepEqual(f.deliveries, [{ agentId: 'god-1', messageId: 'm1' }]);
});

test('A2 duplicate / coalesced hints in one turn produce ONE scan: one route, one delivery', async (t) => {
  const f = await floor(t);
  f.hive.startRouter();
  f.write('jim-1', msg('m2', 'god-1'));
  const w = f.rt.live(f.outbox('jim-1'));
  let scans = 0;
  const real = f.hive.routeOnce.bind(f.hive);
  f.hive.routeOnce = () => { scans++; return real(); };
  w.hint(); w.hint(); w.hint();
  assert.equal(f.rt.immediates.length, 1, 'one queued drain');
  f.rt.flush();
  assert.equal(scans, 1);
  assert.deepEqual(f.deliveries, [{ agentId: 'god-1', messageId: 'm2' }]);
});

test('A3 a missed watch event is repaired by the reconciliation interval', async (t) => {
  const f = await floor(t);
  f.hive.startRouter();
  f.write('jim-1', msg('m3', 'god-1'));
  f.rt.intervals[0].fn();                     // no watch callback at all
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm3.json')));
  assert.deepEqual(f.deliveries, [{ agentId: 'god-1', messageId: 'm3' }]);
});

test('A4 a newly hired agent is watched at once; a removed or archived agent\'s watcher closes on reconciliation', async (t) => {
  const f = await floor(t);
  f.hive.startRouter();
  await f.hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: f.home });
  const pam = f.rt.live(f.outbox('pam-1'));
  assert.ok(pam, 'watched immediately, not at the next interval');
  f.write('pam-1', msg('m4', 'god-1'));
  pam.hint(); f.rt.flush();
  assert.deepEqual(f.deliveries.map((d) => d.messageId), ['m4']);
  fs.rmSync(path.join(f.home, 'hive', 'agents', 'pam-1'), { recursive: true, force: true });
  f.rt.intervals[0].fn();
  assert.equal(pam.closed, true, 'a vanished outbox is unwatched');
  const jim = f.rt.live(f.outbox('jim-1'));
  f.hive.setArchived('jim-1', true);
  f.rt.intervals[0].fn();
  assert.equal(jim.closed, true, 'an archived agent is not watched');
});

test('A5 the observer fires after a direct delivery and a bounce to god; never for a missing inbox or a terminal handoff', async (t) => {
  const f = await floor(t, { emit: () => true });   // the renderer accepts terminal handoffs
  await f.hive.ensureAgent({ id: 'kim-1', name: 'Kim', provider: 'custom', cwd: f.home });
  f.hive.send(msg('d1', 'jim-1'), 'god-1');
  assert.deepEqual(f.deliveries, [{ agentId: 'jim-1', messageId: 'd1' }], 'direct');
  f.deliveries.length = 0;
  f.hive.send(msg('d2', 'nobody'), 'jim-1');
  assert.equal(f.deliveries.length, 1, 'the bounce to god is a real delivery');
  assert.equal(f.deliveries[0].agentId, 'god-1');
  f.deliveries.length = 0;
  fs.rmSync(f.inbox('jim-1'), { recursive: true, force: true });
  f.hive.send(msg('d3', 'jim-1'), 'god-1');
  assert.ok(!f.deliveries.some((d) => d.agentId === 'jim-1'), 'a missing inbox is never reported as a delivery');
  fs.mkdirSync(path.join(f.inbox('jim-1'), '.done'), { recursive: true });
  f.deliveries.length = 0;
  f.hive.send(msg('d4', 'kim-1'), 'jim-1');
  assert.deepEqual(f.deliveries, [], 'a terminal handoff writes no inbox: no delivery');
  // An observer that throws never turns a durable write into a routing failure.
  f.hive.setDeliveryObserver(() => { throw new Error('boom'); });
  f.hive.send(msg('d5', 'jim-1'), 'god-1');
  assert.ok(fs.existsSync(path.join(f.inbox('jim-1'), 'd5.json')));
});

test('A6 watcher errors and stopRouter lose no files: a later scan or restart still routes them', async (t) => {
  const f = await floor(t);
  f.hive.startRouter();
  const w = f.rt.live(f.outbox('jim-1'));
  w.handlers.error(new Error('EPERM'));
  assert.equal(w.closed, true, 'a broken watcher is dropped');
  f.write('jim-1', msg('m6', 'god-1'));
  f.rt.intervals[0].fn();
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm6.json')), 'reconciliation routes it');
  assert.ok(f.rt.live(f.outbox('jim-1')), 'and re-attaches the watcher');
  // A hint queued, then the router stops: the queued scan never runs after the stop.
  f.write('jim-1', msg('m7', 'god-1'));
  f.rt.live(f.outbox('jim-1')).hint();
  f.hive.stopRouter();
  assert.ok([...f.rt.watchers.values()].every((x) => x.closed), 'stop closes every watcher');
  assert.equal(f.rt.intervals[0].cleared, true);
  f.rt.flush();
  assert.ok(fs.existsSync(path.join(f.outbox('jim-1'), 'm7.json')), 'still on disk, not lost');
  f.hive.startRouter();                       // restart: the immediate catch-up scan routes it
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm7.json')));
});
