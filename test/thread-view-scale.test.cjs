/* THREAD-VIEW opt-in release-scale measurement.
 * Command: THREAD_VIEW_SCALE=1 node --test test/thread-view-scale.test.cjs
 * It compiles only the private store and starts the tail worker directly: no
 * Electron, real userData, hive, or installed app is touched. The opt-in guard
 * keeps its 50 MiB writes and host-sensitive timing assertions out of default
 * test globs and full suites. The 180s timeout leaves headroom above the
 * measured bounded catch-up stream, not an arbitrary unlimited allowance. */
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
const CHUNK_BYTES = 64 * 1024;
// N2: declared before execution. v1.1.52's recorded max was about 64 ms;
// this isolated Node gate permits 20 ms of host scheduling noise.
const BASELINE_MAX_MS = 64;
const NOISE_ALLOWANCE_MS = 20;
const LOOP_CEILING_MS = BASELINE_MAX_MS + NOISE_ALLOWANCE_MS;

function loadStore(dir) {
  const output = path.join(dir, 'threadView.cjs');
  const compiled = ts.transpileModule(read('src/main/threadView.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  fs.writeFileSync(output, compiled);
  return require(output);
}

function p95(rows) { return rows[Math.min(rows.length - 1, Math.ceil(rows.length * 0.95) - 1)]; }
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function claudeAssistantLine(n) {
  const prefix = `{"type":"assistant","timestamp":${Date.now()},"message":{"content":"`;
  const suffix = `","n":${n}}}`;
  return prefix + 'x'.repeat(CHUNK_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix) - 1) + suffix + '\n';
}

async function measure(action) {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const started = performance.now();
  await action();
  await immediate();
  delay.disable();
  return {
    elapsedMs: performance.now() - started,
    p99Ms: delay.percentile(99) / 1e6,
    maxMs: delay.max / 1e6
  };
}

function serialise(measurement) {
  return Object.fromEntries(Object.entries(measurement).map(([key, value]) => [key, Number(value.toFixed(3))]));
}

if (process.env.THREAD_VIEW_SCALE !== '1') {
  test('THREAD-VIEW release scale is opt-in', { skip: 'Set THREAD_VIEW_SCALE=1; the gate writes a temp 50 MiB fixture.' }, () => {});
} else test('THREAD-VIEW release scale: real 50 MiB worker stream plus 300-agent churn', { timeout: 180_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-thread-view-scale-'));
  const userData = path.join(temp, 'userData');
  const source = path.join(temp, 'provider.jsonl');
  const storeModule = loadStore(temp);
  const store = new storeModule.ThreadViewStore(path.join(userData, 'threads'));
  await store.init();
  const worker = new Worker(path.join(root, 'src', 'main', 'thread-tail-worker.cjs'));
  const batches = [];
  let ingested = Promise.resolve();
  let waiter;
  let waitTarget = 0;
  worker.on('message', (message) => {
    if (message?.type === 'lines' && typeof message.batchMs === 'number') {
      batches.push(message.batchMs);
      // This is the production main-path work: receipt check plus normalized
      // append, not merely receipt of an arbitrary 64 KiB worker payload.
      ingested = ingested.then(async () => {
        for (const line of message.lines) await store.ingestClaudeLine('michael', line);
      });
      void ingested.then(() => { if (waiter && batches.length >= waitTarget) { const resolve = waiter; waiter = undefined; resolve(); } });
    }
  });
  const nextBatch = (target) => new Promise((resolve) => { waitTarget = target; waiter = resolve; });
  try {
    assert.ok(path.resolve(userData).startsWith(path.resolve(os.tmpdir()) + path.sep), 'must use a temp userData root');
    const idle = await measure(async () => { await sleep(40); });
    await fsp.writeFile(source, '');
    const human = 'scale-human';
    store.recordReceipt('michael', human, 'human-terminal');
    await store.ingestClaudeLine('michael', JSON.stringify({ type: 'user', timestamp: Date.now(), message: { content: human } }));
    worker.postMessage({ type: 'source', source: { agentId: 'michael', provider: 'claude', file: source } });
    await sleep(20); // queue ordering establishes the worker's initial EOF cursor

    // Whole-window C1 monitor: begins with the first real source byte and ends
    // only after the orphan sweep returns. Per-phase monitors diagnose its cost.
    const whole = monitorEventLoopDelay({ resolution: 1 });
    whole.enable();
    const stream = await measure(async () => {
      for (let bytes = 0; bytes < FIXTURE_BYTES; bytes += CHUNK_BYTES) {
        await fsp.appendFile(source, claudeAssistantLine(bytes / CHUNK_BYTES));
        // The 500 ms timer can win this race; both paths share one cursor, so
        // the later poll is a harmless no-op and the line count remains exact.
      }
      const wait = nextBatch(FIXTURE_BYTES / CHUNK_BYTES);
      worker.postMessage({ type: 'poll' });
      await wait;
    });
    const workerP95 = p95([...batches].sort((a, b) => a - b));
    assert.equal(batches.length, FIXTURE_BYTES / CHUNK_BYTES, 'every 64 KiB source chunk reaches the worker');
    assert.ok(workerP95 < 10, `worker cumulative batch p95 ${workerP95.toFixed(2)}ms >= 10ms per 64 KiB chunk`);

    // Event text is capped at 64 KiB. Three valid events per agent make a
    // 50 MiB fixture under both the 8 MiB/agent and 128 MiB global caps.
    const eventsPerAgent = 3;
    const bytesEach = Math.ceil(FIXTURE_BYTES / (AGENTS * eventsPerAgent));
    const storePhase = await measure(async () => {
      for (let i = 0; i < AGENTS; i += 1) {
        for (let event = 0; event < eventsPerAgent; event += 1) {
          await store.append(`agent-${i}`, { speaker: 'human', source: 'human-ui', text: `${i}:${event}:${'x'.repeat(bytesEach - 32)}` });
        }
      }
    });
    const total = fs.readdirSync(path.join(userData, 'threads'))
      .filter((name) => /^agent-/.test(name))
      .reduce((sum, id) => sum + fs.statSync(path.join(userData, 'threads', id, 'active.jsonl')).size, 0);
    assert.ok(total >= FIXTURE_BYTES * 0.99, `stored ${total} bytes, expected near ${FIXTURE_BYTES}`);
    assert.ok(total <= storeModule.GLOBAL_CAP, 'fixture remains under the global cap; this does not exercise global pruning');

    const sweepStart = Date.now();
    for (let i = 0; i < AGENTS; i += 1) {
      const dir = path.join(userData, 'threads', `orphan-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest-v1.json'), '{}');
      fs.utimesSync(dir, new Date(sweepStart - 2_000), new Date(sweepStart - 2_000));
    }
    const sweep = await measure(async () => {
      const removed = await store.sweepOrphans((id) => id.startsWith('agent-') || id.endsWith('0'), sweepStart - 1_000);
      assert.equal(removed.length, 270, 'registered candidates remain while every other direct manifest orphan is removed');
    });
    await immediate();
    whole.disable();
    const wholeWindow = { elapsedMs: stream.elapsedMs + storePhase.elapsedMs + sweep.elapsedMs, p99Ms: whole.percentile(99) / 1e6, maxMs: whole.max / 1e6 };
    for (const [name, result] of Object.entries({ stream, store: storePhase, sweep, whole: wholeWindow })) {
      assert.ok(result.maxMs <= LOOP_CEILING_MS, `${name} loop max ${result.maxMs.toFixed(2)}ms exceeds ${LOOP_CEILING_MS}ms`);
    }
    console.log(JSON.stringify({
      fixtureBytes: total, streamBytes: FIXTURE_BYTES, chunks: batches.length, agents: AGENTS,
      workerCumulativeBatchP95Ms: Number(workerP95.toFixed(3)), baselineMaxMs: BASELINE_MAX_MS,
      noiseAllowanceMs: NOISE_ALLOWANCE_MS, loopCeilingMs: LOOP_CEILING_MS,
      idle: serialise(idle), stream: serialise(stream), store: serialise(storePhase), sweep: serialise(sweep), whole: serialise(wholeWindow)
    }));
  } finally {
    await worker.terminate();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
