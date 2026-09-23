'use strict';

/**
 * AGY 1.1.48 commit 2 - the statusline shim, its transport, and HookServer's intake.
 *
 * The shim is executed for real here: written to a temp dir exactly as hive.ts writes it,
 * run under node with real stdin, and pointed at a real local pipe. Antigravity waits on
 * it (and auto-disables a statusline that keeps failing), so the timing contract is part
 * of the behaviour: every path exits 0, the fast paths well inside 500 ms.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { AGY_STATUSLINE_SHIM } = loadTs('src/main/agyStatuslineShim.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const FIXTURE = path.join(__dirname, 'fixtures', 'agy-statusline-1.2.8.json');
const EMAIL = 'fixture.person@example.invalid';
const golden = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// ─── harness ────────────────────────────────────────────────────────────────

function shimFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agy-statusline.cjs');
  fs.writeFileSync(file, AGY_STATUSLINE_SHIM, 'utf8');
  // Loaded with --require BEFORE the shim: records how long the shim itself ran, from its
  // first line to process exit, into a side file - so stdout and stderr stay exactly what
  // the shim wrote. Process creation is outside this window by construction.
  fs.writeFileSync(path.join(dir, 'timing-preload.cjs'),
    "const t0 = process.hrtime.bigint();\n" +
    "process.on('exit', () => { require('fs').writeFileSync(process.env.SHIM_ELAPSED_FILE, String(Number(process.hrtime.bigint() - t0) / 1e6)); });\n");
  return { dir, file };
}

let pipeSeq = 0;
let elapsedSeq = 0;
const pipeName = (dir) => process.platform === 'win32'
  ? `\\\\.\\pipe\\agy-shim-test-${process.pid}-${++pipeSeq}`
  : path.join(dir, `s${++pipeSeq}.sock`);

/** A pipe server that records every newline-delimited message it receives. */
async function server(t, dir) {
  const sock = pipeName(dir);
  const got = [];
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { if (buf) got.push(buf); c.end('{}'); });
    c.on('error', () => {});
  });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  return { sock, got };
}

/** Run the shim. `stdin` null leaves stdin OPEN (to test the watchdog). */
function runShim(file, { stdin, env = {}, args = [] } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const elapsedFile = path.join(path.dirname(file), `elapsed-${++elapsedSeq}.txt`);
    const child = spawn(process.execPath, ['--require', path.join(path.dirname(file), 'timing-preload.cjs'), file, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SHIM_ELAPSED_FILE: elapsedFile, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // A shim that never exits must FAIL a test, not hang the suite: kill it and say so.
    const guard = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, 5000);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      let inProcess = null;
      try { inProcess = Number(fs.readFileSync(elapsedFile, 'utf8')); } catch (e) { /* never exited cleanly */ }
      resolve({ code: signal ? `killed:${signal}` : code, out, err, ms: Date.now() - started, inProcess });
    });
    if (stdin !== null) child.stdin.end(stdin);
  });
}

/** Give the server a moment to see the connection's end. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/**
 * THE TIMING CONTRACT, MEASURED INSIDE THE SHIM.
 *
 * Wall time from spawn includes process creation, which the shim cannot influence: under
 * the full suite's concurrency two back-to-back bare node starts differed by hundreds of
 * milliseconds, and first an absolute bound and then a baseline-relative one both flaked
 * on it. So the shim is timed from its own first line to its exit (see the preload), and
 * the assertions say what the contract actually means: a fast path exits ON ITS OWN, long
 * before the 400 ms watchdog could fire; a stuck stdin exits BECAUSE of the watchdog.
 * End-to-end latency under a real AGY on a loaded machine is a packaged-gate measurement
 * (commit 5), and a real risk - AGY auto-disables a statusline that keeps failing.
 */
const WATCHDOG_MS = 400;
/** A fast path must finish well inside the watchdog. Generous, because a starved CPU
 *  still slows the shim's own few milliseconds of work. */
