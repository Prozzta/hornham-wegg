'use strict';

/**
 * L0-VAL — L0-SEM §8 "Numeric overhead budget", the rows nothing was checking.
 *
 * WHY THIS FILE EXISTS, AND HOW ITS CONTENTS WERE CHOSEN. Not by reading §8 and
 * guessing which rows looked thin: by MUTATION. Each defence in the capacity surface
 * was removed or altered in an isolated worktree and all nine capacity suites rerun.
 * A defence whose removal leaves 171 of 171 green is a defence nothing checks — "a
 * test that would still pass if the thing it names were removed". Of 24 mutants 18
 * were killed; every genuine survivor was a §8 budget row, which is what this file
 * closes.
 *
 * Each surviving mutant was then probed for EQUIVALENCE before being believed. A
 * mutation that changes no observable behaviour survives for a reason that has
 * nothing to do with coverage, and in a mutation score the two are indistinguishable
 * and mean opposite things. One survivor was exactly that and is deliberately NOT
 * pinned here: the UNKNOWN-applicability guard inside `allWindowsPositive` is
 * unreachable, because `deriveState` already returns UNKNOWN for the same input —
 * and that earlier guard IS killed. Redundant defence in depth is not a coverage gap.
 *
 * Every assertion below was verified against the implementation before being written,
 * and where a boundary is claimed BOTH SIDES of it are asserted. A cap test that only
 * shows the over-cap case passes just as well against an implementation that answers
 * UNKNOWN to everything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { T0, win, obs } = require('./fixtures/capacity-corpus.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY, RETENTION_CAPS } = loadTs('src/main/providerCapacityTracker.ts');
const { CodexRolloutCapacitySource } = loadTs('src/main/codexRolloutCapacity.ts');

const tracker = () => {
  let now = T0;
  let mono = 0;
  return new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
};

/** An observation for `key`, padded so its SERIALIZED size lands on `bytes`. */
function sizedTo(key, scope, bytes) {
  let pad = 0;
  for (let guard = 0; guard < 64; guard++) {
    const o = obs({
      poolKey: key, accountScope: scope, observedAt: T0, receivedAt: T0,
      windows: [win()], planType: 'z'.repeat(pad)
    });
    const n = JSON.stringify(o).length;
    if (n === bytes) return o;
    if (n > bytes) throw new Error(`cannot size below ${n} bytes`);
    pad += bytes - n;
  }
  throw new Error('sizing did not converge');
}

const poolOf = (t, key) => t.pool(key);

// ---------------------------------------------------------------------------
// §8 retained domain state — "max 32 pools, 16 windows/pool, 8 KiB normalized per
// pool, 256 KiB serialized collection", and line 172: a breach makes the pool
// UNKNOWN and "must not silently discard an applicable window and remain healthy".
// ---------------------------------------------------------------------------

test('§8 PER-POOL BYTES: 8 KiB exactly is accepted and one byte more is UNKNOWN, never healthy', () => {
  assert.equal(RETENTION_CAPS.maxPoolBytes, 8 * 1024, '§8 says 8 KiB normalized per pool');
  const key = 'codex:acct-a:limit-1';

  // AT the cap: accepted. Asserted first, because without it the over-cap assertion
  // below is satisfied by an implementation that calls everything UNKNOWN.
  const atCap = tracker();
  atCap.ingest(sizedTo(key, 'acct-a', RETENTION_CAPS.maxPoolBytes));
  assert.equal(poolOf(atCap, key).state, 'AVAILABLE', 'a reading exactly at the cap is within budget');

  // ONE BYTE OVER: UNKNOWN. This is the case the mutation campaign proved unchecked —
  // deleting the per-pool byte check left all nine capacity suites green while an
  // over-budget reading reported AVAILABLE/FRESH_READING.
  const over = tracker();
  over.ingest(sizedTo(key, 'acct-a', RETENTION_CAPS.maxPoolBytes + 1));
  const p = poolOf(over, key);
  assert.equal(p.state, 'UNKNOWN', '§8 line 172: a cap breach makes the pool UNKNOWN');
  assert.notEqual(p.state, 'AVAILABLE', 'THE FAILURE MODE: an over-budget reading reading healthy');
  assert.equal(p.stateReason, 'RETENTION_CAP_EXCEEDED', 'and says why, once');
});

