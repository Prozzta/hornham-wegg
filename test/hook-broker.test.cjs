'use strict';

/**
 * HOOK-BROKER P1 (Jim's spec, god's go): Claude's hooks are POSTed to the HookServer
 * in-process over loopback HTTP (0 processes per hook) instead of cold-starting cmd.exe +
 * Electron-as-node per event (~450 ms, 2 processes, an antivirus scan each).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

// Probe isolation: nothing below may touch the real HOME (hive objects write provider config).
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-broker-home-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.ok(os.homedir().startsWith(JAIL) || process.env.USERPROFILE === JAIL, 'jailed');
test.after(() => {
  for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const hooks = loadTs('src/main/hooks.ts');
const { HookServer, HOOK_HTTP_BODY_MAX, HOOK_HTTP_RELISTEN_DELAYS_MS, applyUrlIdentity } = hooks;
const { HiveManager, mergeNoProxy, HOOK_HTTP_TIMEOUT_S } = loadTs('src/main/hive.ts');

const A = 'andy-mtuk4y4x', B = 'jim-mtujpe28';

/** A real HookServer (pipe + HTTP broker) with every observable recorded. */
async function broker(t, { halt = false, deny = false, steer = null } = {}) {
  const rec = { events: [], sessions: [], sent: [], handled: [], logs: [], steers: 0 };
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hook-broker-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: (a, s) => rec.sessions.push([a, s]), appendLog: (e) => rec.logs.push(e),
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {}
  };
  const control = {
    shouldHalt: () => halt,
    takeSteer: () => { if (steer === null) return null; rec.steers += 1; const s = steer; steer = null; return s; },
    toolDecision: () => (deny ? { deny: true, reason: 'gated' } : { deny: false })
  };
  const s = new HookServer(hive, () => ({ send: (ch, m) => rec.sent.push({ ch, ...m }) }), () => ({}), control, undefined, undefined,
    (agentId, event, message, fullyIdle, turnId) => rec.events.push({ agentId, event }));
  const realHandle = s.handle.bind(s);
  s.handle = (p) => { rec.handled.push(JSON.parse(JSON.stringify(p))); return realHandle(p); };
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(s.hookBrokerPort(), 'the broker is listening');
  return { s, rec, sock };
}

function post(url, body, raw) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = raw ?? Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let out = ''; res.on('data', (d) => { out += d; }); res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('(1) a POST with the right token reaches handle() with the URL identity, and replies with handle()\'s result', async (t) => {
  const { s, rec } = await broker(t, { deny: true });
  const url = s.hookUrl(A);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/hook\/andy-mtuk4y4x\/[0-9a-f]{32}$/);
  const r = await post(url, { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.hookSpecificOutput.permissionDecision, 'deny', 'the tool gate works over HTTP');
  assert.equal(rec.handled[0].agent_id, A, 'identity from the URL');
  assert.equal(rec.handled[0].transport, 'http');
  const stop = await post(url, { hook_event_name: 'Stop' });
  assert.deepEqual(stop.body, {});
  assert.deepEqual(rec.events.map((e) => [e.agentId, e.event]), [[A, 'PreToolUse'], [A, 'Stop']]);
  assert.deepEqual(rec.sessions, [[A, 's1']]);
});

test('(2) a wrong token, an unknown agent or a revoked token is 403 and never handled', async (t) => {
  const { s, rec } = await broker(t);
  const url = s.hookUrl(A);
  const wrong = url.replace(/[0-9a-f]{32}$/, '0'.repeat(32));
  assert.equal((await post(wrong, { hook_event_name: 'Stop' })).status, 403);
  assert.equal((await post(url.replace('/hook/andy-mtuk4y4x/', '/hook/nobody/'), { hook_event_name: 'Stop' })).status, 403);
  const other = s.hookUrl(B);
  assert.equal((await post(other.replace('/hook/jim-mtujpe28/', '/hook/andy-mtuk4y4x/'), { hook_event_name: 'Stop' })).status, 403, 'B\'s token does not work for A');
  s.revokeHookToken(A);
  assert.equal((await post(url, { hook_event_name: 'Stop' })).status, 403, 'revoked');
  const fresh = s.hookUrl(A); const again = s.hookUrl(A);
  assert.equal((await post(fresh, { hook_event_name: 'Stop' })).status, 403, 'a respawn\'s new token replaces the old one');
  assert.equal((await post(again, { hook_event_name: 'Stop' })).status, 200);
  assert.equal(rec.handled.length, 1, 'only the one valid request was handled');
});