const FAST_PATH_MAX_MS = 300;
/** How far past the watchdog a starved process may be scheduled before it exits. */
const WATCHDOG_SLACK_MS = 1500;

// ─── the happy path ─────────────────────────────────────────────────────────

test('SHIM: one sanitized line out, one envelope to HIVE_SOCK, exit 0 - fast', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  const r = await runShim(file, { stdin: JSON.stringify(golden()), env: { HIVE_SOCK: srv.sock, AGENT_ID: 'andy-1' } });
  await settle();

  assert.equal(r.code, 0);
  assert.equal(r.out, `AGY ${String.fromCharCode(183)} Gemini 3.8 Flash (High) ${String.fromCharCode(183)} working\n`);
  assert.equal(r.err, '');
  assert.ok(r.inProcess !== null && r.inProcess < FAST_PATH_MAX_MS,
    `exits on its own, not by the watchdog: ${r.inProcess} ms in-process (${r.ms} ms wall)`);

  assert.equal(srv.got.length, 1, 'exactly one envelope');
  const lines = srv.got[0].split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'newline-delimited, one message');
  const env = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(env).sort(), ['agent_id', 'agy_status', 'hook_event_name']);
  assert.equal(env.hook_event_name, 'AgyStatusLine');
  assert.equal(env.agent_id, 'andy-1');
  assert.deepEqual(env.agy_status, golden(), 'the payload travels whole, to be normalized in main');
});

test('SHIM: the terminal line carries no quota, no identity, no path, no JSON', async (t) => {
  const { file } = shimFile(t);
  const r = await runShim(file, { stdin: JSON.stringify(golden()) });
  for (const secret of [EMAIL, 'fixture-home', 'fixture-workspace', '0.97', '97', 'quota', '{', 'Google AI Pro']) {
    assert.ok(!r.out.includes(secret), `leaked to the terminal: ${secret}`);
  }
});

test('SHIM: state words for idle, tool_use and confirmation', async (t) => {
  const { file } = shimFile(t);
  const line = async (fn) => { const p = golden(); fn(p); return (await runShim(file, { stdin: JSON.stringify(p) })).out; };
  assert.match(await line((p) => { p.agent_state = 'idle'; }), / idle\n$/);
  assert.match(await line((p) => { p.agent_state = 'tool_use'; }), / working\n$/);
  assert.match(await line((p) => { p.agent_state = 'tool_use'; p.tool_confirmation_pending = true; }), / confirmation\n$/);
  assert.equal(await line((p) => { p.agent_state = 'authenticating'; p.model = null; }), '', 'boot: no line');
});

test('SHIM: control characters and escapes are stripped; the model is cut at 48', async (t) => {
  const { file } = shimFile(t);
  const p = golden();
  p.model.display_name = `\u001b[31mRed\u0007 ${'M'.repeat(80)}`;
  const r = await runShim(file, { stdin: JSON.stringify(p) });
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(r.out.slice(0, -1)), 'no control characters survive');
  const model = r.out.split(` ${String.fromCharCode(183)} `)[1];
  assert.ok([...model].length <= 48, `truncated: ${[...model].length}`);
});

test('SHIM: a personal session (no AGENT_ID) sends agent_id null - never invented', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  await runShim(file, { stdin: JSON.stringify(golden()), env: { HIVE_SOCK: srv.sock } });
  await settle();
  assert.equal(JSON.parse(srv.got[0]).agent_id, null);
});

// ─── every failure path exits 0, quickly ────────────────────────────────────