test('§8 POOL COUNT: the cap is 32 — the 32nd pool is healthy and the 33rd breaches', () => {
  assert.equal(RETENTION_CAPS.maxPools, 32, '§8 says max 32 pools');
  const t = tracker();
  const key = (i) => `codex:acct-${i}:limit-1`;
  const small = (i) => obs({ poolKey: key(i), accountScope: `acct-${i}`, observedAt: T0, receivedAt: T0, windows: [win()] });

  for (let i = 0; i < RETENTION_CAPS.maxPools; i++) t.ingest(small(i));
  // BOTH SIDES. Raising the cap to any larger number leaves the over-cap assertion
  // satisfied, so the 32nd pool being healthy is what pins the number itself.
  assert.equal(t.snapshot().pools.length, RETENTION_CAPS.maxPools, 'all 32 retained');
  assert.equal(poolOf(t, key(RETENTION_CAPS.maxPools - 1)).state, 'AVAILABLE', 'the 32nd pool is within budget');

  t.ingest(small(RETENTION_CAPS.maxPools));
  const p = poolOf(t, key(RETENTION_CAPS.maxPools));
  assert.ok(p, 'the 33rd pool is retained rather than dropped, so the breach is visible');
  assert.equal(p.state, 'UNKNOWN', 'the 33rd pool breaches the count cap');
  assert.equal(p.stateReason, 'RETENTION_CAP_EXCEEDED');
  assert.equal(
    poolOf(t, key(0)).state,
    'AVAILABLE',
    'and the breach is charged to the pool that caused it, not to the pools already inside budget'
  );
});

test('§8 WINDOWS PER POOL: the cap is 16 — sixteen windows are healthy, seventeen breach', () => {
  assert.equal(RETENTION_CAPS.maxWindowsPerPool, 16, '§8 says 16 windows per pool');
  const key = 'codex:acct-a:limit-1';
  const windows = (n) =>
    Array.from({ length: n }, (_, i) => win({ windowId: `w${i}`, kind: 'OTHER', windowMinutes: 60 + i }));

  const atCap = tracker();
  atCap.ingest(obs({ observedAt: T0, receivedAt: T0, windows: windows(RETENTION_CAPS.maxWindowsPerPool) }));
  assert.equal(poolOf(atCap, key).state, 'AVAILABLE', 'sixteen valid windows are within budget');

  const over = tracker();
  over.ingest(obs({ observedAt: T0, receivedAt: T0, windows: windows(RETENTION_CAPS.maxWindowsPerPool + 1) }));
  const p = poolOf(over, key);
  assert.equal(p.state, 'UNKNOWN', 'the seventeenth window breaches');
  assert.equal(p.stateReason, 'RETENTION_CAP_EXCEEDED');
  // §8 line 172's actual words. A truncate-to-16-and-carry-on implementation would
  // also report healthy, and that is the outcome the clause forbids by name.
  assert.notEqual(p.state, 'AVAILABLE', 'it must not silently discard a window and remain healthy');
});

test('§8 the three retention caps are ARITHMETICALLY CONSISTENT, or the collection cap cannot fire', () => {
  // A TRIPWIRE, NOT A BEHAVIOUR. maxPools x maxPoolBytes is EXACTLY maxCollectionBytes
  // at these values, and the collection check fires on STRICTLY MORE — so with every
  // pool legal and the count legal the collection cap can never fire. That is a fact
  // about the three numbers, measured: 32 pools at 8,192 bytes serialize to 262,144,
  // which is the cap, with zero headroom.
  //
  // This is pinned rather than left in prose because the reachability of the third cap
  // is a consequence of the other two, so changing ANY of the three silently changes
  // whether it is dead. This assertion fails at exactly that moment and says why.
  const product = RETENTION_CAPS.maxPools * RETENTION_CAPS.maxPoolBytes;
  assert.equal(
    product,
    RETENTION_CAPS.maxCollectionBytes,
    'the per-pool and pool-count caps bound the collection to exactly the collection cap; ' +
      'if this ever differs, re-examine whether COLLECTION_BYTES is reachable and whether ' +
      'a retained cap-breaching pool can put the collection over budget unreported'
  );

  // And the measured half of the same claim: 32 maximal legal pools reach the cap and
  // do not cross it, so none of them reports a collection breach.
  const t = tracker();
  let total = 0;
  for (let i = 0; i < RETENTION_CAPS.maxPools; i++) {
    const o = sizedTo(`codex:acct-${i}:limit-1`, `acct-${i}`, RETENTION_CAPS.maxPoolBytes);
    total += JSON.stringify(o).length;
    t.ingest(o);
  }
  assert.equal(total, RETENTION_CAPS.maxCollectionBytes, 'the maximal legal collection lands ON the cap');
  assert.equal(
    t.snapshot().pools.filter((p) => p.state === 'UNKNOWN').length,
    0,
    'a collection exactly at its budget is within budget'
  );
});

