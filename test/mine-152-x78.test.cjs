'use strict';

/**
 * MINE-152 X7/X8 + N1-N3 (Jim's audit section 10, god's scope) and Jim's J test gaps.
 *  X7  a stop mid-pass never starts a NEW daemon (it would be an orphan the quit cannot reap);
 *  X8  a swap refused because the live palace is in use keeps the VERIFIED rebuild and retries
 *      on quiet ticks (bounded), then discards it; no leak;
 *  N1  a healthy palace at a later start reclaims the old backup; N2 staging leftovers reaped;
 *  N3  a job still running at the 60-min cap is re-waited, never resubmitted.
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
const miner = loadTs('src/main/incrementalMiner.ts');
const { MemoryManager } = loadTs('src/main/memory.ts');

const REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'mempalace', 'repair-status-3.7.1.txt'), 'utf8');
const JOB = 'abcdef0123456789abcdef0123456789';
let pid = 4_500_000;

function fakeWorld(t, script) {
  const spawns = [], killed = [];
  const realSpawn = cp.spawn, realSync = cp.spawnSync, realKill = procKill.hardKillTree;
  cp.spawn = (bin, args) => {
    const proc = new EventEmitter();
    proc.pid = ++pid; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => true;
    proc.exit = (code, out) => setImmediate(() => { if (out) proc.stdout.emit('data', Buffer.from(out)); proc.emit('close', code); });
    const rec = { args: [...args], proc, at: Date.now() };
    spawns.push(rec); script(rec);
    return proc;
  };
  cp.spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
  procKill.hardKillTree = (p) => killed.push(p);
  t.after(() => { cp.spawn = realSpawn; cp.spawnSync = realSync; procKill.hardKillTree = realKill; });
  return { spawns, killed };
}
const verb = (s) => s.args.join(' ');
function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-x78-'));
  fs.mkdirSync(path.join(root, 'hive', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hive', 'registry.json'), JSON.stringify({ agents: {} }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const agent = (root, id, body) => { const d = path.join(root, 'hive', 'agents', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'memory.md'), body); };
function manager(t, root) {
  const m = new MemoryManager(() => root, () => ({ enabled: true, model: 'minilm' }));
  m.bin = () => 'mempalace';
  t.after(() => { m.mineStopped = true; });
  return m;
}
function clock(t, start = 1_000_000) { const real = Date.now; const c = { now: start }; Date.now = () => c.now; t.after(() => { Date.now = real; }); return c; }
const quiet = (t) => { const e = console.error, l = console.log, w = console.warn; console.error = console.log = console.warn = () => {}; t.after(() => { console.error = e; console.log = l; console.warn = w; }); };
async function until(pred, ms = 3000) { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } }
const realNow = Date.now;

// ── X7 ──────────────────────────────────────────────────────────────────────

test('X7: a quit during agent A\'s job submit, with B also ready, never starts a daemon after stop()', async (t) => {
  const w = fakeWorld(t, (s) => {
    if (verb(s) === 'daemon start' || verb(s) === 'daemon stop') { s.proc.exit(0); return; }
    if (s.args.includes('--background')) return;      // A's submit hangs until quit
    s.proc.exit(0);
  });
  const root = home(t); agent(root, 'a', '1'); agent(root, 'b', '2');
  const m = manager(t, root); const c = clock(t);
  const attempted = [];
  const realMine = m.mineAgent.bind(m);
  m.mineAgent = (dir, id) => { attempted.push(id); return realMine(dir, id); };
  await m.mineNow(); c.now += 61_000;
  const pass = m.mineNow();
  await until(() => w.spawns.some((s) => s.args.includes('--background')));
  const submit = w.spawns.find((s) => s.args.includes('--background'));
  const stopIndex = w.spawns.length;
  m.stop({ quitting: true });
  submit.proc.emit('close', null);                       // the killed client exits
  await pass;
  await new Promise((r) => setTimeout(r, 20));
  const after = w.spawns.slice(stopIndex).map(verb);
  assert.deepEqual(after.filter((v) => v === 'daemon start'), [], `no daemon start after stop (saw: ${JSON.stringify(after)})`);
  assert.equal(after.filter((v) => v.startsWith('mine')).length, 0, 'B is not mined after the stop');
  assert.deepEqual(attempted, ['a'], 'the pass stops at once: B is never even attempted');
});

test('X7: ensureDaemon refuses after stop (a non-quit stop too)', async (t) => {
  const w = fakeWorld(t, (s) => s.proc.exit(0));
  const m = manager(t, home(t));
  m.stop();
  assert.equal(await m.ensureDaemon(), false);
  assert.equal(w.spawns.filter((s) => verb(s) === 'daemon start').length, 0);
});

// ── X8 ──────────────────────────────────────────────────────────────────────

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
      if (opts.buildFails) { fs.mkdirSync(s.args[s.args.indexOf('--palace') + 1], { recursive: true }); s.proc.exit(1); return; }
      const staged = s.args[s.args.indexOf('--palace') + 1];
      fs.mkdirSync(staged, { recursive: true }); fs.writeFileSync(path.join(staged, 'marker'), 'new');
      if (opts.onBuild) opts.onBuild();
    }
    s.proc.exit(0);
  };
}
/** Make renaming the live palace fail (EBUSY: a reader holds it) while `held()` is true. */
function holdPalace(t, root, held) {
  const real = fs.renameSync;
  fs.renameSync = (a, b) => { if (held() && path.resolve(a) === path.resolve(root, 'palace')) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } return real(a, b); };
  t.after(() => { fs.renameSync = real; });
}
const siblings = (root, kind) => fs.readdirSync(root).filter((n) => n.startsWith(`palace.mempalace-${kind}-`));