test('SHIM FAILURES: dead socket, bad JSON, empty, array, oversize - all exit 0, none connect', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  const big = JSON.stringify({ ...golden(), pad: 'x'.repeat(70 * 1024) });
  const cases = [
    ['dead socket', JSON.stringify(golden()), { HIVE_SOCK: pipeName(dir) }],
    ['invalid JSON', '{ nope', { HIVE_SOCK: srv.sock }],
    ['empty stdin', '', { HIVE_SOCK: srv.sock }],
    ['an array', '[1,2,3]', { HIVE_SOCK: srv.sock }],
    ['over the 64 KiB ceiling', big, { HIVE_SOCK: srv.sock }]
  ];
  for (const [name, stdin, env] of cases) {
    const r = await runShim(file, { stdin, env });
    assert.equal(r.code, 0, `${name}: exit 0`);
    assert.ok(r.inProcess !== null && r.inProcess < FAST_PATH_MAX_MS,
      `${name}: exits on its own - ${r.inProcess} ms in-process (${r.ms} ms wall)`);
    if (name !== 'dead socket') assert.equal(r.out, '', `${name}: nothing printed`);
  }
  await settle();
  assert.equal(srv.got.length, 0, 'not one of them reached the server');
});

test('SHIM WATCHDOG: stdin that never closes still exits 0 at ~400 ms', async (t) => {
  const { file } = shimFile(t);
  const r = await runShim(file, { stdin: null });
  assert.equal(r.code, 0, 'exits by itself - not killed by the test guard');
  // It ends at all (no hang), and it ends because of the 400 ms watchdog - not before.
  assert.ok(r.inProcess >= WATCHDOG_MS - 10, `the WATCHDOG ended it, not an early exit: ${r.inProcess} ms in-process`);
  assert.ok(r.inProcess < WATCHDOG_MS + WATCHDOG_SLACK_MS, `and it did fire: ${r.inProcess} ms in-process`);
});

// ─── endpoint selection ─────────────────────────────────────────────────────

function locator(dir, fields) {
  const file = path.join(dir, 'endpoint.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, pid: process.pid, processStartedAt: 1, createdAt: 1, ...fields }));
  return file;
}
const OWNER = 'c'.repeat(32);

test('LOCATOR: with no HIVE_SOCK, a valid locator for THIS owner token is used', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  const loc = locator(dir, { sock: srv.sock, token: OWNER });
  await runShim(file, { stdin: JSON.stringify(golden()), args: ['--owner', OWNER, '--locator', loc] });
  await settle();
  assert.equal(srv.got.length, 1);
});

test('LOCATOR: a token mismatch, a dead owner, a wrong schema or a relative path - no connect', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  const cases = [
    ['token mismatch', { sock: srv.sock, token: 'd'.repeat(32) }, OWNER],
    ['dead owning process', { sock: srv.sock, token: OWNER, pid: 2147483646 }, OWNER],
    ['wrong schema', { sock: srv.sock, token: OWNER, schema: 2 }, OWNER]
  ];
  for (const [name, fields, owner] of cases) {
    const loc = locator(dir, fields);
    const r = await runShim(file, { stdin: JSON.stringify(golden()), args: ['--owner', owner, '--locator', loc] });
    assert.equal(r.code, 0, name);
  }
  const rel = await runShim(file, { stdin: JSON.stringify(golden()), args: ['--owner', OWNER, '--locator', 'endpoint.json'] });
  assert.equal(rel.code, 0);
  await settle();
  assert.equal(srv.got.length, 0, 'none of them connected');
});

test('LOCATOR: an inherited HIVE_SOCK wins over any locator', async (t) => {
  const { dir, file } = shimFile(t);
  const worker = await server(t, dir);
  const personal = await server(t, dir);
  const loc = locator(dir, { sock: personal.sock, token: OWNER });
  await runShim(file, { stdin: JSON.stringify(golden()), env: { HIVE_SOCK: worker.sock }, args: ['--owner', OWNER, '--locator', loc] });
  await settle();
  assert.equal(worker.got.length, 1);
  assert.equal(personal.got.length, 0);
});

// ─── census ─────────────────────────────────────────────────────────────────

