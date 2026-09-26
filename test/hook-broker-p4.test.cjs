'use strict';

/**
 * HOOK-BROKER P4 (AGY, Jim's spike): AGY's observational hooks (PostToolUse, PostInvocation) and
 * its statusline go through `agy-oneway.cmd` (cmd built-ins + findstr, ~34 ms) into the HookServer
 * pipe, one-way, instead of cmd + the Electron shim (~450 ms). The events that must answer
 * (PreToolUse deny, PreInvocation steer (Y1), Stop block) keep the shim. Everything stays zero-token
 * (command hooks only).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-p4-home-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'jailed');
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { HookServer, parseOnewayFrame, agyHookPayload } = loadTs('src/main/hooks.ts');
const { HiveManager, agyOnewayCmd, AGY_HOOK_SHIM } = loadTs('src/main/hive.ts');
const { installedValueFor } = loadTs('src/main/agyStatuslineOwnership.ts');
const WIN = process.platform === 'win32';
const TOKEN = 'ab'.repeat(16);
// AGY's real hook payload shape (camelCase, toolCall{name,args}).
const AGY = { conversationId: 'conv-1', transcriptPath: 'C:/t.jsonl', workspacePaths: ['C:/w'], toolCall: { name: 'run_command', args: { CommandLine: 'echo "hi" & dir' } } };

test('parseOnewayFrame: both headers (CRLF), a literal or empty agent id, and bad headers', () => {
  const h = parseOnewayFrame(`agy PostToolUse phyllis\r\n${JSON.stringify(AGY)}\r\n`);
  assert.deepEqual({ ...h, body: undefined }, { kind: 'hook', event: 'PostToolUse', token: '', agentId: 'phyllis', body: undefined, bodyOk: true });
  assert.deepEqual(h.body, AGY);
  const s = parseOnewayFrame(`agy-status ${TOKEN} phyllis\r\n{"agent_state":"idle"}`);
  assert.equal(s.kind, 'status'); assert.equal(s.token, TOKEN); assert.equal(s.agentId, 'phyllis');
  assert.equal(parseOnewayFrame(`agy-status ${TOKEN} %AGENT_ID%\r\n{}`).agentId, null, 'a literal %AGENT_ID% = no agent');
  assert.equal(parseOnewayFrame(`agy-status ${TOKEN} \r\n{}`).agentId, null, 'empty = a user\'s own session');
  assert.equal(parseOnewayFrame('agy PreToolUse x\r\n{}'), null, 'only the observational events ride one-way');
  assert.equal(parseOnewayFrame('agy-status nothex x\r\n{}'), null);
  assert.equal(parseOnewayFrame('{"hook_event_name":"Stop"}\n'), null);
  const trunc = parseOnewayFrame('agy PostToolUse phyllis\r\n{"toolCall": {"name": "x", "ar');
  assert.equal(trunc.bodyOk, false, 'findstr cuts lines over ~8 KB: degraded, header intact');
});

/** Capture what the REAL AGY_HOOK_SHIM sends for a payload, for the parity check. */
function shimPayload(t, event, agy) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(JAIL, 'shim-'));
    const shim = path.join(dir, 'agy-hook.cjs'); fs.writeFileSync(shim, AGY_HOOK_SHIM);
    const sock = WIN ? `\\\\.\\pipe\\p4-shim-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(dir, 's.sock');
    let got = null;
    const srv = net.createServer((c) => { let b = ''; c.on('data', (d) => { b += d; if (b.includes('\n')) { got = JSON.parse(b.split('\n')[0]); c.end('{}'); } }); });
    srv.listen(sock, () => {
      const ch = spawn(process.execPath, [shim, event], { env: { ...process.env, AGENT_ID: 'phyllis', HIVE_SOCK: sock }, stdio: ['pipe', 'ignore', 'ignore'] });
      ch.on('close', () => { srv.close(); got ? resolve(got) : reject(new Error('no payload')); });
      ch.stdin.end(JSON.stringify(agy));
    });
  });
}

test('translation parity: agyHookPayload == what AGY_HOOK_SHIM sends today', async (t) => {
  for (const ev of ['PostToolUse', 'PostInvocation']) {
    const fromShim = await shimPayload(t, ev, AGY);
    const mine = JSON.parse(JSON.stringify(agyHookPayload(ev, 'phyllis', AGY)));
    for (const k of Object.keys(fromShim)) if (fromShim[k] === undefined) delete fromShim[k];
    delete fromShim.fully_idle;   // Stop-only field, absent on these events
    assert.deepEqual(mine, fromShim, ev);
  }
});

/** What the REAL AGY_HOOK_SHIM prints for an event when the HookServer replies `reply`. */
function shimOut(t, event, reply) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(JAIL, 'shimo-'));
    const shim = path.join(dir, 'agy-hook.cjs'); fs.writeFileSync(shim, AGY_HOOK_SHIM);
    const sock = WIN ? `\\\\.\\pipe\\p4-shimo-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(dir, 's.sock');
    const srv = net.createServer((c) => { let b = ''; c.on('data', (d) => { b += d; if (b.includes('\n')) c.end(JSON.stringify(reply)); }); });
    srv.listen(sock, () => {
      const ch = spawn(process.execPath, [shim, event], { env: { ...process.env, AGENT_ID: 'phyllis', HIVE_SOCK: sock }, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = ''; ch.stdout.on('data', (d) => { out += d; });
      ch.on('close', () => { srv.close(); resolve(out); });
      ch.stdin.end('{}');
    });
  });
}