test('X8: a swap refused (palace in use) KEEPS the verified rebuild, retries on a quiet tick after release, and succeeds; no leak', async (t) => {
  fakeWorld(t, repairScript());
  const root = home(t); const palace = bloated(root);
  let held = true; holdPalace(t, root, () => held);
  const m = manager(t, root); const c = clock(t); quiet(t);
  await m.maybeRebuildPalace();
  assert.equal(fs.readFileSync(path.join(palace, 'marker'), 'utf8'), 'old', 'the live palace is untouched');
  assert.equal(siblings(root, 'rebuild').length, 1, 'the verified rebuild is KEPT (was leaked or thrown away)');
  assert.ok(m.pendingSwap, 'a retry is scheduled');
  held = false;
  await m.mineNow();
  assert.equal(fs.readFileSync(path.join(palace, 'marker'), 'utf8'), 'old', 'not retried before its time (even though it would succeed now)');
  c.now += 2 * 60_000 + 1;
  await m.mineNow();
  assert.equal(fs.readFileSync(path.join(palace, 'marker'), 'utf8'), 'new', 'the rebuild is live');
  assert.equal(siblings(root, 'rebuild').length, 0, 'nothing left behind');
  assert.equal(siblings(root, 'backup').length, 1, 'the old palace is the backup');
  assert.equal(m.pendingSwap, null);
});

test('X8: while a verified rebuild waits for its swap, NO mine runs (it would run on the bloated palace and starve the retry); mining resumes after', async (t) => {
  fakeWorld(t, repairScript());
  const root = home(t); bloated(root); agent(root, 'a', 'x');
  let held = true; holdPalace(t, root, () => held);
  const m = manager(t, root); const c = clock(t); quiet(t);
  const mined = [];
  m.mineAgent = async (_d, id) => { mined.push(id); return true; };
  await m.maybeRebuildPalace();
  await m.mineNow(); c.now += 61_000; await m.mineNow(); c.now += 30_000; await m.mineNow();
  assert.deepEqual(mined, [], 'deferred while the rebuild is pending');
  held = false; c.now += 2 * 60_000; await m.mineNow();
  assert.equal(m.pendingSwap, null, 'swapped');
  c.now += 61_000; await m.mineNow();
  assert.deepEqual(mined, ['a'], 'mining resumes on the rebuilt palace');
});

test('X8: a palace in use through every retry -> the rebuild is discarded after the bound (no leak); a stop discards it too', async (t) => {
  fakeWorld(t, repairScript());
  const root = home(t); bloated(root);
  holdPalace(t, root, () => true);
  const m = manager(t, root); const c = clock(t); quiet(t);
  await m.maybeRebuildPalace();
  for (let i = 0; i < 20 && m.pendingSwap; i++) { c.now += 2 * 60_000 + 1; await m.mineNow(); }
  assert.equal(m.pendingSwap, null, 'given up');
  assert.equal(siblings(root, 'rebuild').length, 0, 'discarded, not leaked');
  // a stop with a pending swap discards it as well
  const root2 = home(t); bloated(root2);
  holdPalace(t, root2, () => true);
  const m2 = manager(t, root2);
  await m2.maybeRebuildPalace();
  assert.equal(siblings(root2, 'rebuild').length, 1);
  m2.stop({ quitting: true });
  assert.equal(siblings(root2, 'rebuild').length, 0);
});

test('J18/J20: the staged dir is discarded on a quit mid-repair and on a failed build', async (t) => {
  let m;
  fakeWorld(t, repairScript({ onBuild: () => m.stop() }));
  const root = home(t); bloated(root); quiet(t);
  m = manager(t, root);
  await m.maybeRebuildPalace();
  assert.equal(siblings(root, 'rebuild').length, 0, 'quit mid-repair: discarded');
  const w2root = home(t); bloated(w2root);
  fakeWorld(t, repairScript({ buildFails: true }));
  const m2 = manager(t, w2root);
  await m2.maybeRebuildPalace();
  assert.equal(siblings(w2root, 'rebuild').length, 0, 'failed build: discarded');
});

