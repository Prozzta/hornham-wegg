/* THREAD-VIEW release-scale measurement.  It deliberately compiles only the
 * private store and starts the tail worker directly: no Electron, real userData,
 * hive, or installed app is touched. Run standalone, not in the default suite. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const MIB = 1024 * 1024;
const AGENTS = 300;
const FIXTURE_BYTES = 50 * MIB;
// N2: declared before execution. v1.1.52's recorded max was about 64 ms;
// this isolated Node gate permits 20 ms of host scheduling noise.
const BASELINE_MAX_MS = 64;
const NOISE_ALLOWANCE_MS = 20;

function loadStore(dir) {
  const output = path.join(dir, 'threadView.cjs');
  const compiled = ts.transpileModule(read('src/main/threadView.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  fs.writeFileSync(output, compiled);
  return require(output);
}

function p95(rows) { return rows[Math.min(rows.length - 1, Math.ceil(rows.length * 0.95) - 1)]; }

test('THREAD-VIEW release scale: 64 KiB worker batches plus 50 MiB / 300-agent churn', { timeout: 120_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-thread-view-scale-'));
  const userData = path.join(temp, 'userData');
  const source = path.join(temp, 'provider.jsonl');
  const storeModule = loadStore(temp);
  const delay = monitorEventLoopDelay({ resolution: 1 });
  const worker = new Worker(path.join(root, 'src', 'main', 'thread-tail-worker.cjs'));
  const batches = [];
  let waiter;
  worker.on('message', (message) => {
    if (message?.type === 'lines' && typeof message.batchMs === 'number') {
      batches.push(message.batchMs);
      if (waiter) { const resolve = waiter; waiter = undefined; resolve(); }
    }
  });
  const nextBatch = () => new Promise((resolve) => { waiter = resolve; });
  try {
    assert.ok(path.resolve(userData).startsWith(path.resolve(os.tmpdir()) + path.sep), 'must use a temp userData root');
    await fsp.writeFile(source, '');
    worker.postMessage({ type: 'source', source: { agentId: 'michael', provider: 'claude', file: source } });
    await new Promise((resolve) => setTimeout(resolve, 550)); // worker establishes EOF cursor
    for (let i = 0; i < 20; i += 1) {
      const wait = nextBatch();
      await fsp.appendFile(source, JSON.stringify({ type: 'assistant', n: i, text: 'x'.repeat(60 * 1024) }) + '\n');
      await wait;
    }
    const workerP95 = p95([...batches].sort((a, b) => a - b));
    assert.ok(workerP95 < 10, `worker p95 ${workerP95.toFixed(2)}ms >= 10ms per 64 KiB batch`);

    delay.enable();
    const store = new storeModule.ThreadViewStore(path.join(userData, 'threads'));
    await store.init();
    // Event text is deliberately capped at 64 KiB in production. Spread the
    // fixture across three valid events per agent instead of measuring a path
    // the store is designed to truncate.
    const eventsPerAgent = 3;
    const bytesEach = Math.ceil(FIXTURE_BYTES / (AGENTS * eventsPerAgent));
    const start = performance.now();
    for (let i = 0; i < AGENTS; i += 1) {
      for (let event = 0; event < eventsPerAgent; event += 1) {
        await store.append(`agent-${i}`, { speaker: 'human', source: 'human-ui', text: `${i}:${event}:${'x'.repeat(bytesEach - 32)}` });
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    delay.disable();
    const elapsedMs = performance.now() - start;
    const total = [...fs.readdirSync(path.join(userData, 'threads'))]
      .filter((name) => /^agent-/.test(name))
      .reduce((sum, id) => sum + fs.statSync(path.join(userData, 'threads', id, 'active.jsonl')).size, 0);
    assert.ok(total >= FIXTURE_BYTES * 0.99, `stored ${total} bytes, expected near ${FIXTURE_BYTES}`);
    assert.ok(total <= storeModule.GLOBAL_CAP, '50 MiB fixture must stay below global cap');

    const sweepStart = Date.now();
    for (let i = 0; i < AGENTS; i += 1) {
      const dir = path.join(userData, 'threads', `orphan-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest-v1.json'), '{}');
      fs.utimesSync(dir, new Date(sweepStart - 2_000), new Date(sweepStart - 2_000));
    }
    const removed = await store.sweepOrphans((id) => id.startsWith('agent-') || id.endsWith('0'), sweepStart - 1_000);
    assert.equal(removed.length, 270, 'registered candidates remain while every other direct manifest orphan is removed');
    assert.ok(delay.max / 1e6 <= BASELINE_MAX_MS + NOISE_ALLOWANCE_MS, `main-loop max ${(delay.max / 1e6).toFixed(2)}ms exceeds baseline + ${NOISE_ALLOWANCE_MS}ms`);
    console.log(JSON.stringify({ fixtureBytes: total, agents: AGENTS, workerP95Ms: Number(workerP95.toFixed(3)), storeElapsedMs: Number(elapsedMs.toFixed(3)), loopP99Ms: Number((delay.percentile(99) / 1e6).toFixed(3)), loopMaxMs: Number((delay.max / 1e6).toFixed(3)), baselineMaxMs: BASELINE_MAX_MS, noiseAllowanceMs: NOISE_ALLOWANCE_MS }));
  } finally {
    delay.disable();
    await worker.terminate();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