test('(3) identity: the URL wins; a different body agent_id is a subagent (kept out of session/lifecycle/Stop); an incoming provider_agent_id is stripped', async (t) => {
  const { s, rec } = await broker(t);
  const url = s.hookUrl(A);
  await post(url, { hook_event_name: 'PostToolUse', agent_id: A, session_id: 'own' });
  await post(url, { hook_event_name: 'PostToolUse', agent_id: 'a08368e867baa90c6', session_id: 'sub' });
  await post(url, { hook_event_name: 'Stop', agent_id: 'a08368e867baa90c6' });
  await post(url, { hook_event_name: 'Stop', provider_agent_id: 'forged' });
  assert.equal(rec.handled[0].provider_agent_id, undefined);
  assert.equal(rec.handled[1].provider_agent_id, 'a08368e867baa90c6');
  assert.equal(rec.handled[3].provider_agent_id, undefined, 'a body cannot claim to be a subagent');
  assert.deepEqual(rec.sessions, [[A, 'own']], 'the subagent session is never recorded');
  assert.deepEqual(rec.events.map((e) => e.event), ['PostToolUse', 'Stop'], 'own PostToolUse + the (forged-provider) own Stop; the subagent\'s two are out');
  assert.equal(rec.sent.filter((m) => m.event === 'Stop').length, 1, 'only the agent\'s own Stop is emitted');
});

test('applyUrlIdentity: the pure rule', () => {
  const p1 = { agent_id: 'x', provider_agent_id: 'y' }; applyUrlIdentity(p1, 'x'); assert.deepEqual(p1, { agent_id: 'x' });
  const p2 = { agent_id: 'sub' }; applyUrlIdentity(p2, 'x'); assert.deepEqual(p2, { agent_id: 'x', provider_agent_id: 'sub' });
  const p3 = {}; applyUrlIdentity(p3, 'x'); assert.deepEqual(p3, { agent_id: 'x' });
});

async function settingsFor(t, broker) {
  const home = fs.mkdtempSync(path.join(JAIL, 'h-'));
  const hive = new HiveManager(() => home);
  if (broker !== undefined) hive.setHookBroker(broker);
  const spawn = await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const raw = fs.readFileSync(path.join(home, 'hive/agents/a1/settings.json'), 'utf8');
  return { settings: JSON.parse(raw), raw, spawn };
}

test('(4) with the broker up: every Claude hook but SessionStart is http to this agent\'s URL; SessionStart and the status line stay command', async (t) => {
  const URL_ = 'http://127.0.0.1:5555/hook/a1/' + 'ab'.repeat(16);
  const { settings } = await settingsFor(t, { urlFor: () => URL_, revoke: () => {} });
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    for (const m of matchers) {
      assert.equal(m.hooks.length, 1, `${event}: exactly one handler (never both http and command)`);
      const h = m.hooks[0];
      if (event === 'SessionStart') assert.equal(h.type, 'command', 'Claude skips HTTP hooks for SessionStart');
      else { assert.equal(h.type, 'http', event); assert.equal(h.url, URL_); assert.equal(h.timeout, HOOK_HTTP_TIMEOUT_S); }
    }
  }
  assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
  assert.equal(settings.statusLine.type, 'command');
});

test('(5) with the broker down (no broker, or no URL), the settings are byte-identical command hooks', async (t) => {
  const none = await settingsFor(t, undefined);
  const down = await settingsFor(t, { urlFor: () => null, revoke: () => {} });
  const norm = (raw) => raw.replace(/h-[A-Za-z0-9]+/g, 'h-X');
  assert.equal(norm(down.raw), norm(none.raw));
  assert.doesNotMatch(none.raw, /"type": "http"/);
  for (const matchers of Object.values(none.settings.hooks)) for (const m of matchers) assert.equal(m.hooks[0].type, 'command');
});

test('(6) ordering: 200 interleaved POSTs for 2 agents arrive per-agent in send order, seq strictly increasing', async (t) => {
  const { s, rec } = await broker(t);
  const ua = s.hookUrl(A), ub = s.hookUrl(B);
  const events = ['PreToolUse', 'PostToolUse', 'Stop'];
  const send = async (url, tag) => { for (let i = 0; i < 100; i++) await post(url, { hook_event_name: events[i % 3], tool_name: `${tag}${i}` }); };
  await Promise.all([send(ua, 'a'), send(ub, 'b')]);
  for (const [id, tag] of [[A, 'a'], [B, 'b']]) {
    const mine = rec.handled.filter((p) => p.agent_id === id);
    assert.equal(mine.length, 100);
    mine.forEach((p, i) => { assert.equal(p.tool_name, `${tag}${i}`); assert.equal(p.seq, i + 1, 'seq strictly increasing from 1'); assert.equal(p.transport, 'http'); });
  }
});