// ── N1 / N2 ─────────────────────────────────────────────────────────────────

test('N1: a HEALTHY palace at a later start reclaims backups from earlier runs; a backup made in this run is kept', async (t) => {
  fakeWorld(t, (s) => { if (verb(s).endsWith('repair-status')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(REAL)); s.proc.emit('close', 0); }); return; } s.proc.exit(0); });
  const root = home(t);
  const palace = path.join(root, 'palace'); fs.mkdirSync(path.join(palace, 'seg'), { recursive: true });
  fs.writeFileSync(path.join(palace, 'seg', 'data_level0.bin'), Buffer.alloc(1000));   // healthy: tiny index
  quiet(t);
  const m = manager(t, root);
  const old = path.join(root, `palace.mempalace-backup-${m.startedAt - 86_400_000}`);
  const mine = path.join(root, `palace.mempalace-backup-${m.startedAt + 5}`);
  fs.mkdirSync(old); fs.mkdirSync(mine);
  await m.maybeRebuildPalace();
  assert.equal(fs.existsSync(old), false, 'the earlier run\'s backup is reclaimed');
  assert.equal(fs.existsSync(mine), true, 'this run\'s backup is kept');
});

test('N2: start() reaps staging dirs a killed repair left behind', (t) => {
  fakeWorld(t, (s) => s.proc.exit(0));
  const root = home(t); bloated(root);
  const leftover = path.join(root, 'palace.mempalace-rebuild-123'); fs.mkdirSync(leftover);
  quiet(t);
  const m = manager(t, root);
  m.startMineLoop = () => {};
  m.maybeRebuildPalace = async () => {};
  m.start();
  assert.equal(fs.existsSync(leftover), false);
});

// ── N3 + J14/J15/J16 ────────────────────────────────────────────────────────

test('N3/J14: a job still running at the 60-min cap is left to finish and re-waited by id next pass (no duplicate submit)', async (t) => {
  let running = true;
  const c = { now: 1_000_000 };
  Date.now = () => c.now; t.after(() => { Date.now = realNow; });
  const w = fakeWorld(t, (s) => {
    const v = verb(s);
    if (s.args.includes('--background')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(`Submitted daemon job ${JOB} (mine)\n`)); s.proc.emit('close', 0); }); return; }
    if (v === `daemon wait ${JOB}`) { c.now += 61 * 60_000; if (running) s.proc.exit(1); else s.proc.exit(0); return; }
    if (v.startsWith('daemon jobs')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(`${JOB}  ${running ? 'running' : 'succeeded'}  mine  x\n`)); s.proc.emit('close', 0); }); return; }
    s.proc.exit(0);
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root); m.sleep = () => Promise.resolve(); quiet(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.equal(miner.loadMineState(root).entries.a, undefined, 'not yet');
  assert.equal(m.jobsInFlight.get('a'), JOB, 'the job id is remembered');
  running = false;
  c.now += 3 * 60_000; await m.mineNow();
  assert.equal(w.spawns.filter((s) => s.args.includes('--background')).length, 1, 'ONE submit in total');
  assert.ok(miner.loadMineState(root).entries.a, 'the same job completed and was recorded');
  assert.equal(m.jobsInFlight.has('a'), false);
});

test('J15: a wait client that ends fast while the job is still running does not spin (waits JOB_POLL_MIN_MS)', async (t) => {
  let waits = 0; const sleeps = [];
  fakeWorld(t, (s) => {
    const v = verb(s);
    if (s.args.includes('--background')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(`Submitted daemon job ${JOB} (mine)\n`)); s.proc.emit('close', 0); }); return; }
    if (v === `daemon wait ${JOB}`) { waits += 1; s.proc.exit(waits < 3 ? 1 : 0); return; }
    if (v.startsWith('daemon jobs')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(`${JOB}  running  mine  x\n`)); s.proc.emit('close', 0); }); return; }
    s.proc.exit(0);
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root); m.sleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };
  const c = clock(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.deepEqual(sleeps, [15_000, 15_000], 'one poll gap per fast-failing wait');
});

test('J16: a CLI call that hits its wall cap has its whole process tree killed', async (t) => {
  const w = fakeWorld(t, () => {});   // never exits
  const keepAlive = setInterval(() => {}, 10);   // the production cap timer is unref'd
  t.after(() => clearInterval(keepAlive));
  const m = manager(t, home(t));
  const r = await m.runCapture('mempalace', ['daemon', 'wait', JOB], 30);
  assert.equal(r.timedOut, true);
  assert.deepEqual(w.killed, [w.spawns[0].proc.pid]);
});
