'use strict';

/**
 * MINE-152 blockers (Jim's audit, god's scope; taken over from Oscar):
 *  (1) a palace rebuild and the mines are mutually exclusive, and a swap forgets any
 *      fingerprint recorded after its staging read (that content is not in the new palace);
 *  (2) quit kills every in-flight mempalace tree and stops the daemon, bounded;
 *  (3) only a usage error means "no daemon" (one-shot fallback, after a daemon stop);
 *      a SLOW start is supported: the first-boot grace stays, and nothing one-shots;
 *  (4) the debounce has a max wait, so a memory that keeps changing is still mined.
 *
 * mempalace is faked at the child_process boundary: every spawn is recorded and scripted.
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

let pid = 4_100_000;
/** A scripted fake child: `script(proc)` decides when it writes and exits. */
function fakeWorld(t, script) {
  const spawns = [];
  const syncs = [];
  const killed = [];
  const realSpawn = cp.spawn, realSync = cp.spawnSync, realKill = procKill.hardKillTree;
  cp.spawn = (bin, args) => {
    const proc = new EventEmitter();
    proc.pid = ++pid;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => true;
    proc.exit = (code, stderr) => setImmediate(() => { if (stderr) proc.stderr.emit('data', Buffer.from(stderr)); proc.emit('close', code); });
    const rec = { args: [...args], proc, at: spawns.length };
    spawns.push(rec);
    script(rec);
    return proc;
  };
  cp.spawnSync = (bin, args, opts) => { syncs.push({ bin, args: [...args], opts }); return { status: 0, stdout: '', stderr: '' }; };
  procKill.hardKillTree = (p) => { killed.push(p); };
  t.after(() => { cp.spawn = realSpawn; cp.spawnSync = realSync; procKill.hardKillTree = realKill; });
  return { spawns, syncs, killed };
}

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-152b-'));
  fs.mkdirSync(path.join(root, 'hive', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hive', 'registry.json'), JSON.stringify({ agents: {} }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function agent(root, id, body) {
  const dir = path.join(root, 'hive', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), body);
}
function manager(t, root, { bin = 'mempalace' } = {}) {
  const m = new MemoryManager(() => root, () => ({ enabled: true, model: 'minilm' }));
  m.bin = () => bin;
  t.after(() => { m.mineStopped = true; });
  return m;
}
/** Date.now under test control; timers stay real. */
function clock(t, start = 1_000_000) {
  const real = Date.now;
  const c = { now: start };
  Date.now = () => c.now;
  t.after(() => { Date.now = real; });
  return c;
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(pred, ms = 2000) {
  const end = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (!pred()) { if (process.hrtime.bigint() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)); }
}
const verb = (s) => s.args.join(' ');

// ── (3) the daemon decision ─────────────────────────────────────────────────

test('(3) ABSENT mempalace: nothing is ever spawned', async (t) => {
  const w = fakeWorld(t, () => {});
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root, { bin: null });
  const c = clock(t);
  await m.mineNow(); c.now += 120_000; await m.mineNow();
  m.stop({ quitting: true });
  assert.equal(w.spawns.length, 0);
  assert.equal(w.syncs.length, 0);
});

test('(3) NO daemon (usage error): daemon stop FIRST, one log, then serialized one-shot mines', async (t) => {
  const order = [];
  const w = fakeWorld(t, (s) => {
    order.push(verb(s));
    if (s.args[0] === 'daemon' && s.args[1] === 'start') s.proc.exit(2, "mempalace: error: argument command: invalid choice: 'daemon'");
    else if (s.args[0] === 'daemon') s.proc.exit(2, 'invalid choice');
    else if (s.args[0] === 'mine') setTimeout(() => s.proc.exit(0), 20);
  });
  const root = home(t); agent(root, 'a', 'x'); agent(root, 'b', 'y');
  const m = manager(t, root);
  const c = clock(t);
  const logs = []; const realErr = console.error; console.error = (x) => logs.push(String(x)); t.after(() => { console.error = realErr; });
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.deepEqual(order.slice(0, 2), ['daemon start', 'daemon stop'], 'no daemon can be left beside the one-shot mines');
  const mines = w.spawns.filter((s) => s.args[0] === 'mine');
  assert.equal(mines.length, 2);
  for (const s of mines) assert.equal(s.args.includes('--daemon'), false, 'one-shot, not a daemon job');
  assert.equal(logs.filter((l) => /no daemon: using one-shot mining/.test(l)).length, 1, 'logged once');
  assert.equal(m.status().miningMode, 'one-shot');
});

