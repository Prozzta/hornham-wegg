'use strict';
/**
 * L0-VAL - the L0-SEM §12/§15 tracker-heap acceptance harness.
 *
 * NOT PART OF THE TEST SUITE, deliberately: it lives outside test/*.test.cjs so it
 * cannot move a test count, and it needs a forced GC, which the suite does not pass.
 * It is committed because a reported number nobody can reproduce is an anecdote.
 *
 *   hive-node --expose-gc test/tools/capacity-heap-probe.cjs <root> <arm>
 *   hive-node            test/tools/capacity-heap-probe.cjs <root> report
 *
 *   arms: f1-pad f1-many f1-exh f2-pad f2-many f2-exh breach
 *         (+ "-control" on any of them)
 *
 * f1 is the PER-POOL-CEILING frontier and f2 the POOL-COUNT-CEILING frontier. The
 * names carry the frontier KIND and no count, because §18 derives the count.
 *
 * ==========================================================================
 * WHAT §15 REOPENED, AND WHY THE OLD NUMBERS ARE GONE
 * ==========================================================================
 * §12's original 32 x 8 KiB fixture is a BREACH fixture, not a maximal valid state, so
 * the 0.281-0.302 MiB discharge is withdrawn and so is the 243,056-267,928 reclaimed
 * range measured against it. §15 requires BOTH cap-valid frontier shapes, and neither
 * substitutes for the other "because serialized size does not prove V8 retained-size
 * ordering". The breach arm is kept as ADDITIONAL evidence and can discharge nothing.
 *
 * BOTH FRONTIERS ARE DERIVED AT RUN TIME, AND §18 IS WHY BOTH HAVE TO BE. §15's fixed
 * phrase "31 pools at the per-pool maximum" is SUPERSEDED: a cap-valid frontier is the
 * boundary of the INTERSECTION of every independent cap, including the derived timer-
 * growth reserve, for the particular shape family being measured.
 *   f1  PER-POOL CEILING:   every observation at the 8 KiB per-pool cap, then derive the
 *                           greatest pool count N <= 32 that stays valid. N+1 is proven
 *                           to breach whenever N < 32.
 *   f2  POOL-COUNT CEILING: hold 32 pools, then derive the largest per-pool size that
 *                           stays valid. The next byte is proven to breach.
 * N IS NOT 31 FOR EVERY FAMILY AND THAT IS THE POINT OF DERIVING IT. The corrected
 * 24-character finite-JSON-number premise widened the reserve (L0-FIX7, a82eaca5) and
 * the ceiling moved with it, so a family that fitted 31 maximal pools under the old
 * under-derived reserve may fit fewer now. A name or a constant encoding 31 would
 * silently measure the wrong fixture and report a number for it.
 *
 * VALID MEANS MORE THAN "WITHIN THE CAP". §18: a fixture with ANY pool replaced by a
 * breach sentinel is not a valid-state heap fixture even though every pool identity is
 * still present. So validity here is all three at once - every pool retained, NO pool
 * sentinelled, and the published collection PLUS ITS FULL RESERVE inside 256 KiB. The
 * reserve is in that sum deliberately: leaving it out measures a state the runtime
 * would not itself admit.
 *
 * THREE SHAPE FAMILIES AT EACH FRONTIER, AND THE REASON IS NOT SYMMETRY. For families
 * that pay on input for every byte they publish, padding to the same serialized size
 * makes the SERIALIZED frontier shape-independent - measured: one window plus a
 * 7,518-char pad and sixteen windows plus a 5,583-char pad both retain 8,114 bytes, and
 * both derive the same frontier 2 size of 7,952. So within those families the largest
 * fitting SIZE is unique while the SHAPE at that size is not, and a long ASCII string
 * and sixteen small objects are very different object graphs at identical byte counts.
 *
 * THAT SHAPE-INDEPENDENCE IS NOT GENERAL, AND `exh` IS THE COUNTEREXAMPLE: it derives
 * 7,936, sixteen bytes lower per pool, BECAUSE OUTPUT-ONLY BYTES ARE NOT CHARGED ON
 * INPUT. An earlier version of this comment stated the independence without that
 * qualification; the exhausted family falsified it. Every family therefore derives its
 * OWN frontier 2 size rather than inheriting one, and the MAXIMUM across families is
 * reported, which is strictly stronger than choosing.
 *
 * `exh` is the third family and it exists because of a gap in the first version of this
 * harness. `numericallyExhaustedWindowIds` is OUTPUT-ONLY - derived, present in the
 * projection, absent from the observation - so an exhausted reading publishes bytes that
 * cost NOTHING on input, so it reaches the ceiling on FEWER pools or SMALLER pools than
 * a family that pays on input for everything it publishes. Under the pre-L0-FIX7 reserve
 * that showed up as a tighter margin at the same 31 pools; under the corrected reserve it
 * can show up as a smaller derived N. EITHER WAY THE FIGURE IS DERIVED IN THE RUN AND
 * PRINTED - no margin or pool count from a superseded reserve is quoted here, because a
 * number measured correctly against the wrong ceiling is the exact failure this file has
 * already produced once. An acceptance pass whose coverage is knowingly incomplete,
 * excused by a residual note, is a "claim one notch stronger than its evidence" failure
 * in a quieter form: a residual is for what cannot be closed cheaply, not for what can.
 *
 * AND THE CLAIM IS NOT UPGRADED TO MATCH. Adding this family makes the coverage BETTER,
 * NOT COMPLETE. Adversarial fixtures elsewhere have reached tighter margins than
 * anything constructed here, and a sixteen-window exhausted fixture at the per-pool
 * maximum BREACHES and is therefore not a valid shape at all. THE WORST VALID SHAPE
 * REMAINS UNDERIVED, and finding it would need a derived maximum over legal shapes,
 * which is analysis nobody has done. So the printed wording is TIGHTEST VALID SHAPE
 * CONSTRUCTED and must never become "worst valid shape": an arm added and a claim
 * upgraded to match would be the same failure in the opposite direction, and harder to
 * catch precisely because the coverage genuinely improved.
 *
 * ==========================================================================
 * THE ESTIMATOR: `reclaimed`, NOT A BASELINE DIFFERENCE
 * ==========================================================================
 * `delta` - heapUsed after construction minus an empty-tracker baseline - DOES NOT
 * WORK, and the control arms are what prove it. A control does every byte of the same
 * construction and ingests NOTHING, so its honest delta is zero; it has measured
 * -554,360 / -2,871,312 / -2,657,680. The noise floor is multi-megabyte and SIGNED
 * against a quantity near 0.3 MB, and the sign is not controlled by the subject: adding
 * one env-var read inside the build loop, retaining nothing, moved a delta from
 * +322,104 byte-identical across five runs to -2,395,832. That is why the audit saw
 * five negative runs per arm where this machine saw five positive ones. Neither
 * environment was wrong. Byte-level reproducibility had made me confident in a number
 * that was reproducible AND confounded, which are not the same thing.
 *
 * So the estimator is `reclaimed`: the heap that comes back when the tracker and every
 * tracker-owned reference are released, across a window in which nothing else is
 * allocated. §12's own words predicted the failure - "heapUsed is process-wide and
 * GC-sensitive; it cannot honestly enforce ownership inside ProviderCapacityTracker" -
 * so what follows is the measured demonstration of that sentence, not a refutation.
 *
 * A WARM-UP BEFORE THE BASELINE IS THE OBVIOUS FIX AND IT IS WORSE: the five-run spread
 * widens from 0 bytes to 245 KB and a deliberately retained 2 MiB string becomes
 * INVISIBLE (under target, exit 0). Recorded so nobody re-spends that afternoon.
 *
 * NO ABSOLUTE RANGE IS CLAIMED IN THIS COMMENT. A committed comment cannot carry an
 * absolute heap figure across machines, Node builds and allocator states - the figure
 * that used to be here had already drifted above its own stated top on the machine that
 * produced it. Numbers live in the output, where they are dated.
 *
 * ONE ARM PER PROCESS. Three arms in one process read ~20% LOW, because arms 2 and 3
 * measured against a warm, fragmented heap arm 1 never saw. A spread that looks like
 * noise can be an ordering artefact. `report` spawns a fresh process per run.
 *
 * THE RECLAIM CONTROL failed three times before it passed:
 *   1. the published snapshot held in a local        308,640 delta / 5,488 reclaimed
 *   2. moved into a { } block, still reachable via the module context   same failure
 *   3. a real function scope, nulled inside the frame   ~316,000 / ~7,000 reclaimed
 * Nulling a local inside a frame still on the stack proves nothing about reachability,
 * so the release happens in the CALLER after the measuring frame RETURNS.
 *
 * WHAT A PASS MEANS, AT EXACTLY THE STRENGTH §15 ALLOWS: an EMPIRICAL ISOLATED-DEV
 * ACCEPTANCE PASS. Never a universal V8 or runtime bound, never a production
 * enforcement guarantee, and never a claim about any machine but the one that ran it.
 *
 * EXIT CODES, because "over budget" and "I could not measure" are different answers:
 *   0  measured, within target        1  a real finding (fixture wrong, or over target)
 *   3  VOID: the method could not measure. Nothing is concluded.      2  usage.
 */
