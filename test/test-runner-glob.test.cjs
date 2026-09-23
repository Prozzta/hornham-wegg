/**
 * The focused-suite runner (test/tools/run-tests.cjs).
 *
 * The defect this pins: `node --test test/*.test.cjs` reached cmd.exe unexpanded on
 * Windows + Node 20, matched nothing, and exited having run ZERO tests. Every count ever
 * quoted from that script was really produced by hand-expanding the list. So the tests
 * that matter here are the ones about EMPTINESS - a run that executes nothing must never
 * be able to look like a pass - plus a pin on the package.json script itself, which is
 * the only thing that stops the glob quietly coming back.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const runner = require('./tools/run-tests.cjs');
const { selectTestFiles, run } = runner;

const REPO = path.resolve(__dirname, '..');
const TEST_DIR = path.join(REPO, 'test');

/** A spawn stub that records its call and reports the given result. */
function fakeSpawn(result = { status: 0 }) {
  const calls = [];
  const spawn = (args, opts) => { calls.push({ args, opts }); return result; };
  return { spawn, calls };
}

function sink() {
  const lines = [];
  return { lines, write: (l) => lines.push(l) };
}

test('selectTestFiles takes every *.test.cjs and nothing else, sorted', () => {
  const { files, total } = selectTestFiles(
    ['zeta.test.cjs', 'alpha.test.cjs', 'tools', 'README.md', 'helper.cjs', 'thing.test.js']
  );
  assert.deepStrictEqual(files, ['alpha.test.cjs', 'zeta.test.cjs']);
  assert.strictEqual(total, 2);
});

test('filters narrow by case-insensitive substring, de-duplicated and sorted', () => {
  const entries = ['wake-cold-boot.test.cjs', 'wake-stall.test.cjs', 'canary-lock.test.cjs', 'queue.test.cjs'];
  const { files, unmatched, total } = selectTestFiles(entries, ['WAKE', 'wake-stall', 'canary']);
  assert.deepStrictEqual(files, ['canary-lock.test.cjs', 'wake-cold-boot.test.cjs', 'wake-stall.test.cjs']);
  assert.deepStrictEqual(unmatched, []);
  assert.strictEqual(total, 4);
});

test('a filter that matches nothing is reported, not silently dropped', () => {
  const { unmatched } = selectTestFiles(['a.test.cjs'], ['a', 'nope']);
  assert.deepStrictEqual(unmatched, ['nope']);
});

test('THE REGRESSION: an empty test directory exits NON-ZERO and never spawns', () => {
  const { spawn, calls } = fakeSpawn();
  const e = sink();
  const code = run({ testDir: 'test', readdir: () => ['README.md', 'tools'], spawn, err: e.write, log: () => {} });
  assert.notStrictEqual(code, 0, 'a run that executed nothing must not report success');
  assert.strictEqual(calls.length, 0);
  assert.match(e.lines.join('\n'), /executed nothing/);
});

test('a typo in a filter fails the run rather than passing the files that did match', () => {
  const { spawn, calls } = fakeSpawn();
  const e = sink();
  const code = run({
    testDir: 'test', filters: ['wake', 'waek'],
    readdir: () => ['wake-stall.test.cjs'], spawn, err: e.write, log: () => {}
  });
  assert.notStrictEqual(code, 0);
  assert.strictEqual(calls.length, 0, 'nothing may run until the caller has the suite they asked for');
  assert.match(e.lines.join('\n'), /waek/);
});

test('the expanded file list is passed to node --test - no glob character survives', () => {
  const { spawn, calls } = fakeSpawn({ status: 0 });
  const code = run({
    testDir: path.join('/repo', 'test'), cwd: '/repo',
    readdir: () => ['b.test.cjs', 'a.test.cjs'], spawn, log: () => {}
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.length, 1);
  const args = calls[0].args;
  assert.strictEqual(args[0], '--test');
  assert.strictEqual(args.length, 3);
  assert.ok(args.slice(1).every((a) => !a.includes('*')), `glob leaked into ${args.join(' ')}`);
  assert.ok(args.slice(1).every((a) => a.endsWith('.test.cjs')));
  assert.deepStrictEqual(args.slice(1).map((a) => path.basename(a)), ['a.test.cjs', 'b.test.cjs']);
});

test('it announces the count, so a reader can tell work happened', () => {
  const l = sink();
  const { spawn } = fakeSpawn({ status: 0 });
  run({ testDir: 'test', readdir: () => ['a.test.cjs', 'b.test.cjs'], spawn, log: l.write });
  assert.match(l.lines.join('\n'), /running 2 test files/);
});

test('a failing child suite propagates its exit code verbatim', () => {
  const { spawn } = fakeSpawn({ status: 7 });
  const code = run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn, log: () => {} });
  assert.strictEqual(code, 7);
});

test('a child killed by a signal is a failure, not a pass', () => {
  const { spawn } = fakeSpawn({ status: null, signal: 'SIGTERM' });
  const e = sink();
  const code = run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn, err: e.write, log: () => {} });
  assert.notStrictEqual(code, 0);
  assert.match(e.lines.join('\n'), /SIGTERM/);
});

test('a spawn that never starts is a failure, not a pass', () => {
  const { spawn } = fakeSpawn({ error: new Error('ENOENT'), status: null });
  const code = run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn, err: () => {}, log: () => {} });
  assert.notStrictEqual(code, 0);
});

test('an unreadable test directory is a failure, not an empty pass', () => {
  const { spawn, calls } = fakeSpawn();
  const code = run({
    testDir: 'test', spawn, err: () => {}, log: () => {},
    readdir: () => { throw new Error('ENOENT'); }
  });
  assert.notStrictEqual(code, 0);
  assert.strictEqual(calls.length, 0);
});

test('PIN: package.json test:focused invokes the runner and carries no shell glob', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const script = pkg.scripts['test:focused'];
  assert.ok(script, 'test:focused must exist');
  assert.ok(!script.includes('*'), `test:focused must not rely on shell glob expansion: ${script}`);
  assert.match(script, /run-tests\.cjs/);
});

test('PIN: against the REAL test directory the runner selects this file and many more', () => {
  const { files } = selectTestFiles(fs.readdirSync(TEST_DIR));
  assert.ok(files.includes('test-runner-glob.test.cjs'), 'the runner must pick up its own test');
  assert.ok(files.length > 100, `expected the whole suite, got ${files.length}`);
  assert.ok(!files.includes('tools'), 'directories are not test files');
});

test('PIN: the runner stays out of the shipped app - it lives under test/', () => {
  const rel = path.relative(REPO, require.resolve('./tools/run-tests.cjs')).replace(/\\/g, '/');
  assert.ok(rel.startsWith('test/'), `runner must live under test/, found at ${rel}`);
});
