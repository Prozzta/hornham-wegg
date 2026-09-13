'use strict';

/**
 * L0-TAIL — durable capacity observations across a process restart.
 *
 * The human's rulings, which these arms exist to hold:
 *   1. persist OBSERVATIONS, never derived verdicts as authoritative current state
 *   2. preserve the provider's own timestamps; fabricate nothing
 *   3. a monotonic deadline does not survive a restart and must not be rebuilt as
 *      though it did; wall-clock age alone must not promote restored evidence
 *   4. preserve the last known epoch/continuity identity, WITHOUT restoring the old
 *      verdict as current truth - "pre-restart epoch 42 / LIMITED, post-restart
 *      epoch 42 / UNKNOWN"
 *   5. restart must NEITHER manufacture AVAILABLE nor leave the app stuck LIMITED
 *   6. restored data passes the normal ingestion boundary with explicit
 *      restored/unconfirmed provenance
 *
 * A RESTART IS SIMULATED THE WAY A RESTART ACTUALLY HAPPENS: a second tracker with
 * its OWN monotonic clock starting from zero. Reusing one tracker would leave the
 * monotonic origin intact and quietly test nothing, because the defect this feature
 * addresses is precisely that the origin is gone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY, REASON, TIMER_GROWTH_RESERVE_PER_POOL } =
  loadTs('src/main/providerCapacityTracker.ts');
const {
  CapacityStore, loadCapacityStore, saveCapacityStore, serializeCapacityStore,
  restoreCapacityStore, CAPACITY_STORE_VERSION
} = loadTs('src/main/capacityPersistence.ts');

const T0 = 1_800_000_000_000;
const KEY = 'codex:acct-a:codex';
const RESET = T0 + 3_600_000;

const win = (over = {}) => ({
  windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: 20, remainingPercent: 80, resetsAt: RESET, ...over
});

const obs = (over = {}) => ({
  poolKey: KEY, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s.jsonl', sourceSequence: 1,
  observedAt: T0, receivedAt: T0, windows: [win()],
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus', ...over
});

/** One process. `mono` restarts from zero in the next one, as a real restart does. */
function proc(startWall = T0) {
  let now = startWall;
  let mono = 0;
  const t = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  return {
    t,
    advance: (ms) => { now += ms; mono += ms; },
    /** Wall clock only - the monotonic clock is not moved, which is the point. */
    setWall: (v) => { now = v; },
    at: () => now
  };
}

/** Carry a collection across a restart the way the store does, via JSON. */
function acrossRestart(from, startWall) {
  const wire = JSON.parse(JSON.stringify({
    version: CAPACITY_STORE_VERSION, savedAt: from.at(), pools: from.t.persistable()
  }));
  const next = proc(startWall);
  const restored = restoreCapacityStore(next.t, wire.pools);
  return { ...next, restored, wire };
}

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-restart-'));
  test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return join(dir, 'capacity-observations.json');
}

// ═══════════════════════════════════════════════════════════════════════════
// The defect itself: a known pool must not vanish
// ═══════════════════════════════════════════════════════════════════════════

test('RESTART: a previously-seen pool survives with NO subsequent agent activity', () => {
  // The required fixture, and the whole point of the feature. Before this, the pool
  // was simply gone until something happened to produce another reading.
  const a = proc();
  a.t.ingest(obs());
  assert.equal(a.t.pool(KEY).state, 'AVAILABLE', 'precondition: it was known and healthy');

  const b = acrossRestart(a, T0 + 60_000);
  assert.equal(b.restored, 1, 'the pool came back');
  const p = b.t.pool(KEY);
  assert.notEqual(p, null, 'a previously-seen pool is DISCLOSED, not absent');
  assert.equal(p.poolKey, KEY);
  assert.equal(p.provider, 'codex');
  assert.equal(p.limitId, 'codex');
});