const WT = process.argv[2];
const which = process.argv[3];

/** §12/§15: an isolated-Dev acceptance target for heap attributable to retained state. */
const HEAP_TARGET_BYTES = 1024 * 1024;
const RUNS_PER_ARM = 5;
/**
 * The two cap-VALID frontier KINDS §15 requires, across the three shape families §18
 * names. `breach` is extra evidence only and discharges nothing.
 */
const FAMILIES = ['pad', 'many', 'exh'];
const VALID_ARMS = [...FAMILIES.map((f) => `f1-${f}`), ...FAMILIES.map((f) => `f2-${f}`)];
const ALL_ARMS = [...VALID_ARMS, 'breach'];

const baseArm = typeof which === 'string' ? which.replace(/-control$/, '') : '';
if (!WT || (which !== 'report' && !ALL_ARMS.includes(baseArm))) {
  console.error(`usage: capacity-heap-probe.cjs <repo-root> report|${ALL_ARMS.join('|')}[-control]`);
  process.exit(2);
}
process.chdir(WT);

if (which === 'report') {
  report();
} else {
  measure(baseArm, which.endsWith('-control'));
}

function measure(arm, isControl) {
  const v8 = require('v8');
  const vm = require('vm');
  v8.setFlagsFromString('--expose_gc');
  const gcOnce = global.gc || vm.runInNewContext('gc');
  const settle = () => { for (let i = 0; i < 8; i++) gcOnce(); };
  const used = () => process.memoryUsage().heapUsed;

  const loadTs = require(WT + '/test/load-ts.cjs');
  const {
    ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS,
    TIMER_GROWTH_RESERVE_PER_POOL, TIMER_GROWTH_RESERVE_COLLECTION
  } = loadTs('src/main/providerCapacityTracker.ts');
  const { T0, win, obs } = require(WT + '/test/fixtures/capacity-corpus.cjs');
  const byteLen = (v) => JSON.stringify(v).length;

  /**
   * `pad` is one window plus a long ASCII planType - the friendliest case for V8, which
   * stores ASCII one byte per character. `many` is sixteen windows, the per-pool cap,
   * which maximises OBJECT COUNT at the same serialized size. Neither is assumed to be
   * the expensive one; see the header.
   */
  function sized(key, scope, bytes, shape) {
    // `exh`: one window read as numerically exhausted, so the OUTPUT-ONLY
    // numericallyExhaustedWindowIds list is non-empty and publishes bytes that cost
    // nothing on input. Sixteen exhausted windows are NOT offered: at the per-pool
    // maximum that fixture breaches, so it is not a valid shape to measure.
    const windows = shape === 'many'
      ? Array.from({ length: RETENTION_CAPS.maxWindowsPerPool },
          (_, i) => win({ windowId: 'w' + i, kind: 'OTHER', windowMinutes: 60 + i }))
      : shape === 'exh' ? [win({ usedPercent: 100, remainingPercent: 0 })]
        : [win()];
    let pad = 0;
    for (let guard = 0; guard < 200; guard++) {
      const o = obs({
        poolKey: key, accountScope: scope, observedAt: T0, receivedAt: T0,
        windows, planType: 'z'.repeat(pad)
      });
      const n = byteLen(o);
      if (n === bytes) return o;
      if (n > bytes) return null;
      pad += bytes - n;
    }
    throw new Error('sizing did not converge');
  }

  /**
   * Is `count` pools of `bytes` each a VALID state, in §18's sense rather than merely a
   * state the cap tolerates? Every pool actually retained - a dropped pool is a different
   * collection - and NO pool sentinelled, because §18 is explicit that surviving identity
   * is not enough and a sentinel discards the very content whose heap cost is being
   * measured.
   *
   * §18'S RESERVE CONDITION IS ASSERTED ON THE MEASURED FIXTURE, NOT EVALUATED HERE, AND
   * THE REASON IS A CONFOUND I PUT IN MYSELF. Serializing the collection inside the search
   * allocates a ~259 KB string on every probe, and the CONTROL arms run the identical
   * derivation - so the controls began reclaiming a quarter-megabyte that had nothing to
   * do with any retained state, and the separation the acceptance depends on collapsed on
   * five of six arms. The check itself is right and it is still made; it is made once, on
   * the fixture that is actually measured, AFTER the measuring window has closed. A
   * validity check that changes the measurement is not free, and this one cost a whole
   * report before the controls said so.
   */
  function validAt(count, bytes, shape) {
    const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => T0, () => 0);
    for (let i = 0; i < count; i++) {
      const o = sized(`codex:acct-${i}:limit-1`, `acct-${i}`, bytes, shape);
      if (!o) return false;
      t.ingest(o);
    }
    const s = t.snapshot();
    if (s.pools.length !== count) return false;
    return s.pools.filter((p) => p.state === 'UNKNOWN').length === 0;
  }

  /** The growth reserve the runtime charges for a collection of `count` pools. */
  function reserveFor(count) {
    return TIMER_GROWTH_RESERVE_PER_POOL * count + TIMER_GROWTH_RESERVE_COLLECTION;
  }

  /**
   * DERIVED, NOT HARDCODED. The largest per-pool size at which `count` pools are still a
   * valid state. Binary search, and the caller asserts the boundary is REAL by checking
   * that one byte more breaches - a search over a predicate that is not monotone returns
   * a number with no meaning and no error.
   */
  function largestFitting(count, shape) {
    let lo = 1;
    let hi = RETENTION_CAPS.maxPoolBytes;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (validAt(count, mid, shape)) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  /**
   * §18 frontier 1, DERIVED PER FAMILY: with every observation at the per-pool ceiling,
   * the greatest pool count that is still valid. This used to be the literal 31 and it is
   * not a constant - output-only bytes let one family reach the ceiling on fewer pools
   * than another at the identical per-pool size.
   */
  function largestCount(shape) {
    let lo = 1;
    let hi = RETENTION_CAPS.maxPools;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (validAt(mid, RETENTION_CAPS.maxPoolBytes, shape)) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  const shape = arm.endsWith('-many') ? 'many' : arm.endsWith('-exh') ? 'exh' : 'pad';
  const isF1 = arm.startsWith('f1');
  const count = arm === 'breach' ? RETENTION_CAPS.maxPools
    : isF1 ? largestCount(shape) : RETENTION_CAPS.maxPools;
  const perPool = arm === 'breach' || isF1
    ? RETENTION_CAPS.maxPoolBytes
    : largestFitting(RETENTION_CAPS.maxPools, shape);
  if (count === null) {
    console.error('VOID  no pool count at the per-pool ceiling is a valid state for this family');
    process.exit(3);
  }
  if (perPool === null) {
    console.error('VOID  no per-pool size makes this pool count a valid state');
    process.exit(3);
  }

  /**
   * Build the retained state and hand the live objects back so the CALLER decides when
   * they die. A CONTROL does every byte of the same construction and ingests nothing.
   */
  function build() {
    const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => T0, () => 0);
    settle();
    const base = used();
    let serialized = 0;
    for (let i = 0; i < count; i++) {
      const o = sized(`codex:acct-${i}:limit-1`, `acct-${i}`, perPool, shape);
      serialized += byteLen(o);
      if (!isControl) tracker.ingest(o);
    }
    const s = tracker.snapshot();
    const pools = s.pools.length;
    const unknown = s.pools.filter((p) => p.state === 'UNKNOWN').length;
    const published = byteLen(s);
    const keep = { tracker, snapshot: s };
    settle();
    return { base, delta: used() - base, serialized, pools, unknown, published, keep };
  }

  let r = build();
  const { base, delta, serialized, pools, unknown, published } = r;
  const before = used();
  r = null; // the tracker AND its published snapshot, released OUTSIDE the building frame
  settle();
  const reclaimed = before - used();

  console.log(JSON.stringify({ arm: which, shape, pools, perPool, unknown,
    serialized, published, base, delta, reclaimed }));

  // The fixture must be the state §15 names. A real number measured against the wrong
  // fixture is the failure this whole file exists to stop.
  const expectPools = isControl ? 0 : count;
  const expectUnknown = isControl ? 0 : (arm === 'breach' ? 1 : 0);
  const checks = [
    ['the expected pools are retained', pools === expectPools, `${pools} != ${expectPools}`],
    ['the fixture is the state the arm names', unknown === expectUnknown, `${unknown} UNKNOWN != ${expectUnknown}`],
    ['every observation was built at the arm\'s per-pool size',
      serialized === count * perPool, `${serialized} != ${count * perPool}`]
  ];
  if (!isControl && arm !== 'breach') {
    checks.push(['the published collection is within the cap',
      published <= RETENTION_CAPS.maxCollectionBytes,
      `${published} > ${RETENTION_CAPS.maxCollectionBytes}`]);
    // §18: within the cap is not enough - the post-projection collection PLUS ITS FULL
    // RESERVE has to fit, because that is what the runtime itself admits against. Asserted
    // on the fixture that was measured, and only after the measuring window has closed.
    checks.push(['the collection plus its full growth reserve is within the cap',
      published + reserveFor(pools) <= RETENTION_CAPS.maxCollectionBytes,
      `${published} + ${reserveFor(pools)} > ${RETENTION_CAPS.maxCollectionBytes}`]);
    // EVERY derived frontier must BE a frontier, on both axes. An arm that measures an
    // interior point and calls it the edge reports a real number for the wrong fixture,
    // which is the failure this whole file exists to stop.
    if (isF1 && count < RETENTION_CAPS.maxPools) {
      checks.push(['the derived pool count is a real edge - one more pool breaches',
        !validAt(count + 1, perPool, shape),
        `${count + 1} pools at ${perPool} bytes is still valid, so ${count} is not the greatest`]);
    }
    if (!isF1) {
      checks.push(['the derived per-pool size is a real edge - one byte more breaches',
        !validAt(count, perPool + 1, shape),
        `${perPool + 1} bytes per pool still fits, so ${perPool} is not the largest`]);
    }
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, , detail] of failed) console.error(`FAIL  ${name}  --  ${detail}`);
  if (failed.length) {
    console.error('A measurement against the wrong fixture is not a measurement.');
    process.exit(1);
  }
  if (isControl) process.exit(0); // a control is a floor, not a verdict

  if (delta <= 0 || reclaimed <= 0) {
    console.error(`VOID  delta ${delta}, reclaimed ${reclaimed}: the heap did not grow while retaining ${pools} pools.`);
    console.error('The measurement is confounded, NOT the tracker efficient. Nothing is concluded.');
    process.exit(3);
  }
  if (reclaimed >= HEAP_TARGET_BYTES) {
    console.error(`FAIL  reclaimed ${reclaimed} >= the §12 target of ${HEAP_TARGET_BYTES}.`);
    console.error('§12: report a failed target and choose structure reduction or a smaller serialized cap.');
    process.exit(1);
  }
}

