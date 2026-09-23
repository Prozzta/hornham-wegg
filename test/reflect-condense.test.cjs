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

const { MemoryReflector, validateSummary, planEviction, buildCondensePrompt, splitSection, partitionsExactly } = loadTs('src/main/reflect.ts');

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

test('planEviction: a single LINE over the cap is refused - it is the one thing that cannot split', () => {
  // Sections are no longer atomic (the god canary), but a single line still is: cutting
  // one mid-line would put half a thought in the summary and orphan the other half.
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

// PRE-FLIGHT REFUSAL moved: see T6 (all-unfittable -> named refusal, 0 calls) and T5
// (an unfittable line is passed over while fittable units behind it are taken).

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


// ─── oversized sections (1.1.47 re-cut blocker, god's canary) ───────────────
//
// WHAT THESE ENCODE. On the installed re-cut god's memory would not condense: one `## `
// section of 355,645 B (312 bullets) sat at the THIRD-oldest position. Sections were
// atomic, so the planner took the two small sections ahead of it and stopped; the pass
// shrank the file ~11 KB; the whole-file not-smaller rule (5%) rejected it; and the file
// could never move again. Spec: agents/jim-mtujpe28/god-notsmaller-DIAG.md sections 3-4
// (T1-T10). god's REAL memory is never a fixture here - it is an agent's private memory;
// the god SHAPE is rebuilt synthetically (T4) and the frozen copy is replayed locally.

const UNIT_MAX = 40_000;

/** A section of `n` UNIQUE bullets of ~`each` bytes, some with continuation lines. */
function bulletSection(heading, n, each = 1100) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(`- ${heading.slice(3, 20)} bullet ${i}: ${'recorded detail '.repeat(Math.ceil(each / 16))}`);
    if (i % 5 === 0) lines.push(`  continuation of bullet ${i} that must stay with it`);
  }
  return sect(heading, lines.join('\n'));
}

/** `n` sections whose headings AND bodies are unique to `tag` - never a duplicate of
 *  another call's content, so "this one was taken" cannot be satisfied by a twin. */
const uniqueSections = (tag, n, each = 5000) => Array.from({ length: n }, (_, i) =>
  sect(`## ${tag} ${i}`, `${tag} entry ${i}: ${'unique detail '.repeat(Math.ceil(each / 14))}`));

/** A section whose body is ONE line longer than any unit. */
const giantLine = (heading, bytes = 60_000) => sect(heading, `one indivisible line ${'x'.repeat(bytes)}`);

/**
 * THE NO-LOSS ORACLE (T2). Every non-blank input line is EITHER verbatim in the final
 * file - in its original relative order - OR present in a prompt the stub received.
 * Pinned lines must be in the file. This does not trust the reflector's own bookkeeping.
 */
function assertNoLoss(inputText, finalText, prompts, pinned = ['- pinned: never lose this line']) {
  const promptText = prompts.join('\n');
  const finalLines = finalText.split('\n').map((l) => l.trimEnd());
  const skip = new Set([PINNED_HEADING, CONDENSED_HEADING, RECENT_HEADING]);
  let cursor = 0;
  let checked = 0;
  for (const raw of inputText.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim() || skip.has(line)) continue;
    checked++;
    const at = finalLines.indexOf(line, cursor);
    if (at >= 0) { cursor = at + 1; continue; }
    assert.ok(promptText.includes(line), `LOST - in neither the file nor any prompt: ${line.slice(0, 90)}`);
  }
  for (const p of pinned) assert.ok(finalLines.includes(p), `pinned line not verbatim: ${p}`);
  assert.ok(checked > 0);
}

test('SPLIT: an oversized multi-line section splits at bullet boundaries, losslessly', () => {
  const s = bulletSection('## 2026-09-10 Mission 2 COMPLETE', 312, 1100);
  const parts = splitSection(s, UNIT_MAX);
  assert.ok(parts.length > 1, 'it must split');
  for (const p of parts) {
    assert.ok(p.fittable, 'every part of a bullet section fits');
    assert.ok(Buffer.byteLength(`${p.section.heading}\n${p.section.body}`, 'utf8') <= UNIT_MAX);
  }
  assert.equal(parts[0].section.heading, s.heading, 'unit 1 keeps the original heading');
  parts.slice(1).forEach((p, i) => {
    assert.equal(p.section.heading, `${s.heading} (continued ${i + 2}/${parts.length})`);
  });
  assert.equal(parts.map((p) => p.section.body).join('\n'), s.body, 'the bodies join back EXACTLY');
  for (const p of parts.slice(1)) {
    assert.ok(!/^\s/.test(p.section.body), 'no unit starts mid-bullet: continuations stay with their bullet');
  }
});

