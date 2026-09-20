'use strict';

/**
 * L0-FUSION stage 5.4b - WHAT A PERSON IS TOLD about a queue that is not moving, and the
 * ONE human action that ends an INTERFERED hold.
 *
 * Three kinds of test, and what each is worth:
 *   - BEHAVIOURAL killers over src/shared/deliveryHold.ts (pure wording). Each takes the
 *     module under test, passes on the real one, and a named mutant must die at the
 *     assertion that names the guarantee. Expected wording rules are WRITTEN OUT here,
 *     never read back from the module.
 *   - A TOTALITY check: the wording table covers exactly the evidence labels main
 *     publishes, compared against a list written out here AND against main's own union.
 *   - STATIC wiring tripwires (index.ts, preload, the composer). These prove a literal
 *     shape in the source and no more; they are tripwires, not the guarantee. The
 *     guarantee that an INTERFERED hold has no timer and refuses "send now" is carried by
 *     the owner's behavioural killer `inhibitionHoldsUntilAHumanResolves`
 *     (test/automatic-submit.test.cjs). What cannot be proven under node:test - that the
 *     button really renders and really is a click - is owed to the electron harness (5.4c).
 *
 * Every source read goes through read-source.cjs (line-ending independent).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const SRC = 'src/shared/deliveryHold.ts';
const REAL = loadTs(SRC);

const EVIDENCE = [
  'NO_POOL', 'FRESH_HEALTHY', 'STALE_AFTER_HEALTHY', 'FRESH_NOT_HEALTHY', 'STALE_AFTER_LIMITED',
  'STALE_AFTER_UNHEALTHY', 'RECOVERING', 'NO_STATE', 'INDETERMINATE', 'UNCLASSIFIED',
  'SPENT_RESET_PASSED', 'LIMITED_NO_KNOWN_RESET'
];
/** The two holds with no exit but a person (revised L0-UNKNOWN ruling, cases c1 / c2). */
const ENDLESS = ['SPENT_RESET_PASSED', 'LIMITED_NO_KNOWN_RESET'];
/** Delivery flows on these, and NONE of them is a measured all-clear. */
const PROCEEDS_BUT_NOT_HEALTHY = ['NO_POOL', 'STALE_AFTER_HEALTHY', 'RECOVERING'];
const CLAIMS_HEALTH = /\bavailable\b|\bhealthy\b|\ballowed\b|\bok\b|\bfine\b/i;

const INTERFERED = { requestId: 'queue:alice:m1', reason: 'HUMAN_INPUT_AFTER_STAGE', at: 1 };
const input = (over = {}) => ({
  agentName: 'Alice', interfered: null, paused: false, headManual: false,
  capacityHold: false, capacityEvidence: null, ...over
});

const K = {};

K.noPoolIsOutsideCapacityGating = async (mod) => {
  assert.equal(mod.CAPACITY_WORDING.NO_POOL.state, 'outside capacity gating', 'NO_POOL is worded "outside capacity gating"');
  assert.equal(mod.capacityStateNote('NO_POOL'), 'outside capacity gating',
    'a MOVING queue with no pool still says it is outside capacity gating - silence would read as an all-clear');
  for (const e of PROCEEDS_BUT_NOT_HEALTHY) {
    assert.ok(!CLAIMS_HEALTH.test(mod.CAPACITY_WORDING[e].state), `${e} is NEVER worded as available or healthy: "${mod.CAPACITY_WORDING[e].state}"`);
    assert.ok(mod.capacityStateNote(e), `${e} is never passed over in silence while delivery flows`);
  }
  assert.equal(mod.capacityStateNote('FRESH_HEALTHY'), null, 'only a fresh measured all-clear needs no note');
  assert.equal(mod.capacityStateNote(null), null);
};

