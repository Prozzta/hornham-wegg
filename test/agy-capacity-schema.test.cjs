'use strict';

/**
 * AGY 1.1.48 commit 1 - the Antigravity capacity schema and its strict normalizer.
 *
 * WHAT THIS PINS. One Antigravity statusline tick describes TWO allowance pools - a 3P
 * family for third-party models and a Gemini family for Gemini-branded ones - and the
 * normalizer must return both, together, or nothing at all. The design of record is
 * agents/dwight-mu32ztys/agy-1.1.48-DESIGN.md sections 1.1-1.2; the schema facts
 * (the `quota` map, `tool_use` as an `agent_state` VALUE, confirmation as `tool_use` +
 * `tool_confirmation_pending: true`, the quota-less `authenticating` boot tick) come
 * from Oscar's raw 1.2.8 captures and Jim's MF-1 correction.
 *
 * THE FIXTURE IS SYNTHETIC WHERE IT MATTERS. Its shape and numbers are a real 1.2.8
 * tick; its email and every path are fictitious, because the real captures carry a
 * person's address and home directory and a repository is not a place for either.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  normalizeAgyStatusLine, classifyAgyStatusLine, agyFamilyOfModel,
  AGY_QUOTA_KEYS, AGY_AGENT_STATES, AGY_DRIFT_CODES, AGY_RESET_TOLERANCE_MS,
  normalizeClaudeStatusLine, normalizeCodexRateLimits
} = loadTs('src/main/capacityNormalize.ts');
const { agyAccountScope, geminiHome } = loadTs('src/main/capacityScope.ts');
const { PROVIDER_IDS, OBSERVATION_SOURCES } = loadTs('src/shared/providerCapacity.ts');
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { loadCapacityStore, CAPACITY_STORE_VERSION } = loadTs('src/main/capacityPersistence.ts');

const FIXTURE = path.join(__dirname, 'fixtures', 'agy-statusline-1.2.8.json');
const EMAIL = 'fixture.person@example.invalid';
/** The instant the fixture's reset seconds were measured against. */
const RECEIVED = Date.parse('2026-09-22T09:44:03Z');
const SCOPE = 'agyscope0001';

const golden = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const run = (payload, receivedAt = RECEIVED) =>
  classifyAgyStatusLine({ payload, accountScope: SCOPE, receivedAt });
const tickOf = (payload, receivedAt = RECEIVED) =>
  normalizeAgyStatusLine({ payload, accountScope: SCOPE, receivedAt });
const driftOf = (payload) => {
  const c = run(payload);
  assert.equal(c.ok, false, 'expected a refusal');
  return c.driftCode;
};
/** Mutate a deep copy of the golden fixture. */
const mutated = (fn) => { const p = golden(); fn(p); return p; };

// ─── vocabulary ─────────────────────────────────────────────────────────────

test('vocabulary: antigravity is a provider and antigravity-status-line is a source', () => {
  assert.ok(PROVIDER_IDS.includes('antigravity'));
  assert.ok(OBSERVATION_SOURCES.includes('antigravity-status-line'));
  // The two older providers are untouched.
  assert.ok(PROVIDER_IDS.includes('claude') && PROVIDER_IDS.includes('codex'));
});

test('vocabulary: the measured agent_state set is CLOSED at exactly four values', () => {
  assert.deepEqual([...AGY_AGENT_STATES].sort(), ['authenticating', 'idle', 'tool_use', 'working']);
  assert.deepEqual([...AGY_QUOTA_KEYS], ['3p-5h', '3p-weekly', 'gemini-5h', 'gemini-weekly']);
});

// ─── the golden tick ────────────────────────────────────────────────────────

