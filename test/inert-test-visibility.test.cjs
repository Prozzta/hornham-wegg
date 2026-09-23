'use strict';
/**
 * Inert test files must announce themselves in the SUMMARY counters.
 *
 * The defect class: `node --test` puts a skipped SUITE under `# suites`, and a whole
 * framework-less file under `# tests`, but neither ever reaches `# skipped`. So a gate
 * that could not run produced `tests 0 / fail 0 / skipped 0`, and a platform-inert file
 * produced a bare `ok 1` with no marker at all — both identical, in every number a reader
 * actually checks, to a gate that ran and held. An absence that reads as health.
 *
 * Three files were inert this way: test/wake-bundle-pins.test.cjs (GATE-3, when out/ is
 * absent), test/proc-kill.test.cjs (on win32) and test/quit-sweep.electron.test.cjs (off
 * win32). These tests pin the helper, pin all three call sites, and — because a pin on
 * source could pass while the counter still said nothing — spawn a real `node --test` and
 * assert the skip actually lands in `# skipped`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { announceInert } = require('./tools/inert.cjs');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/** Capture what announceInert registers, without registering anything real. */
function spy() {
  const calls = [];
  return { calls, test: (name, opts, fn) => calls.push({ name, opts, fn }) };
}

test('announceInert registers exactly one skipped test carrying the reason', () => {
  const s = spy();
  announceInert('the thing', 'because the build is absent', { test: s.test });
  assert.strictEqual(s.calls.length, 1);
  const { name, opts, fn } = s.calls[0];
  assert.strictEqual(name, 'the thing');
  assert.strictEqual(opts.skip, 'because the build is absent');
  assert.strictEqual(typeof fn, 'function');
  assert.strictEqual(fn(), undefined, 'the body must be a no-op — it is a marker, not a test');
});

test('an inert announcement without a reason is refused', () => {
  const s = spy();
  // An unexplained skip is the exact bug this helper exists to fix, so it must not be
  // possible to register one.
  assert.throws(() => announceInert('nameless reason', '', { test: s.test }), /reason/);
  assert.throws(() => announceInert('', 'a reason', { test: s.test }), /name/);
  assert.strictEqual(s.calls.length, 0);
});

test('it is a SKIP, never a failure - an inert file must not turn a checkout red', () => {
  const s = spy();
  announceInert('x', 'y', { test: s.test });
  const { opts } = s.calls[0];
  assert.ok(opts.skip, 'must be skip');
  assert.ok(!opts.todo, 'todo would misreport it as unfinished work');
  assert.ok(!('only' in opts));
});

for (const [file, why] of [
  ['test/proc-kill.test.cjs', 'inert on win32'],
  ['test/quit-sweep.electron.test.cjs', 'inert off win32']
]) {
  test(`PIN: ${file} announces its platform skip instead of exiting 0 silently`, () => {
    const src = read(file);
    assert.match(src, /announceInert\(/, `${file} (${why}) must announce its inert path`);
    // The regression: a bare exit on the guard path is counted as a PASS. Anchored to a
    // statement, so the comment explaining the old behaviour does not trip it.
    const guard = src.slice(0, src.indexOf('announceInert('));
    assert.ok(!/^\s*process\.exit\(0\)/m.test(guard),
      `${file} still exits 0 on the inert path, which node --test reports as ok 1`);
  });
}

test('PIN: GATE-3 keeps its deliberate suite skip AND announces the unbuilt case', () => {
  const src = read('test/wake-bundle-pins.test.cjs');
  assert.match(src, /describe\([^\n]*\{\s*skip:/, 'the suite-level skip is deliberate and stays');
  assert.match(src, /announceInert\(/, 'and the unbuilt case must reach # skipped');
});

test('PIN: GATE-3 announces only when out/ is ABSENT - a stale bundle is the pins’ own job', () => {
  const src = read('test/wake-bundle-pins.test.cjs');
  const at = src.indexOf('announceInert(');
  assert.ok(at > 0);
  // Guarded by `if (!built)`, so a BUILT tree registers nothing extra: the six pins run as
  // before and no audited baseline moves. Present-but-stale is not double-handled here.
  const before = src.slice(0, at);
  assert.match(before.slice(-400), /if \(!built\) \{/);
});

/** Run one test file under `node --test` and return its summary counters. */
function summarize(file) {
  // NODE_TEST_CONTEXT is inherited and makes the child refuse to run files ("run() is
  // being called recursively"), which would leave this assertion permanently vacuous -
  // the very failure mode under test. Strip it so the child is a real, independent run.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ['--test', file], { cwd: REPO, encoding: 'utf8', env });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const num = (k) => {
    const m = out.match(new RegExp(`^# ${k} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { out, status: res.status, tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped') };
}

test('END TO END: the platform-inert file of this OS reports # skipped, not a silent pass', () => {
  // Whichever of the mirrored pair is inert HERE - so this proves the real counter on
  // every platform, not just the one it was written on.
  const inert = process.platform === 'win32' ? 'test/proc-kill.test.cjs' : 'test/quit-sweep.electron.test.cjs';
  const s = summarize(inert);
  assert.strictEqual(s.fail, 0, `${inert} must not fail:\n${s.out}`);
  assert.strictEqual(s.skipped, 1, `${inert} must report one SKIP in the summary, got skipped=${s.skipped}:\n${s.out}`);
  assert.strictEqual(s.pass, 0, 'an inert file must not be counted as a pass');
  assert.match(s.out, /# SKIP /, 'and the reason must be visible in the stream');
});

test('END TO END: GATE-3 with no build reports # skipped rather than 0/0/0', (t) => {
  const built = fs.existsSync(path.join(REPO, 'out', 'main', 'index.js'));
  if (built) {
    // Self-consistency, and the whole point of this commit: in a BUILT tree GATE-3's
    // unbuilt path cannot be exercised in place, so this test says so in `# skipped`
    // rather than returning early and reporting a pass for an assertion it never made.
    return t.skip('out/ IS built here — GATE-3’s unbuilt path cannot be exercised in place');
  }
  const s = summarize('test/wake-bundle-pins.test.cjs');
  assert.strictEqual(s.fail, 0);
  assert.strictEqual(s.skipped, 1, `GATE-3 must report a skip when unbuilt, got skipped=${s.skipped}:\n${s.out}`);
});
