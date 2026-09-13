'use strict';
/**
 * L0-VAL - the L0-SEM §12 tracker-heap measurement harness.
 *
 * NOT PART OF THE TEST SUITE, deliberately: it lives outside test/*.test.cjs so it
 * cannot move a test count, and it needs a forced GC, which the suite does not pass.
 * It is committed because a reported number nobody can reproduce is an anecdote.
 *
 *   hive-node --expose-gc test/tools/capacity-heap-probe.cjs <root> alone|snap|structured|noise
 *   hive-node            test/tools/capacity-heap-probe.cjs <root> report
 *
 * ==========================================================================
 * IT ASSERTS NOW, AND IT CAN SAY "I COULD NOT MEASURE THIS".
 * ==========================================================================
 * The audit found the previous version printing numbers that contradicted its own
 * comment and exiting zero either way - a green result that cannot go red, outside
 * the glob so nothing ever noticed. Chasing that produced something worse than a
 * stale comment, so read this before trusting any figure this file prints.
 *
 * THE OLD ESTIMATOR DOES NOT WORK, AND HERE IS THE MEASUREMENT THAT SHOWS IT.
 * `delta` is heapUsed after building minus heapUsed at an empty-tracker baseline.
 * Run the NOISE arm - identical work, every observation built and sized, NOTHING
 * ingested, so nothing is retained and the honest answer is zero:
 *     pools:0  delta: -554,360 / -2,871,312 / -2,657,680
 * THE NOISE FLOOR IS MULTI-MEGABYTE AND SIGNED, against a quantity of ~0.3 MB. And
 * the sign is not controlled by the subject: adding ONE env-var read inside the build
 * loop - retaining nothing - moved the delta from +322,104, byte-identical across
 * five runs, to -2,395,832. Byte-level reproducibility had made me confident in a
 * number that was reproducible AND confounded, which are not the same thing.
 * THAT IS WHY THE AUDIT SAW FIVE NEGATIVE RUNS PER ARM WHERE THIS MACHINE SAW FIVE
 * POSITIVE ONES. Neither environment was wrong; the estimator has no sign discipline.
 *
 * WHAT IS USABLE IS `reclaimed`: the heap that comes back when the tracker is
 * dropped, across a window in which nothing else is allocated. Same runs:
 *     with 32 maximal pools retained   281,128 / 375,712 / 417,424
 *     with nothing retained (noise)     12,776 /   8,424 / 171,552
 * The signal dominates and the sign is right, so `reclaimed` is what the target is
 * checked against and `delta` is kept only as a printed diagnostic. This is not a
 * comfortable margin - roughly 2-3x over the floor - and §12 predicted exactly that:
 * "heapUsed is process-wide and GC-sensitive; it cannot honestly enforce ownership
 * inside ProviderCapacityTracker." What follows is the measured demonstration of that
 * sentence, not a refutation of it.
 *
 * A WARM-UP BEFORE THE BASELINE IS THE OBVIOUS FIX AND IT IS WORSE. Measured: the
 * spread across five runs widens from 0 bytes to 245 KB, and a deliberately retained
 * 2 MiB string becomes INVISIBLE (delta 511,480, under target, exit 0). Recorded so
 * that the next person does not spend the afternoon I spent.
 *
 * NO ABSOLUTE RANGE IS CLAIMED HERE ANY MORE, and that is a withdrawal, not a
 * correction. This comment used to state 295,028-316,656 bytes as the result. That
 * figure cannot be carried in a committed comment across machines, Node builds and
 * allocator states - re-measured on the machine that produced it, it had already
 * drifted above its own stated top. What replaces it is a BOUND THE TOOL CHECKS
 * wherever it runs, plus dated numbers in the output.
 *
 * WHAT DOES SURVIVE IS THE RELATIVE FINDING, because a comparison within one run
 * reproduces where an absolute figure does not. Running the three arms in ONE process
 * read ~20% LOW against one arm per process: arms 2 and 3 measured against a warm,
 * fragmented heap arm 1 never saw. A spread that looks like noise can be an ordering
 * artefact. Hence ONE ARM PER PROCESS, and `report` spawns a fresh process per run.
 *
 * §12 ASKS FOR A RANGE OVER AT LEAST FIVE RUNS, so the tool does the five runs. The
 * previous version did one, and the range existed only in prose I typed after running
 * it by hand - the same gap as the stale comment, one level up.
 *
 * WHICH ARM IS MOST EXPENSIVE IS NOT PREDICTED, BECAUSE THE PREDICTION WAS WRONG.
 * This file used to argue that many small objects "cost far more per serialized byte"
 * than one long ASCII string. Measured, `structured` (16 windows, the per-pool cap)
 * costs LESS than `alone` (one window plus a long ASCII pad). So both shapes are
 * measured because which is worse is not obvious, and `report` takes the MAXIMUM
 * across arms, since a target must hold for the worst valid shape.
 *
 * NO production heap sampling is added and NO size estimator is written. The numbers
 * are process.memoryUsage().heapUsed - V8's own accounting - and an assumed size
 * presented as a measurement would be worse than an honest gap.
 *
 * THE RECLAIM CONTROL failed three times before it passed:
 *   1. the published snapshot held in a local        308,640 delta / 5,488 reclaimed
 *   2. moved into a { } block, still reachable via the module context   same failure
 *   3. a real function scope, nulled inside the frame   ~316,000 / ~7,000 reclaimed
 * Nulling a local inside a frame still on the stack proves nothing about reachability,
 * so the release happens in the CALLER after the measuring frame RETURNS. Each of
 * those three attempts would have published a number.
 *
 * EXIT CODES, because "over budget" and "I could not measure" are different answers
 * and printing one number for both is how this file went wrong in the first place:
 *   0  measured, within target
 *   1  a real finding: the fixture is not the maximal valid state, or the target is
 *      exceeded. §12: "report a failed target and choose structure reduction or a
 *      smaller serialized cap from the observed data."
 *   3  VOID: the method could not measure. Nothing is concluded about the tracker.
 *   2  usage.
 */
