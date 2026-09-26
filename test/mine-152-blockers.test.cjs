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
const JOB = 'abcdef0123456789abcdef0123456789';
/** Speaks the real 3.7.1 daemon protocol (observed in a jail): `mine --background` prints
 *  "Submitted daemon job <id> (mine)", `daemon wait <id>` exits 0 when the job is done,
 *  `daemon jobs` lists "<id>  <state>  <kind>  <iso>". `wait` = 'ok' | 'hang' | 'fail'. */
function daemonCli(s, { wait = 'ok', jobState = 'succeeded', running = true } = {}) {
  const v = verb(s);
  if (v === 'daemon start' || v === 'daemon stop') { s.proc.exit(0); return; }
  if (v === 'daemon status') { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(running ? 'MemPalace daemon is running\n' : 'MemPalace daemon is not running\n')); s.proc.emit('close', running ? 0 : 1); }); return; }
  if (s.args[0] === 'mine' && s.args.includes('--background')) {
    setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(`Submitted daemon job ${JOB} (mine)\n`)); s.proc.emit('close', 0); });
    return;
  }
  if (v === `daemon wait ${JOB}`) { if (wait === 'ok') s.proc.exit(0); else if (wait === 'fail') s.proc.exit(1); return; }
  if (v.startsWith('daemon jobs')) {
    setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(`${JOB}  ${jobState}  mine        2026-09-25T21:09:20.665756+00:00\n`)); s.proc.emit('close', 0); });
    return;
  }
  s.proc.exit(0);
}

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