test('SPLIT: a section under the unit size is untouched - the same object', () => {
  const s = sect('## small', 'a\nb\nc');
  const parts = splitSection(s, UNIT_MAX);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].section, s);
});

test('SPLIT: a single line over the unit size is ONE unfittable unit - never cut mid-line', () => {
  const parts = splitSection(giantLine('## huge'), UNIT_MAX);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].fittable, false);
});

test('SPLIT: a trailing blank line never becomes a unit of its own (the empty-unit bug)', () => {
  // Through the parser, a section body ends with a newline. The first cut of the splitter
  // turned that blank line into a whitespace-only "(continued 2/2)" unit: fittable, so it
  // was TAKEN - a call spent summarising nothing, counted as progress, forever.
  for (const body of [`${'x'.repeat(60_000)}\n`, `${'x'.repeat(60_000)}\n\n\n`, `\n\n${'x'.repeat(60_000)}\n`]) {
    const parts = splitSection(sect('## huge', body), UNIT_MAX);
    assert.equal(parts.length, 1, JSON.stringify(parts.map((p) => p.section.body.length)));
    assert.equal(parts[0].fittable, false);
  }
  const big = bulletSection('## b', 360, 1100);
  const parts = splitSection(sect(big.heading, `${big.body}\n\n\n`), UNIT_MAX);
  for (const p of parts) assert.ok(p.section.body.trim(), 'no whitespace-only unit, ever');
});

test('planEviction: REFUSES only when the unfittable piece is a single LINE', () => {
  // A multi-line section of the same size is NOT refused - it splits (T1).
  const plan = planEviction(null, null, [bulletSection('## big', 400, 1100)]);
  assert.equal(plan.fits, true, 'a big multi-bullet section is splittable, so it fits');
  assert.equal(plan.splitSections, 1);
});

for (const where of ['oldest', 'middle']) {
  test(`T1 (${where}): ONE ~400 KB multi-bullet section converges under budget`, async () => {
    const big = bulletSection('## 2026-09-10 the giant', 360, 1100);
    const secs = where === 'oldest'
      ? [big, ...sections(20, 5000)]
      : [...sections(10, 5000), big, ...sections(10, 5000)];
    const text = memoryOf(secs);
    const rec = recordingRunner();
    const f = fixtureWith(text, rec.run);
    const [r] = await f.reflector.reflectNow('andy');

    assert.equal(r.condensed, true, r.reason);
    assert.ok(r.newBytes <= BUDGET_BYTES, `converged: ${r.oldBytes} -> ${r.newBytes}`);
    assert.ok(r.passes <= 6, `within the pass cap: ${r.passes}`);
    for (const p of rec.prompts) assert.ok(bytes(p) <= MAX_PROMPT_BYTES, 'EVERY pass inside the cap');
    assert.ok(f.logs.some((e) => e.kind === 'condense' && e.split >= 1), 'the splitter really ran');
    assertNoLoss(text, fs.readFileSync(f.mem, 'utf8'), rec.prompts);   // T2
    f.cleanup();
  });
}

test('T4: the god SHAPE (464 sections, index 2 = 312 bullets / ~355 KB, ~960 KB) converges, losing nothing', async () => {
  const secs = [];
  for (let i = 0; i < 464; i++) {
    if (i === 2) secs.push(bulletSection('## 2026-09-10 11:25 Mission 2 COMPLETE', 312, 1100));
    else secs.push(sect(`## day ${i}`, `entry ${i}: ${'routine standup detail '.repeat(57)}`));
  }
  const text = memoryOf(secs);
  assert.ok(bytes(text) > 900_000, `the shape is god-sized: ${bytes(text)}`);
  assert.ok(bytes(`${secs[2].heading}\n${secs[2].body}`) > 300_000, 'the giant alone is over the pass cap');
  const rec = recordingRunner();
  const f = fixtureWith(text, rec.run, { recentKeep: 12 });
  const [r] = await f.reflector.reflectNow('andy');

  assert.equal(r.condensed, true, r.reason);
  assert.ok(r.newBytes <= BUDGET_BYTES, `converged: ${r.oldBytes} -> ${r.newBytes} in ${r.passes} passes`);
  assert.ok(!f.logs.some((e) => e.kind === 'condense-abort'), `no abort: ${JSON.stringify(f.logs.filter((e) => e.kind === 'condense-abort'))}`);
  assertNoLoss(text, fs.readFileSync(f.mem, 'utf8'), rec.prompts);
  f.cleanup();
});