test('RESTART: the restored pool is UNKNOWN/restored-unconfirmed, never the old verdict', () => {
  const a = proc();
  a.t.ingest(obs());
  const b = acrossRestart(a, T0 + 60_000);
  const p = b.t.pool(KEY);
  assert.equal(p.state, 'UNKNOWN', 'restart must NEVER manufacture AVAILABLE');
  assert.equal(p.stateReason, REASON.RESTORED, 'and says so explicitly, as restored/unconfirmed');
});

test('RESTART: a restored reading is NEVER fresh, even one second old', () => {
  // Ruling 3, in its strongest form. The tempting implementation computes the
  // remaining TTL from wall-clock age, which would make this pool FRESH and
  // therefore classifiable - the exact promotion the ruling forbids by name.
  const a = proc();
  a.t.ingest(obs());
  const b = acrossRestart(a, T0 + 1_000);
  const p = b.t.pool(KEY);
  assert.equal(p.freshness, 'STALE', 'a monotonic deadline cannot be reconstructed');
  assert.equal(p.state, 'UNKNOWN');
  assert.ok(p.ageMs >= 1_000, 'and the age it reports is the real one, not zero');
});

test('RESTART: provider timestamps cross verbatim - nothing is restamped', () => {
  // Ruling 2. A restore that re-dated the reading to now would make a stale fact
  // look current, which is the same class of error as the presence record that was
  // refused for fabricating a timestamp.
  const a = proc();
  a.t.ingest(obs({ observedAt: T0 - 90_000, receivedAt: T0 - 90_000 }));
  const b = acrossRestart(a, T0 + 60_000);
  const p = b.t.pool(KEY);
  assert.equal(p.observedAt, T0 - 90_000, 'the provider event time is preserved exactly');
  assert.equal(p.receivedAt, T0 - 90_000, 'and so is the receipt time');
  assert.equal(p.source, 'codex-rollout', 'the original provenance is preserved, not overwritten');
});

// ═══════════════════════════════════════════════════════════════════════════
// Restart during a known limit window — the epoch-42 case
// ═══════════════════════════════════════════════════════════════════════════

test('RESTART during a known limit window: epoch 42 / LIMITED becomes epoch 42 / UNKNOWN', () => {
  // The human's own worked example, asserted literally. THE EPOCH CROSSES AND THE
  // VERDICT DOES NOT. This is the arm that catches restoring a derived verdict:
  // deriveState's epoch branch outranks everything, so without the restored gate
  // above it this pool republishes LIMITED with no provider having said anything.
  const a = proc();
  a.t.ingest(obs());
  a.advance(1_000);
  a.t.ingest(obs({
    observedAt: a.at(), receivedAt: a.at(), sourceSequence: 2,
    providerReachedType: 'rate_limit_reached'
  }));
  const before = a.t.pool(KEY);
  assert.equal(before.state, 'LIMITED', 'precondition: a real limit window');
  const epochId = before.limitEpochAt;
  assert.ok(epochId !== null, 'precondition: an epoch is open');

  const b = acrossRestart(a, a.at() + 30_000);
  const after = b.t.pool(KEY);
  assert.equal(after.limitEpochAt, epochId, 'SAME epoch identity: continuity is preserved');
  assert.equal(after.state, 'UNKNOWN', 'but the pre-restart verdict is NOT current truth');
  assert.equal(after.stateReason, REASON.RESTORED);
});

test('RESTART: a restored limit is neither cleared into AVAILABLE nor stuck LIMITED', () => {
  // Ruling 5, both sides, because each alone is trivially satisfiable by the wrong
  // implementation: always-LIMITED satisfies the first and always-AVAILABLE the
  // second. Time passing changes neither answer.
  const a = proc();
  a.t.ingest(obs({ providerReachedType: 'rate_limit_reached' }));
  const b = acrossRestart(a, T0 + 30_000);

  assert.equal(b.t.pool(KEY).state, 'UNKNOWN');
  b.advance(6 * 3_600_000);
  b.t.evaluate();
  const p = b.t.pool(KEY);
  assert.notEqual(p.state, 'AVAILABLE', 'a restart does not clear a provider limitation');
  assert.notEqual(p.state, 'LIMITED', 'and does not leave the app stuck on a restored verdict');
  assert.equal(p.state, 'UNKNOWN', 'it is honestly unknown until something live says otherwise');
});