test('GOLDEN 1.2.8: exactly two pools, four exact windows, bound to Gemini', () => {
  // CASE-SENSITIVE ON PURPOSE. The model id below is the MEASURED display label,
  // byte for byte, and binding is `startsWith('Gemini ')`. If a future build reports
  // a slug or a lowercase id, this test must FAIL rather than silently bind that
  // model to 3P - so do not "fix" it by loosening the match.
  const p = golden();
  assert.equal(p.model.id, 'Gemini 3.8 Flash (High)');
  const t = tickOf(p);
  assert.ok(t, 'the golden tick must normalize');

  assert.equal(t.version, '1.2.8');
  assert.equal(t.activeLimitId, 'gemini');
  assert.equal(t.lifecycle, 'running');
  assert.deepEqual(t.observations.map((o) => o.poolKey),
    [`antigravity:${SCOPE}:3p`, `antigravity:${SCOPE}:gemini`]);
  assert.deepEqual(t.observations.map((o) => o.limitId), ['3p', 'gemini']);
  assert.deepEqual(t.observations.flatMap((o) => o.windows.map((w) => w.windowId)),
    ['3p-5h', '3p-weekly', 'gemini-5h', 'gemini-weekly']);
  assert.deepEqual(t.observations.flatMap((o) => o.windows.map((w) => w.kind)),
    ['FIVE_HOUR', 'SEVEN_DAY', 'FIVE_HOUR', 'SEVEN_DAY']);
  assert.deepEqual(t.observations.flatMap((o) => o.windows.map((w) => w.label)),
    ['5h', 'Weekly', '5h', 'Weekly']);
  assert.deepEqual(t.observations.flatMap((o) => o.windows.map((w) => w.windowMinutes)),
    [300, 10080, 300, 10080]);
});

test('GOLDEN 1.2.8: every per-observation field is exactly what the design specifies', () => {
  const t = tickOf(golden());
  for (const o of t.observations) {
    assert.equal(o.provider, 'antigravity');
    assert.equal(o.accountScope, SCOPE);
    assert.equal(o.source, 'antigravity-status-line');
    assert.equal(o.sourceVersion, '1.2.8', 'the provider version is RECORDED');
    assert.equal(o.observedAt, RECEIVED, 'no authoritative observation time: receipt time');
    assert.equal(o.receivedAt, RECEIVED);
    assert.equal(o.streamId, 'c7d28ffd-108c-451b-8029-fd8920993b71');
    assert.equal(o.sourceSequence, null);
    assert.equal(o.providerAttributedLimitingWindowId, null);
    assert.equal(o.providerReachedType, null);
    assert.equal(o.ordinaryUsageAllowed, null);
    for (const w of o.windows) assert.equal(w.applicability, 'APPLICABLE');
  }
  const g5 = t.observations[1].windows[0];
  assert.equal(g5.resetsAt, Date.parse('2026-09-22T14:27:03Z'), 'reset_time supplies resetsAt');
});

test('GOLDEN: the case-sensitivity is real - a slug-shaped id binds to 3P, not Gemini', () => {
  // The companion to the golden test's comment: this is the behaviour that makes a
  // future id-shape change FAIL the golden test instead of quietly passing.
  assert.equal(agyFamilyOfModel('gemini-3.8-flash'), '3p');
  assert.equal(agyFamilyOfModel('gemini 3.8 Flash (High)'), '3p');
  assert.equal(agyFamilyOfModel('Gemini 3.8 Flash (High)'), 'gemini');
});

// ─── family binding ─────────────────────────────────────────────────────────

test('BINDING: Claude and GPT models bind 3P; the MEASURED id wins over the display name', () => {
  for (const id of ['Claude Sonnet 5', 'GPT-5.6 Sol', 'Some Future Model']) {
    const t = tickOf(mutated((p) => { p.model.id = id; }));
    assert.equal(t.activeLimitId, '3p', id);
  }
  // A display label that disagrees with the id does not move the binding.
  const t = tickOf(mutated((p) => { p.model.id = 'Claude Sonnet 5'; p.model.display_name = 'Gemini 3.8 Flash (High)'; }));
  assert.equal(t.activeLimitId, '3p');
  // Binding picks the ACTIVE family only. Both pools are still returned.
  assert.equal(t.observations.length, 2);
});

// ─── conversion ─────────────────────────────────────────────────────────────

test('CONVERSION: 0, 0.5 and 1 convert exactly, and every pair sums to exactly 100', () => {
  for (const [f, remaining, used] of [[0, 0, 100], [0.5, 50, 50], [1, 100, 0]]) {
    const t = tickOf(mutated((p) => { p.quota['3p-5h'].remaining_fraction = f; }));
    const w = t.observations[0].windows[0];
    assert.equal(w.remainingPercent, remaining);
    assert.equal(w.usedPercent, used);
  }
  const t = tickOf(golden());
  for (const w of t.observations.flatMap((o) => o.windows)) {
    assert.equal(w.usedPercent + w.remainingPercent, 100, w.windowId);
  }
});

