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

test('one debounced daemon job covers thirty one-minute memory appends', async (t) => {
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
  assert.equal(jobs, 0, 'each fresh append resets the quiet window before any job is submitted');
  await memory.mineNow();
  assert.equal(jobs, 1, 'exactly one mature job reaches the daemon');
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

test('watchdog policy is a 60-second daemon-stop backoff, never the old ten-minute wait', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'memory.ts'), 'utf8');
  assert.match(source, /const MINE_WATCHDOG_MS = 60_000/);
  assert.match(source, /\['mine', agentDir, '--wing', id, '--agent', id, '--daemon'\]/);
  assert.match(source, /this\.stopDaemon\(\)/);
  assert.match(source, /PRIORITY_BELOW_NORMAL/);
});
