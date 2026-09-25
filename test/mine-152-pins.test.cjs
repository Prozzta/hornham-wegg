'use strict';

/**
 * MINE-152 X1 (Jim): the palace repair never ran, because repair-status was parsed with an
 * invented one-line format; real MemPalace 3.7.1 prints one block per collection. Plus the
 * pins for Oscar's original behaviours that no test held (Jim's M set): swap rollback and
 * guard, the staged count check, the failed-mine retry, the per-agent 10-minute cap, the
 * transient-start retry, the 30-minute re-probe, the archived skip, pass serialization,
 * and below-normal priority.
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
const rebuild = loadTs('src/main/palaceRebuild.ts');
const miner = loadTs('src/main/incrementalMiner.ts');
const { MemoryManager } = loadTs('src/main/memory.ts');

const FIX = path.join(__dirname, 'fixtures', 'mempalace');
const REAL = fs.readFileSync(path.join(FIX, 'repair-status-3.7.1.txt'), 'utf8');
const STAGED = fs.readFileSync(path.join(FIX, 'repair-status-3.7.1-staged.txt'), 'utf8');

let pid = 4_300_000;
function fakeWorld(t, script = (s) => s.proc.exit(0)) {
  const spawns = [], killed = [], prio = [];
  const realSpawn = cp.spawn, realSync = cp.spawnSync, realKill = procKill.hardKillTree, realPrio = os.setPriority;
  cp.spawn = (bin, args) => {
    const proc = new EventEmitter();
    proc.pid = ++pid; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => true;
    proc.exit = (code, stderr) => setImmediate(() => { if (stderr) proc.stderr.emit('data', Buffer.from(stderr)); proc.emit('close', code); });
    const rec = { args: [...args], proc };
    spawns.push(rec); script(rec);
    return proc;
  };
  cp.spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
  procKill.hardKillTree = (p) => killed.push(p);
  os.setPriority = (p, v) => prio.push([p, v]);
  t.after(() => { cp.spawn = realSpawn; cp.spawnSync = realSync; procKill.hardKillTree = realKill; os.setPriority = realPrio; });
  return { spawns, killed, prio };
}
function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-152p-'));
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
const verb = (s) => s.args.join(' ');

// ── X1: the real report ─────────────────────────────────────────────────────

test('X1: the REAL 3.7.1 repair-status is read per collection (sqlite count only)', () => {
  assert.deepEqual(rebuild.repairStatusCounts(REAL), { drawers: 3317, closets: 478 });
  assert.equal(rebuild.repairStatusEmbeddingCount(REAL), 3795);
  assert.deepEqual(rebuild.repairStatusCounts(STAGED), { drawers: 3317, closets: 478 }, 'a fresh rebuild: HNSW lags (3,000 / unflushed), sqlite is exact');
  assert.equal(rebuild.sameCollectionCounts(rebuild.repairStatusCounts(REAL), rebuild.repairStatusCounts(STAGED)), true);
});

test('X1: a changed, missing or extra collection fails the staged check; an unreadable report is null', () => {
  const real = rebuild.repairStatusCounts(REAL);
  assert.equal(rebuild.sameCollectionCounts(real, { drawers: 3317, closets: 477 }), false);
  assert.equal(rebuild.sameCollectionCounts(real, { drawers: 3317 }), false);
  assert.equal(rebuild.sameCollectionCounts(real, { drawers: 3317, closets: 478, extra: 1 }), false);
  assert.equal(rebuild.sameCollectionCounts(real, null), false);
  assert.equal(rebuild.repairStatusCounts('SQLite embeddings: 3,795\nHNSW: 3795'), null, 'the invented format is not the real one');
  assert.equal(rebuild.repairStatusCounts('MemPalace Repair -- Status\n  (no palace)'), null);
});

test('X1: dataLevel0Bytes sums EVERY segment (portable paths)', (t) => {
  const root = home(t);
  const palace = path.join(root, 'palace');
  for (const [seg, n] of [['a', 1000], ['b', 2500]]) { fs.mkdirSync(path.join(palace, seg), { recursive: true }); fs.writeFileSync(path.join(palace, seg, 'data_level0.bin'), Buffer.alloc(n)); }
  assert.equal(rebuild.dataLevel0Bytes(palace), 3500);
});

/** A bloated palace: one embedding against a 20 KB HNSW file. */
function bloated(root) {
  const palace = path.join(root, 'palace');
  fs.mkdirSync(path.join(palace, 'seg'), { recursive: true });
  fs.writeFileSync(path.join(palace, 'seg', 'data_level0.bin'), Buffer.alloc(20_000));
  fs.writeFileSync(path.join(palace, 'marker'), 'old');
  fs.writeFileSync(path.join(palace, 'mempalace_embedder.json'), JSON.stringify({ mempalace_drawers: { model_name: 'minilm', dimension: 0 } }));
  return palace;
}
const report = (counts) => REAL.replace('3,317', String(counts.drawers)).replace('  sqlite count:   478', `  sqlite count:   ${counts.closets}`);