test('ZERO IS NUMERICAL, NOT CAUSAL: RESERVE_ONLY in the tracker, never LIMITED, never attributed', () => {
  const t = tickOf(mutated((p) => { p.quota['3p-5h'].remaining_fraction = 0; }));
  assert.equal(t.observations[0].providerAttributedLimitingWindowId, null);
  assert.equal(t.observations[0].providerReachedType, null);

  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => RECEIVED, () => 0);
  for (const o of t.observations) tracker.ingest(o);
  const p3 = tracker.pool(`antigravity:${SCOPE}:3p`);
  assert.equal(p3.state, 'RESERVE_ONLY', 'a fresh zero holds ordinary work');
  assert.notEqual(p3.state, 'LIMITED', 'AGY stated no refusal, so nothing may call it LIMITED');
  assert.deepEqual(p3.numericallyExhaustedWindowIds, ['3p-5h']);
  assert.equal(p3.providerAttributedLimitingWindowId, null);
  // The sibling family is untouched by its neighbour's zero.
  assert.equal(tracker.pool(`antigravity:${SCOPE}:gemini`).state, 'AVAILABLE');
});

// ─── all-or-nothing ─────────────────────────────────────────────────────────

test('ALL-OR-NOTHING: every quota-shape fault refuses the WHOLE tick, with its own drift code', () => {
  const cases = [
    ['missing family bucket', (p) => { delete p.quota['gemini-weekly']; }, 'quota-keys'],
    ['unknown fifth bucket', (p) => { p.quota['3p-monthly'] = { ...p.quota['3p-5h'] }; }, 'quota-keys'],
    ['quota is an array', (p) => { p.quota = Object.values(p.quota); }, 'quota-missing'],
    ['quota absent', (p) => { delete p.quota; }, 'quota-missing'],
    ['bucket is an array', (p) => { p.quota['3p-5h'] = [1]; }, 'bucket-keys'],
    ['bucket gains a field', (p) => { p.quota['3p-5h'].extra = 1; }, 'bucket-keys'],
    ['bucket loses a field', (p) => { delete p.quota['gemini-5h'].reset_in_seconds; }, 'bucket-keys'],
    ['fraction above 1', (p) => { p.quota['3p-5h'].remaining_fraction = 1.0000001; }, 'fraction'],
    ['fraction below 0', (p) => { p.quota['3p-5h'].remaining_fraction = -0.01; }, 'fraction'],
    ['fraction NaN', (p) => { p.quota['3p-5h'].remaining_fraction = NaN; }, 'fraction'],
    ['fraction Infinity', (p) => { p.quota['3p-5h'].remaining_fraction = Infinity; }, 'fraction'],
    ['fraction as a string', (p) => { p.quota['3p-5h'].remaining_fraction = '1'; }, 'fraction'],
    ['reset_time not a date', (p) => { p.quota['3p-5h'].reset_time = 'soon'; }, 'reset-time'],
    ['reset_time without offset', (p) => { p.quota['3p-5h'].reset_time = '2026-09-22T14:44:06'; }, 'reset-time'],
    ['reset_time impossible', (p) => { p.quota['3p-5h'].reset_time = '2026-02-31T99:00:00Z'; }, 'reset-time'],
    ['reset seconds negative', (p) => { p.quota['3p-5h'].reset_in_seconds = -1; }, 'reset-seconds'],
    ['reset seconds Infinity', (p) => { p.quota['3p-5h'].reset_in_seconds = Infinity; }, 'reset-seconds']
  ];
  for (const [name, fn, code] of cases) {
    const p = mutated(fn);
    assert.equal(tickOf(p), null, `${name}: must refuse the whole tick`);
    assert.equal(driftOf(p), code, `${name}: drift code`);
  }
});

test('ALL-OR-NOTHING: a fault in ONE family never publishes the other, healthy one', () => {
  // The half that parsed is exactly as suspect as the half that did not.
  const p = mutated((x) => { x.quota['gemini-weekly'].remaining_fraction = 2; });
  assert.equal(tickOf(p), null);
});

