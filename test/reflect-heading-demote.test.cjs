'use strict';

/**
 * 1.1.47 fix3 — model-authored `## ` headings must never reach memory.md.
 *
 * THE BLOCKER (Jim, agents/jim-mtujpe28/god-recentmismatch-DIAG.md). `## ` is not
 * decoration in this file, it is the STRUCTURE: parseMemory carves the pinned/condensed/
 * recent regions and every section on it. So a summary line beginning `## ` does not
 * render a heading inside the condensed region - it ENDS that region and opens a new
 * section. The re-parse then counts more sections than the rewrite kept, verify refuses
 * its own correct output with `recent-count-mismatch`, and the file never condenses.
 * god's memory was intact and fully condensable the whole time; the rewrite was being
 * FALSELY REJECTED. Near-deterministic for a heading-rich take like god's, luck for
 * everyone else (Phyllis hit it at 20:53 and escaped it at 21:40).
 *
 * The fix is to DEMOTE, not to refuse: a refusal is re-emitted by the model on the next
 * attempt and the file stalls exactly as it does today. These tests therefore assert both
 * halves - that the round-trip now holds, AND that the content survived the demotion.
 *
 * The real memory.md never enters the repo. Every fixture here is synthetic god-shape.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryReflector, demoteHeadings, parseMemory, rebuild, mergePinned, pinnedLines } =
  loadTs('src/main/reflect.ts');

const PINNED_HEADING = '## 📌 Durable facts (pinned — never condensed)';
const CONDENSED_HEADING = '## 🗜 Condensed history';
const RECENT_HEADING = '## Recent';

/** god-SHAPE: a flat file of ~20 dated `## ` sections over the trigger, plus the tail
 *  that recentKeep will keep. Level-2 headings on purpose - parseMemory only carves `## `. */
function godShapeMemory({ sections = 20, pinned = ['- pinned: never lose this line'] } = {}) {
  const recent = [];
  for (let i = 0; i < sections; i++) {
    recent.push(`## 2026-09-${String(i + 1).padStart(2, '0')} day ${i}`);
    recent.push(`work item ${i}: ${'detail '.repeat(200)}`);
    recent.push('');
  }
  return [
    '# god memory',
    '',
    PINNED_HEADING,
    ...pinned,
    '',
    CONDENSED_HEADING,
    `previously condensed history ${'blah '.repeat(500)}`,
    '',
    RECENT_HEADING,
    ...recent
  ].join('\n');
}