test('(3) one-shot mines never overlap: the second starts only after the first exits', async (t) => {
  let open = 0, maxOpen = 0;
  const w = fakeWorld(t, (s) => {
    if (s.args[0] === 'daemon') { s.proc.exit(2, "invalid choice: 'daemon'"); return; }
    open += 1; maxOpen = Math.max(maxOpen, open);
    setTimeout(() => { open -= 1; s.proc.exit(0); }, 30);
  });
  const root = home(t); agent(root, 'a', '1'); agent(root, 'b', '2'); agent(root, 'c', '3');
  const m = manager(t, root);
  const c = clock(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.equal(w.spawns.filter((s) => s.args[0] === 'mine').length, 3);
  assert.equal(maxOpen, 1);
});

test('(3) SLOW daemon start (no usage error): the start is abandoned + daemon stopped; NO one-shot; retried later', async (t) => {
  const w = fakeWorld(t, (s) => {
    if (s.args[1] === 'stop') s.proc.exit(0);
    else if (s.args[0] === 'mine') s.proc.exit(0);   // (a one-shot would complete)
    // `daemon start` never answers
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  m.daemonStartupTimeoutMs = 60;
  const keepAlive = setInterval(() => {}, 10);   // the production timers are unref'd
  t.after(() => clearInterval(keepAlive));
  const c = clock(t);
  const realErr = console.error; console.error = () => {}; t.after(() => { console.error = realErr; });
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  const start = w.spawns.find((s) => verb(s) === 'daemon start');
  assert.ok(w.killed.includes(start.proc.pid), 'the hung start client\'s tree was killed');
  assert.ok(w.spawns.some((s) => verb(s) === 'daemon stop'), 'no half-started daemon is left running');
  assert.equal(w.spawns.filter((s) => s.args[0] === 'mine').length, 0, 'slow is not unsupported: nothing one-shots');
  assert.notEqual(m.status().miningMode, 'one-shot');
  assert.equal(m.daemonStart, null, 'the start is forgotten, so the normal retry can try again');
});

test('(3) the first-boot grace is 10 minutes again (a cold model load is not a missing daemon)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory.ts'), 'utf8');
  assert.match(src, /const DAEMON_STARTUP_TIMEOUT_MS = 10 \* 60_000;/);
  assert.doesNotMatch(src, /mining is off/, 'the stale comment is gone');
});