test('CENSUS: the shim requires built-in fs, net and path, and nothing else', () => {
  const requires = [...AGY_STATUSLINE_SHIM.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(requires, ['fs', 'net', 'path']);
  assert.ok(!/\bimport\b/.test(AGY_STATUSLINE_SHIM), 'no ESM import either');
});

test('CENSUS: the shim source has no backslash, backtick or dollar-brace to be mangled', () => {
  assert.ok(!AGY_STATUSLINE_SHIM.includes(String.fromCharCode(92)), 'backslash');
  assert.ok(!AGY_STATUSLINE_SHIM.includes(String.fromCharCode(96)), 'backtick');
  assert.ok(!AGY_STATUSLINE_SHIM.includes('$' + '{'), 'dollar-brace');
});

test('CENSUS: the shim never logs, never reads email, never polls', () => {
  assert.ok(!/console\./.test(AGY_STATUSLINE_SHIM), 'no console output - stdout is the terminal line only');
  assert.ok(!/email/.test(AGY_STATUSLINE_SHIM), 'never names the email field');
  assert.ok(!/setInterval/.test(AGY_STATUSLINE_SHIM), 'no polling');
  assert.match(AGY_STATUSLINE_SHIM, /var MAX_STDIN = 65536;/);
  assert.match(AGY_STATUSLINE_SHIM, /var CONNECT_MS = 150;/);
  assert.match(AGY_STATUSLINE_SHIM, /var WATCHDOG_MS = 400;/);
  // Declared is not enough - each deadline must actually be ARMED.
  // Plain substring checks, deliberately: a regex here has to escape parentheses, and a
  // lost backslash turns the escape into a capture group that silently tests something
  // else. (It happened while writing this test.)
  assert.ok(AGY_STATUSLINE_SHIM.includes('setTimeout(quit, WATCHDOG_MS);'), 'the absolute watchdog is armed');
  assert.ok(AGY_STATUSLINE_SHIM.includes('}, CONNECT_MS);'), 'the connect/write deadline is armed');
  assert.ok(AGY_STATUSLINE_SHIM.includes('if (size > MAX_STDIN)'), 'the stdin ceiling is enforced');
});

// ─── HookServer intake ──────────────────────────────────────────────────────

/**
 * The golden payload, re-anchored to NOW. HookServer stamps receipt with the real clock,
 * and the normaliser checks every reset against receipt within 5 s - so the fixture's
 * resets, measured against 2026-09-22, are correctly refused as `reset-disagree`. That
 * refusal is the consistency check doing its job; for an accept-path test the resets have
 * to be consistent with the moment of receipt.
 */
function fresh() {
  const p = golden();
  const now = Date.now();
  for (const b of Object.values(p.quota)) b.reset_time = new Date(now + b.reset_in_seconds * 1000).toISOString();
  return p;
}

const logRows = [];
function hookServer({ onEvent, onAgyTick, control } = {}) {
  logRows.length = 0;
  const hive = { sockPath: () => null, codexHomeFor: () => null, recordSession: () => {}, appendLog: (e) => logRows.push(e) };
  return new HookServer(hive, () => null, () => ({}), control, undefined, undefined, onEvent, undefined, onAgyTick);
}

test('HOOKSERVER: a valid envelope yields ONE coherent tick, and touches no hook machinery', () => {
  const ticks = [];
  const events = [];
  const s = hookServer({
    onEvent: (...a) => events.push(a),
    onAgyTick: (agentId, tick) => ticks.push({ agentId, tick }),
    control: { shouldHalt: () => { throw new Error('the halt gate must not be consulted'); } }
  });
  const res = s.handle({ hook_event_name: 'AgyStatusLine', agent_id: 'andy-1', agy_status: fresh() });
  assert.deepEqual(res, {});
  assert.equal(events.length, 0, 'a statusline tick is not a hook event');
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].agentId, 'andy-1');
  assert.equal(ticks[0].tick.observations.length, 2);
  assert.equal(ticks[0].tick.lifecycle, 'running');
});

test('HOOKSERVER: a personal tick arrives with agentId null', () => {
  const ticks = [];
  const s = hookServer({ onAgyTick: (agentId) => ticks.push(agentId) });
  s.handle({ hook_event_name: 'AgyStatusLine', agent_id: null, agy_status: fresh() });
  assert.deepEqual(ticks, [null]);
});