/** Script the three repair calls; `stagedCounts` is what the staged palace reports. */
function repairScript(stagedCounts) {
  return (s) => {
    const v = verb(s);
    if (v.endsWith('repair-status')) {
      const palace = s.args[s.args.indexOf('--palace') + 1];
      const counts = palace.includes('mempalace-rebuild-') ? stagedCounts : { drawers: 1, closets: 0 };
      setImmediate(() => { s.proc.stdout.emit('data', Buffer.from(report(counts))); s.proc.emit('close', 0); });
      return;
    }
    if (s.args.includes('repair')) {
      fs.mkdirSync(s.args[s.args.indexOf('--palace') + 1], { recursive: true });
      fs.writeFileSync(path.join(s.args[s.args.indexOf('--palace') + 1], 'marker'), 'new');
    }
    s.proc.exit(0);
  };
}

test('X1: a bloated palace IS repaired: staged from sqlite, verified per collection, daemon stopped, swapped; the old one kept', async (t) => {
  const w = fakeWorld(t, repairScript({ drawers: 1, closets: 0 }));
  const root = home(t); const palace = bloated(root);
  const m = manager(t, root); quiet(t);
  await m.maybeRebuildPalace();
  const order = w.spawns.map(verb).map((v) => v.replace(/^--palace \S+ /, ''));
  assert.deepEqual(order.slice(0, 2), ['repair-status', 'repair --mode from-sqlite --source ' + palace + ' --yes --no-backup']);
  assert.equal(order[2], 'repair-status');
  assert.equal(order[3], 'daemon stop', 'the daemon is stopped before the swap (Windows cannot rename open files)');
  assert.equal(fs.readFileSync(path.join(palace, 'marker'), 'utf8'), 'new', 'the rebuilt palace is live');
  const backup = fs.readdirSync(root).find((n) => n.startsWith('palace.mempalace-backup-'));
  assert.ok(backup && fs.readFileSync(path.join(root, backup, 'marker'), 'utf8') === 'old', 'the previous palace is retained');
  assert.ok(fs.existsSync(path.join(palace, 'mempalace_embedder.json')), 'the rebuilt palace carries its embedder record');
});

test('M3: a staged palace whose counts differ is NOT swapped, and the staging copy is discarded', async (t) => {
  fakeWorld(t, repairScript({ drawers: 1, closets: 5 }));
  const root = home(t); const palace = bloated(root);
  const m = manager(t, root); quiet(t);
  await m.maybeRebuildPalace();
  assert.equal(fs.readFileSync(path.join(palace, 'marker'), 'utf8'), 'old', 'live palace untouched');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('palace.')), [], 'no staged or backup copy left behind');
});