// ---------------------------------------------------------------------------
// §8 Codex file processing — "max 256 KiB appended bytes per read".
// ---------------------------------------------------------------------------

/** A CODEX_HOME whose rollout hides one usable snapshot `fromEnd` bytes from EOF. */
function homeWithSnapshotAt(fromEnd) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-l0val-'));
  const dir = path.join(home, 'sessions', '2026', '09', '13');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-09-13T10-00-00-aaa.jsonl');
  const usable = JSON.stringify({
    timestamp: '2026-09-13T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 41, window_minutes: 300, resets_at: 1789004151 },
        secondary: { used_percent: 9, window_minutes: 10080, resets_at: 1789590951 },
        plan_type: 'plus',
        rate_limit_reached_type: null
      }
    }
  });
  // Filler lines carry NO rate_limits, so the reader must actually reach the snapshot
  // rather than find a nearer one. One filler line is 128 bytes including its newline.
  const filler = JSON.stringify({ type: 'other', pad: 'p'.repeat(80) });
  const fillerLine = filler + '\n';
  const after = Math.max(1, Math.round(fromEnd / fillerLine.length));
  fs.writeFileSync(file, `${'lead\n'.repeat(64)}${usable}\n${fillerLine.repeat(after)}`);
  return { home, file, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('§8 ROLLOUT READ: the tail reaches a snapshot 128 KiB back, which a 64 KiB tail cannot', () => {
  // Nothing in the rollout suite builds a file larger than a few hundred bytes, so the
  // read budget was exercised by nothing: shrinking the tail from 256 KiB back to the
  // 64 KiB it was raised FROM (commit 7c0ce776) left all nine suites green. A revert of
  // that commit was therefore invisible.
  const h = homeWithSnapshotAt(128 * 1024);
  try {
    assert.ok(fs.statSync(h.file).size > 64 * 1024, 'precondition: the snapshot really is out of a 64 KiB tail');
    const o = new CodexRolloutCapacitySource(() => 'scope-x').observe(h.home);
    assert.ok(o, 'a usable snapshot 128 KiB from the end is still found');
    assert.equal(o.windows.find((w) => w.kind === 'FIVE_HOUR').remainingPercent, 59);
    assert.equal(o.observedAt, Date.parse('2026-09-13T10:00:00.000Z'), 'dated by its own event time');
  } finally {
    h.cleanup();
  }
});

test('§8 ROLLOUT READ: the tail is a CEILING — a snapshot beyond 256 KiB is not read', () => {
  // The other side of the same budget, and the reason it must be asserted: "max 256 KiB
  // appended bytes per read" is a maximum, so an implementation that simply read the
  // whole file would satisfy the test above and breach the budget. This is the bound.
  const h = homeWithSnapshotAt(400 * 1024);
  try {
    const o = new CodexRolloutCapacitySource(() => 'scope-x').observe(h.home);
    assert.equal(o, null, 'a snapshot outside the 256 KiB read budget is a miss, not a larger read');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// §8 Timers — "One main-process earliest-boundary timer for all freshness/reset
// deadlines" — and Quiet-state work, which only became measurable once L0-WIRE gave
// the runtime an injected timer seam.
// ---------------------------------------------------------------------------

const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');

/**
 * A runtime rig that can hold MANY timers at once, which is the whole point.
 *
 * The existing runtime rig keeps ONE `pending` slot, so a second armed timer
 * silently overwrites the first and the violation is invisible by construction:
 * arming an extra timer on every rearm leaves all nine capacity suites green. A
 * budget of "one timer" cannot be checked by a rig that can only represent one.
 *
 * Both clocks advance by the delay the runtime actually asked for, so what is under
 * test is the schedule the runtime chose rather than one this test chose for it.
 */
function runtimeRig() {
  let now = T0;
  let mono = 0;
  const delivered = [];
  const live = new Map();
  let seq = 0;
  let maxOutstanding = 0;
  let armedTotal = 0;
  let fired = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  const runtime = new CapacityRuntime({
    deliver: (intents) => delivered.push(...intents),
    now: () => now,
    setTimer: (fn, ms) => {
      const h = ++seq;
      live.set(h, { fn, at: now + ms });
      armedTotal += 1;
      maxOutstanding = Math.max(maxOutstanding, live.size);
      return h;
    },
    clearTimer: (h) => live.delete(h)
  }, tracker);
  return {
    tracker, runtime, delivered,
    outstanding: () => live.size,
    stats: () => ({ maxOutstanding, armedTotal, fired }),
    now: () => now,
    /** Fire every boundary due on or before `until`, in order. */
    runUntil(until) {
      for (let guard = 0; guard < 1000; guard++) {
        const due = [...live.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [h, t] = due;
        const delta = t.at - now;
        now = t.at;
        mono += delta;
        live.delete(h);
        fired += 1;
        t.fn();
      }
      mono += Math.max(0, until - now);
      now = Math.max(now, until);
    }
  };
}

test('§8 TIMERS: at most ONE boundary timer is outstanding, across repeated re-arming', () => {
  const h = runtimeRig();
  const reading = (at, remaining) =>
    obs({ observedAt: at, receivedAt: at, windows: [win({ usedPercent: 100 - remaining, remainingPercent: remaining })] });

  // Several arming events, because one rearm cannot distinguish "replaces" from "adds".
  h.runtime.ingest('agent-1', reading(h.now(), 80));
  assert.equal(h.outstanding(), 1, 'a fresh reading arms exactly one boundary');
  h.runtime.ingest('agent-1', reading(h.now(), 70));
  h.runtime.ingest('agent-2', reading(h.now(), 60));
  assert.equal(h.outstanding(), 1, 'later readings REPLACE the boundary rather than adding one');

  h.runUntil(T0 + 10 * 60_000);
  assert.equal(
    h.stats().maxOutstanding,
    1,
    '§8: "One main-process earliest-boundary timer for all freshness/reset deadlines" — ' +
      'never two at once, at any point in the run'
  );
});

test('§8 QUIET STATE: ten minutes of one fresh static reading fires ONE boundary and notifies nobody', () => {
  const h = runtimeRig();
  h.runtime.ingest('agent-1', obs({ observedAt: T0, receivedAt: T0, windows: [win()] }));
  const key = 'codex:acct-a:limit-1';
  assert.equal(h.tracker.pool(key).state, 'AVAILABLE', 'precondition: the reading was accepted and is healthy');
  assert.equal(h.outstanding(), 1, 'precondition: a boundary was actually scheduled');

  h.runUntil(T0 + 10 * 60_000);

  // §8 Quiet-state work: "only the single scheduled semantic boundary may fire".
  assert.equal(h.stats().fired, 1, 'exactly ONE boundary fires in ten quiet minutes — the freshness expiry');
  assert.equal(h.delivered.length, 0, '0 notifications: a reading ageing out is not news');
  assert.equal(h.outstanding(), 0, 'and nothing is left armed, so the quiet state is genuinely quiet');

  // The boundary did real work rather than being a no-op that costs nothing to pass.
  const p = h.tracker.pool(key);
  assert.equal(p.freshness, 'STALE', 'the scheduled boundary is what expired the reading');
  assert.equal(p.state, 'UNKNOWN', 'and an expired reading reads UNKNOWN, never healthy');
});