test('RESETS: disagreement over 5 s refuses; exactly 5 s passes', () => {
  const at5 = mutated((p) => { p.quota['3p-5h'].reset_in_seconds = 18003 - AGY_RESET_TOLERANCE_MS / 1000; });
  assert.ok(tickOf(at5), 'the boundary itself agrees');
  const over = mutated((p) => { p.quota['3p-5h'].reset_in_seconds = 18003 - 5.001; });
  assert.equal(tickOf(over), null);
  assert.equal(driftOf(over), 'reset-disagree');
  // The seconds are a CHECK, never a repair: a tick whose reset_time is missing is not
  // rescued by computing one from reset_in_seconds.
  assert.equal(tickOf(mutated((p) => { delete p.quota['3p-5h'].reset_time; })), null);
});

test('TOP-LEVEL TOLERANCE: an unknown display-only field is not drift', () => {
  const t = tickOf(mutated((p) => { p.brand_new_display_field = { anything: true }; }));
  assert.ok(t, 'new top-level properties are ignored');
});

test('VERSION: a changed version with an identical schema is ACCEPTED and RECORDED', () => {
  const t = tickOf(mutated((p) => { p.version = '1.3.0'; }));
  assert.ok(t);
  assert.equal(t.version, '1.3.0');
  assert.deepEqual(t.observations.map((o) => o.sourceVersion), ['1.3.0', '1.3.0']);
});

test('VERSION: missing, empty, non-string or absurd versions are drift', () => {
  for (const v of [undefined, '', 128, 'x'.repeat(65), 'has space']) {
    const p = mutated((x) => { if (v === undefined) delete x.version; else x.version = v; });
    assert.equal(driftOf(p), 'version', String(v));
  }
});

test('MODEL: a null, absent or blank model refuses the tick', () => {
  for (const fn of [(p) => { p.model = null; }, (p) => { delete p.model; }, (p) => { p.model.id = '  '; }]) {
    assert.equal(driftOf(mutated(fn)), 'model');
  }
});

// ─── lifecycle ──────────────────────────────────────────────────────────────

test('LIFECYCLE: idle, working, tool_use and confirmation map exactly', () => {
  const life = (fn) => tickOf(mutated(fn)).lifecycle;
  assert.equal(life((p) => { p.agent_state = 'idle'; }), 'idle');
  assert.equal(life((p) => { p.agent_state = 'working'; }), 'running');
  // tool_use is a STATE VALUE (MF-1). There is no boolean field of that name.
  assert.equal(life((p) => { p.agent_state = 'tool_use'; }), 'running');
  assert.equal(life((p) => { p.agent_state = 'tool_use'; p.tool_confirmation_pending = true; }),
    'waiting_for_confirmation');
  // An explicit false is the same as absent.
  assert.equal(life((p) => { p.agent_state = 'working'; p.tool_confirmation_pending = false; }), 'running');
});

test('LIFECYCLE: the real boot tick (authenticating, model null, no quota) yields NO tick', () => {
  // N-1 option (b): unknown at boot. Making authentication look active would recreate
  // the v1.1.46 false-active parked agent if the later idle tick were lost.
  const boot = {
    cwd: 'C:\\fixture-workspace', session_id: '', conversation_id: '', model: null,
    version: '1.2.8', product: 'antigravity', agent_state: 'authenticating', terminal_width: 80
  };
  assert.equal(tickOf(boot), null);
  assert.equal(driftOf(boot), 'authenticating');
  // ...and a hypothetical authenticating tick WITH a complete quota is still no tick.
  assert.equal(driftOf(mutated((p) => { p.agent_state = 'authenticating'; })), 'authenticating');
});

test('LIFECYCLE: an unknown agent_state or a non-boolean confirmation flag is drift', () => {
  assert.equal(driftOf(mutated((p) => { p.agent_state = 'thinking'; })), 'agent-state');
  assert.equal(driftOf(mutated((p) => { p.agent_state = 'Working'; })), 'agent-state');
  assert.equal(driftOf(mutated((p) => { delete p.agent_state; })), 'agent-state');
  assert.equal(driftOf(mutated((p) => { p.tool_confirmation_pending = 'true'; })), 'confirmation-flag');
  // The old mis-reading (a boolean `tool_use` field) is simply an unknown top-level key.
  assert.equal(tickOf(mutated((p) => { p.agent_state = 'idle'; p.tool_use = true; })).lifecycle, 'idle');
});