test('M1: if the second rename fails, the first is undone (the live palace is restored)', (t) => {
  const root = home(t);
  const palace = bloated(root);
  const staged = path.join(root, 'staged'); fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'marker'), 'new');
  const backup = path.join(root, 'backup');
  const real = fs.renameSync; let n = 0;
  fs.renameSync = (a, b) => { n += 1; if (n === 2) throw new Error('EPERM'); return real(a, b); };
  t.after(() => { fs.renameSync = real; });
  assert.equal(rebuild.swapStagedPalace(palace, staged, backup), false);
  assert.equal(fs.readFileSync(path.join(palace, 'marker'), 'utf8'), 'old', 'rolled back');
  assert.equal(fs.existsSync(backup), false);
});

test('M2: the swap refuses when the palace or the staged copy is missing, or a backup already exists', (t) => {
  const root = home(t);
  const palace = bloated(root);
  const staged = path.join(root, 'staged'); fs.mkdirSync(staged);
  const backup = path.join(root, 'backup'); fs.mkdirSync(backup);
  const real = fs.renameSync; let renames = 0;
  fs.renameSync = (...a) => { renames += 1; return real(...a); };
  t.after(() => { fs.renameSync = real; });
  assert.equal(rebuild.swapStagedPalace(palace, staged, backup), false, 'backup exists');
  assert.equal(fs.readFileSync(path.join(palace, 'marker'), 'utf8'), 'old');
  fs.rmSync(backup, { recursive: true });
  assert.equal(rebuild.swapStagedPalace(path.join(root, 'nope'), staged, backup), false, 'no palace');
  assert.equal(rebuild.swapStagedPalace(palace, path.join(root, 'nope'), backup), false, 'no staged');
  assert.equal(fs.existsSync(backup), false);
  assert.equal(renames, 0, 'refused BEFORE touching anything (not merely because a rename failed)');
});

// ── the mine loop ───────────────────────────────────────────────────────────

test('M4: a failed mine is retried after MINE_RETRY_MS, and succeeds then', async (t) => {
  fakeWorld(t);
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root); const c = clock(t);
  let ok = false; const calls = [];
  m.mineAgent = async () => { calls.push(c.now); return ok; };
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.equal(calls.length, 1);
  assert.equal(m.pendingMines.get('a').quietUntil, c.now + 120_000, 'kept, and retried after 2 min');
  c.now += 119_000; await m.mineNow();
  assert.equal(calls.length, 1, 'not before the retry time');
  ok = true; c.now += 2_000; await m.mineNow();
  assert.equal(calls.length, 2);
  assert.ok(miner.loadMineState(root).entries.a);
});

test('M6: after a mine, a new change is mined no sooner than 10 minutes after it', async (t) => {
  fakeWorld(t);
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root); const c = clock(t);
  const calls = [];
  m.mineAgent = async () => { calls.push(c.now); return true; };
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  fs.appendFileSync(path.join(root, 'hive', 'agents', 'a', 'memory.md'), 'more');
  for (let i = 0; i < 12; i++) { c.now += 60_000; await m.mineNow(); }
  assert.equal(calls.length, 2);
  assert.ok(calls[1] - calls[0] >= 600_000, `second mine ${(calls[1] - calls[0]) / 60_000} min after the first`);
});

test('M7: a transient daemon-start failure (not a usage error) never switches to one-shot; the start is retried', async (t) => {
  const w = fakeWorld(t, (s) => { if (verb(s) === 'daemon start') s.proc.exit(1, 'boom'); else s.proc.exit(0); });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root); const c = clock(t); quiet(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  assert.equal(w.spawns.filter((s) => s.args[0] === 'mine').length, 0, 'no one-shot');
  assert.notEqual(m.status().miningMode, 'one-shot');
  c.now += 121_000; await m.mineNow();
  assert.equal(w.spawns.filter((s) => verb(s) === 'daemon start').length, 2, 'the start is retried');
});

test('M8: a CLI without a daemon is re-probed after 30 minutes (an in-session upgrade recovers)', async (t) => {
  const w = fakeWorld(t);
  const root = home(t);
  const m = manager(t, root); const c = clock(t); quiet(t);
  m.markDaemonUnavailable('no daemon');
  assert.equal(await m.ensureDaemon(), false);
  assert.equal(w.spawns.length, 0, 'inside the window: not re-probed');
  c.now += 30 * 60_000 + 1;
  assert.equal(await m.ensureDaemon(), true, 'the upgraded CLI starts its daemon');
  assert.deepEqual(w.spawns.map(verb), ['daemon start']);
  assert.equal(m.status().miningMode, 'daemon');
});