test('RESTART: elapsed downtime past the reset boundary does not manufacture RECOVERING', () => {
  // The subtler half of ruling 3. The reset-passage hint is computed from the
  // observation's own boundary and the wall clock, so on restored evidence it would
  // synthesize "recovery is likely" out of nothing but the app having been closed.
  // KILLS the version that leaves resetPassed() ungated on restored records.
  const a = proc();
  a.t.ingest(obs({ providerReachedType: 'rate_limit_reached' }));
  const b = acrossRestart(a, RESET + 60_000);
  b.t.evaluate();
  const p = b.t.pool(KEY);
  assert.equal(p.state, 'UNKNOWN', 'not RECOVERING');
  assert.equal(p.recoveryPending, false, 'and no recovery hint was latched from downtime alone');
});

// ═══════════════════════════════════════════════════════════════════════════
// What clears it, and what does not
// ═══════════════════════════════════════════════════════════════════════════

test('RESTART: a fresh live observation replaces restored/unconfirmed state', () => {
  // The required fixture. Restored evidence is not a trap the pool cannot leave:
  // the first live reading is authoritative and classifies normally.
  const a = proc();
  a.t.ingest(obs());
  const b = acrossRestart(a, T0 + 60_000);
  assert.equal(b.t.pool(KEY).state, 'UNKNOWN', 'precondition');

  b.advance(1_000);
  b.t.ingest(obs({ observedAt: b.at(), receivedAt: b.at(), sourceSequence: 7 }));
  const p = b.t.pool(KEY);
  assert.equal(p.state, 'AVAILABLE', 'live evidence confirms and the pool classifies again');
  assert.equal(p.freshness, 'FRESH', 'and it is genuinely fresh, on this process own clock');
});

test('RESTART: fresh live evidence CONFIRMS a restored epoch rather than dropping it', () => {
  // "fresh telemetry then either confirms continuity or establishes a new epoch."
  // Confirmation must keep the ORIGINAL `since`, or the refusal looks like it ended
  // and restarted - which is what re-deriving the epoch on restore would have done.
  const a = proc();
  a.t.ingest(obs({ providerReachedType: 'rate_limit_reached' }));
  const epochId = a.t.pool(KEY).limitEpochAt;

  const b = acrossRestart(a, T0 + 30_000);
  b.advance(1_000);
  b.t.ingest(obs({
    observedAt: b.at(), receivedAt: b.at(), sourceSequence: 9,
    providerReachedType: 'rate_limit_reached'
  }));
  const p = b.t.pool(KEY);
  assert.equal(p.state, 'LIMITED', 'the live refusal classifies normally again');
  assert.equal(p.limitEpochAt, epochId, 'and it is the SAME epoch, not a new one');
});

test('RESTART: fresh permission ENDS a restored epoch', () => {
  // The other branch of the same sentence, so "confirms continuity" is not the only
  // reachable outcome. K1 clears it.
  const a = proc();
  a.t.ingest(obs({ providerReachedType: 'rate_limit_reached' }));
  const b = acrossRestart(a, T0 + 30_000);
  b.advance(1_000);
  b.t.ingest(obs({
    observedAt: b.at(), receivedAt: b.at(), sourceSequence: 9, ordinaryUsageAllowed: true
  }));
  const p = b.t.pool(KEY);
  assert.equal(p.limitEpochAt, null, 'explicit provider permission closes it');
  assert.notEqual(p.state, 'UNKNOWN', 'and the pool is confirmed rather than unconfirmed');
});

test('RESTART: re-reading the SAME historical line does not confirm anything', () => {
  // A real post-restart sequence: the rollout tail still ends on the line we
  // persisted. It is the same evidence, so the provider has said nothing new and the
  // pool must stay unconfirmed. Catches "any ingest clears the restored flag".
  const a = proc();
  a.t.ingest(obs());
  const b = acrossRestart(a, T0 + 60_000);
  const again = b.t.ingestDetailed(obs());
  assert.equal(again.accepted, true, 'the duplicate is valid');
  assert.equal(again.reason, 'DUPLICATE', 'and says nothing new');
  assert.equal(b.t.pool(KEY).state, 'UNKNOWN', 'so the pool is still unconfirmed');
});