test('(3) daemon PRESENT: unchanged, jobs go to the daemon', async (t) => {
  const w = fakeWorld(t, (s) => { s.proc.exit(0); });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  const c = clock(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  const mines = w.spawns.filter((s) => s.args[0] === 'mine');
  assert.equal(mines.length, 1);
  assert.ok(mines[0].args.includes('--daemon'));
  assert.equal(m.status().miningMode, 'daemon');
});

// ── (2) quit ────────────────────────────────────────────────────────────────

test('(2) QUIT: every in-flight mempalace tree is killed and the daemon stopped (sync, bounded); a second stop is a no-op', async (t) => {
  const w = fakeWorld(t, (s) => {
    if (verb(s) === 'daemon start') s.proc.exit(0);
    // the mine hangs until killed
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  const c = clock(t);
  await m.mineNow(); c.now += 61_000;
  const pass = m.mineNow();
  await until(() => w.spawns.some((s) => s.args[0] === 'mine'));
  const mine = w.spawns.find((s) => s.args[0] === 'mine');
  m.stop({ quitting: true });
  assert.ok(w.killed.includes(mine.proc.pid), 'the mine\'s whole tree (python child included) is killed');
  const stops = w.syncs.filter((s) => s.args.join(' ') === 'daemon stop');
  assert.equal(stops.length, 1, 'daemon stop, synchronously');
  assert.ok(stops[0].opts.timeout > 0 && stops[0].opts.timeout <= 10_000, 'bounded');
  m.stop({ quitting: true });
  assert.equal(w.syncs.filter((s) => s.args.join(' ') === 'daemon stop').length, 1, 'idempotent');
  mine.proc.emit('close', null);
  await pass;
  assert.equal(miner.loadMineState(root).entries.a, undefined, 'a killed mine never records a fingerprint');
});

test('(2) a stopped manager starts nothing new', async (t) => {
  const w = fakeWorld(t, (s) => s.proc.exit(0));
  const root = home(t); agent(root, 'a', 'x');
  bloatedPalace(root);
  const m = manager(t, root);
  const c = clock(t);
  m.ensureDaemon = async () => true;
  await m.mineNow();                 // the change is queued ...
  c.now += 61_000;                   // ... and mature
  m.stop();
  await m.mineNow();
  await m.maybeRebuildPalace();
  assert.equal(w.spawns.length, 0);
});

// ── (1) rebuild vs mines ────────────────────────────────────────────────────

/** A palace that is "bloated" (one embedding, a 20 KB HNSW file). */
function bloatedPalace(root) {
  const palace = path.join(root, 'palace');
  fs.mkdirSync(path.join(palace, 'seg'), { recursive: true });
  fs.writeFileSync(path.join(palace, 'seg', 'data_level0.bin'), Buffer.alloc(20_000));
  return palace;
}

test('(1) a mine never runs while a rebuild is in flight (the start() race), and runs right after', async (t) => {
  fakeWorld(t, () => {});
  const root = home(t); agent(root, 'a', 'x');
  bloatedPalace(root);
  const m = manager(t, root);
  const c = clock(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  m.runRaw = async (_bin, args) => { if (args.includes('repair-status')) { await gate; return { ok: true, output: 'SQLite: 999999' }; } return { ok: false, output: '' }; };
  const mined = [];
  m.mineAgent = async (_d, id) => { mined.push(id); return true; };
  const rebuild = m.maybeRebuildPalace();                 // start(): rebuild first ...
  await m.mineNow(); c.now += 61_000; await m.mineNow();  // ... then the mine loop
  assert.deepEqual(mined, [], 'no mine while the rebuild holds the palace');
  release(); await rebuild;
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.deepEqual(mined, ['a'], 'deferred (one debounce after the rebuild), not lost');
});

test('(1) a rebuild never starts while a mine is in flight', async (t) => {
  fakeWorld(t, () => {});
  const root = home(t); agent(root, 'a', 'x');
  bloatedPalace(root);
  const m = manager(t, root);
  const c = clock(t);
  let release; const gate = new Promise((r) => { release = r; });
  m.mineAgent = async () => { await gate; return true; };
  const raws = [];
  m.runRaw = async (_b, args) => { raws.push(args.join(' ')); return { ok: false, output: '' }; };
  await m.mineNow(); c.now += 61_000;
  const pass = m.mineNow();
  await tick();
  await m.maybeRebuildPalace();
  assert.deepEqual(raws, []);
  release(); await pass;
});

test('(1) after a swap, a fingerprint recorded since the staging read is forgotten (mined again); older ones stay', async (t) => {
  fakeWorld(t, () => {});
  const root = home(t);
  const palace = bloatedPalace(root);
  const m = manager(t, root);
  const c = clock(t);
  m.mineState = { version: 1, entries: { old: { size: 1, sha256: 'o', mtimeMs: 1, minedAt: c.now - 1000 } } };
  m.runRaw = async (_b, args) => {
    if (args.includes('repair-status')) return { ok: true, output: 'SQLite: 1' };
    if (args.includes('repair')) {
      const staged = args[args.indexOf('--palace') + 1];
      fs.mkdirSync(staged, { recursive: true });
      c.now += 5_000;
      // something landed in the LIVE palace after the staging read
      m.mineState.entries.late = { size: 1, sha256: 'l', mtimeMs: 1, minedAt: c.now };
      return { ok: true, output: '' };
    }
    return { ok: false, output: '' };
  };
  const realLog = console.log, realWarn = console.warn; console.log = () => {}; console.warn = () => {};
  t.after(() => { console.log = realLog; console.warn = realWarn; });
  await m.maybeRebuildPalace();
  assert.ok(fs.readdirSync(root).some((n) => n.startsWith('palace.mempalace-backup-')), 'the swap happened');
  assert.ok(existsIn(palace), 'a palace is live');
  const saved = miner.loadMineState(root).entries;
  assert.equal(saved.late, undefined, 'mined after the staging read: forgotten, so it is mined again');
  assert.ok(saved.old, 'mined before: kept');
});
function existsIn(p) { return fs.existsSync(p); }

// ── (4) starvation ──────────────────────────────────────────────────────────

test('(4) queueChangedMemory: continuous changes still mature by the max wait', () => {
  const pending = new Map();
  const fp = (n) => ({ size: n, sha256: String(n), mtimeMs: n });
  for (let i = 0; i < 30; i++) miner.queueChangedMemory(pending, 'a', fp(i), i * 60_000, 60_000, 600_000);
  assert.equal(pending.get('a').firstChangedAt, 0);
  assert.equal(pending.get('a').quietUntil, 600_000, 'capped at first change + 10 min');
  assert.deepEqual(miner.readyMineIds(pending, 600_000), ['a']);
});

test('(4) a memory.md appended to every minute is mined within ~10 min of its first change, at most once per 10 min', async (t) => {
  fakeWorld(t, () => {});
  const root = home(t); agent(root, 'live', '0\n');
  const m = manager(t, root);
  const c = clock(t);
  const jobs = [];
  m.mineAgent = async () => { jobs.push(c.now); return true; };
  const first = c.now;
  for (let i = 0; i < 30; i++) {
    fs.appendFileSync(path.join(root, 'hive', 'agents', 'live', 'memory.md'), `${i}\n`);
    await m.mineNow();
    c.now += 60_000;
  }
  assert.ok(jobs.length >= 1, 'no starvation');
  assert.ok(jobs[0] - first <= 600_000, `first job ${(jobs[0] - first) / 60_000} min after the first change`);
  for (let i = 1; i < jobs.length; i++) assert.ok(jobs[i] - jobs[i - 1] >= 600_000, 'the per-agent 10-minute cap holds');
});

test('(2) WIRING: every quit path stops memory in quitting mode (will-quit and teardownAndQuit)', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(index, /app\.on\('will-quit', \(\) => \{[\s\S]{0,1200}memory\.stop\(\{ quitting: true \}\)/);
  const teardown = index.slice(index.indexOf('function teardownAndQuit(): void {'), index.indexOf("ipcMain.handle('app:confirmClose'"));
  assert.match(teardown, /memory\.stop\(\{ quitting: true \}\)/);
});
