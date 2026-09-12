'use strict';
/**
 * L0-VAL - the L0-SEM §12 tracker-heap measurement harness.
 *
 * NOT PART OF THE TEST SUITE, deliberately: it lives outside test/*.test.cjs so it
 * cannot move a test count, and it needs --expose-gc, which the suite does not pass.
 * It is committed because a reported number nobody can reproduce is an anecdote.
 *
 *   hive-node --expose-gc test/tools/capacity-heap-probe.cjs <repo-root> alone|snap|structured
 *
 * ONE ARM PER PROCESS. §12 asks for a disposable process with an EMPTY-TRACKER baseline
 * against the MAXIMAL VALID retained-state fixture, forced GC, and the range over at
 * least five runs. Running the three arms in ONE process reported 241,796-264,092 bytes;
 * one arm per process reports 295,028-316,656. The in-process figures were ~20% LOW,
 * because arms 2 and 3 measured against a warm, fragmented heap arm 1 never saw. A
 * spread that looks like noise can be an ordering artefact.
 *
 * NO production heap sampling is added and NO size estimator is written. The number is
 * process.memoryUsage().heapUsed after a forced collection - V8's own accounting - and
 * an assumed size presented as a measurement would be worse than an honest gap.
 *
 * EVERY ARM CARRIES A RECLAIM CONTROL, and it failed three times before it passed:
 *   1. the published snapshot held in a local        308,640 delta / 5,488 reclaimed
 *   2. moved into a { } block, still reachable via the module context   same failure
 *   3. a real function scope, nulled inside the frame   ~316,000 / ~7,000 reclaimed
 * Nulling a local inside a frame still on the stack proves nothing about reachability,
 * so the release happens in the CALLER after the measuring frame RETURNS. A delta whose
 * memory does not come back was never the thing being measured - and each of those three
 * attempts would have published a number.
 */
const WT = process.argv[2];
process.chdir(WT);

const v8 = require('v8');
const vm = require('vm');
v8.setFlagsFromString('--expose_gc');
const gcOnce = global.gc || vm.runInNewContext('gc');
const settle = () => { for (let i = 0; i < 8; i++) gcOnce(); };
const used = () => process.memoryUsage().heapUsed;

const loadTs = require(WT + '/test/load-ts.cjs');
const { ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS } = loadTs('src/main/providerCapacityTracker.ts');
const { T0, win, obs } = require(WT + '/test/fixtures/capacity-corpus.cjs');

/**
 * `structured` maximises OBJECT COUNT as well as bytes: 16 windows, the per-pool cap.
 * One long ASCII string is the FRIENDLIEST possible case for heap - V8 stores ASCII
 * one byte per character - so measuring only that would flatter the result. A realistic
 * maximal pool is many small objects, which costs far more per serialized byte.
 */
function sizedTo(key, scope, bytes, structured) {
  const windows = structured
    ? Array.from({ length: RETENTION_CAPS.maxWindowsPerPool },
        (_, i) => win({ windowId: 'w' + i, kind: 'OTHER', windowMinutes: 60 + i }))
    : [win()];
  let pad = 0;
  for (let guard = 0; guard < 64; guard++) {
    const o = obs({
      poolKey: key, accountScope: scope, observedAt: T0, receivedAt: T0,
      windows, planType: 'z'.repeat(pad)
    });
    const n = JSON.stringify(o).length;
    if (n === bytes) return o;
    if (n > bytes) throw new Error('cannot size below ' + n);
    pad += bytes - n;
  }
  throw new Error('sizing did not converge');
}

/**
 * Build the MAXIMAL VALID retained state and return the delta plus, optionally, the
 * live objects so the caller can decide when they die. Nothing here measures reclaim.
 */
function build(holdSnapshot, structured) {
  const now = T0;
  const mono = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  settle();
  const base = used();
  let serialized = 0;
  for (let i = 0; i < RETENTION_CAPS.maxPools; i++) {
    const o = sizedTo('codex:acct-' + i + ':limit-1', 'acct-' + i, RETENTION_CAPS.maxPoolBytes, structured);
    serialized += JSON.stringify(o).length;
    tracker.ingest(o);
  }
  const s = tracker.snapshot();
  const pools = s.pools.length;
  const unknown = s.pools.filter((p) => p.state === 'UNKNOWN').length;
  const keep = { tracker, snapshot: holdSnapshot ? s : null };
  settle();
  return { base, delta: used() - base, serialized, pools, unknown, keep };
}

/** Run one arm: build, then release in the CALLER and require the memory back. */
function arm(holdSnapshot, structured) {
  let r = build(holdSnapshot, structured);
  const { base, delta, serialized, pools, unknown } = r;
  const before = used();
  r = null; // the only reference to `keep`, released OUTSIDE the building frame
  settle();
  return { base, delta, serialized, pools, unknown, reclaimed: before - used() };
}

// ONE ARM PER PROCESS, which is what "a disposable process with an empty-tracker
// baseline" actually requires: running three arms in one process gives arms 2 and 3 a
// warm, fragmented heap that arm 1 never saw, and that difference would show up as a
// spread I might have read as measurement noise.
const which = process.argv[3];
const ARMS = { alone: [false, false], snap: [true, false], structured: [true, true] };
const r = arm(...ARMS[which]);
console.log(JSON.stringify({ arm: which, serialized: r.serialized, pools: r.pools,
  unknown: r.unknown, delta: r.delta, reclaimed: r.reclaimed }));
const alone = r, withSnap = r, structured = r;