const WT = process.argv[2];
const which = process.argv[3];
const ARMS = { alone: [false, false], snap: [true, false], structured: [true, true], noise: [false, false] };
if (!WT || (which !== 'report' && !(which in ARMS))) {
  console.error('usage: capacity-heap-probe.cjs <repo-root> alone|snap|structured|noise|report');
  process.exit(2);
}
process.chdir(WT);

/** §12: "1 MiB is an isolated-Dev acceptance target for heap attributable to retained capacity state". */
const HEAP_TARGET_BYTES = 1024 * 1024;
const RUNS_PER_ARM = 5;
const MEASURED_ARMS = ['alone', 'snap', 'structured'];

if (which === 'report') {
  report();
} else {
  measure(which);
}

function measure(armName) {
  const v8 = require('v8');
  const vm = require('vm');
  v8.setFlagsFromString('--expose_gc');
  const gcOnce = global.gc || vm.runInNewContext('gc');
  const settle = () => { for (let i = 0; i < 8; i++) gcOnce(); };
  const used = () => process.memoryUsage().heapUsed;

  const loadTs = require(WT + '/test/load-ts.cjs');
  const { ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS } = loadTs('src/main/providerCapacityTracker.ts');
  const { T0, win, obs } = require(WT + '/test/fixtures/capacity-corpus.cjs');
  /** The NOISE arm does every byte of the same work and retains none of it. */
  const retain = armName !== 'noise';

  /**
   * `structured` maximises OBJECT COUNT as well as bytes: 16 windows, the per-pool
   * cap. `alone` is one window plus a long ASCII pad - the friendliest case for V8,
   * which stores ASCII one byte per character. See the header for why neither is
   * assumed to be the expensive one.
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
   * Build the MAXIMAL VALID retained state and return the delta plus the live objects
   * so the CALLER decides when they die. Nothing here measures reclaim.
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
      if (retain) tracker.ingest(o);
    }
    let s = tracker.snapshot();
    const pools = s.pools.length;
    const unknown = s.pools.filter((p) => p.state === 'UNKNOWN').length;
    const keep = { tracker, snapshot: holdSnapshot ? s : null };
    // THE LOCAL HAD TO GO, OR THE `snap` ARM COULD NOT DIFFER FROM `alone`. `s` was
    // still in scope when the delta was taken, so both arms held the published
    // snapshot and both printed the same number TO THE BYTE - a comparison between
    // two conditions that could not come out differently, invisible for the same
    // reason as everything else here: nothing asserted that the arms differ.
    if (!holdSnapshot) s = null;
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

  const r = arm(...ARMS[armName]);
  const caps = RETENTION_CAPS;
  console.log(JSON.stringify({ arm: armName, serialized: r.serialized, pools: r.pools,
    unknown: r.unknown, base: r.base, delta: r.delta, reclaimed: r.reclaimed }));

  // The fixture must be the state §12 names. A real number measured against the wrong
  // fixture is the failure mode this whole file exists to stop.
  const expectPools = retain ? caps.maxPools : 0;
  const fixture = [
    ['serialized collection is exactly the maximal valid size',
      r.serialized === caps.maxPools * caps.maxPoolBytes, `${r.serialized} != ${caps.maxPools * caps.maxPoolBytes}`],
    ['the expected pools are retained', r.pools === expectPools, `${r.pools} != ${expectPools}`],
    ['the fixture is VALID, not a breach fixture', r.unknown === 0, `${r.unknown} pools UNKNOWN`]
  ];
  const failed = fixture.filter(([, ok]) => !ok);
  for (const [name, , detail] of failed) console.error(`FAIL  ${name}  --  ${detail}`);
  if (failed.length) {
    console.error(`${failed.length} fixture check(s) FAILED. A measurement against the wrong fixture is not a measurement.`);
    process.exit(1);
  }
  if (!retain) process.exit(0); // the noise arm is a floor, not a verdict

  // VOID rather than FAIL: a heap that shrank while 32 maximal pools were retained
  // says the process moved under the measurement, and says nothing about the tracker.
  if (r.delta <= 0 || r.reclaimed <= 0) {
    console.error(`VOID  delta ${r.delta}, reclaimed ${r.reclaimed}: the heap did not grow while retaining 32 maximal pools.`);
    console.error('The measurement is confounded, NOT the tracker efficient. Nothing is concluded. See the header.');
    process.exit(3);
  }
  if (r.reclaimed >= HEAP_TARGET_BYTES) {
    console.error(`FAIL  reclaimed ${r.reclaimed} >= the §12 target of ${HEAP_TARGET_BYTES}.`);
    console.error('§12: report a failed target and choose structure reduction or a smaller serialized cap from the observed data.');
    process.exit(1);
  }
}

/**
 * §12's unit is a RANGE OVER AT LEAST FIVE RUNS, and a warm heap changes the answer,
 * so the five runs are five PROCESSES. The NOISE arm runs first and its result is a
 * precondition: if retaining nothing reclaims as much as retaining the maximal state,
 * this method cannot see the tracker and the report is VOID.
 */
function report() {
  const { spawnSync } = require('child_process');
  const run = (name) => {
    const r = spawnSync(process.execPath, ['--expose-gc', __filename, WT, name], { encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return { status: r.status, stderr: (r.stderr || '').trim(), row: line ? JSON.parse(line) : null };
  };

  const floorRuns = [];
  for (let i = 0; i < RUNS_PER_ARM; i++) {
    const r = run('noise');
    if (r.status !== 0 || !r.row) {
      console.error(`VOID  noise run ${i + 1}: exit ${r.status}\n${r.stderr || '(no stderr)'}`);
      process.exit(3);
    }
    floorRuns.push(Math.abs(r.row.reclaimed));
  }
  const floor = Math.max(...floorRuns);
  console.log(JSON.stringify({ arm: 'noise', runs: floorRuns.length, reclaimedFloor: floor }));

  const rows = [];
  let findings = 0;
  let voids = 0;
  for (const name of MEASURED_ARMS) {
    const got = [];
    for (let i = 0; i < RUNS_PER_ARM; i++) {
      const r = run(name);
      if (r.status === 3) { voids++; console.error(`VOID  ${name} run ${i + 1}\n${r.stderr}`); continue; }
      if (r.status !== 0 || !r.row) { findings++; console.error(`FAIL  ${name} run ${i + 1}: exit ${r.status}\n${r.stderr || '(no stderr)'}`); continue; }
      got.push(r.row.reclaimed);
    }
    if (got.length) {
      rows.push({ arm: name, runs: got.length, reclaimedMin: Math.min(...got), reclaimedMax: Math.max(...got) });
    }
  }
  for (const row of rows) console.log(JSON.stringify(row));

  const upper = rows.length ? Math.max(...rows.map((r) => r.reclaimedMax)) : null;
  const lower = rows.length ? Math.min(...rows.map((r) => r.reclaimedMin)) : null;
  console.log(JSON.stringify({ estimator: 'reclaimed', runsPerArm: RUNS_PER_ARM, noiseFloor: floor,
    lowerAcrossArms: lower, upperAcrossArms: upper, targetBytes: HEAP_TARGET_BYTES }));

  if (voids || upper === null) {
    console.error(`VOID  ${voids} run(s) could not be measured. Report no figure.`);
    process.exit(3);
  }
  // The floor is a precondition on the METHOD, so it voids rather than fails. Half is
  // the line: below that the quantity and its own noise are the same size.
  if (floor >= lower / 2) {
    console.error(`VOID  noise floor ${floor} is not small against the smallest measured ${lower}.`);
    console.error('Retaining nothing reclaims nearly as much as retaining the maximal state, so this method cannot see the tracker.');
    process.exit(3);
  }
  if (upper >= HEAP_TARGET_BYTES) {
    console.error(`FAILED TARGET: upper result ${upper} against ${HEAP_TARGET_BYTES}.`);
    console.error('§12: report a failed target and choose structure reduction or a smaller serialized cap from the observed data.');
    findings++;
  }
  if (findings) process.exit(1);
}