K.endlessHoldsSayThatSendNowIsTheWayOut = async (mod) => {
  for (const e of EVIDENCE) {
    const v = mod.deliveryHoldView(input({ capacityHold: true, capacityEvidence: e }));
    assert.equal(v.kind, 'CAPACITY');
    assert.equal(v.action, 'SEND_NOW', `a capacity hold (${e}) is released by "send now"`);
    assert.match(v.title, /send now/, `${e}: the title names "send now"`);
    assert.ok(v.hint.includes(mod.CAPACITY_WORDING[e].state), `${e}: the hint carries the state in words`);
    if (ENDLESS.includes(e)) {
      assert.equal(mod.CAPACITY_WORDING[e].endsByItself, false, `${e} NEVER ends by itself`);
      assert.match(v.hint, /nothing will lift this on its own/, `${e}: the hint says nothing will lift it`);
      assert.match(v.hint, /send now/, `${e}: the hint ITSELF names the way out, not only the tooltip`);
      assert.match(v.title, /NOTHING AUTOMATIC WILL RELEASE IT/, `${e}: the title does not promise a release`);
    } else {
      assert.equal(mod.CAPACITY_WORDING[e].endsByItself, true, `${e} can end by itself`);
      assert.ok(!/nothing will lift/.test(v.hint), `${e}: an ordinary hold is not called endless`);
    }
  }
  assert.equal(mod.CAPACITY_WORDING.SPENT_RESET_PASSED.state, 'spent, reset passed, no refusal', 'c1 in god’s words');
  assert.equal(mod.CAPACITY_WORDING.LIMITED_NO_KNOWN_RESET.state, 'limited, no known reset', 'c2 in god’s words');
  const unknown = mod.deliveryHoldView(input({ capacityHold: true, capacityEvidence: null }));
  assert.equal(unknown.kind, 'CAPACITY', 'a hold with no evidence attached is STILL shown as a hold');
};

K.interferedOutranksEverythingAndIsNeverSendNow = async (mod) => {
  for (const over of [{}, { paused: true }, { capacityHold: true, capacityEvidence: 'SPENT_RESET_PASSED' }, { headManual: true },
    { paused: true, capacityHold: true, capacityEvidence: 'NO_POOL', headManual: true }]) {
    const v = mod.deliveryHoldView(input({ interfered: INTERFERED, ...over }));
    assert.equal(v && v.kind, 'INTERFERED', `INTERFERED outranks every other hold (${JSON.stringify(over)})`);
    assert.equal(v.action, 'RESOLVE_INTERFERENCE', 'INTERFERED is ended by a human resolving it - NEVER by "send now"');
    assert.match(v.title, /Nothing was submitted and nothing was erased/, 'the person is told their text is intact');
    assert.match(v.title, /does not time out/, 'and that nothing will lift it for them');
  }
};

K.sendNowBypassesPauseAndCapacityOnly = async (mod) => {
  assert.equal(mod.deliveryHoldView(input({ paused: true, capacityHold: true, capacityEvidence: 'FRESH_NOT_HEALTHY', headManual: true })), null,
    'a head released with "send now" is not shown as held by the pause or by capacity');
  assert.equal(mod.deliveryHoldView(input({ paused: true })).kind, 'PAUSED');
  assert.equal(mod.deliveryHoldView(input({ paused: true, capacityHold: true, capacityEvidence: 'NO_STATE' })).kind, 'PAUSED',
    'a person’s pause is named before capacity');
  assert.equal(mod.deliveryHoldView(input()), null, 'nothing held, nothing said');
  assert.equal(mod.deliveryHoldView(input({ capacityEvidence: 'FRESH_NOT_HEALTHY' })), null,
    'EVIDENCE alone never makes a hold: only main’s `capacityHold` does');
};

K.onlyTheHeldQueueRowIsFlagged = async (mod) => {
  assert.equal(mod.isHeldQueueItem(INTERFERED, 'm1'), true);
  assert.equal(mod.isHeldQueueItem(INTERFERED, 'm10'), false);
  assert.equal(mod.isHeldQueueItem(INTERFERED, '1'), false, 'a suffix of the id is not the id');
  assert.equal(mod.isHeldQueueItem(null, 'm1'), false);
  assert.equal(mod.isHeldQueueItem({ ...INTERFERED, requestId: 'wake:alice:m1' }, 'm1'), false,
    'a worker wake held under INTERFERED flags NO queue row');
};