// ═══════════════════════════════════════════════════════════════════════════
// Clocks
// ═══════════════════════════════════════════════════════════════════════════

test('RESTART: BACKWARDS wall-clock movement cannot promote a restored pool', () => {
  // The required fixture. Nothing about a restored pool is derived from wall-clock
  // age, so moving the clock backwards - the case that makes an age look small -
  // cannot make it fresh or healthy.
  const a = proc();
  a.t.ingest(obs());
  const b = acrossRestart(a, T0 + 60_000);
  assert.equal(b.t.pool(KEY).state, 'UNKNOWN', 'precondition');

  b.setWall(T0 - 3_600_000);
  b.t.evaluate();
  const p = b.t.pool(KEY);
  assert.equal(p.state, 'UNKNOWN', 'an hour of backwards clock changes nothing');
  assert.equal(p.freshness, 'STALE');
  assert.ok(p.ageMs >= 0, 'and the reported age never goes negative');
});

test('RESTART: a restored reading dated after a backwards clock jump is REFUSED, not clamped', () => {
  // A deliberate trade-off, recorded here rather than left to be discovered. If the
  // clock moves back far enough, a persisted observation is future-dated and the
  // normal future-skew rule refuses it, so the pool is honestly absent instead of
  // restored. That is the conservative half of ruling 6 - the restore uses the
  // NORMAL boundary - and the alternative is worse: a future-dated reading outranks
  // every subsequent live observation by ordering key, so accepting it would pin the
  // pool permanently unconfirmed and deaf to real evidence. Clamping the timestamp
  // is not available; that is fabrication.
  const a = proc();
  a.t.ingest(obs());
  const b = acrossRestart(a, T0 - 3_600_000);
  assert.equal(b.restored, 0, 'refused rather than admitted with a rewritten time');
  assert.equal(b.t.pool(KEY), null, 'honestly absent, which a caller reads as unknown');
});

test('RESTART: a STALE restored observation is still disclosed as a pool', () => {
  // The required stale fixture. Staleness is the normal case for restored evidence -
  // it is stale by construction - and the pool still exists, which is the C2.6 point:
  // UNKNOWN disclosed rather than absent.
  const a = proc();
  a.t.ingest(obs({ observedAt: T0 - 86_400_000, receivedAt: T0 - 86_400_000 }));
  const b = acrossRestart(a, T0 + 60_000);
  const p = b.t.pool(KEY);
  assert.notEqual(p, null, 'a day-old reading still gives the pool its existence back');
  assert.equal(p.state, 'UNKNOWN');
  assert.equal(p.freshness, 'STALE');
  assert.ok(p.ageMs >= 86_400_000, 'and the age tells the truth about how old it is');
});

// ═══════════════════════════════════════════════════════════════════════════
// The store file itself
// ═══════════════════════════════════════════════════════════════════════════

test('STORE: a clean first install restores nothing and stays honestly absent', () => {
  // The required fixture, and the thing the refused presence record would have
  // broken. No file, no pool, no invented identity.
  const file = join(mkdtempSync(join(tmpdir(), 'cap-clean-')), 'capacity-observations.json');
  assert.deepEqual(loadCapacityStore(file), [], 'a missing store is empty, not an error');
  const p = proc();
  assert.equal(new CapacityStore(file, p.t).restore(), 0);
  assert.equal(p.t.snapshot().pools.length, 0, 'nothing was minted to have something to show');
});

