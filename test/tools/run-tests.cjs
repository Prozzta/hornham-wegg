#!/usr/bin/env node
/**
 * The focused-suite runner: enumerate `test/*.test.cjs` in Node and hand the expanded
 * list to `node --test`.
 *
 * WHY THIS EXISTS. `node --test test/*.test.cjs` relies on the SHELL expanding the glob.
 * cmd.exe does not, and Node's own glob support for `--test` arrived in Node 21, so on
 * Windows + Node 20 the pattern reached Node verbatim, matched nothing, and the script
 * exited having run ZERO tests. The failure mode that actually cost us was not the red
 * exit: it was that a run which executed nothing was indistinguishable, from the outside,
 * from a run that passed. So this runner's contract is narrow and deliberate:
 *
 *   - it expands the list itself, so no shell is involved on any platform;
 *   - it PRINTS the count it is about to run, so a reader can see work happened;
 *   - an empty selection is an ERROR, never a quiet success. A filter that matches
 *     nothing, or a test directory with no test files in it, exits non-zero and says so.
 *
 * Optional args narrow the run by substring (case-insensitive) against the file name:
 *   npm run test:focused -- wake        # every *wake*.test.cjs
 *   npm run test:focused -- wake canary # the union of both
 *
 * Pure selection + injected effects, so the zero-match and exit-code paths are testable
 * without spawning anything.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_SUFFIX = '.test.cjs';

/** Every top-level test file in `entries`, sorted, narrowed by `filters`. Pure. */
function selectTestFiles(entries, filters = []) {
  const all = entries.filter((n) => n.endsWith(TEST_SUFFIX)).sort();
  if (!filters.length) return { files: all, unmatched: [], total: all.length };
  const files = [];
  const unmatched = [];
  for (const f of filters) {
    const needle = String(f).toLowerCase();
    const hits = all.filter((n) => n.toLowerCase().includes(needle));
    if (!hits.length) unmatched.push(f);
    for (const h of hits) if (!files.includes(h)) files.push(h);
  }
  files.sort();
  return { files, unmatched, total: all.length };
}

/** The runner proper. Every effect is injected; returns the process exit code. */
function run({
  testDir,
  filters = [],
  readdir = (d) => fs.readdirSync(d),
  spawn = (args, opts) => spawnSync(process.execPath, args, opts),
  cwd = process.cwd(),
  log = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`)
} = {}) {
  let entries;
  try {
    entries = readdir(testDir);
  } catch (e) {
    err(`[test-runner] cannot read ${testDir}: ${String(e)}`);
    return 1;
  }
  const { files, unmatched, total } = selectTestFiles(entries, filters);

  // A filter that matched nothing is almost always a typo. Running the files that DID
  // match would report green for a suite the caller never actually asked for.
  if (unmatched.length) {
    err(`[test-runner] no test file matches: ${unmatched.join(', ')} (of ${total} in ${testDir})`);
    return 1;
  }
  // The regression this runner exists to prevent: never exit 0 having run nothing.
  if (!files.length) {
    err(`[test-runner] no *${TEST_SUFFIX} files found in ${testDir} - refusing to report a run that executed nothing`);
    return 1;
  }

  const rel = files.map((n) => path.join(path.relative(cwd, testDir) || '.', n));
  log(`[test-runner] running ${files.length}${filters.length ? ` of ${total}` : ''} test files via node --test`);
  const res = spawn(['--test', ...rel], { cwd, stdio: 'inherit' });
  if (res.error) {
    err(`[test-runner] could not start node --test: ${String(res.error)}`);
    return 1;
  }
  // A child killed by a signal reports status null; that is a failure, not a pass.
  if (typeof res.status !== 'number') {
    err(`[test-runner] node --test terminated by signal ${res.signal ?? 'unknown'}`);
    return 1;
  }
  return res.status;
}

module.exports = { selectTestFiles, run, TEST_SUFFIX };

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  process.exit(run({
    testDir: path.join(repoRoot, 'test'),
    filters: process.argv.slice(2),
    cwd: repoRoot
  }));
}