test('HOOKSERVER: drift is counted by {version, code} - no tick, nothing retained', (t) => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a);
  t.after(() => { console.warn = orig; });
  const ticks = [];
  const s = hookServer({ onAgyTick: (...a) => ticks.push(a) });
  const bad = fresh();
  bad.quota['3p-5h'].remaining_fraction = 2;
  s.handle({ hook_event_name: 'AgyStatusLine', agent_id: 'a', agy_status: bad });
  s.handle({ hook_event_name: 'AgyStatusLine', agent_id: 'a', agy_status: bad });
  assert.equal(ticks.length, 0);
  assert.deepEqual(s.agyDriftCounts(), { '1.2.8|fraction': 2 });
  assert.equal(warned.length, 1, 'logged once per kind, not once per tick');
  assert.deepEqual(logRows, [{ kind: 'agy-statusline-drift', version: '1.2.8', driftCode: 'fraction' }],
    'one log.jsonl row: the fixed code and version, and nothing else');
  const logged = JSON.stringify(warned);
  for (const secret of [EMAIL, 'fixture-home', 'quota', '0.97']) assert.ok(!logged.includes(secret), `leaked: ${secret}`);
});

test('HOOKSERVER: the boot tick is not drift; the tally is bounded', (t) => {
  const orig = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = orig; });
  const s = hookServer({});
  s.handle({ hook_event_name: 'AgyStatusLine', agy_status: { version: '1.2.8', agent_state: 'authenticating', model: null } });
  assert.deepEqual(s.agyDriftCounts(), {}, 'authenticating is the ratified boot state, not a fault');
  for (let i = 0; i < 50; i++) {
    const p = golden();
    p.version = `9.${i}`;
    p.agent_state = 'mystery';
    s.handle({ hook_event_name: 'AgyStatusLine', agy_status: p });
  }
  const counts = s.agyDriftCounts();
  assert.equal(Object.keys(counts).length, 33, '32 distinct keys plus one overflow bucket');
  assert.equal(counts.overflow, 18);
});

// ─── wiring census ──────────────────────────────────────────────────────────

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('WIRING: startup leases after the HookServer listens; every teardown releases it', () => {
  const index = read('src/main/index.ts');
  const start = index.indexOf('hookServer.start();');
  const lease = index.indexOf('hive.startAgyStatusline();');
  assert.ok(start > 0 && lease > start, 'the locator must name a pipe that is already listening');
  for (const tag of ['quit', 'changeHome', 'reset']) {
    const release = index.indexOf(`console.error('[${tag}] stopAgyStatusline:'`);
    const stop = index.indexOf(`console.error('[${tag}] hookServer.stop:'`);
    assert.ok(release > 0 && release < stop, `${tag}: released before the HookServer stops`);
  }
  assert.match(index, /app\.on\('will-quit', \(\) => \{[\s\S]{0,600}hive\.stopAgyStatusline\(\)/,
    'and on will-quit, which an ordinary quit with no terminals reaches without teardownAndQuit');
});

test('WIRING: the dev build never leases, and an AGY spawn reconciles first', () => {
  const hive = read('src/main/hive.ts');
  const body = hive.slice(hive.indexOf('  startAgyStatusline(): void {'), hive.indexOf('  reconcileAgyStatusline(): void {'));
  assert.match(body, /if \(DEV_ISOLATION\) \{[\s\S]*?return;/, 'MUNDER_DEV=1 returns before anything is written');
  assert.ok(body.indexOf('DEV_ISOLATION') < body.indexOf('new AgyStatuslineOwner'));
  const spawnBranch = hive.slice(hive.indexOf("if (desc.shim === 'agy') {"), hive.indexOf("else if (desc.shim === 'codex')"));
  assert.match(spawnBranch, /this\.installAgyHooks\(\);\s*[\s\S]*?this\.reconcileAgyStatusline\(\);/);
});