const MUTANTS = [
  { name: 'no pool worded as available',
    edits: [["  NO_POOL: { state: 'outside capacity gating', endsByItself: true },", "  NO_POOL: { state: 'provider capacity available', endsByItself: true },"]],
    killer: 'noPoolIsOutsideCapacityGating', dies: /NO_POOL is worded "outside capacity gating"/ },
  { name: 'a stale all-clear worded healthy',
    edits: [["state: 'capacity reading is stale; the last one was an all-clear'", "state: 'capacity healthy (stale reading)'"]],
    killer: 'noPoolIsOutsideCapacityGating', dies: /STALE_AFTER_HEALTHY is NEVER worded as available or healthy/ },
  { name: 'a moving no-pool queue passed over in silence',
    edits: [["  if (!evidence || evidence === 'FRESH_HEALTHY') return null;", "  if (!evidence || evidence === 'FRESH_HEALTHY' || evidence === 'NO_POOL') return null;"]],
    killer: 'noPoolIsOutsideCapacityGating', dies: /silence would read as an all-clear/ },
  { name: 'an endless hold worded as one that will lift',
    edits: [["  SPENT_RESET_PASSED: { state: 'spent, reset passed, no refusal', endsByItself: false },", "  SPENT_RESET_PASSED: { state: 'spent, reset passed, no refusal', endsByItself: true },"]],
    killer: 'endlessHoldsSayThatSendNowIsTheWayOut', dies: /SPENT_RESET_PASSED NEVER ends by itself/ },
  { name: 'the way out left to the tooltip',
    edits: [[": nothing will lift this on its own — use \"send now\"`,",': nothing will lift this on its own`,']],
    killer: 'endlessHoldsSayThatSendNowIsTheWayOut', dies: /the hint ITSELF names the way out/ },
  { name: 'INTERFERED offered "send now"',
    edits: [["      action: 'RESOLVE_INTERFERENCE'\n", "      action: 'SEND_NOW'\n"]],
    killer: 'interferedOutranksEverythingAndIsNeverSendNow', dies: /NEVER by "send now"/ },
  { name: 'a manual head hides INTERFERED',
    edits: [['  if (i.interfered) {', '  if (i.interfered && !i.headManual) {']],
    killer: 'interferedOutranksEverythingAndIsNeverSendNow', dies: /INTERFERED outranks every other hold/ },
  { name: 'the pause outranks INTERFERED',
    edits: [['  if (i.interfered) {', '  if (i.interfered && !i.paused) {']],
    killer: 'interferedOutranksEverythingAndIsNeverSendNow', dies: /INTERFERED outranks every other hold/ },
  { name: 'a released head still shown as capacity-held',
    edits: [['  if (i.capacityHold && !i.headManual) {', '  if (i.capacityHold) {']],
    killer: 'sendNowBypassesPauseAndCapacityOnly', dies: /is not shown as held by the pause or by capacity/ },
  { name: 'evidence alone makes a hold',
    edits: [['  if (i.capacityHold && !i.headManual) {', "  if ((i.capacityHold || i.capacityEvidence === 'FRESH_NOT_HEALTHY') && !i.headManual) {"]],
    killer: 'sendNowBypassesPauseAndCapacityOnly', dies: /EVIDENCE alone never makes a hold/ },
  { name: 'a worker wake flags a queue row',
    edits: [["interfered.requestId.startsWith('queue:') && ", '']],
    killer: 'onlyTheHeldQueueRowIsFlagged', dies: /flags NO queue row/ }
];

for (const [name, killer] of Object.entries(K)) test(`killer on the real module: ${name}`, () => killer(REAL));

