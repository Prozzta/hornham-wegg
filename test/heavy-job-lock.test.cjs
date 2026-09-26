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
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'bash' }, { pid: 11, parentPid: 10, commandLine: 'node --test test/*.test.cjs' }, { pid: 20, parentPid: 2, commandLine: 'npm ci' }];
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
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'bash' }, { pid: 11, parentPid: 10, commandLine: 'npm ci' }];
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
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'bash' }, { pid: 11, parentPid: 10, commandLine: 'npm run build' }];
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
  const y = lock(1, { roots: () => [{ agentId: 'b', pid: 20 }], probe: async () => [{ pid: 20, parentPid: 1, commandLine: 'bash' }] });
  y.l.acquire('b', H, 'npm ci', '1', false);
  y.l.callDone('b', '1');
  await new Promise((r) => setImmediate(r));
  assert.equal(y.l.snapshot().length, 0);
  assert.equal(y.logs.at(-1).reason, 'posttool');
});

test('Jim N5: a TTL expiry while the watcher last SAW the job running logs expired-still-running (not a silent ttl)', async () => {
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => [{ pid: 11, parentPid: 10, commandLine: 'node --test test/*.test.cjs' }] });
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
