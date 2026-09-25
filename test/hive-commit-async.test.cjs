'use strict';

/**
 * MESSAGE-LAG-152 cause 1 (Jim proved it; god's fix): the hive's state commit ran
 * spawnSync('git add -A') + spawnSync('git commit') on Electron main for every routed
 * message (1.7-3.2 s, all IPC stalled). It is now a request to HiveCommitter: coalesced,
 * async, single-flight, flushed on quit, and failures never reach delivery.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const C = loadTs('src/main/hiveCommitter.ts');
const { HiveCommitter, coalescedMessage, NO_AUTO_MAINTENANCE, MESSAGE_LINES } = C;

/** A fake world: manual timers, a scripted git, a fake clock. */
function world(opts = {}) {
  const timers = [];
  let clock = 1_000_000;
  const calls = [];
  const logs = [];
  const gitQueue = opts.gitQueue ?? [];
  const deferred = [];
  const git = (args, cwd) => {
    calls.push(args.filter((a) => !a.startsWith('-c') && !/=/.test(a)));
    calls[calls.length - 1].raw = args;
    if (opts.hold) return new Promise((resolve) => deferred.push(resolve));
    const next = gitQueue.shift();
    return Promise.resolve(next ?? { ok: true, out: '', err: '' });
  };
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const c = new HiveCommitter({
    root: () => root,
    git,
    log: (l) => logs.push(l),
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, at: clock + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    sleep: () => Promise.resolve(),
    gcFirstDelayMs: opts.gcFirstDelayMs ?? 1e12,
    gcIntervalMs: opts.gcIntervalMs ?? 1e12,
    ...opts.deps
  });
  const fire = async () => {
    const live = timers.filter((t) => t.live);
    for (const t of live) { t.live = false; clock = Math.max(clock, t.at); t.fn(); }
    await tick();
  };
  const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
  return { c, calls, logs, timers, fire, tick, deferred, advance: (ms) => { clock += ms; }, get clock() { return clock; }, root };
}
const verbs = (calls) => calls.map((a) => a[0]);

test('request() touches no git at all; a burst of N becomes ONE commit that lists them', async () => {
  const w = world();
  for (let i = 0; i < 25; i++) w.c.request(`hive: msg a→b ${i}`);
  await w.tick();
  assert.equal(w.calls.length, 0, 'no git during the burst');
  assert.equal(w.c.pendingCount(), 25);
  await w.fire();
  assert.deepEqual(verbs(w.calls).filter((v) => v === 'commit'), ['commit'], 'exactly one commit');
  const commit = w.calls.find((a) => a[0] === 'commit');
  const msg = commit[commit.indexOf('-m') + 1];
  assert.match(msg, /^hive: 25 changes\n\n- hive: msg a→b 0\n/);
  assert.equal(w.c.stats.commits, 1);
  assert.equal(w.c.pendingCount(), 0);
});

test('the debounce waits for the idle window but never past MAX_WAIT from the oldest request', () => {
  const w = world({ deps: { idleMs: 5000, maxWaitMs: 30000 } });
  w.c.request('a');
  assert.equal(w.timers.at(-1).ms, 5000);
  w.advance(27000);
  w.c.request('b');
  assert.equal(w.timers.at(-1).ms, 3000, 'capped by the oldest request\'s 30 s');
  assert.equal(w.timers.filter((t) => t.live).length, 1, 'one live timer');
});

test('single flight: requests during a commit wait for it, then commit together; never two gits at once', async () => {
  const w = world({ hold: true });
  w.c.request('first');
  await w.fire();
  assert.equal(w.deferred.length, 1, 'git add is running');
  w.c.request('second'); w.c.request('third');
  await w.fire();                        // the second timer fires while the first commit runs
  assert.equal(w.deferred.length, 1, 'no second git while the first is in flight');
  // finish add+commit of the first batch, then the second batch's add+commit
  for (let i = 0; i < 4; i++) { const r = w.deferred.shift(); assert.ok(r, `step ${i}`); r({ ok: true, out: '', err: '' }); await w.tick(); }
  assert.equal(w.c.stats.maxConcurrent, 1);
  const msgs = w.calls.filter((a) => a[0] === 'commit').map((a) => a[a.indexOf('-m') + 1]);
  assert.deepEqual(msgs, ['first', 'hive: 2 changes\n\n- second\n- third']);
});

