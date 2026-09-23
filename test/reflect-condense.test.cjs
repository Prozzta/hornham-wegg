'use strict';

/**
 * Condensation end to end: the reflector, the injected hidden runner, and memory.md.
 *
 * The v1.1.46 path could accept free-form text scraped from an unrelated transcript and
 * write it into an agent's memory. These drive `reflectNow()` against a real fixture home
 * and assert the two halves that matter: a VALID structured payload condenses the file,
 * and every capture failure leaves `memory.md` BYTE-IDENTICAL with one `condense-abort`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryReflector, validateSummary, planEviction, buildCondensePrompt } = loadTs('src/main/reflect.ts');

const PINNED_HEADING = '## 📌 Durable facts (pinned — never condensed)';
const CONDENSED_HEADING = '## 🗜 Condensed history';
const RECENT_HEADING = '## Recent';

/** A memory.md well over the trigger, with pinned lines and many recent sections. */
function fixtureMemory() {
  const recent = [];
  for (let i = 0; i < 40; i++) {
    recent.push(`## day ${i}`);
    recent.push(`work item ${i}: ${'detail '.repeat(200)}`);
    recent.push('');
  }
  return [
    '# Andy memory',
    '',
    PINNED_HEADING,
    '- pinned: never lose this line',
    '',
    CONDENSED_HEADING,
    `previously condensed history ${'blah '.repeat(500)}`,
    '',
    RECENT_HEADING,
    ...recent
  ].join('\n');
}