function fixture(runHidden, memoryText = godShapeMemory()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-demote-'));
  const agentDir = path.join(home, 'hive', 'agents', 'god');
  fs.mkdirSync(agentDir, { recursive: true });
  const mem = path.join(agentDir, 'memory.md');
  fs.writeFileSync(mem, memoryText);
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

/** A stub model that returns exactly the summary a test wants to replay. */
const summaryOf = (condensed, hoist = []) => async () => ({
  ok: true,
  sessionId: '11111111-1111-4111-8111-111111111111',
  structuredOutput: { condensed, hoist },
  result: JSON.stringify({ condensed, hoist })
});

const aborts = (logs) => logs.filter((e) => e.kind === 'condense-abort');

// ─── the pure function ──────────────────────────────────────────────────────

test('demoteHeadings: demotes `## ` only, is idempotent, and preserves the text', () => {
  assert.equal(demoteHeadings('## Key decisions'), '### Key decisions');
  assert.equal(demoteHeadings('## 📌 facts'), '### 📌 facts');
  assert.equal(demoteHeadings('a\n## b\nc\n## d'), 'a\n### b\nc\n### d');
  // Idempotent: a second pass over already-safe text changes nothing.
  assert.equal(demoteHeadings(demoteHeadings('## x')), '### x');
  // Deeper headings and non-headings are NOT touched - the lookahead requires whitespace.
  assert.equal(demoteHeadings('### already'), '### already');
  assert.equal(demoteHeadings('#### deeper'), '#### deeper');
  assert.equal(demoteHeadings('##nospace'), '##nospace');
  assert.equal(demoteHeadings('text ## mid-line'), 'text ## mid-line');
  // Only at line start, and every line start.
  assert.equal(demoteHeadings('## a\n\n## b'), '### a\n\n### b');
  // The words are all still there: demotion changes structure, never content.
  assert.equal(demoteHeadings('## Key decisions').replace(/#/g, ''), ' Key decisions');
});

// ─── T1: the 21:38:29Z abort, replayed ──────────────────────────────────────

test('T1: a heading-bearing summary now CONDENSES - the exact failure that blocked 1.1.47', async () => {
  const f = fixture(summaryOf('Overview.\n\n## Key decisions\n- x\n\n## Outcomes\n- y'));
  const before = fs.readFileSync(f.mem, 'utf8');
  const parsedBefore = parseMemory(before);
  try {
    const res = await f.reflector.reflectNow('god');
    assert.equal(res?.[0]?.condensed, true,
      `must condense; aborts: ${JSON.stringify(aborts(f.logs).map((a) => a.reason))}`);
    assert.deepEqual(aborts(f.logs), [], 'and NOT abort with recent-count-mismatch');

    const after = fs.readFileSync(f.mem, 'utf8');
    const parsed = parseMemory(after);
    // The headings survived as level 3, INSIDE the condensed region…
    assert.match(parsed.condensed, /### Key decisions/, 'the heading is demoted, not deleted');
    assert.match(parsed.condensed, /### Outcomes/);
    assert.ok(!/\n## Key decisions/.test(after), 'and no level-2 heading reached the file');
    // …so the region did not end early and the section count is what the rewrite kept.
    assert.equal(parsed.recent.length, 5, 'recent.length == recentKeep, the count verify compares');
    assert.ok(parsed.recent.length < parsedBefore.recent.length, 'and the file actually shrank');
    // NO-LOSS ORACLE: every kept section is still there, byte for byte.
    for (const s of parsed.recent) assert.ok(before.includes(s.heading), `${s.heading} came from the original`);
  } finally { f.cleanup(); }
});

test('T1b: WITHOUT the demotion that same summary is rejected - the bug is real and this test sees it', () => {
  // Proving the mechanism directly, because the fix makes it unreachable through condense().
  // A `## ` line inside the condensed text ends the condensed region on re-parse and the
  // rest becomes extra sections - exactly +2 for the two headings below.
  const header = '# god memory';
  const pinned = ['- pinned: never lose this line'];
  const keep = parseMemory(godShapeMemory()).recent.slice(-5);
  const raw = 'Overview.\n\n## Key decisions\n- x\n\n## Outcomes\n- y';

  const broken = parseMemory(rebuild(header, pinned, raw, keep));
  assert.equal(broken.recent.length, keep.length + 2, 'the raw summary injects 2 phantom sections');

  const fixed = parseMemory(rebuild(header, pinned, demoteHeadings(raw), keep));
  assert.equal(fixed.recent.length, keep.length, 'demoted, the round-trip is exact');
});

// ─── T2: the hoist path ─────────────────────────────────────────────────────

test('T2: a `## ` HOIST line is demoted into the pinned block and round-trips', async () => {
  const f = fixture(summaryOf('a much shorter history', ['## durable fact']));
  try {
    const res = await f.reflector.reflectNow('god');
    assert.equal(res?.[0]?.condensed, true,
      `must condense; aborts: ${JSON.stringify(aborts(f.logs).map((a) => a.reason))}`);
    const after = fs.readFileSync(f.mem, 'utf8');
    const parsed = parseMemory(after);
    assert.match(parsed.pinned, /### durable fact/, 'the hoisted line is demoted');
    assert.ok(!/\n## durable fact/.test(after), 'no level-2 heading in the file');
    assert.match(parsed.pinned, /- pinned: never lose this line/, 'the old pinned line survives');
    assert.equal(parsed.recent.length, 5, 'and the recent count still matches');
  } finally { f.cleanup(); }
});

// ─── T3: the shadow hole ────────────────────────────────────────────────────

test('T3: a `## 📌` inside the summary can no longer SHADOW the pinned block', async () => {
  // The worst shape: the model emits the pinned block's own heading. Before the fix the
  // re-parse found the model's fragment where the real pinned region should be - and the
  // file was ACCEPTED, so the durable facts were silently replaced by the model's text.
  const f = fixture(summaryOf('history\n\n## 📌 facts\n- f'));
  try {
    const res = await f.reflector.reflectNow('god');
    assert.equal(res?.[0]?.condensed, true,
      `must condense; aborts: ${JSON.stringify(aborts(f.logs).map((a) => a.reason))}`);
    const after = fs.readFileSync(f.mem, 'utf8');
    const parsed = parseMemory(after);
    // The REBUILT pinned block is what is in the pinned region - not the model's fragment.
    assert.match(parsed.pinned, /- pinned: never lose this line/, 'the real durable fact is the pinned region');
    assert.ok(!parsed.pinned.includes('- f'), 'the model fragment did NOT become the pinned block');
    assert.match(parsed.condensed, /### 📌 facts/, 'it stayed in the condensed region, demoted');
    assert.equal(parsed.recent.length, 5);
    // And there is exactly ONE pinned heading in the file.
    assert.equal(after.split(PINNED_HEADING).length - 1, 1, 'exactly one pinned heading');
  } finally { f.cleanup(); }
});

// ─── T4: the property ───────────────────────────────────────────────────────

test('T4 PROPERTY: over a torture corpus, rebuild∘parseMemory always round-trips exactly', () => {
  const header = '# god memory';
  const oldPinned = ['- pinned: never lose this line'];
  const survivors = parseMemory(godShapeMemory()).recent.slice(-5);
  const CORPUS = [
    '',
    'plain prose with no structure at all',
    '## Key decisions',
    '### already safe',
    '#### deeper',
    '## 📌 Durable facts (pinned — never condensed)',
    '## 🗜 Condensed history',
    '## Recent',
    '## a\n## b\n## c',
    'lead\n\n## mid\n\ntail',
    '\n\n\n## after blank lines',
    '##nospace\n## space',
    'text ## not-at-line-start',
    '## trailing\n',
    '## 2026-09-01 dated like a real section\nbody\n\n## 2026-09-02 another\nbody'
  ];
  for (const raw of CORPUS) {
    for (const hoistRaw of ['', '## hoisted', '- ordinary line']) {
      const condensed = demoteHeadings(raw);
      const hoist = hoistRaw ? [demoteHeadings(hoistRaw)] : [];
      const merged = mergePinned(oldPinned, hoist);
      const parsed = parseMemory(rebuild(header, merged, condensed, survivors));
      assert.equal(parsed.recent.length, survivors.length,
        `recent count must survive: ${JSON.stringify(raw)} / ${JSON.stringify(hoistRaw)}`);
      assert.notEqual(parsed.condensed, null,
        `condensed region must exist: ${JSON.stringify(raw)}`);
      // The pinned region is always the block we merged, never a model fragment.
      for (const line of oldPinned) {
        assert.ok(parsed.pinned.includes(line), `pinned preserved: ${JSON.stringify(raw)}`);
      }
      assert.deepEqual(pinnedLines(parsed.pinned), merged, `pinned round-trips: ${JSON.stringify(raw)}`);
    }
  }
});

test('T4b: the SAME corpus without demotion is not round-trip safe - the property is load-bearing', () => {
  const header = '# god memory';
  const survivors = parseMemory(godShapeMemory()).recent.slice(-5);
  const offenders = ['## Key decisions', '## a\n## b\n## c', 'lead\n\n## mid\n\ntail'];
  for (const raw of offenders) {
    const parsed = parseMemory(rebuild(header, ['- p'], raw, survivors));
    assert.notEqual(parsed.recent.length, survivors.length,
      `${JSON.stringify(raw)} must break the round-trip when NOT demoted`);
  }
});

// ─── the system prompt hint ─────────────────────────────────────────────────

test('the CONDENSE_SYSTEM hint asks for `### `, and the prefix is still constant', () => {
  const { buildCondensePrompt } = loadTs('src/main/reflect.ts');
  const section = { heading: '## s', body: 'b' };
  const a = buildCondensePrompt('old', [section], 'pinned');
  const b = buildCondensePrompt('other', [section], 'pinned');
  assert.match(a, /Never start a line with "## "/, 'the model is told, as belt and braces');
  assert.match(a, /Use\n {2}"### " for any structure/);
  // Byte-identical instruction prefix across calls, so it still prompt-caches: the hint
  // must not have introduced anything dynamic.
  const prefix = (s) => s.slice(0, s.indexOf('Never start a line with "## "') + 40);
  assert.equal(prefix(a), prefix(b), 'the cached prefix is unchanged between calls');
});
