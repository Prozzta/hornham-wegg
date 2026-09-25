'use strict';

/**
 * HOOK-BROKER P3 (Jim's spike, god's go): Codex PreToolUse/PostToolUse as `mcp_tool` hooks into
 * the in-app MCP endpoint (0 processes). The tool receives no payload, so it is rebuilt from the
 * rollout tail; everything else about the hook is handled exactly like the command shim's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-p3-home-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { HookServer } = loadTs('src/main/hooks.ts');
const mcp = loadTs('src/main/codexHookMcp.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const THREAD = '01a0a169-b0e4-71f0-970a-4a8033ccaae4';
const TURN = '01a0a169-b0e4-71f0-970a-4a8033cc0001';
const OLD_TURN = '01a0a0f3-6380-7da1-9c69-f9b2a928ed56';
// Real rollout line shapes (from a live Codex 0.154 rollout).
const L = {
  taskComplete: (t) => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'task_complete', turn_id: t } }),
  turnContext: (t) => JSON.stringify({ timestamp: 't', type: 'turn_context', payload: { turn_id: t, cwd: 'C:\\x' } }),
  call: (id, name, input) => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name, input } }),
  fcall: (id, name, args) => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } }),
  out: (id, text) => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text }] } }),
  tokens: () => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: {} } })
};

test('rebuildToolHook: PreToolUse gets the PENDING call; turn_id from turn_context, never an older task_complete', () => {
  const tail = [L.turnContext(OLD_TURN), L.call('c0', 'exec', 'old'), L.out('c0', 'x'), L.taskComplete(OLD_TURN), L.turnContext(TURN), L.call('c1', 'exec', 'echo p3')].join('\n');
  const r = mcp.rebuildToolHook(tail, 'PreToolUse');
  assert.deepEqual(r, { turnId: TURN, toolName: 'exec', toolInput: { input: 'echo p3' }, callId: 'c1', degraded: false });
});

test('rebuildToolHook: a LATE task_complete of an older turn never replaces the running turn\'s id', () => {
  const tail = [L.turnContext(TURN), L.taskComplete(OLD_TURN), L.call('c1', 'exec', 'echo p3')].join('\n');
  assert.equal(mcp.rebuildToolHook(tail, 'PreToolUse').turnId, TURN);
});

test('rebuildToolHook: PostToolUse joins the newest output to its call; function_call arguments are parsed', () => {
  const tail = [L.turnContext(TURN), L.fcall('c2', 'shell', { command: ['echo', 'hi'] }), L.out('c2', 'hi'), L.tokens()].join('\n');
  const r = mcp.rebuildToolHook(tail, 'PostToolUse');
  assert.equal(r.toolName, 'shell');
  assert.deepEqual(r.toolInput, { command: ['echo', 'hi'] });
  assert.deepEqual(r.toolResponse, [{ type: 'input_text', text: 'hi' }]);
  assert.equal(r.turnId, TURN);
  assert.equal(r.degraded, false);
});

test('rebuildToolHook: no pending call yet (every call has its output) or no call at all -> DEGRADED', () => {
  const done = [L.turnContext(TURN), L.call('c1', 'exec', 'a'), L.out('c1', 'x')].join('\n');
  assert.deepEqual(mcp.rebuildToolHook(done, 'PreToolUse'), { turnId: TURN, degraded: true });
  assert.deepEqual(mcp.rebuildToolHook(L.turnContext(TURN), 'PostToolUse'), { turnId: TURN, degraded: true });
});

test('rebuildToolHook: PostToolUse fires BEFORE Codex writes the output item (measured on the TUI): the newest call, no response yet, NOT degraded', () => {
  const tail = [L.turnContext(TURN), L.call('c0', 'exec', 'old'), L.out('c0', 'x'), L.call('c1', 'exec', 'echo one')].join('\n');
  assert.deepEqual(mcp.rebuildToolHook(tail, 'PostToolUse'), { turnId: TURN, toolName: 'exec', toolInput: { input: 'echo one' }, callId: 'c1', degraded: false });
});

test('the MCP hooks are bounded at 5 s (hook timeout + MCP tool timeout); a healthy one takes ms', () => {
  assert.equal(mcp.MCP_HOOK_TIMEOUT_S, 5);
  const t = mcp.codexMcpHookToml('http://127.0.0.1:1/mcp/a/' + 'ab'.repeat(16), 'ab'.repeat(16));
  assert.match(t.server, /tool_timeout_sec = 5/);
  assert.match(t.hook('PreToolUse'), /\ntimeout = 5\n/);
});

test('CodexThreadRollouts finds the rollout whose name ends in the thread id (newest day first)', (t) => {
  const home = fs.mkdtempSync(path.join(JAIL, 'cx-'));
  const day = path.join(home, 'sessions', '2026', '09', '25'); fs.mkdirSync(day, { recursive: true });
  const f = path.join(day, `rollout-2026-09-25T20-00-00-${THREAD}.jsonl`); fs.writeFileSync(f, L.turnContext(TURN) + '\n');
  fs.writeFileSync(path.join(day, 'rollout-2026-09-25T19-00-00-other-thread-0000.jsonl'), '');
  const r = new mcp.CodexThreadRollouts();
  assert.equal(r.find(home, THREAD), f);
  assert.equal(r.find(home, 'not a thread id!'), null);
});

/** A real HookServer with a Codex home holding a rollout for THREAD. */
async function server(t, { gated = [], sessionId } = {}) {
  const home = fs.mkdtempSync(path.join(JAIL, 'cx-'));
  const day = path.join(home, 'sessions', '2026', '09', '25'); fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-x-${THREAD}.jsonl`);
  fs.writeFileSync(rollout, [L.turnContext(TURN), L.call('c1', 'exec', 'echo p3')].join('\n') + '\n');
  const rec = { handled: [], events: [], sessions: [], breaker: [] };
  const hive = { sockPath: () => (process.platform === 'win32' ? `\\\\.\\pipe\\p3-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(home, 's.sock')), codexHomeFor: () => home, recordSession: (a, s) => rec.sessions.push([a, s]), appendLog: () => {}, registry: () => ({ agents: { cx: { sessionId } } }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: (id, tool) => (gated.includes(tool) ? { deny: true, reason: `Tool ${tool} is gated by the operator.` } : { deny: false }), snapshot: () => ({ gatedTools: gated }) };
  const breaker = { recordToolUse: (...a) => rec.breaker.push(a), recordCompactStart: () => {}, recordCompactEnd: () => {} };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control, breaker, undefined, (agentId, event, message, fullyIdle, turnId) => rec.events.push({ agentId, event, turnId }));
  const real = s.handle.bind(s); s.handle = (p) => { rec.handled.push(JSON.parse(JSON.stringify(p))); return real(p); };
  s.start(); t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return { s, rec, rollout, home };
}
function rpc(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let o = ''; res.on('data', (d) => { o += d; }); res.on('end', () => resolve({ status: res.statusCode, body: o ? JSON.parse(o) : null })); });
    req.on('error', reject); req.end(data);
  });
}
const call = (ep, event, k = ep.token, threadId = THREAD) => rpc(ep.url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hive_hook', arguments: { event, k }, _meta: { threadId } } });

test('MCP handshake: initialize, notifications, tools/list (one internal tool), ping', async (t) => {
  const { s } = await server(t);
  const ep = s.mcpEndpoint('cx');
  assert.match(ep.url, /\/mcp\/cx\/[0-9a-f]{32}$/);
  const init = await rpc(ep.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal((await rpc(ep.url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc(ep.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map((x) => x.name), ['hive_hook']);
  assert.deepEqual((await rpc(ep.url, { jsonrpc: '2.0', id: 3, method: 'ping' })).body.result, {});
});

test('a PreToolUse over MCP is rebuilt from the rollout and handled like the shim\'s (agent, tool, turn, seq, transport)', async (t) => {
  const { s, rec, rollout } = await server(t);
  const ep = s.mcpEndpoint('cx');
  const r = await call(ep, 'PreToolUse');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result.structuredContent, {});
  const p = rec.handled[0];
  assert.equal(p.agent_id, 'cx');
  assert.equal(p.tool_name, 'exec');
  assert.deepEqual(p.tool_input, { input: 'echo p3' });
  assert.equal(p.turn_id, TURN);
  assert.equal(p.session_id, THREAD);
  assert.equal(p.transcript_path, rollout);
  assert.equal(p.transport, 'mcp');
  assert.equal(p.seq, 1);
  assert.deepEqual(rec.events, [{ agentId: 'cx', event: 'PreToolUse', turnId: TURN }], 'the FALSEACTIVE turn tracking gets the turn id');
});

test('a gate decision maps back as hookSpecificOutput (deny)', async (t) => {
  const { s } = await server(t, { gated: ['exec'] });
  const r = await call(s.mcpEndpoint('cx'), 'PreToolUse');
  assert.equal(r.body.result.structuredContent.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.body.result.content[0].text, /deny/);
});

test('a wrong/missing k, a wrong URL token, another tool name or an unsupported event is rejected and NOT handled', async (t) => {
  const { s, rec } = await server(t);
  const ep = s.mcpEndpoint('cx');
  assert.equal((await call(ep, 'PreToolUse', '0'.repeat(32))).body.error.code, -32001, 'the model cannot inject: k must be the agent token');
  assert.equal((await call(ep, 'PreToolUse', null)).body.error.code, -32001);
  assert.equal((await rpc(ep.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'other', arguments: { event: 'PreToolUse', k: ep.token } } })).body.error.code, -32001);
  assert.equal((await call(ep, 'Stop')).body.error.code, -32602, 'only the tool hooks ride MCP');
  const bad = ep.url.replace(/[0-9a-f]{32}$/, 'f'.repeat(32));
  assert.equal((await rpc(bad, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 403);
  assert.equal(rec.handled.length, 0);
});

test('a subagent thread (not the agent\'s recorded session) becomes provider_agent_id and stays out of its lifecycle', async (t) => {
  const { s, rec } = await server(t, { sessionId: 'main-thread-0000' });
  await call(s.mcpEndpoint('cx'), 'PreToolUse');
  assert.equal(rec.handled[0].provider_agent_id, THREAD);
  assert.deepEqual(rec.events, [], 'no lifecycle transition from a subagent');
  assert.deepEqual(rec.sessions, []);
});

test('degraded: the item is not in the rollout (after one retry) -> delivered degraded; fails CLOSED only with a gate active; the breaker skips it', async (t) => {
  const open = await server(t);
  fs.writeFileSync(open.rollout, [L.turnContext(TURN), L.call('c1', 'exec', 'a'), L.out('c1', 'x')].join('\n') + '\n');
  const ep = open.s.mcpEndpoint('cx');
  const r1 = await call(ep, 'PreToolUse');
  assert.deepEqual(r1.body.result.structuredContent, {}, 'no gates: nothing to deny');
  assert.equal(open.rec.handled[0].payload_degraded, true);
  assert.equal(open.rec.handled[0].tool_name, undefined);
  fs.writeFileSync(open.rollout, L.turnContext(TURN) + '\n');
  await call(ep, 'PostToolUse');
  assert.deepEqual(open.rec.breaker, [], 'the breaker never samples a degraded hook');
  const closed = await server(t, { gated: ['Bash'] });
  fs.writeFileSync(closed.rollout, L.turnContext(TURN) + '\n');
  const r2 = await call(closed.s.mcpEndpoint('cx'), 'PreToolUse');
  assert.equal(r2.body.result.structuredContent.hookSpecificOutput.permissionDecision, 'deny', 'unknown tool + an active gate = deny');
});

test('the retry catches an item that lands just after the hook (the spike saw ~25 ms)', async (t) => {
  const { s, rec, rollout } = await server(t);
  fs.writeFileSync(rollout, L.turnContext(TURN) + '\n');
  setTimeout(() => fs.appendFileSync(rollout, L.call('c9', 'exec', 'late') + '\n'), 5);
  await call(s.mcpEndpoint('cx'), 'PreToolUse');
  assert.equal(rec.handled[0].tool_name, 'exec');
  assert.equal(rec.handled[0].payload_degraded, undefined);
});

async function codexConfig(broker) {
  const home = fs.mkdtempSync(path.join(JAIL, 'h-'));
  const hive = new HiveManager(() => home);
  hive.setHookBroker(broker);
  await hive.ensureAgent({ id: 'cx', name: 'C', provider: 'codex', cwd: home });
  return fs.readFileSync(path.join(home, 'hive', 'agents', 'cx', '.codex', 'config.toml'), 'utf8');
}

test('config: mcp_tool ONLY for PreToolUse/PostToolUse (+ the MCP server); every other event stays the command shim', async () => {
  const tok = 'ab'.repeat(16);
  const cfg = await codexConfig({ urlFor: () => null, mcpFor: () => ({ url: `http://127.0.0.1:5555/mcp/cx/${tok}`, token: tok }), revoke: () => {} });
  assert.match(cfg, /\[mcp_servers\.munder_hooks\]\nurl = "http:\/\/127\.0\.0\.1:5555\/mcp\/cx\/[0-9a-f]{32}"/);
  const blocks = cfg.split('[[hooks.').slice(1).filter((b) => !b.startsWith(b.split(']')[0] + '.hooks'));
  const byEvent = {};
  for (const m of cfg.matchAll(/\[\[hooks\.(\w+)\.hooks\]\]\ntype = "(\w+)"/g)) byEvent[m[1]] = m[2];
  assert.deepEqual(byEvent, { PreToolUse: 'mcp_tool', PostToolUse: 'mcp_tool', Stop: 'command', SubagentStop: 'command', SessionStart: 'command', UserPromptSubmit: 'command', PreCompact: 'command', PostCompact: 'command' });
  assert.match(cfg, new RegExp(`input = \\{ event = "PreToolUse", k = "${tok}" \\}`));
  assert.doesNotMatch(cfg, /enabled_tools/, 'hiding the tool breaks the hooks (spike C)');
  assert.doesNotMatch(cfg, /type = "(prompt|agent)"/, 'never a hook type that runs the model');
  void blocks;
});

test('config: with no MCP endpoint (broker down) every Codex hook is the command shim, as before', async () => {
  const cfg = await codexConfig({ urlFor: () => null, mcpFor: () => null, revoke: () => {} });
  assert.doesNotMatch(cfg, /mcp_servers\.munder_hooks|mcp_tool/);
  assert.equal([...cfg.matchAll(/type = "command"/g)].length, 8);
});

test('STATIC: the MCP-routed events are exactly Pre/PostToolUse, and no hook type that consumes model tokens exists anywhere', () => {
  assert.deepEqual([...mcp.MCP_HOOK_EVENTS], ['PreToolUse', 'PostToolUse']);
  for (const f of ['src/main/hive.ts', 'src/main/codexHookMcp.ts', 'src/main/hooks.ts']) {
    assert.doesNotMatch(codeOnly(readSource(f)), /type = "(prompt|agent)"|type: '(prompt|agent)'/, f);
  }
});

test('N-P3a: a call an earlier ABORTED turn never answered is not pending; only the current turn\'s calls count', () => {
  const tail = [L.turnContext(OLD_TURN), L.call('old', 'exec', 'stale'), L.turnContext(TURN), L.call('c1', 'exec', 'now')].join('\n');
  assert.deepEqual(mcp.rebuildToolHook(tail, 'PreToolUse'), { turnId: TURN, toolName: 'exec', toolInput: { input: 'now' }, callId: 'c1', degraded: false });
  const none = [L.turnContext(OLD_TURN), L.call('old', 'exec', 'stale'), L.turnContext(TURN)].join('\n');
  assert.deepEqual(mcp.rebuildToolHook(none, 'PreToolUse'), { turnId: TURN, degraded: true }, 'the stale call is never claimed as this hook\'s');
});

test('rebuildToolHook: two PENDING parallel calls are ambiguous for PreToolUse -> degraded, no name claimed', () => {
  const tail = [L.turnContext(TURN), L.call('c1', 'exec', 'a'), L.call('c2', 'exec', 'b')].join('\n');
  assert.deepEqual(mcp.rebuildToolHook(tail, 'PreToolUse'), { turnId: TURN, degraded: true });
  const one = [L.turnContext(TURN), L.call('c1', 'exec', 'a'), L.out('c1', 'x'), L.call('c2', 'exec', 'b')].join('\n');
  assert.equal(mcp.rebuildToolHook(one, 'PreToolUse').toolName, 'exec', 'one pending is unambiguous');
});