/** A fixture harness home with one agent, plus a reflector wired to a stub runner. */
function fixture(runHidden) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-'));
  const agentDir = path.join(home, 'hive', 'agents', 'andy');
  fs.mkdirSync(agentDir, { recursive: true });
  const mem = path.join(agentDir, 'memory.md');
  fs.writeFileSync(mem, fixtureMemory());
  const logs = [];
  const reflector = new MemoryReflector(
    () => home,
    () => 'claude',
    () => ({}),
    () => ({ enabled: true, intervalMs: 60_000, byteTriggerPct: 50, sectionTrigger: 10, recentKeep: 5, minBytes: 1 }),
    (e) => logs.push(e),
    runHidden
  );
  return { home, mem, logs, reflector, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const okResult = (over = {}) => async () => ({
  ok: true,
  sessionId: '11111111-1111-4111-8111-111111111111',
  structuredOutput: { condensed: 'a much shorter history', hoist: ['- pinned: a new durable fact'] },
  result: '{"condensed":"a much shorter history","hoist":["- pinned: a new durable fact"]}',
  ...over
});

test('a valid STRUCTURED payload condenses the file and hoists the new pinned line', async () => {
  const f = fixture(okResult());
  const before = fs.readFileSync(f.mem, 'utf8');
  const [r] = await f.reflector.reflectNow('andy');
  assert.equal(r.condensed, true, r.reason);
  const after = fs.readFileSync(f.mem, 'utf8');
  assert.ok(after.length < before.length, 'the whole point is that it got smaller');
  assert.ok(after.includes('a much shorter history'));
  assert.ok(after.includes('- pinned: never lose this line'), 'existing pinned lines are byte-preserved');
  assert.ok(after.includes('- pinned: a new durable fact'), 'the hoist landed in the pinned block');
  assert.ok(f.logs.some((e) => e.kind === 'condense'), 'one success is logged');
  f.cleanup();
});

test('STRUCTURED BEATS PROSE: an unparseable `result` cannot spoil a valid structured output', async () => {
  // v1.1.46 parsed the prose and failed. The structured field is the contract now.
  const f = fixture(okResult({ result: 'Sure! Here is your condensed memory, hope it helps.' }));
  const [r] = await f.reflector.reflectNow('andy');
  assert.equal(r.condensed, true, r.reason);
  assert.ok(fs.readFileSync(f.mem, 'utf8').includes('a much shorter history'));
  f.cleanup();
});

test('WHOLE-RESULT COMPATIBILITY: no structured_output, but `result` is exactly the object', async () => {
  const f = fixture(async () => ({
    ok: true,
    result: '{"condensed":"a much shorter history","hoist":[]}'
  }));
  const [r] = await f.reflector.reflectNow('andy');
  assert.equal(r.condensed, true, r.reason);
  f.cleanup();
});

for (const [name, runHidden] of [
  ['a capture failure', async () => ({ ok: false, error: 'stdout was not JSON' })],
  ['a session id mismatch', async () => ({ ok: false, error: 'session id mismatch' })],
  ['a nonzero exit', async () => ({ ok: false, error: 'claude exited 3' })],
  ['a timeout', async () => ({ ok: false, error: 'hidden session timed out' })],
  ['an oversized capture', async () => ({ ok: false, error: 'stdout exceeded 1048576 bytes' })],
  ['a missing structured payload', async () => ({ ok: true, result: undefined, structuredOutput: undefined })],
  ['a structured payload of the wrong shape', async () => ({ ok: true, structuredOutput: { summary: 'wrong key' } })],
  ['prose with the JSON embedded in it', async () => ({ ok: true, result: 'Here you go: {"condensed":"x","hoist":[]}' })],
  ['a fenced result', async () => ({ ok: true, result: '```json\n{"condensed":"x","hoist":[]}\n```' })]
]) {
  test(`FAIL CLOSED: ${name} leaves memory.md byte-identical`, async () => {
    const f = fixture(runHidden);
    const before = fs.readFileSync(f.mem);
    const [r] = await f.reflector.reflectNow('andy');
    assert.equal(r.condensed, false);
    assert.deepEqual(fs.readFileSync(f.mem), before, 'the original memory must survive untouched');
    const aborts = f.logs.filter((e) => e.kind === 'condense-abort');
    assert.equal(aborts.length, 1, 'exactly one abort is recorded');
    assert.equal(aborts[0].reason, 'summarize-failed');
    f.cleanup();
  });
}

test('SAFETY UNCHANGED: a valid summary that is not smaller is still refused', async () => {
  const huge = 'x'.repeat(400_000);
  const f = fixture(async () => ({ ok: true, structuredOutput: { condensed: huge, hoist: [] } }));
  const before = fs.readFileSync(f.mem);
  const [r] = await f.reflector.reflectNow('andy');
  assert.equal(r.condensed, false);
  assert.deepEqual(fs.readFileSync(f.mem), before);
  assert.ok(f.logs.some((e) => e.kind === 'condense-abort' && e.reason === 'not-smaller'), `expected not-smaller, got ${JSON.stringify(f.logs)}`);
  f.cleanup();
});

test('the reflector passes ONE schema and the caller validates the same shape again', async () => {
  let seen = null;
  const f = fixture(async (_prompt, opts) => { seen = opts; return okResult()(); });
  await f.reflector.reflectNow('andy');
  assert.ok(seen.jsonSchema, 'a schema must reach the CLI');
  assert.equal(seen.jsonSchema.additionalProperties, false);
  assert.deepEqual([...seen.jsonSchema.required].sort(), ['condensed', 'hoist']);
  assert.ok(seen.disallowedTools.includes('Bash'), 'a pure text transform never shells out');
  f.cleanup();
});

// ─── validateSummary, the one gate in front of memory.md ───

test('validateSummary prefers structured output and refuses everything inexact', () => {
  assert.deepEqual(validateSummary({ condensed: 'a', hoist: ['b'] }), { condensed: 'a', hoist: ['b'] });
  assert.deepEqual(validateSummary(undefined, '{"condensed":"a","hoist":[]}'), { condensed: 'a', hoist: [] });
  // hoist is optional in practice but must be an array when present.
  assert.deepEqual(validateSummary({ condensed: 'a' }), { condensed: 'a', hoist: [] });
  assert.equal(validateSummary({ condensed: 'a', hoist: 'nope' }), null);

  for (const [structured, result, why] of [
    [undefined, undefined, 'nothing at all'],
    [undefined, '', 'an empty result'],
    [{ condensed: '   ' }, undefined, 'a blank summary'],
    [{ condensed: 42 }, undefined, 'a non-string summary'],
    [[{ condensed: 'a' }], undefined, 'an array'],
    ['{"condensed":"a","hoist":[]}', undefined, 'a JSON string instead of an object'],
    [undefined, 'prefix {"condensed":"a","hoist":[]}', 'a prefixed result'],
    [undefined, '{"condensed":"a","hoist":[]} suffix', 'a suffixed result'],
    [undefined, '```json\n{"condensed":"a","hoist":[]}\n```', 'a fenced result']
  ]) {
    assert.equal(validateSummary(structured, result), null, `must refuse ${why}`);
  }
});


// ─── the byte bound and the dig-out (condense-packaged-fail) ─────────────────
//
// WHAT THESE ENCODE. Packaged 1.1.47: god's 944 KB memory.md produced a condense
// prompt the model refused outright - terminal_reason 'prompt_too_long',
// api_error_status 400, "~313578 tokens (limit 200000)". Nothing bounded the prompt
// but the section COUNT, so its weight was whatever those sections happened to be,
// and every retry was refused for the same reason: the file could never recover.
// Now one pass carries a bounded chunk and the file walks down across passes.

/** Mirrors the module's private constants. If either moves, these tests should be
 *  read again rather than quietly re-baselined - they are the contract. */
const MAX_PROMPT_BYTES = 300_000;
const BUDGET_BYTES = 131_072;

const bytes = (t) => Buffer.byteLength(t, 'utf8');
const sect = (heading, body) => ({ heading, body });

/** n sections of roughly "each" bytes, oldest first. */
function sections(n, each = 10_000) {
  const body = 'detail '.repeat(Math.ceil(each / 7));
  return Array.from({ length: n }, (_, i) => sect('## day ' + i, 'item ' + i + ': ' + body));
}

/** A memory.md built from given sections, in the canonical three-region shape. */
function memoryOf(secs, { condensed = 'previously condensed history', pinned = '- pinned: never lose this line' } = {}) {
  return ['# Andy memory', '', PINNED_HEADING, pinned, '', CONDENSED_HEADING, condensed, '', RECENT_HEADING,
    ...secs.flatMap((x) => [x.heading, x.body, ''])].join('\n');
}

/** fixture(), but with memory content of our choosing. */
function fixtureWith(text, runHidden, settings = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-'));
  const agentDir = path.join(home, 'hive', 'agents', 'andy');
  fs.mkdirSync(agentDir, { recursive: true });
  const mem = path.join(agentDir, 'memory.md');
  fs.writeFileSync(mem, text);
  const logs = [];
  const reflector = new MemoryReflector(
    () => home, () => 'claude', () => ({}),
    () => ({ enabled: true, intervalMs: 60_000, byteTriggerPct: 50, sectionTrigger: 10, recentKeep: 5, minBytes: 1, ...settings }),
    (e) => logs.push(e),
    runHidden
  );
  return { home, mem, logs, reflector, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/** A runner that records every prompt it is given and returns a short summary. */
function recordingRunner(summary = 'a much shorter history') {
  const prompts = [];
  const run = async (prompt) => {
    prompts.push(prompt);
    return { ok: true, structuredOutput: { condensed: summary, hoist: [] } };
  };
  return { run, prompts };
}

test('planEviction: bounds ONE call by BYTES, and defers the rest instead of dropping it', () => {
  const secs = sections(100);                       // ~1 MB of backlog
  const plan = planEviction(null, null, secs);

  assert.ok(plan.fits, 'ordinary sections must fit');
  assert.ok(plan.take.length > 0 && plan.take.length < secs.length,
    'a 1 MB backlog must be split, not taken whole');
  assert.ok(plan.promptBytes <= MAX_PROMPT_BYTES,
    'THE regression: the prompt is bounded by bytes, not by section count');
  assert.deepEqual([...plan.take, ...plan.defer], secs,
    'take + defer must reconstruct the backlog EXACTLY - nothing may be lost in the split');
});

test('planEviction: measures the REAL prompt, not an estimate of it', () => {
  const plan = planEviction('some prior summary', '- pinned: x', sections(50));
  assert.equal(plan.promptBytes, bytes(buildCondensePrompt('some prior summary', plan.take, '- pinned: x')),
    'the planner and the call must build the same artifact, or the budget drifts');
});

test('planEviction: takes the OLDEST first, so the summary stays chronological', () => {
  const secs = sections(100);
  const plan = planEviction(null, null, secs);
  assert.equal(plan.take[0].heading, '## day 0');
  assert.equal(plan.defer[plan.defer.length - 1].heading, '## day 99');
});

test('planEviction: REFUSES when one atomic section alone exceeds the cap', () => {
  // A '## ' section is indivisible - splitting one puts half a thought in the summary
  // and orphans the other half. There is nothing to do but refuse.
  const plan = planEviction(null, null, [sect('## huge', 'x'.repeat(MAX_PROMPT_BYTES + 1))]);
  assert.equal(plan.fits, false);
  assert.equal(plan.take.length, 0, 'and it must not pretend to take it');
});

test('planEviction: REFUSES when the fixed overhead alone exceeds the cap', () => {
  // Not the same case: here the backlog is tiny and the CURRENT summary is the problem.
  const plan = planEviction('y'.repeat(MAX_PROMPT_BYTES + 1), null, sections(2, 100));
  assert.equal(plan.fits, false);
  assert.ok(plan.overheadBytes > MAX_PROMPT_BYTES, 'and it says which half did not fit');
});

test('DEFERRED SECTIONS SURVIVE A PASS BYTE-FOR-BYTE - the silent-data-loss regression', async () => {
  // rebuild() writes pinned + summary + kept sections. A section that this pass did NOT
  // summarize is in none of those unless it is explicitly carried over, so getting this
  // wrong eats memory quietly: the file shrinks, every check passes, and the content is
  // simply gone.
  //
  // Sized so ONE pass lands under budget while still deferring a remainder - otherwise
  // the loop correctly eats the deferred sections on a later pass and there is nothing
  // left to observe. (It ran green against a first draft of this test for exactly that
  // reason: the invariant is per-pass, so the assertion has to be per-pass too.)
  const secs = sections(38);
  const f = fixtureWith(memoryOf(secs), recordingRunner().run);
  const [r] = await f.reflector.reflectNow('andy');

  assert.equal(r.condensed, true, r.reason);
  assert.equal(r.passes, 1, 'this fixture must settle in ONE pass for the check below to mean anything');
  const row = f.logs.find((e) => e.kind === 'condense');
  assert.ok(row.deferred > 0, 'and it must actually defer something, or it proves nothing');

  const after = fs.readFileSync(f.mem, 'utf8');
  for (const x of secs.slice(row.evicted)) {
    // rebuild() right-trims each section, so compare the shape it actually writes.
    const want = (x.heading + '\n' + x.body).replace(/\s+$/, '');
    assert.ok(after.includes(want), 'section lost: ' + x.heading);
  }
  f.cleanup();
});

test('PRE-FLIGHT REFUSAL: an unfittable input fails NAMED, and spends no API call', async () => {
  const secs = [sect('## huge', 'x'.repeat(MAX_PROMPT_BYTES + 1)), ...sections(6, 1000)];
  let called = 0;
  const f = fixtureWith(memoryOf(secs), async () => { called++; return { ok: true }; });
  const before = fs.readFileSync(f.mem, 'utf8');
  const [r] = await f.reflector.reflectNow('andy');

  assert.equal(r.reason, 'prompt-too-large', 'NAMED - not a bare "claude exited 1"');
  assert.equal(r.condensed, false);
  assert.equal(called, 0, 'THE point: the refusal is free. Discovering this cost a 400 before.');
  assert.equal(fs.readFileSync(f.mem, 'utf8'), before, 'and the file is untouched');
  const abort = f.logs.find((e) => e.kind === 'condense-abort');
  assert.equal(abort.reason, 'prompt-too-large');
  assert.match(String(abort.detail), /exceeds the 300000 B cap/, 'the log says which limit and by how much');
  f.cleanup();
});

test('ITERATE: an oversized file digs DOWN UNDER BUDGET across passes', async () => {
  const secs = sections(80);                        // ~800 KB: unfixable in one call
  const rec = recordingRunner();
  const f = fixtureWith(memoryOf(secs), rec.run);
  const startBytes = bytes(fs.readFileSync(f.mem, 'utf8'));
  assert.ok(startBytes > MAX_PROMPT_BYTES, 'fixture must exceed one call to be the case under test');

  const [r] = await f.reflector.reflectNow('andy');

  assert.equal(r.condensed, true, r.reason);
  assert.ok(r.passes > 1, 'one call cannot do it - it must take several, got ' + r.passes);
  assert.equal(r.oldBytes, startBytes, 'oldBytes is the ORIGINAL size, not the last pass input');
  assert.ok(r.newBytes <= BUDGET_BYTES,
    'the whole objective: ' + startBytes + ' B -> ' + r.newBytes + ' B, under ' + BUDGET_BYTES);
  for (const prompt of rec.prompts) {
    assert.ok(bytes(prompt) <= MAX_PROMPT_BYTES, 'EVERY pass stays inside the cap, not just the first');
  }
  assert.ok(fs.readFileSync(f.mem, 'utf8').includes('- pinned: never lose this line'),
    'and the pinned line survives every pass');
  f.cleanup();
});

test('ITERATE: stops at the per-scan cap instead of monopolising the sweep', async () => {
  const f = fixtureWith(memoryOf(sections(300)), recordingRunner().run);   // ~3 MB
  const [r] = await f.reflector.reflectNow('andy');

  assert.equal(r.passes, 6, 'MAX_PASSES_PER_SCAN - the other agents get their turn');
  assert.ok(r.newBytes < r.oldBytes, 'progress is still real; the next tick resumes it');
  f.cleanup();
});

test('ITERATE: a pass that makes no progress stops the loop - never spins', async () => {
  // The rewrite is rejected (not-smaller), so condensed:false and the loop must end.
  const f = fixtureWith(memoryOf(sections(80)), async () => ({
    ok: true, structuredOutput: { condensed: 'z'.repeat(900_000), hoist: [] }
  }));
  const [r] = await f.reflector.reflectNow('andy');

  assert.equal(r.condensed, false);
  assert.equal(r.passes, 1, 'a refused rewrite must not be retried with the same input');
  f.cleanup();
});
