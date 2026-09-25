'use strict';

/**
 * MINE-152 visibility (god, with Jim's re-audit 2): a packaged build shows no console, so the
 * palace repair, the swap (pending / done / abandoned), the backup reclaim and the mine deferral
 * are written to log.jsonl, and status() carries swapPending (the Memory panel shows it).
 * The runbook's install check reads these rows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');

const procKill = loadTs('src/main/procKill.ts');
const { MemoryManager } = loadTs('src/main/memory.ts');

const REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'mempalace', 'repair-status-3.7.1.txt'), 'utf8');
let pid = 4_700_000;

function fakeWorld(t, script) {
  const realSpawn = cp.spawn, realSync = cp.spawnSync, realKill = procKill.hardKillTree;
  cp.spawn = (bin, args) => {
    const proc = new EventEmitter();
    proc.pid = ++pid; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => true;
    proc.exit = (code, out) => setImmediate(() => { if (out) proc.stdout.emit('data', Buffer.from(out)); proc.emit('close', code); });
    script({ args: [...args], proc });
    return proc;
  };
  cp.spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
  procKill.hardKillTree = () => {};
  t.after(() => { cp.spawn = realSpawn; cp.spawnSync = realSync; procKill.hardKillTree = realKill; });
}
const verb = (s) => s.args.join(' ');
function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-vis-'));
  fs.mkdirSync(path.join(root, 'hive', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hive', 'registry.json'), JSON.stringify({ agents: {} }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function bloated(root) {
  const palace = path.join(root, 'palace');
  fs.mkdirSync(path.join(palace, 'seg'), { recursive: true });
  fs.writeFileSync(path.join(palace, 'seg', 'data_level0.bin'), Buffer.alloc(20_000));
  fs.writeFileSync(path.join(palace, 'marker'), 'old');
  return palace;
}
const report = (d, c) => REAL.replace('3,317', String(d)).replace('  sqlite count:   478', `  sqlite count:   ${c}`);
function repairScript(opts = {}) {
  return (s) => {
    const v = verb(s);
    if (v.endsWith('repair-status')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(report(1, 0))); s.proc.emit('close', 0); }); return; }
    if (s.args.includes('repair')) {
      const staged = s.args[s.args.indexOf('--palace') + 1];
      fs.mkdirSync(staged, { recursive: true });
      if (opts.buildFails) { s.proc.exit(1); return; }
      fs.writeFileSync(path.join(staged, 'marker'), 'new');
    }
    s.proc.exit(0);
  };
}
function holdPalace(t, root, held) {
  const real = fs.renameSync;
  fs.renameSync = (a, b) => { if (held() && path.resolve(a) === path.resolve(root, 'palace')) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return real(a, b); };
  t.after(() => { fs.renameSync = real; });
}
function manager(t, root) {
  const log = [];
  const m = new MemoryManager(() => root, () => ({ enabled: true, model: 'minilm' }), (e) => log.push(e));
  m.bin = () => 'mempalace';
  t.after(() => { m.mineStopped = true; });
  return { m, log };
}
function clock(t, start = 1_000_000) { const real = Date.now; const c = { now: start }; Date.now = () => c.now; t.after(() => { Date.now = real; }); return c; }
const quiet = (t) => { const e = console.error, l = console.log, w = console.warn; console.error = console.log = console.warn = () => {}; t.after(() => { console.error = e; console.log = l; console.warn = w; }); };
const kinds = (log) => log.map((e) => e.kind + (e.outcome ? `:${e.outcome}` : ''));

test('a clean repair logs start (sizes, rows) -> swap-done (before/after bytes, backup) -> repair-done swapped', async (t) => {
  fakeWorld(t, repairScript());
  const root = home(t); bloated(root); quiet(t);
  const { m, log } = manager(t, root);
  await m.maybeRebuildPalace();
  assert.deepEqual(kinds(log), ['palace-repair-start', 'palace-swap-done', 'palace-repair-done:swapped']);
  const [start, swap] = log;
  assert.ok(start.palaceBytes >= 20_000 && start.indexBytes === 20_000 && start.rows > 0, JSON.stringify(start));
  assert.equal(swap.attempt, 1);
  assert.ok(swap.bytesBefore > swap.bytesAfter, 'the palace shrank');
  assert.match(swap.backup, /palace\.mempalace-backup-\d+$/);
  assert.equal(typeof log[2].ms, 'number');
  assert.equal(m.status().swapPending, null);
});

test('a held palace: repair-done swap-pending + swap-pending, status().swapPending, ONE mine-deferred, then swap-done on the retry', async (t) => {
  fakeWorld(t, repairScript());
  const root = home(t); bloated(root);
  const d = path.join(root, 'hive', 'agents', 'a'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'memory.md'), 'x');
  let held = true; holdPalace(t, root, () => held);
  const c = clock(t); quiet(t);
  const { m, log } = manager(t, root);
  m.mineAgent = async () => true;
  await m.maybeRebuildPalace();
  assert.deepEqual(kinds(log), ['palace-repair-start', 'palace-repair-done:swap-pending', 'palace-swap-pending']);
  assert.deepEqual({ ...m.status().swapPending }, { attempts: 1, max: 15, nextAt: c.now + 2 * 60_000 });
  await m.mineNow(); c.now += 30_000; await m.mineNow();
  assert.equal(log.filter((e) => e.kind === 'mine-deferred').length, 1, 'logged once per pending swap, not per tick');
  c.now += 2 * 60_000; await m.mineNow();
  assert.deepEqual(kinds(log).slice(-1), ['palace-swap-pending'], 'a refused retry is logged with its attempt');
  assert.equal(log[log.length - 1].attempt, 2);
  held = false; c.now += 2 * 60_000 + 1; await m.mineNow();
  const done = log.find((e) => e.kind === 'palace-swap-done');
  assert.ok(done, 'swap-done'); assert.equal(done.attempt, 3);
  assert.equal(m.status().swapPending, null);
});

test('abandoned after the bound, a failed build, and a reclaim are logged', async (t) => {
  fakeWorld(t, repairScript());
  const root = home(t); bloated(root);
  holdPalace(t, root, () => true);
  const c = clock(t); quiet(t);
  const { m, log } = manager(t, root);
  await m.maybeRebuildPalace();
  for (let i = 0; i < 20 && m.pendingSwap; i++) { c.now += 2 * 60_000 + 1; await m.mineNow(); }
  const ab = log.find((e) => e.kind === 'palace-swap-abandoned');
  assert.ok(ab); assert.equal(ab.attempts, 15);

  const root2 = home(t); bloated(root2);
  fakeWorld(t, repairScript({ buildFails: true }));
  const b = manager(t, root2);
  await b.m.maybeRebuildPalace();
  assert.deepEqual(kinds(b.log), ['palace-repair-start', 'palace-repair-done:build-failed']);

  const root3 = home(t);
  fakeWorld(t, (s) => { if (verb(s).endsWith('repair-status')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(REAL)); s.proc.emit('close', 0); }); return; } s.proc.exit(0); });
  const palace = path.join(root3, 'palace'); fs.mkdirSync(path.join(palace, 'seg'), { recursive: true });
  fs.writeFileSync(path.join(palace, 'seg', 'data_level0.bin'), Buffer.alloc(1000));
  const r = manager(t, root3);
  fs.mkdirSync(path.join(root3, `palace.mempalace-backup-${r.m.startedAt - 86_400_000}`));
  await r.m.maybeRebuildPalace();
  assert.deepEqual(r.log, [{ kind: 'palace-reclaim', what: 'backup', removed: 1 }]);
});

test('wiring: index.ts hands the MemoryManager the hive log', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /new MemoryManager\([\s\S]{0,400}?\(event\) => hive\.appendLog\(event\)\s*\n?\);/);
});