test('(3) daemon PRESENT: the job goes to the daemon (submit in the background, then wait on its id)', async (t) => {
  const w = fakeWorld(t, (s) => daemonCli(s));
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  const c = clock(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  const mines = w.spawns.filter((s) => s.args[0] === 'mine');
  assert.equal(mines.length, 1);
  assert.ok(mines[0].args.includes('--daemon') && mines[0].args.includes('--background'));
  assert.ok(w.spawns.some((s) => verb(s) === `daemon wait ${JOB}`), 'waits on the submitted job id');
  assert.equal(m.status().miningMode, 'daemon');
  assert.ok(miner.loadMineState(root).entries.a, 'a completed job records its fingerprint');
});

// ── X2: judged by the daemon's job state, never by silence ──────────────────

test('X2: a SILENT job that is still running is NOT killed and the daemon is NOT stopped; it is waited for until it succeeds', async (t) => {
  let waits = 0;
  const w = fakeWorld(t, (s) => {
    if (verb(s) === `daemon wait ${JOB}`) {
      waits += 1;
      if (waits === 1) { s.proc.exit(1); return; }        // the first wait client ends without an answer
      s.proc.exit(0); return;                               // ... the job then finishes
    }
    daemonCli(s, { jobState: 'running' });
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  m.sleep = () => Promise.resolve();                       // skip the poll gap
  const c = clock(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.equal(waits, 2, 'still running -> waited again, not abandoned');
  assert.equal(w.spawns.filter((s) => verb(s) === 'daemon stop').length, 0, 'the daemon is never stopped for a slow job');
  assert.deepEqual(w.killed, [], 'nothing killed');
  assert.ok(miner.loadMineState(root).entries.a, 'the slow mine COMPLETES and is recorded');
});

test('X2: a job the daemon reports FAILED (or no longer lists) is a failed mine: no fingerprint, retried later, daemon left running', async (t) => {
  for (const jobState of ['failed', 'missing']) {
    const w = fakeWorld(t, (s) => {
      if (verb(s) === `daemon wait ${JOB}`) { s.proc.exit(1); return; }
      if (jobState === 'missing' && verb(s).startsWith('daemon jobs')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from('')); s.proc.emit('close', 0); }); return; }
      daemonCli(s, { jobState });
    });
    const root = home(t); agent(root, 'a', 'x');
    const m = manager(t, root);
    const c = clock(t);
    const realErr = console.error; console.error = () => {};
    await m.mineNow(); c.now += 61_000; await m.mineNow();
    console.error = realErr;
    assert.equal(miner.loadMineState(root).entries.a, undefined, `${jobState}: no fingerprint`);
    assert.ok(m.pendingMines.get('a').quietUntil > c.now, `${jobState}: queued for a retry`);
    assert.equal(w.spawns.filter((s) => verb(s) === 'daemon stop').length, 0, `${jobState}: the daemon is left alone`);
  }
});

test('X2: a wait client that fails while the daemon reports the job SUCCEEDED is a completed mine', async (t) => {
  fakeWorld(t, (s) => {
    if (verb(s) === `daemon wait ${JOB}`) { s.proc.exit(1); return; }
    daemonCli(s, { jobState: 'succeeded' });
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  const c = clock(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.ok(miner.loadMineState(root).entries.a, 'the job state is the truth, not the wait client');
});

test('X2: an unreachable job list with a LIVE daemon keeps the daemon (no restart/reload)', async (t) => {
  fakeWorld(t, (s) => {
    if (verb(s) === `daemon wait ${JOB}`) { s.proc.exit(1); return; }
    if (verb(s).startsWith('daemon jobs')) { s.proc.exit(1); return; }
    daemonCli(s, { running: true });
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  const c = clock(t);
  const realErr = console.error; console.error = () => {}; t.after(() => { console.error = realErr; });
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.notEqual(m.daemonStart, null, 'a running daemon is not forgotten');
});

test('(2) quit while the job SUBMIT client is in flight: killed, and nothing new is spawned', async (t) => {
  const w = fakeWorld(t, (s) => {
    if (s.args.includes('--background')) return;   // the submit hangs
    daemonCli(s);
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  const c = clock(t);
  await m.mineNow(); c.now += 61_000;
  const pass = m.mineNow();
  await until(() => w.spawns.some((s) => s.args.includes('--background')));
  const submit = w.spawns.find((s) => s.args.includes('--background'));
  const before = w.spawns.length;
  m.stop({ quitting: true });
  assert.ok(w.killed.includes(submit.proc.pid));
  submit.proc.emit('close', null);
  await pass;
  await tick();
  assert.equal(w.spawns.length, before, 'no status probe or retry after quit');
});

test('X2: an unreachable daemon is forgotten (the next mine starts one); a live one is not', async (t) => {
  const w = fakeWorld(t, (s) => {
    if (verb(s) === `daemon wait ${JOB}`) { s.proc.exit(1); return; }
    if (verb(s).startsWith('daemon jobs')) { s.proc.exit(1); return; }   // cannot reach it
    daemonCli(s, { running: false });
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  const c = clock(t);
  const realErr = console.error; console.error = () => {}; t.after(() => { console.error = realErr; });
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.equal(m.daemonStart, null, 'dead daemon: the cached start is dropped');
  assert.ok(w.spawns.some((s) => verb(s) === 'daemon status'), 'it was checked before being declared dead');
  assert.equal(w.spawns.filter((s) => verb(s) === 'daemon stop').length, 0);
});

test('X2: a one-shot mine is capped by WALL time only (no silence watchdog) and the source has no silence watchdog left', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory.ts'), 'utf8');
  assert.doesNotMatch(src, /MINE_WATCHDOG_MS|lastProgress/, 'no stdout-silence watchdog');
  assert.match(src, /const ONE_SHOT_MAX_MS = 30 \* 60_000;/);
  assert.match(src, /this\.runCapture\(bin, args, ONE_SHOT_MAX_MS\)/);
  const submit = src.slice(src.indexOf('private async submitMine('), src.indexOf('private async daemonJobState('));
  assert.doesNotMatch(submit, /stopDaemon/, 'a mine never stops the daemon');
});

test('X2: parseDaemonJobState reads the real `daemon jobs` layout', () => {
  const { parseDaemonJobState } = loadTs('src/main/memory.ts');
  const out = '15a00978d3c847e1b84dab9fcf9e85ed  running    mine        2026-09-25T21:09:20.665756+00:00\n54a01d8a34ff4e09832554b61d300b11  succeeded  mine        2026-09-25T21:09:07.507835+00:00\n';
  assert.equal(parseDaemonJobState(out, '15a00978d3c847e1b84dab9fcf9e85ed'), 'running');
  assert.equal(parseDaemonJobState(out, '54a01d8a34ff4e09832554b61d300b11'), 'succeeded');
  assert.equal(parseDaemonJobState(out, 'ffffffffffffffffffffffffffffffff'), 'missing');
});

// ── (2) quit ────────────────────────────────────────────────────────────────

test('(2) QUIT: every in-flight mempalace tree is killed and the daemon stopped (sync, bounded); a second stop is a no-op', async (t) => {
  const w = fakeWorld(t, (s) => daemonCli(s, { wait: 'hang' }));   // the job's wait client is in flight
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root);
  const c = clock(t);
  await m.mineNow(); c.now += 61_000;
  const pass = m.mineNow();
  await until(() => w.spawns.some((s) => verb(s) === `daemon wait ${JOB}`));
  const mine = w.spawns.find((s) => verb(s) === `daemon wait ${JOB}`);
  const before = w.spawns.length;
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
  await tick();
  assert.equal(w.spawns.length, before, 'after quit, nothing new is spawned (no status probe, no retry)');
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
  let mineCalls = 0;
  const realMine = m.mineAgent.bind(m);
  m.mineAgent = (...a) => { mineCalls += 1; return realMine(...a); };
  t.after(() => assert.equal(mineCalls, 0, 'a stopped manager never even starts a mine'));
  m.stop();
  await m.mineNow();
  await m.maybeRebuildPalace();
  assert.equal(w.spawns.length, 0);
});

// ── (1) rebuild vs mines ────────────────────────────────────────────────────

/** A repair-status report in the REAL 3.7.1 layout (see test/fixtures/mempalace), with chosen counts. */
function statusOut(counts) {
  return Object.entries(counts).map(([k, n]) => `  [${k}]
    sqlite count:   ${n.toLocaleString('en-US')}
    hnsw count:     ${n}
    status:         OK
`).join(String.fromCharCode(10));
}

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
  m.runRaw = async (_bin, args) => { if (args.includes('repair-status')) { await gate; return { ok: true, output: statusOut({ drawers: 999999 }) }; } return { ok: false, output: '' }; };
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
  fakeWorld(t, (s) => daemonCli(s));
  const root = home(t);
  const palace = bloatedPalace(root);
  const m = manager(t, root);
  const c = clock(t);
  m.mineState = { version: 1, entries: { old: { size: 1, sha256: 'o', mtimeMs: 1, minedAt: c.now - 1000 } } };
  m.runRaw = async (_b, args) => {
    if (args.includes('repair-status')) return { ok: true, output: statusOut({ drawers: 1, closets: 0 }) };
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
