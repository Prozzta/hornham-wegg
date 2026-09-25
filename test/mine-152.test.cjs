'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const miner = loadTs('src/main/incrementalMiner.ts');
const rebuild = loadTs('src/main/palaceRebuild.ts');
const { MemoryManager } = loadTs('src/main/memory.ts');

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-152-'));
  fs.mkdirSync(path.join(root, 'hive', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hive', 'registry.json'), JSON.stringify({ agents: {} }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function agent(root, id, body) {
  const dir = path.join(root, 'hive', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), body);
  return dir;
}

test('thirty one-minute memory appends cost a few debounced jobs, bounded by the max wait and the per-agent cap', async (t) => {
  const root = home(t);
  const dir = agent(root, 'live', '0\n');
  const memory = new MemoryManager(() => root, () => ({ enabled: true, model: 'minilm' }));
  memory.bin = () => 'mempalace';
  let jobs = 0;
  memory.mineAgent = async () => { jobs += 1; return true; };
  let now = 1_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; memory.stop(); });

  for (let i = 0; i < 30; i++) {
    fs.appendFileSync(path.join(dir, 'memory.md'), `${i}\n`);
    await memory.mineNow();
    now += 60_000;
  }
  // MINE-152 blocker (4): the quiet window no longer restarts forever. A stream that never
  // goes quiet is mined 10 min after its first change, then at most once per 10 min.
  assert.ok(jobs >= 1 && jobs <= 3, `30 minutes of appends: ${jobs} jobs (0 was starvation; one per append was churn)`);
});

test('archived agents are never queued and persisted fingerprints survive restart', async (t) => {
  const root = home(t);
  agent(root, 'archived', 'old');
  agent(root, 'live', 'new');
  fs.writeFileSync(path.join(root, 'hive', 'registry.json'), JSON.stringify({ agents: { archived: { archived: true }, live: {} } }));
  let now = 1_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const first = new MemoryManager(() => root, () => ({ enabled: true, model: 'minilm' }));
  first.bin = () => 'mempalace';
  const mined = [];
  first.mineAgent = async (_dir, id) => { mined.push(id); return true; };
  await first.mineNow();
  now += 60_000;
  await first.mineNow();
  assert.deepEqual(mined, ['live']);
  assert.ok(fs.existsSync(miner.mineStatePath(root)), 'successful fingerprint is durable');
  for (let i = 0; i < 30; i++) {
    now += 60_000;
    await first.mineNow();
  }
  assert.deepEqual(mined, ['live'], 'unchanged scans submit no more jobs, so they cannot grow the index');

  const restarted = new MemoryManager(() => root, () => ({ enabled: true, model: 'minilm' }));
  restarted.bin = () => 'mempalace';
  restarted.mineAgent = async () => assert.fail('unchanged memory must not mine after restart');
  now += 120_000;
  await restarted.mineNow();
});

test('fingerprints ignore timestamp-only changes, while content changes reset debounce', (t) => {
  const root = home(t);
  const file = path.join(root, 'memory.md');
  fs.writeFileSync(file, 'same');
  const one = miner.fingerprintMemory(file);
  const pending = new Map();
  miner.queueChangedMemory(pending, 'a', one, 0, 60_000);
  miner.queueChangedMemory(pending, 'a', one, 30_000, 60_000);
  assert.deepEqual(miner.readyMineIds(pending, 60_000), ['a']);
  fs.writeFileSync(file, 'changed');
  const two = miner.fingerprintMemory(file);
  miner.queueChangedMemory(pending, 'a', two, 60_000, 60_000);
  assert.deepEqual(miner.readyMineIds(pending, 60_000), []);
});

test('bloat threshold and staged swap are safe, reversible filesystem operations', (t) => {
  assert.equal(rebuild.rebuildNeeded(562 * 1024 * 1024, 3795), true, 'the observed 562MB/3795 palace crosses 10x');
  assert.equal(rebuild.rebuildNeeded(6 * 1024 * 1024, 3795), false, 'a compact ~6MB palace is left alone');
  assert.equal(rebuild.repairStatusEmbeddingCount('SQLite embeddings: 3,795\nHNSW: 3795'), 3795);
  const root = home(t);
  const palace = path.join(root, 'palace');
  const staged = `${palace}.stage`;
  const backup = `${palace}.backup`;
  fs.mkdirSync(palace); fs.writeFileSync(path.join(palace, 'old'), 'old');
  fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'new'), 'new');
  assert.equal(rebuild.swapStagedPalace(palace, staged, backup), true);
  assert.equal(fs.readFileSync(path.join(palace, 'new'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(backup, 'old'), 'utf8'), 'old', 'old palace is retained, never deleted');
});

test('watchdog policy is a 60-second no-progress daemon-stop backoff, while first boot gets grace', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory.ts'), 'utf8');
  assert.match(source, /const MINE_WATCHDOG_MS = 60_000/);
  assert.match(source, /const args = \['mine', agentDir, '--wing', id, '--agent', id\]/);
  assert.match(source, /this\.stopDaemon\(\)/);
  assert.match(source, /PRIORITY_BELOW_NORMAL/);
  assert.match(source, /let lastProgress = Date\.now\(\)/);
  assert.match(source, /DAEMON_STARTUP_TIMEOUT_MS = 10 \* 60_000/);
  assert.match(source, /if \(!watchedOut && daemon\) this\.stopDaemon\(\)/);
  assert.match(source, /code === 2 && \/\(\?:invalid choice\|unrecognized arguments\|daemon\)\/i\.test\(err\)/);
  assert.match(source, /MemPalace has no daemon: using one-shot mining/);
  assert.match(source, /DAEMON_RETRY_MS = 30 \* 60_000/);
  assert.match(source, /return this\.daemonUnavailable \? this\.mineOneShot\(agentDir, id\) : false/);
  assert.match(source, /if \(daemon\) args\.push\('--daemon'\)/);
});