test('M9: an archived agent\'s memory is never queued', async (t) => {
  fakeWorld(t);
  const root = home(t); agent(root, 'gone', 'x'); agent(root, 'live', 'y');
  fs.writeFileSync(path.join(root, 'hive', 'registry.json'), JSON.stringify({ agents: { gone: { archived: true }, live: {} } }));
  const m = manager(t, root); clock(t);
  m.mineAgent = async () => true;
  await m.mineNow();
  assert.equal(m.pendingMines.has('gone'), false);
  assert.equal(m.pendingMines.has('live'), true);
});

test('M10: mine passes never overlap: a pass while one runs does nothing', async (t) => {
  fakeWorld(t);
  const root = home(t); agent(root, 'a', 'x'); agent(root, 'b', 'y');
  const m = manager(t, root); const c = clock(t);
  let release; const gate = new Promise((r) => { release = r; });
  let open = 0, maxOpen = 0;
  m.mineAgent = async () => { open += 1; maxOpen = Math.max(maxOpen, open); await gate; open -= 1; return true; };
  await m.mineNow(); c.now += 61_000;
  const first = m.mineNow();
  await new Promise((r) => setImmediate(r));
  await Promise.race([m.mineNow(), new Promise((r) => setTimeout(r, 50))]);
  assert.equal(maxOpen, 1);
  release(); await first;
});

test('M11: every mempalace process runs below normal priority (daemon start, mine, wait)', async (t) => {
  const w = fakeWorld(t, (s) => {
    if (s.args.includes('--background')) { setImmediate(() => { s.proc.stdout.emit('data', Buffer.from('Submitted daemon job abcdef0123456789 (mine)\n')); s.proc.emit('close', 0); }); return; }
    s.proc.exit(0);
  });
  const root = home(t); agent(root, 'a', 'x');
  const m = manager(t, root); const c = clock(t);
  await m.mineNow(); c.now += 61_000; await m.mineNow();
  const below = os.constants.priority.PRIORITY_BELOW_NORMAL;
  for (const name of ['daemon start', 'mine', 'daemon wait']) {
    const s = w.spawns.find((x) => verb(x).startsWith(name));
    assert.ok(s, `${name} spawned`);
    assert.ok(w.prio.some(([p, v]) => p === s.proc.pid && v === below), `${name} is below normal`);
  }
});

test('X1: the rebuilt palace keeps its embedder record when the model is the same (no "assuming the current model" warning); never a wrong one', (t) => {
  const root = home(t);
  const palace = path.join(root, 'palace'); const staged = path.join(root, 'staged');
  fs.mkdirSync(palace); fs.mkdirSync(staged);
  const rec = JSON.stringify({ mempalace_drawers: { model_name: 'minilm', dimension: 0 }, mempalace_closets: { model_name: 'minilm', dimension: 0 } });
  fs.writeFileSync(path.join(palace, rebuild.EMBEDDER_RECORD), rec);
  assert.equal(rebuild.carryEmbedderRecord(palace, staged, 'embeddinggemma'), false, 'a different model: not copied (the rebuild used the current one)');
  assert.equal(fs.existsSync(path.join(staged, rebuild.EMBEDDER_RECORD)), false);
  assert.equal(rebuild.carryEmbedderRecord(palace, staged, 'minilm'), true);
  assert.equal(fs.readFileSync(path.join(staged, rebuild.EMBEDDER_RECORD), 'utf8'), rec);
  fs.writeFileSync(path.join(staged, rebuild.EMBEDDER_RECORD), '{"own":1}');
  assert.equal(rebuild.carryEmbedderRecord(palace, staged, 'minilm'), false, 'never overwrites the staged palace\'s own record');
});