test('STORE: what is written is OBSERVATIONS, with no derived verdict anywhere', () => {
  // Ruling 1, asserted as an absence across the whole serialized file rather than on
  // one field, so a verdict smuggled in under another key is still caught.
  const p = proc();
  p.t.ingest(obs({ providerReachedType: 'rate_limit_reached' }));
  const { text } = serializeCapacityStore(p.t, p.at());
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, CAPACITY_STORE_VERSION);
  assert.equal(parsed.pools.length, 1);
  assert.ok(parsed.pools[0].observation, 'the observation is what is stored');
  for (const key of ['state', 'stateReason', 'freshness', 'ageMs', 'revision', 'recoveryPending']) {
    assert.equal(text.includes(`"${key}"`), false, `no derived field ${key} is persisted`);
  }
  assert.equal(typeof parsed.pools[0].continuitySince, 'number',
    'the epoch identity crosses as a bounded number');
  assert.equal(parsed.pools[0].continuitySince, p.t.pool(KEY).limitEpochAt, 'and it is the real one');
});

test('STORE: no credential material, and the account scope is an identifier not a secret', () => {
  const p = proc();
  p.t.ingest(obs());
  const { text } = serializeCapacityStore(p.t, p.at());
  for (const shape of ['auth.json', 'access_token', 'refresh_token', 'id_token', 'api_key',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'Bearer ', 'sk-', 'password', 'secret']) {
    assert.equal(text.includes(shape), false, `the store must never contain ${shape}`);
  }
  assert.equal(JSON.parse(text).pools[0].observation.accountScope, 'acct-a');
});

test('STORE: one malformed pool discards the WHOLE store rather than half-trusting it', () => {
  const file = tmp();
  const p = proc();
  p.t.ingest(obs());
  saveCapacityStore(file, p.t, p.at());
  const store = JSON.parse(readFileSync(file, 'utf8'));
  store.pools.push({ observation: { poolKey: 'codex:b:codex', windows: 'not-an-array' }, epoch: null });
  writeFileSync(file, JSON.stringify(store), 'utf8');
  assert.deepEqual(loadCapacityStore(file), [], 'a store that cannot be believed restores nothing');
});

test('STORE: junk, a wrong version and a truncated file each restore nothing', () => {
  const file = tmp();
  for (const body of ['', 'not json at all', '{}', '[]',
    JSON.stringify({ version: CAPACITY_STORE_VERSION + 1, savedAt: T0, pools: [] }),
    JSON.stringify({ version: CAPACITY_STORE_VERSION, savedAt: T0, pools: 'nope' })]) {
    writeFileSync(file, body, 'utf8');
    assert.deepEqual(loadCapacityStore(file), [], `refused: ${body.slice(0, 24) || '(empty)'}`);
  }
});

test('STORE: a round trip through the real file restores the pool', () => {
  const file = tmp();
  const a = proc();
  a.t.ingest(obs());
  const written = new CapacityStore(file, a.t, 5_000, () => a.at()).saveNow();
  assert.equal(written.written, 1);
  assert.equal(written.omitted, 0);
  assert.ok(existsSync(file), 'the store was written');
  assert.equal(existsSync(`${file}.tmp`), false, 'and the temp file was renamed, not left behind');

  const b = proc(T0 + 60_000);
  assert.equal(new CapacityStore(file, b.t).restore(), 1);
  assert.equal(b.t.pool(KEY).state, 'UNKNOWN');
});