test('flush(): commits what is pending at once, after a commit in flight; never rejects', async () => {
  const w = world();
  w.c.request('x'); w.c.request('y');
  await w.c.flush();
  assert.equal(w.c.stats.commits, 1);
  assert.equal(w.c.pendingCount(), 0);
  assert.equal(w.timers.filter((t) => t.live).length, 0, 'the debounce timer is cancelled');
  const h = world({ hold: true });
  h.c.request('a');
  await h.fire();                        // a commit is in flight
  h.c.request('b');
  let done = false;
  const f = h.c.flush().then(() => { done = true; });
  for (let i = 0; i < 4; i++) { await h.tick(); h.deferred.shift()?.({ ok: true, out: '', err: '' }); }
  await f;
  assert.equal(done, true);
  const msgs = h.calls.filter((a) => a[0] === 'commit').map((a) => a[a.indexOf('-m') + 1]);
  assert.deepEqual(msgs, ['a', 'b'], 'the late request was committed by the flush too');
});

test('a failing git never throws into the caller; logged ONCE per distinct failure, again after a success', async () => {
  const bad = { ok: false, out: '', err: 'fatal: something broke\nmore' };
  const w = world({ gitQueue: [{ ok: true }, bad, { ok: true }, bad, { ok: true }, { ok: true }, { ok: true }, bad] });
  const thrower = world({ deps: { git: () => { throw new Error('spawn failed'); } } });
  assert.doesNotThrow(() => thrower.c.request('x'));
  await thrower.c.flush();
  assert.equal(thrower.logs.length, 1);
  w.c.request('1'); await w.c.flush();
  w.c.request('2'); await w.c.flush();
  assert.deepEqual(w.logs, ['[hive] commit: fatal: something broke'], 'the same failure twice: one log line');
  w.c.request('3'); await w.c.flush();   // success resets
  w.c.request('4'); await w.c.flush();
  assert.equal(w.logs.length, 2, 'after a success the failure is reported again');
});

test('index.lock: retried with a (timer) back-off, then committed', async () => {
  const lock = { ok: false, out: '', err: "fatal: Unable to create '.git/index.lock': File exists." };
  const w = world({ gitQueue: [{ ok: true }, lock, { ok: true }, { ok: true }] });
  w.c.request('m');
  await w.c.flush();
  assert.equal(verbs(w.calls).filter((v) => v === 'commit').length, 2);
  assert.equal(w.c.stats.commits, 1);
  assert.equal(w.logs.length, 0);
});