/**
 * §15: at least five runs for EACH valid frontier PLUS the control, with identical
 * construction work in the tracker and no-ingest arms. A warm heap changes the answer,
 * so the runs are separate PROCESSES.
 */
function report() {
  const { spawnSync } = require('child_process');
  const run = (name) => {
    const r = spawnSync(process.execPath, ['--expose-gc', __filename, WT, name], { encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return { status: r.status, stderr: (r.stderr || '').trim(), row: line ? JSON.parse(line) : null };
  };
  const series = (name) => {
    const got = [];
    for (let i = 0; i < RUNS_PER_ARM; i++) {
      const r = run(name);
      if (r.status === 3) { console.error(`VOID  ${name} run ${i + 1}\n${r.stderr}`); return { void: true }; }
      if (r.status !== 0 || !r.row) { console.error(`FAIL  ${name} run ${i + 1}: exit ${r.status}\n${r.stderr || '(no stderr)'}`); return { failed: true }; }
      got.push(r.row);
    }
    const rec = got.map((g) => g.reclaimed);
    return { runs: got.length, min: Math.min(...rec), max: Math.max(...rec),
      perPool: got[0].perPool, pools: got[0].pools, published: got[0].published };
  };

  let voids = 0;
  let findings = 0;
  const rows = {};
  for (const arm of ALL_ARMS) {
    for (const name of [arm, `${arm}-control`]) {
      const s = series(name);
      if (s.void) { voids++; continue; }
      if (s.failed) { findings++; continue; }
      rows[name] = s;
      console.log(JSON.stringify({ arm: name, ...s }));
    }
  }

  // §15: "clear control separation". A frontier whose reclaim is not clearly above its
  // OWN control's floor has not been measured - the control does identical construction,
  // so anything it reclaims is not attributable to retained state.
  const separation = [];
  for (const arm of VALID_ARMS) {
    const a = rows[arm];
    const c = rows[`${arm}-control`];
    if (!a || !c) { voids++; continue; }
    const clear = c.max < a.min / 2;
    separation.push({ arm, armMin: a.min, controlMax: c.max, clear });
    if (!clear) voids++;
  }
  for (const s of separation) console.log(JSON.stringify(s));

  const valid = VALID_ARMS.map((a) => rows[a]).filter(Boolean);
  const upper = valid.length ? Math.max(...valid.map((v) => v.max)) : null;
  console.log(JSON.stringify({
    estimator: 'reclaimed', runsPerArm: RUNS_PER_ARM,
    validFrontiers: VALID_ARMS, upperAcrossValidFrontiers: upper,
    targetBytes: HEAP_TARGET_BYTES,
    breachArmIsEvidenceOnly: true
  }));

  if (voids || upper === null || valid.length !== VALID_ARMS.length) {
    console.error(`VOID  ${voids} condition(s) unmet. REPORT NO FIGURE and discharge nothing.`);
    process.exit(3);
  }
  if (upper >= HEAP_TARGET_BYTES) {
    console.error(`FAILED TARGET: upper result ${upper} across the valid frontiers, against ${HEAP_TARGET_BYTES}.`);
    findings++;
  }
  if (findings) process.exit(1);
  console.log('RESULT: EMPIRICAL ISOLATED-DEV ACCEPTANCE PASS for heap attributable to retained');
  console.log('capacity state, on this machine and this Node build, for BOTH §15 cap-valid');
  console.log('frontier KINDS, across the TIGHTEST VALID SHAPE CONSTRUCTED in each family,');
  console.log('with every pool count and per-pool size DERIVED in this run and its edge proved.');
  console.log('NOT the worst valid shape - that remains UNDERIVED, and deriving it needs a');
  console.log('maximum over legal shapes that nobody has computed. NOT a universal V8 or');
  console.log('runtime bound. NOT a production enforcement guarantee. The breach arm is');
  console.log('additional evidence and discharges nothing.');
}
