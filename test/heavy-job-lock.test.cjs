'use strict';
/**
 * HEAVY-JOB-SERIALIZE (1.1.55; god andyheavy + andyheavycfg, the Human's "Heavy jobs at once").
 * "One heavy job at a time" was a prose rule, broken twice on 2026-09-26 (and the Human's PC froze
 * earlier with several heavy jobs at once). The app now enforces it at PreToolUse with a counting
 * semaphore of N slots (Settings: Off or N, default 1, applied live).
 * HOME is jailed and asserted before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { classifyCommand, classifyHeavy, isBackground, heavyLimit, HeavyJobLock, HEAVY_TTL_MS, HEAVY_SCAN_MISSES, HEAVY_SCAN_MS } = loadTs('src/main/heavyJob.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const REPO = path.resolve(__dirname, '..');

// ── the classifier corpus ────────────────────────────────────────────────────────────────

const HEAVY = [
  ['npm ci', 'install'], ['env -u NoDefaultCurrentDirectoryInExePath npm ci > ../x.log 2>&1', 'install'], ['npm install', 'install'], ['npm i', 'install'],
  ['pnpm install', 'install'], ['yarn', 'install'], ['npm rebuild', 'install'], ['npx electron-rebuild -f', 'install'], ['node-gyp rebuild', 'install'],
  ['npm run build', 'build'], ['npm run -s build > ../b.log 2>&1', 'build'], ['npm run dist:win', 'build'], ['electron-vite build', 'build'], ['npx electron-builder --win', 'build'],
  ['npm test', 'suite'], ['node --test test/*.test.cjs', 'suite'], ['node --test', 'suite'], ['node --test test', 'suite'], ['timeout 600 node --test test/*.test.cjs', 'suite'],
  ['vitest run', 'suite'], ['cd /c/x && npm run -s typecheck && node --test test/*.test.cjs', 'suite'],
  [`node --test ${Array.from({ length: 20 }, (_, i) => `test/t${i}.test.cjs`).join(' ')}`, 'suite'],
  ['node _work/speed-driver.cjs --exe x', 'bench'], ['node scripts/native-memory-parity.cjs', 'bench'], ['node test/tools/inbox-wake-mutants.cjs', 'bench'],
  ['node C:/Dunder/_work/andy-mem154-measure/parity-embed.cjs', 'bench'], ['"Munder Difflin.exe" --native-memory-bench=C:/t', 'bench'],
  ['bash -c "npm ci"', 'install'], ['cmd //c "npm run build"', 'build'], ['powershell -NoProfile -Command "npm test"', 'suite'],
  ['node --test test/*.test.cjs &', 'suite'],
  // Jim MF2: floor commands he probed
  ['node test/tools/run-tests.cjs', 'suite'], ['THREAD_VIEW_SCALE=1 node --test test/thread-view-scale.test.cjs', 'bench']
];
const LIGHT = [
  'node --test test/one.test.cjs', 'node --test test/a.test.cjs test/b.test.cjs', 'node --test --test-name-pattern "x y" test/a.test.cjs',
  'echo npm ci', 'grep "npm ci" README.md', 'git commit -m "run npm ci then npm run build"', 'cat package.json', 'npm run -s typecheck',
  'npx tsc --noEmit -p tsconfig.node.json', 'vitest run src/a.test.ts', 'node scripts/release-markers.cjs node_modules resources/models',
  'git log --oneline -3', 'ls node_modules', 'node -e "console.log(1)"', 'npm view electron version', '',
  // Jim N4: the patterns audits actually run
  'node --test test/a.cjs test/b.cjs', 'node C:/Users/x/scratch/xmut.cjs', 'git -C C:/Dunder/_work/wt diff --stat', 'npm run typecheck',
  // Jim MF2 + H6
  'npm run test:focused -- wake', 'npm test -- test/one.test.cjs', 'node test/tools/run-tests.cjs wake', 'git commit -m "fix; npm ci later"'
];

test('CLASSIFIER: every heavy command in the corpus is heavy, with its kind', () => {
  for (const [cmd, kind] of HEAVY) {
    const c = classifyCommand(cmd);
    assert.equal(c.heavy, true, cmd);
    assert.equal(c.kind, kind, cmd);
  }
});

test('CLASSIFIER: the FALSE POSITIVES stay light (single test files, echo/grep/commit text, typecheck, tsc, one vitest file)', () => {
  for (const cmd of LIGHT) assert.equal(classifyCommand(cmd).heavy, false, cmd);
});

test('CLASSIFIER: tool input shapes (Claude Bash {command}, Codex argv arrays, non-command tools) and background detection', () => {
  assert.equal(classifyHeavy('Bash', { command: 'npm ci' }).heavy, true);
  assert.equal(classifyHeavy('shell', { command: ['npm', 'run', 'build'] }).heavy, true);
  assert.equal(classifyHeavy('Read', { file_path: 'npm ci' }).heavy, false);
  assert.equal(classifyHeavy('Edit', 'x').heavy, false);
  assert.equal(isBackground({ command: 'node --test test/*.test.cjs', run_in_background: true }), true);
  assert.equal(isBackground({ command: 'npm run build &' }), true);
  assert.equal(isBackground({ command: 'npm run build' }), false);
  assert.equal(isBackground({ command: 'a && b' }), false);
});

test('heavyLimit: Off / N (1..16) / default 1', () => {
  assert.equal(heavyLimit('off'), 'off');
  assert.equal(heavyLimit(0), 'off');
  assert.equal(heavyLimit(undefined), 1);
  assert.equal(heavyLimit(2), 2);
  assert.equal(heavyLimit('3'), 3);
  assert.equal(heavyLimit(99), 16);
  assert.equal(heavyLimit(-1), 1);
});

// ── the lock ─────────────────────────────────────────────────────────────────────────────

function lock(limit, extra = {}) {
  let now = 1_000_000; let lim = limit; const logs = []; const timers = [];
  const l = new HeavyJobLock({ limit: () => lim, now: () => now, setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {}, log: (r) => logs.push(r), ...extra });
  return { l, logs, timers, tick: (ms) => { now += ms; }, setLimit: (v) => { lim = v; } };
}
const H = { heavy: true, kind: 'suite' };

test('N=1: the first heavy job takes the slot; another agent is DENIED naming the holder; the holder re-enters; its foreground PostToolUse frees it', () => {
  const x = lock(1);
  assert.deepEqual(x.l.acquire('andy', H, 'node --test test/*.test.cjs', 'c1', false), { allow: true, acquired: true });
  const d = x.l.acquire('jim', H, 'npm ci', 'j1', false);
  assert.equal(d.allow, false);
  assert.match(d.reason, /^Denied by HEAVY-JOB-LOCK: the machine allows 1 heavy job at once and it is held by andy \(suite: node --test test\/\*\.test\.cjs, since \d\d:\d\d:\d\dZ\)/);
  // Jim N3: it says what to do instead, so agents do not retry variants.
  assert.match(d.reason, /Do not retry this or a variant of it now: carry on with light work \(single test files, reads, edits are not limited\) and run it later, once a slot is free .* or ask god to schedule it\./);
  const denyRow = x.logs.find((r) => r.action === 'deny');
  assert.equal(denyRow.command, undefined, 'the denied command itself is not logged');
  assert.equal(denyRow.heavyKind, 'suite');
  assert.equal(denyRow.holders[0].agentId, 'andy', 'the holder is in the deny row');
  assert.deepEqual(x.l.acquire('andy', H, 'npm run build', 'c2', false), { allow: true, acquired: false }, 're-entrant');
  x.l.callDone('andy', 'c1');
  assert.equal(x.l.snapshot().length, 1, 'still one call running');
  x.l.callDone('andy', 'c2');
  assert.equal(x.l.snapshot().length, 0, 'freed');
  assert.equal(x.l.acquire('jim', H, 'npm ci', 'j2', false).allow, true);
  assert.deepEqual(x.logs.map((r) => r.action), ['acquire', 'deny', 'reenter', 'release', 'acquire']);
  assert.equal(x.logs.find((r) => r.action === 'release').reason, 'posttool');
});

test('N=2: two agents hold; the THIRD is denied naming BOTH', () => {
  const x = lock(2);
  assert.equal(x.l.acquire('a', H, 'npm ci', '1', false).allow, true);
  assert.equal(x.l.acquire('b', H, 'npm run build', '2', false).allow, true);
  const d = x.l.acquire('c', H, 'npm test', '3', false);
  assert.equal(d.allow, false);
  assert.match(d.reason, /allows 2 heavy jobs at once and they are held by a \(.*\); b \(/);
});

test('OFF: never denies and holds nothing; a LIVE change applies at the next acquire (1 -> 2 -> off)', () => {
  const x = lock('off');
  for (const a of ['a', 'b', 'c']) assert.deepEqual(x.l.acquire(a, H, 'npm ci', a, false), { allow: true, acquired: false });
  assert.equal(x.l.snapshot().length, 0);
  const y = lock(1);
  y.l.acquire('a', H, 'npm ci', '1', false);
  assert.equal(y.l.acquire('b', H, 'npm ci', '2', false).allow, false);
  y.setLimit(2);
  assert.equal(y.l.acquire('b', H, 'npm ci', '2', false).allow, true, 'raised live');
  assert.equal(y.l.acquire('c', H, 'npm ci', '3', false).allow, false);
  y.setLimit('off');
  assert.equal(y.l.acquire('c', H, 'npm ci', '3', false).allow, true, 'off live');
});

test('BACKGROUND: its PostToolUse does NOT free the slot; the process check does, after 2 scans with no heavy process under the holder\'s PTY', async () => {
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 }, { pid: 11, parentPid: 10, commandLine: 'node --test test/*.test.cjs', createdMs: 1_000_100 }, { pid: 20, parentPid: 2, commandLine: 'npm ci', createdMs: 1_000_100 }];
  let probes = 0;
  const x = lock(1, { roots: () => [{ agentId: 'andy', pid: 10 }, { agentId: 'jim', pid: 2 }], probe: async () => { probes++; return procs; } });
  x.l.acquire('andy', H, 'node --test test/*.test.cjs', 'bg', true);
  x.l.callDone('andy', 'bg');
  assert.equal(x.l.snapshot().length, 1, 'backgrounded: still held after the call returned');
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'its test run is still a descendant of its PTY');
  procs = procs.filter((p) => p.pid !== 11);   // the run finished (jim's npm ci is NOT andy's)
  x.tick(HEAVY_SCAN_MS);                         // a miss counts once the holder is a scan interval old
  // H3 pin (Jim): exactly TWO misses, not one.
  assert.equal(HEAVY_SCAN_MISSES, 2);
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'ONE miss is not enough');
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0, 'freed');
  assert.equal(x.logs.at(-1).reason, 'process-exit');
  assert.ok(probes >= HEAVY_SCAN_MISSES + 1);
});

test('the process check runs ONLY while a slot is held (never when nothing is held); a young holder\'s miss does not count yet', async () => {
  let probes = 0;
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => { probes++; return []; } });
  await x.l.scan();
  assert.equal(probes, 0, 'nothing held: no process listing');
  assert.equal(x.timers.length, 0, 'nothing held: no timer');
  x.l.acquire('a', H, 'npm ci', '1', false);
  assert.equal(x.timers.length, 1, 'armed while held');
  await x.l.scan(); await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'younger than one scan interval: misses do not count yet');
  assert.equal(probes, 2);
});

test('Jim MF1: a FOREGROUND call whose PostToolUse never comes (Esc, a timeout, a degraded Codex hook) is freed by the watcher, not pinned for the TTL', async () => {
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 }, { pid: 11, parentPid: 10, commandLine: 'npm ci', createdMs: 1_000_100 }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm ci', 'call-1', false);   // no callDone will ever arrive
  x.tick(HEAVY_SCAN_MS);
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'still running: kept');
  procs = [procs[0]];
  await x.l.scan(); await x.l.scan();
  assert.equal(x.l.snapshot().length, 0, 'the job is gone: freed although its call never closed');
  assert.equal(x.logs.at(-1).reason, 'process-exit');
});

test('PTY EXIT and the TTL free a slot', () => {
  const x = lock(1);
  x.l.acquire('a', H, 'npm ci', '1', true);
  x.l.agentGone('a');
  assert.equal(x.l.snapshot().length, 0);
  assert.equal(x.logs.at(-1).reason, 'pty-exit');
  x.l.acquire('b', H, 'npm ci', '2', true);
  x.tick(HEAVY_TTL_MS);
  assert.equal(x.l.acquire('c', H, 'npm ci', '3', false).allow, true, 'b expired');
  assert.ok(x.logs.some((r) => r.action === 'release' && r.agentId === 'b' && r.reason === 'ttl'));
});

// ── the hook boundary ────────────────────────────────────────────────────────────────────

async function server(t, limit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-heavy-'));
  const ph = process.env.HOME; const pu = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive');
  t.after(() => { if (ph === undefined) delete process.env.HOME; else process.env.HOME = ph; if (pu === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = pu; hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  for (const id of ['a1', 'a2']) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  const l = new HeavyJobLock({ limit: () => limit, setTimer: () => ({}), clearTimer: () => {} });
  s.setHeavyLock(l);
  return { s, l };
}

test('HOOK: a heavy PreToolUse beyond the limit is DENIED with the Claude-shaped deny (every transport: http, mcp, the AGY pipe shim), a light one is untouched, and PostToolUse frees the slot', async (t) => {
  const { s, l } = await server(t, 1);
  const fire = (agent_id, hook_event_name, command, extra = {}) => s.handle({ agent_id, hook_event_name, session_id: 's', tool_name: 'Bash', tool_input: { command }, ...extra });
  assert.equal(fire('a1', 'PreToolUse', 'npm ci', { transport: 'http', tool_use_id: 'u1' }).hookSpecificOutput?.permissionDecision, undefined, 'a1 takes the slot');
  for (const transport of ['http', 'mcp', 'pipe']) {
    const r = fire('a2', 'PreToolUse', 'npm run build', { transport });
    assert.equal(r.hookSpecificOutput.permissionDecision, 'deny', transport);
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /HEAVY-JOB-LOCK: .* held by a1 \(install: npm ci/);
  }
  assert.equal(fire('a2', 'PreToolUse', 'node --test test/one.test.cjs', { transport: 'http' }).hookSpecificOutput?.permissionDecision, undefined, 'light: never gated');
  fire('a1', 'PostToolUse', 'npm ci', { transport: 'http', tool_use_id: 'u1' });
  assert.equal(l.snapshot().length, 0, 'freed by the same call\'s PostToolUse');
  assert.equal(fire('a2', 'PreToolUse', 'npm run build', { transport: 'http' }).hookSpecificOutput?.permissionDecision, undefined);
});

test('HOOK: without the id, Pre/Post pair by the command; with no lock wired nothing changes', async (t) => {
  const { s, l } = await server(t, 1);
  s.handle({ agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm ci' } });
  assert.equal(l.snapshot().length, 1);
  s.handle({ agent_id: 'a1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm ci' } });
  assert.equal(l.snapshot().length, 0);
  s.setHeavyLock(null);
  for (const a of ['a1', 'a2']) assert.equal(s.handle({ agent_id: a, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm ci' } }).hookSpecificOutput?.permissionDecision, undefined);
});

// ── wiring, config, UI ───────────────────────────────────────────────────────────────────

test('WIRING: index.ts builds the lock from the LIVE setting, hands it to the HookServer, frees an agent\'s slot at PTY teardown, and puts the holders in fleet.json', () => {
  const idx = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /const heavyLock = new HeavyJobLock\(\{\s*limit: \(\) => heavyLimit\(readConfig\(\)\.heavyJobsAtOnce\),/);
  assert.match(idx, /probe: probeProcesses,/);
  assert.match(idx, /hookServer\.setHeavyLock\(heavyLock\);/);
  assert.match(idx, /if \(!\[\.\.\.ptyToAgent\.values\(\)\]\.includes\(agentId\)\) \{ try \{ heavyLock\.agentGone\(agentId\); \}/);
  assert.match(idx, /heavyLock: \{ limit: heavyLimit\(readConfig\(\)\.heavyJobsAtOnce\), holders: heavyLock\.snapshot\(\) \}/);
});

test('CONFIG + SETTINGS: default 1; the Autonomy & Budgets section offers Off and N, saved through updateConfig', () => {
  const cfg = fs.readFileSync(path.join(REPO, 'src', 'main', 'config.ts'), 'utf8');
  assert.match(cfg, /heavyJobsAtOnce\?: number \| 'off';/);
  assert.match(cfg, /heavyJobsAtOnce: 1,/);
  const ui = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  assert.match(ui, /Heavy jobs at once/);
  assert.match(ui, /<option value="off">Off<\/option>/);
  assert.match(ui, /updateConfig\(\{ heavyJobsAtOnce: next \}/);
});

// ── god andyheavyok + Jim heavynote ──────────────────────────────────────────────────────

test('OFF (god): never denies, but a heavy call is still LOGGED as unlimited', () => {
  const x = lock('off');
  x.l.acquire('a', H, 'npm ci', '1', false);
  assert.deepEqual(x.logs.map((r) => r.action), ['unlimited']);
  assert.equal(x.l.snapshot().length, 0);
});

test('Jim N2: a foreground call whose heavy job outlives it (a detached child) KEEPS the slot after one descendant check; freed later by the watcher', async () => {
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 }, { pid: 11, parentPid: 10, commandLine: 'npm run build', createdMs: 1_000_100 }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm run build', '1', false);
  x.l.callDone('a', '1');
  await new Promise((r) => setImmediate(r));
  assert.equal(x.l.snapshot().length, 1, 'an orphaned heavy child keeps the slot');
  assert.equal(x.l.snapshot()[0].background, true);
  assert.ok(x.logs.some((r) => r.action === 'orphan-kept'));
  procs = [procs[0]];
  x.tick(HEAVY_SCAN_MS);
  for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  // and with no heavy child the foreground call frees it after the one check
  const y = lock(1, { roots: () => [{ agentId: 'b', pid: 20 }], probe: async () => [{ pid: 20, parentPid: 1, commandLine: 'bash', createdMs: 1 }] });
  y.l.acquire('b', H, 'npm ci', '1', false);
  y.l.callDone('b', '1');
  await new Promise((r) => setImmediate(r));
  assert.equal(y.l.snapshot().length, 0);
  assert.equal(y.logs.at(-1).reason, 'posttool');
});

test('Jim N5: a TTL expiry while the watcher last SAW the job running logs expired-still-running (not a silent ttl)', async () => {
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => [{ pid: 11, parentPid: 10, commandLine: 'node --test test/*.test.cjs', createdMs: 1_000_100 }] });
  x.l.acquire('a', H, 'node --test test/*.test.cjs', '1', true);
  await x.l.scan();
  x.tick(HEAVY_TTL_MS);
  x.l.snapshot();
  assert.equal(x.logs.at(-1).reason, 'expired-still-running');
});

test('Jim N1 (HOOK): a CODEX (mcp) heavy call is left for the watcher (its PostToolUse may not pair back); a DEGRADED call with no input is allowed and logged', async (t) => {
  const { s, l } = await server(t, 1);
  s.handle({ agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm ci' }, transport: 'mcp' });
  assert.equal(l.snapshot()[0].background, true, 'unpaired: freed by the process check / PTY / TTL');
  s.handle({ agent_id: 'a1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm ci' }, transport: 'mcp' });
  assert.equal(l.snapshot().length, 1, 'a Codex PostToolUse does not free it');
  const r = s.handle({ agent_id: 'a2', hook_event_name: 'PreToolUse', tool_name: 'Bash', payload_degraded: true, transport: 'mcp' });
  assert.equal(r.hookSpecificOutput?.permissionDecision, undefined, 'degraded: allowed');
  const log = fs.readFileSync(path.join(s.hive?.root?.() ?? '', 'log.jsonl'), 'utf8');
  assert.match(log, /"kind":"heavy-lock","action":"degraded","agentId":"a2"/);
});

// ── Jim HEAVY-LOCK-155-AUDIT (CHANGES): MF1 hook paths ───────────────────────────────────

test('Jim MF1a: a call the HITL gate DENIES never takes a slot (the heavy acquire runs after every other PreToolUse deny)', async (t) => {
  const { s, l } = await server(t, 1);
  s.control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: true, reason: 'paused by the operator' }) };
  const r = s.handle({ agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm ci' }, transport: 'http' });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /paused by the operator/);
  assert.equal(l.snapshot().length, 0, 'no slot for a call that never runs');
});

test('Jim MF1b: a FAILED heavy call (PostToolUseFailure, e.g. a suite exiting 1) frees its slot; Claude\'s settings register that event', async (t) => {
  const { s, l } = await server(t, 1);
  s.handle({ agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node --test test/*.test.cjs' }, tool_use_id: 'u9', transport: 'http' });
  assert.equal(l.snapshot().length, 1);
  s.handle({ agent_id: 'a1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'node --test test/*.test.cjs' }, tool_use_id: 'u9', transport: 'http' });
  assert.equal(l.snapshot().length, 0);
  const hiveSrc = fs.readFileSync(path.join(REPO, 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(hiveSrc, /PostToolUse: \[hook\('\*'\)\],[\s\S]{0,400}PostToolUseFailure: \[hook\('\*'\)\],/);
});

// ── Jim re-check MF3: the watcher judges by process CREATION, not by command lines ─────────

// The real command-line shapes Jim captured on this machine (HEAVY-LOCK-155-AUDIT.md re-check):
// none of them classifies as heavy, yet each IS the running heavy job.
// String.raw: the Windows paths are kept byte for byte (no escape processing).
const REAL_SHAPES = [
  String.raw`C:\Program Files\Git\bin\..\usr\bin\bash.exe -c "source /c/Users/x/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && eval 'npm ci > log 2>&1' < /dev/null && pwd -P >| /tmp/cwd"`,
  String.raw`C:\Program Files\Git\bin\..\usr\bin\bash.exe -c "source /c/Users/x/.claude/shell-snapshots/snapshot-bash-1.sh && eval 'node --test test/*.test.cjs' < /dev/null"`,
  String.raw`"C:\nvm\v20\node.exe" "C:\nvm\v20\node_modules\npm\bin\npm-cli.js" ci`,
  String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""C:\nvm\v20\npm.cmd" ci"`,
  String.raw`"C:\nvm\v20\node.exe" "C:\wt\node_modules\electron-builder\cli.js" --win`,
  String.raw`"C:\nvm\v20\node.exe" "C:\wt\node_modules\electron-vite\bin\electron-vite.js" build`,
  String.raw`powershell.exe -NoProfile -NonInteractive -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; & ([scriptblock]::Create($__claudeCodeScript))"`
];

test('MF3: a job visible only through the REAL wrapper shapes keeps the slot (a descendant created after the acquire), whatever its command line says', async () => {
  for (const shape of REAL_SHAPES) assert.equal(classifyCommand(shape).heavy, false, `the shape itself is unclassifiable: ${shape.slice(0, 60)}`);
  for (const shape of REAL_SHAPES) {
    let procs = [{ pid: 10, parentPid: 1, commandLine: 'claude.exe', createdMs: 1 }, { pid: 12, parentPid: 10, commandLine: shape, createdMs: 1_000_050 }];
    const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
    x.l.acquire('a', H, 'npm ci', 'c', false);
    x.tick(HEAVY_SCAN_MS);
    await x.l.scan(); await x.l.scan(); await x.l.scan();
    assert.equal(x.l.snapshot().length, 1, `still running under: ${shape.slice(0, 60)}`);
    procs = [procs[0]];
    await x.l.scan(); await x.l.scan();
    assert.equal(x.l.snapshot().length, 0, 'gone: freed');
  }
});

test('MF3: the PTY root and its LONG-LIVED children (created before the acquire, e.g. an MCP server) never keep a slot', async () => {
  const procs = [{ pid: 10, parentPid: 1, commandLine: 'claude.exe', createdMs: 1_000_000 + 1 }, { pid: 13, parentPid: 10, commandLine: 'node mcp-server.js', createdMs: 900_000 }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm ci', 'c', false);
  x.tick(HEAVY_SCAN_MS);
  await x.l.scan(); await x.l.scan();
  assert.equal(x.l.snapshot().length, 0, 'the root (even if restarted) is not its own descendant; the old child predates the acquire');
});

test('MF3: the real listing carries CreationDate as epoch ms (hidden PowerShell, no window)', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'heavyJob.ts'), 'utf8');
  assert.match(src, /CreationDate\.ToUniversalTime\(\) - \[datetime\]'1970-01-01'\)\.TotalMilliseconds/);
  assert.match(src, /windowsHide: true/);
  assert.ok(!/classifyCommand\(p\.commandLine\)/.test(src), 'the watcher no longer classifies command lines');
});

// ── Jim re-check MF4: a failed listing is UNKNOWN (never a miss); the real listing text is parsed ──

const { parseProcessListing, probeProcesses, PROCESS_LISTING_SCRIPT, HEAVY_CREATED_SKEW_MS } = loadTs('src/main/heavyJob.ts');

// Real ConvertTo-Json -Compress output of the listing script, captured on this machine (2 rows).
const REAL_LISTING = String.raw`[{"ProcessId":4,"ParentProcessId":0,"CommandLine":null,"CreatedMs":1790281982958},{"ProcessId":3648,"ParentProcessId":4748,"CommandLine":"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{n=\u0027CreatedMs\u0027;e={ 1 }} | ConvertTo-Json -Compress\"","CreatedMs":1790448092922}]`;

test('MF4 parser: the REAL listing text parses to rows WITH createdMs (the CreatedMs alias is what the parser reads)', () => {
  const rows = parseProcessListing(REAL_LISTING);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pid: 4, parentPid: 0, commandLine: '', createdMs: 1790281982958 });
  assert.equal(rows[1].pid, 3648); assert.equal(rows[1].parentPid, 4748); assert.equal(rows[1].createdMs, 1790448092922);
  assert.match(rows[1].commandLine, /^C:\\Windows\\System32\\WindowsPowerShell/);
  // one bare object (a one-process listing) is a row too
  assert.deepEqual(parseProcessListing('{"ProcessId":7,"ParentProcessId":1,"CommandLine":"x","CreatedMs":5}'), [{ pid: 7, parentPid: 1, commandLine: 'x', createdMs: 5 }]);
  // the script emits exactly the alias the parser reads (Jim X5: a broken alias must fail a test)
  assert.ok(PROCESS_LISTING_SCRIPT.includes("@{n='CreatedMs';e={"), 'the script aliases CreationDate as CreatedMs');
  assert.ok(PROCESS_LISTING_SCRIPT.includes('ConvertTo-Json -Compress'));
});

test('MF4 parser: an empty, unparseable or CreatedMs-less listing is UNUSABLE (null), never an empty "nothing runs" list', () => {
  for (const bad of ['', '   ', 'Get-CimInstance : Access denied', '[{"ProcessId":4', 'null', '[]', String.raw`[{"ProcessId":4,"ParentProcessId":0,"CommandLine":null,"Created":1}]`]) assert.equal(parseProcessListing(bad), null, JSON.stringify(bad));
});

test('MF4: a FAILED, timed-out, empty or CreatedMs-less listing counts NO miss (logged probe-failed); the slot survives any number of them', async () => {
  const good = [{ pid: 10, parentPid: 1, commandLine: 'claude.exe', createdMs: 1 }];
  for (const [name, probe] of [['null (error / timeout)', async () => null], ['throws', async () => { throw new Error('boom'); }], ['empty', async () => []], ['no createdMs', async () => [{ pid: 10, parentPid: 1, commandLine: 'claude.exe' }]]]) {
    const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe });
    x.l.acquire('a', H, 'npm ci', 'c', true);
    x.tick(HEAVY_SCAN_MS);
    for (let i = 0; i < HEAVY_SCAN_MISSES + 3; i++) await x.l.scan();
    assert.equal(x.l.snapshot().length, 1, `${name}: unknown is not a miss`);
    assert.ok(x.logs.some((r) => r.action === 'probe-failed'), name);
  }
  // control: a good listing with no new descendant DOES free it
  const y = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => good });
  y.l.acquire('a', H, 'npm ci', 'c', true);
  y.tick(HEAVY_SCAN_MS);
  for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await y.l.scan();
  assert.equal(y.l.snapshot().length, 0);
});

test('MF4: a listing that does not contain the holder\'s PTY root counts no miss for THAT holder (another holder in it still can)', async () => {
  const procs = [{ pid: 20, parentPid: 1, commandLine: 'claude.exe', createdMs: 1 }];
  const x = lock(2, { roots: () => [{ agentId: 'a', pid: 10 }, { agentId: 'b', pid: 20 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm ci', 'c', true);
  x.l.acquire('b', H, 'npm ci', 'd', true);
  x.tick(HEAVY_SCAN_MS);
  for (let i = 0; i < HEAVY_SCAN_MISSES + 2; i++) await x.l.scan();
  assert.deepEqual(x.l.snapshot().map((h) => h.agentId), ['a'], 'a: root absent = unknown; b: root present, nothing new = freed');
});

test('Jim X2: the creation-time skew is exactly 2 s (created 2 s before the acquire counts, 2 s + 1 ms does not)', async () => {
  assert.equal(HEAVY_CREATED_SKEW_MS, 2_000);
  for (const [created, kept] of [[1_000_000 - 2_000, true], [1_000_000 - 2_001, false]]) {
    const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => [{ pid: 10, parentPid: 1, commandLine: 'claude.exe', createdMs: 1 }, { pid: 11, parentPid: 10, commandLine: 'x', createdMs: created }] });
    x.l.acquire('a', H, 'npm ci', 'c', true);   // since = 1_000_000
    x.tick(HEAVY_SCAN_MS);
    for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await x.l.scan();
    assert.equal(x.l.snapshot().length, kept ? 1 : 0, `created ${created}`);
  }
});

test('MF4 LIVE (Windows): the real hidden listing returns this node process with its CreatedMs', { skip: process.platform !== 'win32' }, async () => {
  const rows = await probeProcesses();
  assert.ok(Array.isArray(rows) && rows.length > 10, 'a usable listing');
  const me = rows.find((r) => r.pid === process.pid);
  assert.ok(me, 'this process is listed');
  assert.equal(typeof me.createdMs, 'number', 'the CreatedMs alias reaches the parser');
  assert.ok(Math.abs(me.createdMs - (Date.now() - process.uptime() * 1000)) < 10_000, 'the same clock');
});