test('every commit runs with auto-maintenance OFF and WITH hooks (no --no-verify)', async () => {
  const w = world();
  w.c.request('m'); await w.c.flush();
  for (const a of w.calls.filter((x) => x[0] === 'add' || x[0] === 'commit')) {
    const raw = a.raw.join(' ');
    assert.match(raw, /-c gc.auto=0 -c maintenance.auto=false/, `${a[0]} has gc.auto=0 + maintenance.auto=false`);
    assert.deepEqual(NO_AUTO_MAINTENANCE, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false']);
    assert.doesNotMatch(raw, /--no-verify|\s-n\b|hooksPath/);
  }
  assert.doesNotMatch(codeOnly(readSource('src/main/hiveCommitter.ts')), /--no-verify|hooksPath|spawnSync|execFileSync/);
});

test('gc --auto: not before its first delay, then in the SAME single flight as commits, at most once per interval', async () => {
  const w = world({ gcFirstDelayMs: 60_000, gcIntervalMs: 3_600_000, hold: true });
  const settle = async () => { for (let i = 0; i < 8; i++) { await w.tick(); w.deferred.shift()?.({ ok: true, out: '', err: '' }); } };
  w.c.request('early'); await w.fire(); await settle();
  assert.equal(w.c.stats.gcRuns, 0, 'not in the first minute');
  w.advance(61_000);
  w.c.request('later'); await w.fire();
  for (let i = 0; i < 2; i++) { await w.tick(); w.deferred.shift()({ ok: true, out: '', err: '' }); }   // add + commit
  await w.tick();
  assert.equal(verbs(w.calls).at(-1), 'gc', 'gc started after the commit');
  assert.equal(w.deferred.length, 1, 'and is running');
  w.c.request('during'); await w.fire();   // arrives WHILE gc runs
  assert.equal(w.deferred.length, 1, 'no commit starts beside the running gc');
  await settle();
  assert.ok(w.calls.some((a) => a[0] === 'commit' && a.includes('during')), 'the request is committed once gc is done');
  assert.equal(w.c.stats.gcRuns, 1);
  assert.equal(w.c.stats.maxConcurrent, 1, 'gc never beside a commit');
  w.c.request('again'); await w.fire(); await settle();
  assert.equal(w.c.stats.gcRuns, 1, 'not again within the interval');
  const gc = w.calls.find((a) => a[0] === 'gc');
  assert.deepEqual([...gc], ['gc', '--auto', '--quiet']);
  assert.match(gc.raw.join(' '), /-c gc.autoDetach=false gc/, 'gc stays in the foreground (inside the single flight)');
});

test('R1 (Jim): a lock left by a git killed at quit is cleared before the next process\'s FIRST commit, even when under 10 s old', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-lock-'));
  fs.mkdirSync(path.join(root, '.git'));
  const lock = path.join(root, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const twoSecondsAgo = new Date(Date.now() - 2_000);
  fs.utimesSync(lock, twoSecondsAgo, twoSecondsAgo);            // the quick-relaunch case
  const w = world({ root, deps: { git: (args) => Promise.resolve(fs.existsSync(lock)
    ? { ok: false, out: '', err: "fatal: Unable to create 'index.lock': File exists." }
    : { ok: true, out: '', err: '' }) } });
  w.c.request('after relaunch'); await w.c.flush();
  assert.equal(fs.existsSync(lock), false, 'the leftover lock is gone');
  assert.equal(w.c.stats.commits, 1);
  assert.deepEqual(w.logs, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('R1 (Jim): a FRESH lock that appeared after start is left alone (a live git), and a >10 s one is always recovered', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-lock2-'));
  fs.mkdirSync(path.join(root, '.git'));
  const lock = path.join(root, '.git', 'index.lock');
  const w = world({ root, deps: { git: () => Promise.resolve(fs.existsSync(lock)
    ? { ok: false, out: '', err: "fatal: Unable to create 'index.lock': File exists." }
    : { ok: true, out: '', err: '' }) } });
  const future = new Date(Date.now() + 1_000);
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, future, future);                         // touched after this process started
  w.c.request('while someone holds the index'); await w.c.flush();
  assert.equal(fs.existsSync(lock), true, 'a fresh lock is never removed');
  assert.equal(w.c.stats.commits, 0);
  assert.deepEqual(w.logs, ['[hive] commit: index.lock held through every retry']);
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(lock, old, old);                               // its git died long ago
  w.c.request('later'); await w.c.flush();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(w.c.stats.commits, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('N1 (Jim): a git that times out is logged with a reason, not a blank', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-n1-'));
  // `hash-object --stdin` waits on stdin, which execFile leaves open: a guaranteed timeout.
  const res = await C.execFileGit(['hash-object', '--stdin'], dir, 300);
  assert.equal(res.ok, false);
  assert.notEqual(res.err.trim(), '', 'the error text stands in for the empty stderr');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R2 (Jim): a coalesced message lists at most MESSAGE_LINES requests plus one summary line', () => {
  assert.equal(MESSAGE_LINES, 40);
  const msg = coalescedMessage(Array.from({ length: 100 }, (_, i) => `m${i}`));
  const bullets = msg.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, MESSAGE_LINES + 1);
  assert.equal(bullets.at(-1), `- …and ${100 - MESSAGE_LINES} more`);
  assert.equal(bullets[MESSAGE_LINES - 1], `- m${MESSAGE_LINES - 1}`);
});

test('coalescedMessage: one request is itself; many are listed and capped', () => {
  assert.equal(coalescedMessage(['hive: a']), 'hive: a');
  const many = Array.from({ length: MESSAGE_LINES + 3 }, (_, i) => `m${i}`);
  const msg = coalescedMessage(many);
  assert.match(msg, new RegExp(`^hive: ${MESSAGE_LINES + 3} changes`));
  assert.match(msg, /- …and 3 more$/);
});

// ── the real thing: a real git repo, the production runner ──────────────────

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-real-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const gitOut = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

test('REAL GIT: the main thread is never held: requests cost ~0 ms, and the event loop gets its turn while git commits', async () => {
  const dir = gitRepo();
  // A pre-commit hook that marks the file system: it MUST still run (no --no-verify).
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho ran > .git/hook-ran\nexit 0\n');
  try { fs.chmodSync(hook, 0o755); } catch { /* windows */ }
  const c = new HiveCommitter({ root: () => dir, gcFirstDelayMs: 1e12 });
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `f${i}.json`), JSON.stringify({ i }));

  let t = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) c.request(`hive: routed ${i}`);
  const requestMs = Number(process.hrtime.bigint() - t) / 1e6;

  // What stalls Electron's IPC is how long the event loop is kept from its next turn.
  // spawnSync inside the flush (even behind an await) holds it for the whole commit.
  let maxGap = 0; let last = Date.now();
  const probe = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 2);
  t = process.hrtime.bigint();
  const flushing = c.flush();
  await new Promise((r) => setImmediate(r));
  const heldMs = Number(process.hrtime.bigint() - t) / 1e6;
  await flushing;
  const wallMs = Number(process.hrtime.bigint() - t) / 1e6;
  await new Promise((r) => setTimeout(r, 10));
  clearInterval(probe);

  assert.ok(requestMs < 5, `20 requests took ${requestMs.toFixed(2)} ms on the calling thread`);
  // Relative, so a loaded machine (the suite runs files in parallel) cannot flake it: with git
  // off the thread the loop gets its turn after a spawn (~6 ms of a ~190 ms commit here);
  // with spawnSync it waits for the whole commit (held == wall, measured 267 ms).
  const why = `held ${heldMs.toFixed(1)} ms of a ${wallMs.toFixed(0)} ms commit (max loop gap ${maxGap} ms)`;
  assert.ok(heldMs < wallMs / 3, `the event loop was held for most of the commit: ${why}`);
  assert.ok(heldMs < 150, why);
  assert.equal(gitOut(dir, ['rev-list', '--count', 'HEAD']), '1', 'ONE commit for the burst');
  assert.match(gitOut(dir, ['log', '-1', '--format=%s']), /^hive: 20 changes$/);
  assert.equal(gitOut(dir, ['ls-files']).split('\n').length, 20, 'the state is durable: every file committed');
  assert.equal(gitOut(dir, ['log', '-1', '--format=%an']), 'Hive', 'the same identity as before');
  assert.ok(fs.existsSync(path.join(dir, '.git', 'hook-ran')), 'the repo\'s pre-commit hook ran (no --no-verify)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('STATIC: Hive.commit is a request; the router path has no synchronous git left', () => {
  const hive = codeOnly(readSource('src/main/hive.ts'));
  const at = hive.indexOf('  commit(message: string): void {');
  const body = hive.slice(at, hive.indexOf('\n  }', at));
  assert.match(body, /this\.committer\.request\(message\);/);
  assert.doesNotMatch(body, /git\(|spawnSync|sleepSync/);
  // the only sync git left is `git init`
  const syncGitCalls = [...hive.matchAll(/this\.git\(\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(syncGitCalls, ['init'], 'only `git init` (once per hive, ever) is synchronous');
  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /hive\.flushCommits\(\)/, 'quit flushes the pending commit');
});
