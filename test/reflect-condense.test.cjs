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

const { MemoryReflector, validateSummary } = loadTs('src/main/reflect.ts');

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