test('(7) an over-cap body is 413 (logged once) and the broker keeps serving', async (t) => {
  const { s, rec } = await broker(t);
  const url = s.hookUrl(A);
  const errs = []; const realErr = console.error; console.error = (m) => errs.push(String(m)); t.after(() => { console.error = realErr; });
  const big = Buffer.alloc(HOOK_HTTP_BODY_MAX + 1024, 32);
  const r1 = await post(url, null, big).catch((e) => ({ status: 'reset', e }));
  const r2 = await post(url, null, big).catch((e) => ({ status: 'reset', e }));
  assert.ok([413, 'reset'].includes(r1.status) && [413, 'reset'].includes(r2.status));
  assert.equal(errs.filter((m) => /hook body over/.test(m)).length, 1, 'logged once per agent');
  assert.equal(rec.handled.length, 0);
  assert.equal((await post(url, { hook_event_name: 'Stop' })).status, 200, 'still serving');
});

test('(8) a listener error re-listens on the SAME port; persistent failure takes the broker down and new spawns get command hooks', async (t) => {
  const saved = [...HOOK_HTTP_RELISTEN_DELAYS_MS];
  HOOK_HTTP_RELISTEN_DELAYS_MS.splice(0, Infinity, 20, 20);
  t.after(() => HOOK_HTTP_RELISTEN_DELAYS_MS.splice(0, Infinity, ...saved));
  const { s, rec } = await broker(t);
  const realErr = console.error; console.error = () => {}; t.after(() => { console.error = realErr; });
  const port = s.hookBrokerPort();
  const url = s.hookUrl(A);
  s.http.emit('error', new Error('simulated'));
  for (let i = 0; i < 200 && !(s.http && s.http.listening); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.hookBrokerPort(), port, 'same port: running agents\' URLs stay valid');
  assert.equal((await post(url, { hook_event_name: 'Stop' })).status, 200, 'and the old URL still works');
  // Now make every re-listen fail: something else holds the port.
  const blocker = net.createServer();
  s.http.close(); s.http.emit('error', new Error('gone'));
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r));
  t.after(() => blocker.close());
  for (let i = 0; i < 400 && s.hookBrokerPort() !== null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.hookBrokerPort(), null, 'down after the retries');
  assert.equal(s.hookUrl(A), null, 'new spawns get no URL, i.e. command hooks');
  assert.ok(rec.logs.some((l) => l.kind === 'hook-broker-down'), 'logged');
  // It keeps trying: once the port is free again it comes back on it, and URLs work again.
  await new Promise((r) => blocker.close(r));
  for (let i = 0; i < 400 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.hookBrokerPort(), port, 'recovered on the same port (running agents URLs are valid again)');
  assert.ok(rec.logs.some((l) => l.kind === 'hook-broker-up'));
  assert.equal((await post(s.hookUrl(A), { hook_event_name: 'Stop' })).status, 200);
});

test('(9) NO_PROXY carries loopback, merged with any existing value', async (t) => {
  assert.equal(mergeNoProxy(undefined), '127.0.0.1,localhost');
  assert.equal(mergeNoProxy('corp.example,localhost'), 'corp.example,localhost,127.0.0.1');
  process.env.NO_PROXY = 'corp.example';
  const { spawn } = await settingsFor(t, undefined);
  assert.equal(spawn.env.NO_PROXY, 'corp.example,127.0.0.1,localhost');
  assert.equal(spawn.env.no_proxy, spawn.env.NO_PROXY);
});