test('the wording table is TOTAL over exactly the evidence labels main publishes', () => {
  assert.deepEqual(Object.keys(REAL.CAPACITY_WORDING).sort(), [...EVIDENCE].sort(), 'against the list written out in this test');
  const unionOf = (file, anchor) => {
    const text = readSource(file);
    const at = text.indexOf(anchor);
    assert.ok(at >= 0, `${file}: anchor found`);
    const decl = text.slice(at, text.indexOf(';', at));
    return [...decl.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  };
  for (const [file, anchor] of [
    ['src/main/automaticSubmit.ts', 'export type CapacityEvidence ='],
    ['src/main/control.ts', 'capacityEvidence?:'],
    ['src/preload/index.ts', 'capacityEvidence?:'],
    [SRC, 'export type CapacityEvidenceName =']
  ]) assert.deepEqual(unionOf(file, anchor), [...EVIDENCE].sort(), `${file} publishes exactly these labels`);
  for (const w of Object.values(REAL.CAPACITY_WORDING)) assert.ok(w.state && typeof w.endsByItself === 'boolean');
});

// ── STATIC WIRING TRIPWIRES (a literal shape in the source; see the header) ───────────
// `codeOnly` comes from read-source.cjs: parser-based. (A regex stripper stood here first and
// could swallow real code as a comment - see the note there.)
const handlerBody = (text, channel) => {
  const at = text.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(at >= 0, `handler ${channel} exists`);
  return text.slice(at, text.indexOf('\n});', at));
};

test('main: the snapshot REPORTS the owner’s inhibition, and only a dedicated handler resolves it', () => {
  const index = codeOnly(readSource('src/main/index.ts'));
  const snapshot = handlerBody(index, 'control:snapshot');
  assert.match(snapshot, /automaticSubmit\.inhibition\(heldPty\)/, 'read from the ONE owner, not kept anywhere else');
  assert.ok(!/resolveInterference/.test(snapshot), 'a read of the state never resolves it');
  const resolve = handlerBody(index, 'autoSubmit:resolveInterference');
  assert.match(resolve, /automaticSubmit\.resolveInterference\(ptyId\)/);
  assert.ok(!/write|sendToOwner|submit\(|setTimeout|setInterval/.test(resolve), 'resolving types nothing, submits nothing and schedules nothing');
  assert.equal(index.split('.resolveInterference(').length - 1, 1, 'main has exactly ONE caller of resolveInterference: that handler - no timer, no expiry');
  const owner = codeOnly(readSource('src/main/automaticSubmit.ts'));
  const at = owner.indexOf('  resolveInterference(ptyId: string): boolean {');
  const body = owner.slice(at, owner.indexOf('\n  }\n', at));
  assert.ok(at >= 0 && !/safeWrite|deps\.write|enqueue|submit\(/.test(body), 'the owner’s resolve writes nothing and delivers nothing');
  assert.ok(!/setTimeout|setInterval/.test(owner.slice(owner.indexOf('  inhibition(ptyId'), at)), 'an inhibition has no timer');
});

test('renderer: resolveInterference is called from ONE place, a click', () => {
  const dir = path.resolve(__dirname, '..', 'src/renderer/src');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) && files.push(path.join(d, e.name)); };
  walk(dir);
  const callers = files.filter((f) => codeOnly(readSource(f)).includes('resolveInterference('));
  assert.deepEqual(callers.map((f) => path.basename(f)), ['MessageQueueComposer.tsx'], 'one file calls it');
  const composer = codeOnly(readSource(callers[0]));
  assert.equal(composer.split('resolveInterference(').length - 1, 1, 'once');
  assert.match(composer, /onClick=\{\(\) => \{ void window\.cth\.resolveInterference\(agent\.id\)/, 'from an onClick - never an effect, a timer or the drain');
  assert.match(composer, /hold\?\.action === 'RESOLVE_INTERFERENCE' && \(/, 'offered exactly when the hold view names it');
  assert.match(composer, /const releasable = !delivery\.interfered && \(delivery\.paused \|\| delivery\.capacityHold\);/,
    '"send now" is offered for a pause or a capacity hold and NEVER while INTERFERED');
  assert.ok(!/useDeliveryPaused/.test(composer), 'the pause-only poll is replaced, not kept beside the new one');
  const preload = codeOnly(readSource('src/preload/index.ts'));
  assert.match(preload, /resolveInterference: \(agentId: string\): Promise<boolean> =>\s*ipcRenderer\.invoke\('autoSubmit:resolveInterference', agentId\)/);
});

test('this file reads source only through read-source.cjs', () => {
  const me = codeOnly(readSource(__filename));
  assert.ok(!me.includes('fs.read' + 'File'), 'no direct file read of source');
});

// ── MUTANT CENSUS ─────────────────────────────────────────────────────────────────────
const MUTANT_DIR = path.join(__dirname, '.mutants-delivery-hold');

test('MUTANT CENSUS: every mutant applies exactly once, and dies at the assertion that names its guarantee', async (t) => {
  const source = readSource(SRC);
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, mutant] of MUTANTS.entries()) {
      await t.test(`mutant: ${mutant.name}`, async () => {
        assert.ok(K[mutant.killer], `killer ${mutant.killer} exists`);
        await K[mutant.killer](REAL);
        let text = source;
        for (const [from, to] of mutant.edits) {
          const hits = text.split(from).length - 1;
          assert.equal(hits, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE, matched ${hits}`);
          text = text.replace(from, () => to);
        }
        const file = path.join(MUTANT_DIR, `m${i}.ts`);
        fs.writeFileSync(file, text, 'utf8');
        const mod = loadTs(path.relative(path.resolve(__dirname, '..'), file));
        let died = null;
        try { await K[mutant.killer](mod); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong assertion`);
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});