test('LIFECYCLE: restore, clean quit with NO telemetry, restore again — the pool survives', () => {
  // THE DEFECT THIS ARM EXISTS FOR, AND IT WAS MINE. An earlier version had
  // `persistable()` skip restored-unconfirmed pools, to stop one observation
  // surviving an unbounded chain of restarts unconfirmed. But the store is written
  // by WHOLE-FILE REPLACEMENT, so a clean quit with no live telemetry in between
  // rewrote it as `pools: []` and the THIRD start had no pool at all — the exact
  // known-pool-becomes-absent defect this whole feature exists to fix.
  //
  // The guard was also unnecessary: restored evidence is permanently stale and
  // permanently unconfirmed, so it can never become current truth however many
  // restarts it survives. The hazard was already discharged by a mechanism in the
  // same file. AN UNREQUESTED GUARD NEEDS THE SAME QUESTION AS A REQUESTED ONE —
  // what is ALREADY discharging this?
  //
  // The previous arm stopped at `persistable() === []` and never asked what that
  // filter did to the FILE, so it asserted the filter and missed the defect. This
  // one goes through the destructive shutdown to a second restart.
  const file = tmp();
  const a = proc();
  a.t.ingest(obs());
  new CapacityStore(file, a.t, 5_000, () => a.at()).saveNow();

  // Second process: restore, observe nothing at all, quit cleanly.
  const b = proc(T0 + 60_000);
  const storeB = new CapacityStore(file, b.t, 5_000, () => b.at());
  assert.equal(storeB.restore(), 1, 'the pool came back');
  assert.equal(b.t.pool(KEY).state, 'UNKNOWN', 'as restored/unconfirmed');
  storeB.saveNow();                                   // what will-quit does
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pools.length, 1,
    'A CLEAN QUIT WITH NO TELEMETRY MUST NOT EMPTY THE STORE');

  // Third process: the pool is still there.
  const c = proc(T0 + 120_000);
  assert.equal(new CapacityStore(file, c.t, 5_000, () => c.at()).restore(), 1);
  const p = c.t.pool(KEY);
  assert.notEqual(p, null, 'a known pool is still disclosed after a second restart');
  assert.equal(p.state, 'UNKNOWN', 'and is still honestly unconfirmed, not promoted by surviving');
  assert.equal(p.stateReason, REASON.RESTORED);
});

test('WIRE: only a bounded continuity NUMBER crosses — no classifying epoch field does', () => {
  // "THE EPOCH CROSSES AS IDENTITY AND IS FORBIDDEN FROM CLASSIFYING" WAS A
  // STATEMENT ABOUT THE GATE, NOT ABOUT THE PAYLOAD, AND THE GATE IS TEMPORARY.
  // The first version persisted the whole derived epoch. `restoredUnconfirmed`
  // suppressed classification only until the first live reading cleared it, and
  // `nextEpoch` then consumed the restored anchors, remainders, hint, reached type
  // and permission flag as though this process had observed them.
  //
  // So the constraint is asserted ON THE WIRE, as an absence, rather than described
  // in a comment. A principle is not a payload.
  const p = proc();
  p.t.ingest(obs({ providerReachedType: 'rate_limit_reached' }));
  assert.equal(p.t.pool(KEY).state, 'LIMITED', 'precondition: a real epoch is open');

  const { text } = serializeCapacityStore(p.t, p.at());
  const entry = JSON.parse(text).pools[0];
  assert.equal(typeof entry.continuitySince, 'number', 'continuity crosses as a number');
  assert.equal(entry.continuitySince, p.t.pool(KEY).limitEpochAt, 'and it is the real identity');
  assert.equal('epoch' in entry, false, 'no epoch object crosses at all');
  for (const field of ['anchors', 'remaindersAtRefusal', 'hinted', 'evidenceAt',
    'attributedWindowId', 'permissionDenied', 'reachedType']) {
    assert.equal(text.includes(`"${field}"`), false, `no classifying field ${field} is on the wire`);
  }
});

test('WIRE: a restored identity cannot classify even after the restored gate lifts', () => {
  // The end-to-end version of the arm above, and the defect Dwight reproduced: a
  // structurally-accepted epoch publishing RECOVERING off a later INCOMPLETE live
  // reading that carried no limiting fact at all.
  const r = proc();
  // A continuity identity arriving with no epoch behind it — a hand-edited store,
  // or simply one written by a process whose evidence this one never saw.
  assert.equal(r.t.restore(obs(), T0 - 999_999).accepted, true);
  assert.equal(r.t.pool(KEY).limitEpochAt, T0 - 999_999, 'continuity is published');

  r.advance(1_000);
  r.t.ingest(obs({
    observedAt: r.at(), receivedAt: r.at(), sourceSequence: 9,
    windows: [win({ usedPercent: null, remainingPercent: null })]
  }));
  const p = r.t.pool(KEY);
  assert.notEqual(p.state, 'RECOVERING', 'an incomplete reading cannot start a recovery off restored data');
  assert.notEqual(p.state, 'LIMITED', 'nor re-assert a refusal nothing live has stated');
  assert.equal(p.stateReason, REASON.NO_NUMBERS, 'it classifies from the LIVE reading alone');
  assert.equal(p.recoveryPending, false, 'and no restored hint was consumed');
  assert.equal(p.limitEpochAt, T0 - 999_999, 'while continuity identity survives, unconfirmed');
});