test('(10) STATIC: SessionStart is never an http hook, and the http shape is the only alternative', () => {
  const all = codeOnly(readSource('src/main/hive.ts'));
  const at = all.indexOf('  private hookSettings(');
  const src = all.slice(at, all.indexOf('\n  }\n', at));
  assert.ok(at > 0 && src.length > 500, 'hookSettings found');
  assert.match(src, /SessionStart: \[entry\(\)\],/);
  assert.doesNotMatch(src, /SessionStart: \[hook\(/);
  assert.match(src, /const hook = \(matcher\?: string\) => hookUrl\s*\?/);
});

test('the pipe path is stamped too (transport pipe, the same per-agent seq)', async (t) => {
  const { s, rec, sock } = await broker(t);
  await post(s.hookUrl(A), { hook_event_name: 'PreToolUse' });
  await new Promise((resolve, reject) => {
    const c = net.createConnection(sock, () => c.write(JSON.stringify({ hook_event_name: 'PostToolUse', agent_id: A, seq: 999, transport: 'http' }) + '\n'));
    c.on('data', () => {}); c.on('end', resolve); c.on('error', reject);
  });
  const last = rec.handled.at(-1);
  assert.equal(last.transport, 'pipe', 'never trusted from the sender');
  assert.equal(last.seq, 2);
  assert.deepEqual(s.transportCountsNow()[A], { http: 1, pipe: 1, mcp: 0, 'pipe-oneway': 0 });
});

test('N1/N2: a subagent hook never consumes the agent\'s steer; under HALT a subagent Stop is not emitted', async (t) => {
  const b1 = await broker(t, { steer: 'focus on X' });
  const u1 = b1.s.hookUrl(A);
  const sub = await post(u1, { hook_event_name: 'PostToolUse', agent_id: 'sub-1' });
  assert.deepEqual(sub.body, {}, 'no steer injected into the subagent');
  const own = await post(u1, { hook_event_name: 'PostToolUse' });
  assert.match(own.body.hookSpecificOutput.additionalContext, /focus on X/, 'the agent still gets it');
  const b2 = await broker(t, { halt: true });
  const u2 = b2.s.hookUrl(A);
  const r = await post(u2, { hook_event_name: 'Stop', agent_id: 'sub-1' });
  assert.equal(r.body.continue, false, 'the halt still applies');
  assert.equal(b2.rec.sent.filter((m) => m.event === 'Stop').length, 0, 'but a subagent Stop is not shown as the agent going idle');
});

test('N3: the shim strips an incoming provider_agent_id, and a provider id equal to the agent is not a subagent', () => {
  const hive = codeOnly(readSource('src/main/hive.ts'));
  assert.match(hive, /delete payload\.provider_agent_id; \/\/ only this shim may set it/);
  const src = codeOnly(readSource('src/main/hooks.ts'));
  assert.match(src, /p\.provider_agent_id !== '' && p\.provider_agent_id !== agentId;/);
});

test('archiving an agent revokes its hook token (a respawn mints a new one)', async (t) => {
  const home = fs.mkdtempSync(path.join(JAIL, 'h-'));
  const hive = new HiveManager(() => home);
  const revoked = [];
  hive.setHookBroker({ urlFor: () => null, revoke: (id) => revoked.push(id) });
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  hive.setArchived('a1', true);
  assert.deepEqual(revoked, ['a1']);
  hive.setArchived('a1', true);
  assert.deepEqual(revoked, ['a1', 'a1'], 'revoked even when the flag was already set');
});

test('P1 pins (Jim): a GET with a valid token is not a hook (405, never handled); the timeout and re-listen delays are pinned; stop() clears every token', async (t) => {
  assert.equal(HOOK_HTTP_TIMEOUT_S, 30);
  assert.deepEqual([...HOOK_HTTP_RELISTEN_DELAYS_MS], [250, 1_000, 2_000, 5_000, 10_000, 12_000]);
  const { s, rec } = await broker(t);
  const url = s.hookUrl(A);
  const got = await new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: u.hostname, port: u.port, path: u.pathname }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(got, 405);
  assert.equal(rec.handled.length, 0, 'a GET is never handled as an (empty) hook');
  s.stop();
  assert.equal(s.hookTokens.size, 0, 'tokens cleared');
  assert.equal(s.hookUrl(A), null, 'no URL while stopped');
  s.start();
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  const oldPath = new URL(url).pathname;
  const fresh = new URL(s.hookUrl(B));
  const r = await post(`http://127.0.0.1:${fresh.port}${oldPath}`, { hook_event_name: 'Stop' });
  assert.equal(r.status, 403, 'a token minted before stop() is dead after it');
});

test('PORT STOLEN: a re-listen refused with EADDRINUSE logs once which agents need a respawn, tells the renderer, and a respawn clears the flag (command hooks)', async (t) => {
  const saved = [...HOOK_HTTP_RELISTEN_DELAYS_MS];
  HOOK_HTTP_RELISTEN_DELAYS_MS.splice(0, Infinity, 20, 20);
  t.after(() => HOOK_HTTP_RELISTEN_DELAYS_MS.splice(0, Infinity, ...saved));
  const { s, rec } = await broker(t);
  const realErr = console.error; console.error = () => {}; t.after(() => { console.error = realErr; });
  const port = s.hookBrokerPort();
  s.hookUrl(A); s.hookUrl(B);
  const blocker = net.createServer();
  s.http.close(); s.http.emit('error', new Error('listener died'));
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r));   // someone else takes OUR port
  t.after(() => blocker.close());
  for (let i = 0; i < 400 && !rec.logs.some((l) => l.kind === 'hook-broker-port-stolen'); i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 400 && s.hookBrokerPort() !== null; i++) await new Promise((r) => setTimeout(r, 5));
  const stolen = rec.logs.filter((l) => l.kind === 'hook-broker-port-stolen');
  assert.equal(stolen.length, 1, 'logged once per outage');
  assert.deepEqual(stolen[0].agents.sort(), [A, B].sort());
  assert.ok(rec.sent.some((m) => m.ch === 'hive:hookBrokerPortStolen'), 'the renderer is told');
  assert.deepEqual(s.agentsNeedingRespawn().sort(), [A, B].sort());
  assert.equal(s.hookUrl(A), null, 'a respawn gets command hooks while the broker is down');
  assert.deepEqual(s.agentsNeedingRespawn(), [B], 'and that agent is no longer flagged');
});
