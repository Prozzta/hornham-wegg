/* THREAD-VIEW opt-in release-scale measurement.
 * Command: THREAD_VIEW_SCALE=1 node --test test/thread-view-scale.test.cjs
 * It compiles only the private store and starts the tail worker directly: no
 * Electron, real userData, hive, or installed app is touched. The opt-in guard
 * keeps its writes and host-sensitive timing assertions out of default test
 * globs and full suites. `micro` is the 100-chunk preflight; `1` is the
 * separately authorised 50 MiB run. The 600s timeout has abort cleanup and
 * is measured-headroom for bounded 1 MiB/tick catch-up, not an unlimited run. */
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
const CHUNK_BYTES = 64 * 1024;
const FULL_CHUNKS = (50 * MIB) / CHUNK_BYTES;
const MICRO_CHUNKS = 100;
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

function claudeLine(type, n, label) {
  const prefix = `{"type":"${type}","timestamp":${Date.now()},"message":{"content":"`;
  const suffix = `","n":${n}}}`;
  const text = label + 'x'.repeat(CHUNK_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(label) - Buffer.byteLength(suffix) - 1);
  return { line: prefix + text + suffix + '\n', text };
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

const scaleMode = process.env.THREAD_VIEW_SCALE;
if (scaleMode !== '1' && scaleMode !== 'micro') {
  test('THREAD-VIEW release scale is opt-in', { skip: 'Set THREAD_VIEW_SCALE=micro for 100 chunks, or =1 for the separately authorised 50 MiB run.' }, () => {});
} else {
  const chunks = scaleMode === 'micro' ? MICRO_CHUNKS : FULL_CHUNKS;
  const fixtureBytes = chunks * CHUNK_BYTES;
  test(`THREAD-VIEW ${scaleMode === 'micro' ? 'micro' : 'release'} scale: ${chunks} worker chunks plus 300-agent churn`, { timeout: 600_000 }, async (t) => {
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
  const abort = () => new Promise((_, reject) => {
    if (t.signal.aborted) return reject(t.signal.reason ?? new Error('scale test aborted'));
    t.signal.addEventListener('abort', () => reject(t.signal.reason ?? new Error('scale test aborted')), { once: true });
  });
  const throwIfAborted = () => { if (t.signal.aborted) throw (t.signal.reason ?? new Error('scale test aborted')); };
  try {
    assert.ok(path.resolve(userData).startsWith(path.resolve(os.tmpdir()) + path.sep), 'must use a temp userData root');
    const idle = await measure(async () => { await sleep(40); });
    await fsp.writeFile(source, '');
    worker.postMessage({ type: 'source', source: { agentId: 'michael', provider: 'claude', file: source } });
    await sleep(20); // queue ordering establishes the worker's initial EOF cursor

    // Whole-window C1 monitor: begins with the first real source byte and ends
    // only after the orphan sweep returns. Per-phase monitors diagnose its cost.
    const whole = monitorEventLoopDelay({ resolution: 1 });
    whole.enable();
    const stream = await measure(async () => {
      const writer = await fsp.open(source, 'a');
      try {
        for (let n = 0; n < chunks; n += 1) {
          throwIfAborted();
          // Each 20-row window has one Human input, one admitted reply, a
          // machine nudge that closes admission, and 17 non-admitted replies.
          // Thus the full 50 MiB fixture has 40 admitted replies (~2.5 MiB)
          // and 95% rows that do not reach private Talk storage.
          const slot = n % 20;
          const row = slot === 0 ? claudeLine('user', n, `scale-human-${n}:`)
            : slot === 2 ? claudeLine('user', n, `scale-machine-nudge-${n}:`)
            : claudeLine('assistant', n, `scale-assistant-${n}:`);
          if (slot === 0) store.recordReceipt('michael', row.text, 'human-terminal');
          await writer.write(row.line);
          if ((n + 1) % 100 === 0) console.log(JSON.stringify({ phase: 'stream-write', chunks: n + 1 }));
        }
      } finally { await writer.close(); }
      const wait = nextBatch(chunks);
      worker.postMessage({ type: 'poll' });
      await Promise.race([wait, abort()]);
    });
    const workerP95 = p95([...batches].sort((a, b) => a - b));
    assert.equal(batches.length, chunks, 'every 64 KiB source chunk reaches the worker');
    assert.ok(workerP95 < 10, `worker cumulative batch p95 ${workerP95.toFixed(2)}ms >= 10ms per 64 KiB chunk`);

    // Event text is capped at 64 KiB. Three valid events per agent make the
    // fixture fit under both the 8 MiB/agent and 128 MiB global caps.
    const eventsPerAgent = 3;
    const bytesEach = Math.ceil(fixtureBytes / (AGENTS * eventsPerAgent));
    const storePhase = await measure(async () => {
      for (let i = 0; i < AGENTS; i += 1) {
        for (let event = 0; event < eventsPerAgent; event += 1) {
          await store.append(`agent-${i}`, { speaker: 'human', source: 'human-ui', text: `${i}:${event}:${'x'.repeat(bytesEach - 32)}` });
        }
      }
    });
    let total = 0;
    for (const id of await fsp.readdir(path.join(userData, 'threads'))) {
      if (/^agent-/.test(id)) total += (await fsp.stat(path.join(userData, 'threads', id, 'active.jsonl'))).size;
    }
    assert.ok(total >= fixtureBytes * 0.99, `stored ${total} bytes, expected near ${fixtureBytes}`);
    assert.ok(total <= storeModule.GLOBAL_CAP, 'fixture remains under the global cap; this does not exercise global pruning');

    const sweepStart = Date.now();
    const orphanSetup = await measure(async () => {
      for (let i = 0; i < AGENTS; i += 1) {
        const dir = path.join(userData, 'threads', `orphan-${i}`);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'manifest-v1.json'), '{}');
        await fsp.utimes(dir, new Date(sweepStart - 2_000), new Date(sweepStart - 2_000));
      }
    });
    const sweep = await measure(async () => {
      const removed = await store.sweepOrphans((id) => id === 'michael' || id.startsWith('agent-') || id.endsWith('0'), sweepStart - 1_000);
      assert.equal(removed.length, 270, 'registered candidates remain while every other direct manifest orphan is removed');
    });
    await immediate();
    whole.disable();
    const wholeWindow = { elapsedMs: stream.elapsedMs + storePhase.elapsedMs + orphanSetup.elapsedMs + sweep.elapsedMs, p99Ms: whole.percentile(99) / 1e6, maxMs: whole.max / 1e6 };
    // Print measured phase data before enforcing the release gate so a failed
    // diagnostic capture still identifies which phase needs attention.
    console.log(JSON.stringify({
      mode: scaleMode, fixtureBytes: total, streamBytes: fixtureBytes, chunks: batches.length, agents: AGENTS,
      workerCumulativeBatchP95Ms: Number(workerP95.toFixed(3)), baselineMaxMs: BASELINE_MAX_MS,
      noiseAllowanceMs: NOISE_ALLOWANCE_MS, loopCeilingMs: LOOP_CEILING_MS,
      idle: serialise(idle), stream: serialise(stream), store: serialise(storePhase), orphanSetup: serialise(orphanSetup), sweep: serialise(sweep), whole: serialise(wholeWindow)
    }));
    for (const [name, result] of Object.entries({ stream, store: storePhase, orphanSetup, sweep, whole: wholeWindow })) {
      assert.ok(result.maxMs <= LOOP_CEILING_MS, `${name} loop max ${result.maxMs.toFixed(2)}ms exceeds ${LOOP_CEILING_MS}ms`);
    }
  } finally {
    await worker.terminate();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  });
}