test('OPEN QUESTION, PINNED: `initializing` is outside the ratified set, so it is drift', () => {
  // Oscar's own BOOT captures contain `agent_state: 'initializing'` in 2 of 4 boots -
  // including COMPLETE ticks with a model and all four quota buckets - which the
  // design's "measured set is closed at four" did not list. Implemented exactly as
  // ratified (no tick, 'agent-state' drift): safe for wake, because lifecycle stays
  // UNKNOWN exactly as it does for `authenticating`. The cost is capacity dropped
  // while a session sits in `initializing`, and a drift diagnostic on about half of
  // all boots. Raised to god/Jim/Dwight 2026-09-23. If the set is widened, THIS test
  // is the one that must change - deliberately, not by accident.
  const p = mutated((x) => { x.agent_state = 'initializing'; });
  assert.equal(tickOf(p), null);
  assert.equal(driftOf(p), 'agent-state');
});

test('DRIFT CODES: every refusal names a code from the closed set, and carries nothing else', () => {
  const c = run(mutated((p) => { p.quota['3p-5h'].remaining_fraction = 9; }));
  assert.deepEqual(Object.keys(c).sort(), ['driftCode', 'ok', 'version']);
  assert.ok(AGY_DRIFT_CODES.includes(c.driftCode));
  assert.equal(c.version, '1.2.8');
  assert.deepEqual(run('not an object'), { ok: false, driftCode: 'not-object', version: null });
});

// ─── identity and redaction ─────────────────────────────────────────────────

test('REDACTION: no email, home, cwd or transcript path reaches a normalized record', () => {
  const blob = JSON.stringify(tickOf(golden()));
  for (const secret of [EMAIL, 'fixture-home', 'fixture-workspace', 'transcript', 'Google AI Pro']) {
    assert.ok(!blob.includes(secret), `leaked: ${secret}`);
  }
});

test('SCOPE: the email never affects the pool key - mutate it and nothing moves', () => {
  const a = tickOf(golden());
  const b = tickOf(mutated((p) => { p.email = 'someone.else@example.invalid'; }));
  const c = tickOf(mutated((p) => { delete p.email; }));
  assert.deepEqual(a.observations.map((o) => o.poolKey), b.observations.map((o) => o.poolKey));
  assert.deepEqual(a.observations.map((o) => o.poolKey), c.observations.map((o) => o.poolKey));
});

test('SCOPE: GEMINI_CLI_HOME wins when set; blank falls back to ~/.gemini', () => {
  assert.equal(geminiHome({ GEMINI_CLI_HOME: 'C:\\agy-home' }), 'C:\\agy-home');
  assert.equal(geminiHome({ GEMINI_CLI_HOME: '  C:\\agy-home  ' }), 'C:\\agy-home');
  assert.equal(geminiHome({ GEMINI_CLI_HOME: '   ' }), path.join(os.homedir(), '.gemini'));
  assert.equal(geminiHome({}), path.join(os.homedir(), '.gemini'));
});

test('SCOPE: a path hash - stable, short, and two homes are two scopes', () => {
  const a = agyAccountScope({ GEMINI_CLI_HOME: 'C:\\homes\\one\\.gemini' });
  assert.equal(a, agyAccountScope({ GEMINI_CLI_HOME: 'C:\\homes\\one\\.gemini' }));
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, agyAccountScope({ GEMINI_CLI_HOME: 'C:\\homes\\two\\.gemini' }));
  assert.ok(!a.includes('homes'), 'a hash, never the path');
});

test('SCOPE: the shared case rule - folded on a case-insensitive platform only', () => {
  const upper = agyAccountScope({ GEMINI_CLI_HOME: 'C:\\Homes\\One\\.gemini' });
  const lower = agyAccountScope({ GEMINI_CLI_HOME: 'c:\\homes\\one\\.gemini' });
  if (process.platform === 'win32' || process.platform === 'darwin') assert.equal(upper, lower);
  else assert.notEqual(upper, lower);
});