test('T5: a single line over the unit size is PASSED OVER in place; newer units still condense', async () => {
  const secs = [...uniqueSections('older', 5), giantLine('## the indivisible one'), ...uniqueSections('newer', 5),
    ...uniqueSections('kept', 5, 2000)];
  const text = memoryOf(secs);
  const rec = recordingRunner();
  const f = fixtureWith(text, rec.run);
  const [r] = await f.reflector.reflectNow('andy');

  assert.equal(r.condensed, true, r.reason);
  assert.equal(r.passes, 1, 'no loop');
  const after = fs.readFileSync(f.mem, 'utf8');
  const g = secs[5];
  assert.ok(after.includes(`${g.heading}\n${g.body}`), 'the giant line survives verbatim');
  for (const newer of secs.slice(6, 11)) {
    assert.ok(rec.prompts[0].includes(newer.body.trimEnd()), `a unit NEWER than the giant was still taken: ${newer.heading}`);
    assert.ok(!after.includes(newer.heading), `and it is gone from the file: ${newer.heading}`);
  }
  const kept = f.logs.filter((e) => e.kind === 'condense-oversize-kept');
  assert.equal(kept.length, 1, 'one named row per pass');
  assert.equal(kept[0].heading, '## the indivisible one');
  // In position: the giant still precedes the kept tail.
  assert.ok(after.indexOf(g.heading) < after.indexOf(secs[secs.length - 5].heading));
  f.cleanup();
});

test('T6 (was PRE-FLIGHT): when EVERY evictable unit is unfittable - named refusal, 0 calls, byte-identical', async () => {
  const secs = [giantLine('## huge', MAX_PROMPT_BYTES + 1), ...sections(5, 1000)];
  let called = 0;
  const f = fixtureWith(memoryOf(secs), async () => { called++; return { ok: true }; });
  const before = fs.readFileSync(f.mem, 'utf8');
  const [r] = await f.reflector.reflectNow('andy');

  assert.equal(r.reason, 'prompt-too-large', 'NAMED - not a bare "claude exited 1"');
  assert.equal(r.condensed, false);
  assert.equal(called, 0, 'the refusal is free');
  assert.equal(fs.readFileSync(f.mem, 'utf8'), before, 'and the file is untouched');
  const abort = f.logs.find((e) => e.kind === 'condense-abort');
  assert.equal(abort.reason, 'prompt-too-large');
  assert.match(String(abort.detail), /every evictable unit is a single line/, 'the log says why');
});

test('T7: unfittable content over budget ends NAMED (budget-unreachable); the next scan spends nothing', async () => {
  const secs = [...sections(10, 5000), giantLine('## g1'), giantLine('## g2'), giantLine('## g3'), ...sections(5, 1000)];
  let calls = 0;
  const run = async () => { calls++; return { ok: true, structuredOutput: { condensed: 'short', hoist: [] } }; };
  const f = fixtureWith(memoryOf(secs), run);
  const [r1] = await f.reflector.reflectNow('andy');
  assert.equal(r1.reason, 'budget-unreachable');
  assert.equal(r1.condensed, true, 'the fittable part WAS condensed this scan');
  assert.ok(f.logs.some((e) => e.kind === 'condense-abort' && e.reason === 'budget-unreachable'));
  const callsAfterFirst = calls;
  assert.ok(callsAfterFirst >= 1);

  const [r2] = await f.reflector.reflectNow('andy');
  assert.equal(calls, callsAfterFirst, 'a second scan makes ZERO calls');
  assert.equal(r2.reason, 'prompt-too-large');
  f.cleanup();
});

test('T8: per-pass not-smaller - a small REAL shrink is accepted (god\'s pass: 14.6 KB -> 4.9 KB)', async () => {
  // Two small evicted sections (~14.6 KB) ahead of a huge kept tail: the file shrinks ~1%,
  // which the old whole-file 5% rule rejected - permanently, on god's real memory.
  const secs = [...sections(2, 7300), ...sections(5, 150_000)];
  const f = fixtureWith(memoryOf(secs), async () => ({
    ok: true, structuredOutput: { condensed: 's'.repeat(4900), hoist: [] }
  }));
  await f.reflector.reflectNow('andy');
  assert.ok(f.logs.some((e) => e.kind === 'condense'), `accepted: ${JSON.stringify(f.logs.map((e) => e.reason || e.kind))}`);
  assert.ok(!f.logs.some((e) => e.reason === 'not-smaller'));
  f.cleanup();
});