test('WIRE: live hard evidence adopts the carried identity rather than minting a new one', () => {
  // The other half: continuity must actually be USED when live evidence re-opens
  // the refusal, or persisting it bought nothing.
  const r = proc();
  r.t.restore(obs(), T0 - 999_999);
  r.advance(1_000);
  r.t.ingest(obs({
    observedAt: r.at(), receivedAt: r.at(), sourceSequence: 9,
    providerReachedType: 'rate_limit_reached'
  }));
  const p = r.t.pool(KEY);
  assert.equal(p.state, 'LIMITED', 'the live refusal classifies');
  assert.equal(p.limitEpochAt, T0 - 999_999, 'under the ORIGINAL identity, not a new one');
});

test('WIRE: affirmative live permission ends the carried identity', () => {
  // And it must be endable, or a restored number becomes permanent.
  const r = proc();
  r.t.restore(obs(), T0 - 999_999);
  r.advance(1_000);
  r.t.ingest(obs({
    observedAt: r.at(), receivedAt: r.at(), sourceSequence: 9, ordinaryUsageAllowed: true
  }));
  assert.equal(r.t.pool(KEY).limitEpochAt, null, 'explicit permission closes it');
});
test('STORE: the file is bounded by the collection cap, omitting rather than trimming', () => {
  const p = proc();
  for (let i = 0; i < 20; i += 1) {
    p.t.ingest(obs({
      poolKey: `codex:acct-${i}:codex`, accountScope: `acct-${i}`,
      windows: [win({ label: 'L'.repeat(3_000) })]
    }));
  }
  const { text, written, omitted } = serializeCapacityStore(p.t, p.at());
  assert.ok(Buffer.byteLength(text, 'utf8') <= 256 * 1024, 'the store respects the collection cap');
  assert.ok(written > 0, 'and still carries what does fit');
  assert.equal(written + omitted, p.t.persistable().length, 'every pool is either written or omitted');
  for (const pool of JSON.parse(text).pools) {
    assert.equal(pool.observation.windows[0].label.length, 3_000, 'nothing was trimmed to fit');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The budget invariant this change could have broken silently
// ═══════════════════════════════════════════════════════════════════════════

test('BUDGET: adding a reason code did not move the timer-growth reserve', () => {
  // TIMER_GROWTH_RESERVE_PER_POOL is derived from widthSpread(REASON), so a new
  // member outside the existing [10, 29] character range would move the reserve,
  // move the collection ceiling, and invalidate every budget figure measured on
  // this floor - with no test failing that names the cause. Pinned on the
  // derivation rather than on the constant.
  assert.equal(TIMER_GROWTH_RESERVE_PER_POOL, 5 + 19 + 24 * 3);
  const lengths = Object.values(REASON).map((r) => r.length);
  assert.equal(Math.max(...lengths) - Math.min(...lengths), 19, 'the reason spread is unchanged');
  assert.equal(REASON.RESTORED.length, 20, 'and the new member sits inside both ends');
});

test('TAIL-BLINDNESS: a known pool going unobserved degrades to UNKNOWN, never to absent', () => {
  // The original L0-TAIL complaint, in-process: C2.6 wants UNKNOWN disclosed rather
  // than the pool disappearing. This already held while the process lived; it is
  // pinned here because the restart half is what made the whole thing observable.
  const p = proc();
  p.t.ingest(obs());
  p.advance(L0_SEM_POLICY.liveTtlMs + 1);
  p.t.evaluate();
  const pool = p.t.pool(KEY);
  assert.notEqual(pool, null, 'the pool is still disclosed');
  assert.equal(pool.state, 'UNKNOWN');
  assert.equal(pool.stateReason, REASON.STALE, 'as stale, which is a different fact from restored');
});