test('SCOPE: the shared symlink rule - a linked home resolves to its target\'s scope', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-scope-'));
  const real = path.join(root, 'real-home');
  const link = path.join(root, 'linked-home');
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, link, 'junction'); } catch (e) { t.skip(`cannot create a link here: ${e.code}`); return; }
  try {
    assert.equal(agyAccountScope({ GEMINI_CLI_HOME: link }), agyAccountScope({ GEMINI_CLI_HOME: real }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── sourceVersion through the tracker and the store ────────────────────────

test('sourceVersion: Claude and Codex normalizers emit null, never undefined', () => {
  const c = normalizeClaudeStatusLine({
    rateLimits: { five_hour: { used_percentage: 10, resets_at: 1800000000 } }, accountScope: 's', receivedAt: RECEIVED
  });
  const x = normalizeCodexRateLimits({
    rateLimits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1800000000 } },
    accountScope: 's', receivedAt: RECEIVED, source: 'codex-account-read'
  });
  assert.equal(c.sourceVersion, null);
  assert.equal(x.sourceVersion, null);
  assert.ok('sourceVersion' in c && 'sourceVersion' in x, 'present, not merely falsy');
});

test('sourceVersion: the tracker COPIES it into the published projection, and a change republishes', () => {
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => RECEIVED, () => 0);
  const t1 = tickOf(golden());
  tracker.ingest(t1.observations[0]);
  const p1 = tracker.pool(`antigravity:${SCOPE}:3p`);
  assert.equal(p1.sourceVersion, '1.2.8');

  const later = RECEIVED + 1000;
  const t2 = normalizeAgyStatusLine({
    payload: mutated((p) => { p.version = '1.3.0'; }), accountScope: SCOPE, receivedAt: later
  });
  tracker.ingest(t2.observations[0]);
  const p2 = tracker.pool(`antigravity:${SCOPE}:3p`);
  assert.equal(p2.sourceVersion, '1.3.0', 'a new version with the same numbers is still recorded');
  assert.ok(p2.revision > p1.revision, 'and it is a real change to the projection');
});

test('sourceVersion: an older in-memory producer without the field publishes null, not undefined', () => {
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => RECEIVED, () => 0);
  const o = { ...tickOf(golden()).observations[0] };
  delete o.sourceVersion;
  tracker.ingest(o);
  assert.equal(tracker.pool(`antigravity:${SCOPE}:3p`).sourceVersion, null);
});

// The persisted shape an older (pre-1.1.48) build wrote: no sourceVersion key at all.
function storeWith(observationOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-store-'));
  const file = path.join(dir, 'capacity.json');
  const observation = {
    poolKey: 'codex:acct-a:codex', provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
    source: 'codex-account-read', streamId: null, sourceSequence: null,
    observedAt: RECEIVED, receivedAt: RECEIVED, windows: [],
    providerAttributedLimitingWindowId: null, providerReachedType: null,
    ordinaryUsageAllowed: null, planType: null, ...observationOverrides
  };
  for (const [k, v] of Object.entries(observationOverrides)) if (v === undefined) delete observation[k];
  fs.writeFileSync(file, JSON.stringify({
    version: CAPACITY_STORE_VERSION, savedAt: RECEIVED, pools: [{ observation, continuitySince: null }]
  }));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('STORE MIGRATION: a pre-1.1.48 record with NO sourceVersion key loads as null', () => {
  const s = storeWith({});
  try {
    const pools = loadCapacityStore(s.file);
    assert.equal(pools.length, 1, 'an old store is still a valid store');
    assert.equal(pools[0].observation.sourceVersion, null, 'absent migrates to null - never inferred');
  } finally { s.cleanup(); }
});

test('STORE: a present version round-trips; a present but malformed one rejects the store', () => {
  const good = storeWith({ sourceVersion: '1.2.8' });
  const bad = storeWith({ sourceVersion: 128 });
  const huge = storeWith({ sourceVersion: 'x'.repeat(10_000) });
  try {
    assert.equal(loadCapacityStore(good.file)[0].observation.sourceVersion, '1.2.8');
    assert.deepEqual(loadCapacityStore(bad.file), [], 'present-but-wrong is not an old file');
    assert.deepEqual(loadCapacityStore(huge.file), [], 'and an unbounded one is refused');
  } finally { good.cleanup(); bad.cleanup(); huge.cleanup(); }
});