test('T8: per-pass not-smaller - a summary that barely shrinks what it took is still REJECTED', async () => {
  // Takes ~14.6 KB and returns a 13 KB summary: the file shrinks, but by less than a
  // quarter of what was summarised. Not progress.
  const secs = [...sections(2, 7300), ...sections(5, 150_000)];
  const f = fixtureWith(memoryOf(secs), async () => ({
    ok: true, structuredOutput: { condensed: 's'.repeat(13_000), hoist: [] }
  }));
  const before = fs.readFileSync(f.mem, 'utf8');
  await f.reflector.reflectNow('andy');
  assert.ok(f.logs.some((e) => e.reason === 'not-smaller'));
  assert.equal(fs.readFileSync(f.mem, 'utf8'), before);
  f.cleanup();
});

test('T9: a split section\'s untaken units are written back - the plan partitions the backlog exactly', async () => {
  // The giant is too big for one pass, so part of it is taken and part deferred. The
  // deferred remainder must come back as (continued k/n) sections, every line intact.
  const big = bulletSection('## the giant', 360, 1100);
  const secs = [big, ...sections(5, 1000)];
  const text = memoryOf(secs);
  const plan = planEviction('previously condensed history', '- pinned: never lose this line', [big]);
  assert.ok(plan.take.length > 0 && plan.defer.length > 0, 'part taken, part deferred');
  assert.ok(plan.defer.every((d) => / \(continued \d+\/\d+\)$/.test(d.heading)), 'the remainder is (continued k/n)');
  assert.ok(partitionsExactly([big], plan.take, plan.defer), 'take + defer hold every line exactly once');

  const rec = recordingRunner();
  const f = fixtureWith(text, rec.run);
  await f.reflector.reflectNow('andy');
  assertNoLoss(text, fs.readFileSync(f.mem, 'utf8'), rec.prompts);
  f.cleanup();
});

test('T9: partitionsExactly catches a dropped unit and an invented one', () => {
  const big = bulletSection('## the giant', 360, 1100);
  const plan = planEviction(null, null, [big]);
  assert.equal(partitionsExactly([big], plan.take, plan.defer.slice(1)), false, 'a dropped unit');
  assert.equal(partitionsExactly([big], plan.take, [...plan.defer, sect('## x', 'invented')]), false, 'an invented line');
});

test('T10: N passes leave N DISTINCT backups, and the first is the original byte-for-byte', async () => {
  const text = memoryOf(sections(80));
  const f = fixtureWith(text, recordingRunner().run);
  const [r] = await f.reflector.reflectNow('andy');
  assert.ok(r.passes > 1);
  const root = path.join(f.home, 'hive', 'backups');
  const stamps = fs.readdirSync(root).sort();
  assert.equal(stamps.length, r.passes, `one backup per pass: ${stamps.join(', ')}`);
  assert.match(stamps[0], /-p1$/);
  assert.equal(fs.readFileSync(path.join(root, stamps[0], 'andy', 'memory.md'), 'utf8'), text,
    'the FIRST backup is the original - never overwritten by a later pass in the same second');
  f.cleanup();
});

test('REPORTING: a successful pass followed by nothing-to-evict still reports condensed:true', async () => {
  // Evict fits in one pass and the kept tail alone is over budget: pass 2 finds nothing to
  // evict. That is the normal end of a dig-out, not a failed scan.
  const secs = [...sections(3, 5000), ...sections(5, 40_000)];
  const f = fixtureWith(memoryOf(secs), recordingRunner().run);
  const [r] = await f.reflector.reflectNow('andy');
  assert.equal(r.condensed, true);
  assert.equal(r.reason, 'condensed');
  f.cleanup();
});

test('PASS-OVER vs UNTOUCHED: a splittable section entirely behind the cap point comes back in its ORIGINAL form', () => {
  // (continued k/n) headings exist to carry the REMAINDER of a section a pass partly took.
  // A section nobody touched is not fragmented just because it is big.
  const filler = uniqueSections('filler', 60, 5000);           // ~300 KB: the pass fills up on these
  const big = bulletSection('## the untouched giant', 120, 1100); // ~140 KB, splittable, never reached
  const plan = planEviction(null, null, [...filler, big]);
  assert.ok(plan.take.length > 0 && plan.take.length < filler.length + 1);
  assert.ok(plan.defer.includes(big), 'the big section is deferred as the SAME object');
  assert.ok(!plan.defer.some((d) => / \(continued \d+\/\d+\)$/.test(d.heading)), 'no fragments of an untouched section');
});