test('Y1: the AGY shim turns a PreInvocation steer into AGY\'s documented injectSteps (a persistent userMessage); nothing else changes', async (t) => {
  const ctx = { hookSpecificOutput: { hookEventName: 'PreInvocation', additionalContext: 'OPERATOR STEER: B' } };
  assert.deepEqual(JSON.parse(await shimOut(t, 'PreInvocation', ctx)), { injectSteps: [{ userMessage: 'OPERATOR STEER: B' }] });
  assert.equal(await shimOut(t, 'PreInvocation', {}), '', 'no directive: prints nothing');
  assert.deepEqual(JSON.parse(await shimOut(t, 'Stop', { decision: 'block', reason: 'r' })), { decision: 'block', reason: 'r', stopReason: 'r', systemMessage: 'r' });
});

/** A real HookServer on a real pipe, with the lease token. */
async function server(t, owner = TOKEN, control = undefined) {
  const rec = { handled: [] };
  const sock = WIN ? `\\\\.\\pipe\\p4-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 'p4-')), 's.sock');
  const hive = { sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {}, agyStatuslineOwnerToken: () => owner };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control, undefined, undefined, () => {});
  const real = s.handle.bind(s); s.handle = (p) => { rec.handled.push(JSON.parse(JSON.stringify(p))); return real(p); };
  s.start(); t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  const cmdFile = path.join(fs.mkdtempSync(path.join(JAIL, 'bin-')), 'agy-oneway.cmd');
  fs.writeFileSync(cmdFile, agyOnewayCmd(sock));
  return { s, rec, sock, cmdFile };
}
/** Run the one-way command the way AGY does: `<agy-oneway.cmd> <header args>`, stdin = the payload. */
function runOneway(cmdFile, args, env, stdin) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('cmd.exe', ['/d', '/c', cmdFile, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.stdin.end(stdin);
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}
const settle = () => new Promise((r) => setTimeout(r, 150));

test('REAL agy-oneway.cmd: a PostToolUse from a hive agent is delivered, translated, stamped pipe-oneway; no stdout; exit 0', { skip: !WIN }, async (t) => {
  const { rec, cmdFile } = await server(t);
  const r = await runOneway(cmdFile, ['agy', 'PostToolUse'], { AGENT_ID: 'phyllis' }, JSON.stringify(AGY));
  await settle();
  assert.equal(r.code, 0); assert.equal(r.out, '', 'AGY fail-closes on any stdout object: nothing may be printed');
  assert.equal(rec.handled.length, 1);
  const p = rec.handled[0];
  assert.equal(p.hook_event_name, 'PostToolUse'); assert.equal(p.agent_id, 'phyllis'); assert.equal(p.tool_name, 'run_command');
  assert.deepEqual(p.tool_input, { CommandLine: 'echo "hi" & dir' }, 'quotes and & survive');
  assert.equal(p.transport, 'pipe-oneway'); assert.equal(p.seq, 1);
});

test('Y1 (P4 audit): a one-way PostToolUse never consumes a queued steer; the next answering PreInvocation delivers it ONCE', { skip: !WIN }, async (t) => {
  const steers = ['OPERATOR STEER: switch to task B'];
  const control = { shouldHalt: () => false, takeSteer: () => steers.shift(), toolDecision: () => ({ deny: false }) };
  const { s, rec, cmdFile } = await server(t, TOKEN, control);
  await runOneway(cmdFile, ['agy', 'PostToolUse'], { AGENT_ID: 'phyllis' }, JSON.stringify(AGY));
  await settle();
  assert.equal(rec.handled.length, 1); assert.equal(rec.handled[0].transport, 'pipe-oneway');
  assert.equal(steers.length, 1, 'the steer is still queued: a one-way reply is never read');
  const r = s.handle({ hook_event_name: 'PreInvocation', agent_id: 'phyllis', transport: 'pipe' });
  assert.equal(steers.length, 0);
  assert.equal(r.hookSpecificOutput.hookEventName, 'PreInvocation');
  assert.match(r.hookSpecificOutput.additionalContext, /switch to task B/, 'the answering hook carries the steer');
  const again = s.handle({ hook_event_name: 'PreInvocation', agent_id: 'phyllis', transport: 'pipe' });
  assert.doesNotMatch(JSON.stringify(again ?? {}), /switch to task B/, 'delivered once');
  // A second one-way PostToolUse leaves the next steer queued as well.
  steers.push('SECOND');
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'phyllis', transport: 'pipe-oneway' });
  assert.deepEqual(steers, ['SECOND']);
});

test('REAL: a body over findstr\'s ~8 KB line limit is still delivered (degraded, header intact); a user\'s own session is ignored', { skip: !WIN }, async (t) => {
  const { rec, cmdFile } = await server(t);
  await runOneway(cmdFile, ['agy', 'PostInvocation'], { AGENT_ID: 'phyllis' }, JSON.stringify({ ...AGY, big: 'x'.repeat(20000) }));
  await runOneway(cmdFile, ['agy', 'PostToolUse'], { AGENT_ID: '' }, JSON.stringify(AGY));
  await settle();
  assert.equal(rec.handled.length, 1);
  assert.equal(rec.handled[0].hook_event_name, 'PostInvocation');
  assert.equal(rec.handled[0].payload_degraded, true);
});

test('REAL statusline: the lease token is required; a user\'s own session feeds capacity with agent_id null', { skip: !WIN }, async (t) => {
  const { rec, cmdFile } = await server(t);
  const status = JSON.stringify({ agent_state: 'idle', model: { id: 'x' } });
  await runOneway(cmdFile, ['agy-status', TOKEN], { AGENT_ID: 'phyllis' }, status);
  await runOneway(cmdFile, ['agy-status', 'cd'.repeat(16)], { AGENT_ID: 'phyllis' }, status);
  await runOneway(cmdFile, ['agy-status', TOKEN], { AGENT_ID: '' }, status);
  await settle();
  assert.deepEqual(rec.handled.map((p) => [p.hook_event_name, p.agent_id]), [['AgyStatusLine', 'phyllis'], ['AgyStatusLine', null]], 'the wrong token is dropped');
  assert.deepEqual(rec.handled[0].agy_status, JSON.parse(status));
  assert.equal(rec.handled[0].transport, 'pipe-oneway');
});

test('REAL: with the app down (no pipe) the command exits 0 at once, printing nothing', { skip: !WIN }, async (t) => {
  const cmdFile = path.join(fs.mkdtempSync(path.join(JAIL, 'down-')), 'agy-oneway.cmd');
  fs.writeFileSync(cmdFile, agyOnewayCmd(`\\\\.\\pipe\\p4-absent-${process.pid}`));
  const r = await runOneway(cmdFile, ['agy-status', TOKEN], { AGENT_ID: 'phyllis' }, '{}');
  assert.equal(r.code, 0); assert.equal(r.out, '', 'no stdout');
  assert.equal(r.err, '', 'no stderr either (cmd\'s own "cannot find the file" included)');
  assert.ok(r.ms < 3000, `fast: ${r.ms} ms`);
});

test('config: AGY PostToolUse/PostInvocation are the one-way command; PreToolUse/PreInvocation/Stop keep the shim; command type only', { skip: !WIN }, async () => {
  const home = fs.mkdtempSync(path.join(JAIL, 'h-'));
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const hive = new HiveManager(() => home, undefined, {}, () => true);
    await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
    hive.installAgyHooks();
    const hooks = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'hooks.json'), 'utf8'))['munder-hive'];
    // Y2: AGY's hooks.md shapes. Tool events are grouped (matcher + hooks); the rest are FLAT
    // handler objects. A wrapped flat event makes AGY reject the WHOLE group (proven live, 1.2.11).
    for (const ev of ['PreToolUse', 'PostToolUse']) { assert.equal(hooks[ev][0].matcher, '*', ev); assert.equal(hooks[ev][0].hooks.length, 1, ev); }
    for (const ev of ['PreInvocation', 'PostInvocation', 'Stop']) {
      assert.equal(hooks[ev][0].hooks, undefined, `${ev} must be FLAT, not wrapped`);
      assert.equal(hooks[ev][0].matcher, undefined, ev);
      assert.equal(typeof hooks[ev][0].command, 'string', ev);
    }
    const handlerOf = (ev) => (hooks[ev][0].hooks ? hooks[ev][0].hooks[0] : hooks[ev][0]);
    const cmdOf = (ev) => handlerOf(ev).command;
    assert.match(cmdOf('PostToolUse'), /agy-oneway\.cmd agy PostToolUse$/);
    assert.match(cmdOf('PostInvocation'), /agy-oneway\.cmd agy PostInvocation$/);
    // Y1: PreInvocation carries AGY's steer, so it must be able to answer.
    for (const ev of ['PreToolUse', 'PreInvocation', 'Stop']) assert.match(cmdOf(ev), /agy-hook\.cjs/, ev);
    for (const ev of Object.keys(hooks)) { assert.equal(handlerOf(ev).type, 'command'); assert.doesNotMatch(cmdOf(ev), /["']/, 'AGY passes quotes literally'); }
    const bat = fs.readFileSync(path.join(home, 'hive', 'bin', 'agy-oneway.cmd'), 'utf8');
    assert.match(bat, /\(\(echo %1 %2 %AGENT_ID%& findstr \/v \/c:@@m@@\) > \\\\\.\\pipe\\munder-difflin-[0-9a-f]+\) 2>nul/);
  } finally { process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; }
});

test('the statusline value keeps AGY\'s default line beside the one-way command (stack_with_default); the old form is unchanged', () => {
  assert.deepEqual(installedValueFor('c', true), { type: 'command', command: 'c', enabled: true, stack_with_default: true });
  assert.deepEqual(installedValueFor('c'), { type: 'command', command: 'c', enabled: true });
});

test('STATIC: the statusline lease uses the one-way command (with stack_with_default) whenever it exists', () => {
  const { readSource, codeOnly } = require('./read-source.cjs');
  const src = codeOnly(readSource('src/main/hive.ts'));
  assert.match(src, /commandFor: \(token\) => oneway \? `\$\{oneway\} agy-status \$\{token\}` : buildStatuslineCommand\(/);
  assert.match(src, /stackWithDefault: !!oneway,/);
});
