'use strict';

/**
 * 1.1.53 AV (Jim, AV-152; the Human approved R1 + R2).
 *  R1  the Claude status line starts no process: a SOURCED builtins-only script POSTs the
 *      status JSON to the hook broker (/status/<id>/<token>) and prints the gauge the broker
 *      returns. Before: hive-node.cmd + Electron-as-Node per refresh (~5 processes, ~630 ms).
 *      It cannot simply be dropped: it is the only source of the subscription's rate_limits
 *      (the capacity seam), the model and the exact context window.
 *  NO-GIT (the Human, replacing R2): the app no longer runs git in the hive at all; an existing
 *      hive/.git is left on disk untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'perf153-home-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'jailed');
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { HookServer, statusGauge } = loadTs('src/main/hooks.ts');
const { HiveManager, CLAUDE_STATUS_SH, HOOK_SHIM, brokerUrlParts, claudeStatusCommand } = loadTs('src/main/hive.ts');
const WIN = process.platform === 'win32';
const BASH = 'C:/Program Files/Git/bin/bash.exe';
const HAVE_BASH = WIN && fs.existsSync(BASH);
const TOK = 'ab'.repeat(16);

const STATUS = {
  session_id: 's1', transcript_path: 'C:/t.jsonl', model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  context_window: { total_input_tokens: 45_200, context_window_size: 200_000 },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_900_000_000 } }, note: 'héllo ✓'
};

/** A real HookServer with the Status observables recorded. */
async function broker(t) {
  const rec = { models: [], sent: [], capacity: [], handled: [] };
  const sock = WIN ? `\\\\.\\pipe\\perf153-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: { a1: { provider: 'claude' } } }), isGod: () => false, rosterContext: () => '',
    recordModel: (id, m) => rec.models.push([id, m]), appendCostLedger: () => {}
  };
  const s = new HookServer(hive, () => ({ send: (ch, m) => rec.sent.push({ ch, ...m }) }), () => ({}), undefined, undefined, undefined, () => {});
  s.onCapacity = (id, obs) => rec.capacity.push({ id, obs });
  const real = s.handle.bind(s); s.handle = (p) => { rec.handled.push(JSON.parse(JSON.stringify(p))); return real(p); };
  s.start(); t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  const url = s.hookUrl('a1');
  return { s, rec, url, parts: brokerUrlParts(url) };
}
function postStatus(port, id, token, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: `/status/${id}/${token}`, method: 'POST', headers: { 'content-length': data.length } }, (res) => {
      let out = ''; res.setEncoding('utf8'); res.on('data', (d) => { out += d; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: out }));
    });
    req.on('error', reject); req.end(data);
  });
}
/** Run the statusLine command the way Claude does: a shell -c with the status JSON on stdin. */
function runStatusLine(command, stdin, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ch = spawn(BASH, ['-c', command], { env: { ...process.env, ...env }, windowsHide: true });
    let out = '', err = '';
    ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
    ch.stdin.end(stdin);
    ch.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}
async function settingsFor(brokerStub) {
  const home = fs.mkdtempSync(path.join(JAIL, 'h-'));
  const hive = new HiveManager(() => home);
  if (brokerStub !== undefined) hive.setHookBroker(brokerStub);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  return { home, settings: JSON.parse(fs.readFileSync(path.join(home, 'hive/agents/a1/settings.json'), 'utf8')) };
}

// ── R1 ────────────────────────────────────────────────────────────────────

test('R1 route: POST /status/<id>/<token> is the Status event (model, context gauge, rate_limits) and replies with the gauge TEXT', async (t) => {
  const { rec, parts } = await broker(t);
  const r = await postStatus(parts.port, 'a1', parts.token, STATUS);
  assert.equal(r.status, 200);
  assert.match(r.type, /^text\/plain/);
  assert.equal(r.body, 'ctx 45k/200k (23%)');
  assert.equal(rec.handled.length, 1);
  assert.equal(rec.handled[0].hook_event_name, 'Status');
  assert.equal(rec.handled[0].agent_id, 'a1', 'identity from the URL');
  assert.equal(rec.handled[0].transport, 'http');
  assert.deepEqual(rec.models, [['a1', 'claude-opus-5-5']]);
  assert.deepEqual(rec.sent.filter((m) => m.ch === 'hive:contextUpdate').map(({ agentId, tokens, limit }) => ({ agentId, tokens, limit })), [{ agentId: 'a1', tokens: 45_200, limit: 200_000 }]);
  assert.equal(rec.capacity.length, 1, 'the rate_limits still reach the capacity seam');
});

test('R1 route: a wrong token is 403 and never handled; a body with no context window replies an empty gauge', async (t) => {
  const { rec, parts } = await broker(t);
  assert.equal((await postStatus(parts.port, 'a1', 'cd'.repeat(16), STATUS)).status, 403);
  assert.equal((await postStatus(parts.port, 'zz', parts.token, STATUS)).status, 403);
  assert.equal(rec.handled.length, 0);
  const r = await postStatus(parts.port, 'a1', parts.token, { model: { id: 'x' } });
  assert.equal(r.status, 200); assert.equal(r.body, '');
});

test('R1 gauge parity: statusGauge prints exactly what the command shim printed', async () => {
  const cases = [STATUS, { context_window: { total_input_tokens: 0, context_window_size: 1_000_000 } }, { context_window: { total_input_tokens: 5 } }, {}];
  const dir = fs.mkdtempSync(path.join(JAIL, 'shim-'));
  const shim = path.join(dir, 'cth-hook.cjs'); fs.writeFileSync(shim, HOOK_SHIM);
  for (const c of cases) {
    const out = await new Promise((resolve) => {
      const ch = spawn(process.execPath, [shim, '--status'], { env: { ...process.env, HIVE_SOCK: '', AGENT_ID: 'a1' } });
      let o = ''; ch.stdout.on('data', (d) => { o += d; }); ch.on('close', () => resolve(o)); ch.stdin.end(JSON.stringify(c));
    });
    assert.equal(statusGauge(c), out, JSON.stringify(c));
  }
});

test('R1 settings: with the broker up (Windows) the statusLine SOURCES claude-status.sh with port/id/token; the script is written verbatim with LF only', { skip: !WIN }, async () => {
  const URL_ = 'http://127.0.0.1:5555/hook/a1/' + TOK;
  const { home, settings } = await settingsFor({ urlFor: () => URL_, revoke: () => {} });
  const script = path.join(home, 'hive', 'bin', 'claude-status.sh').replace(/\\/g, '/');
  assert.equal(settings.statusLine.type, 'command');
  assert.equal(settings.statusLine.command, `. '${script}' 5555 a1 ${TOK}`);
  const written = fs.readFileSync(script, 'utf8');
  assert.equal(written, CLAUDE_STATUS_SH);
  assert.doesNotMatch(written, /\r/, 'no CR: bash would read it as part of a command');
});

test('R1 settings: with the broker down, or a URL that is not ours, the status line stays the command shim', async () => {
  const down = await settingsFor({ urlFor: () => null, revoke: () => {} });
  assert.match(down.settings.statusLine.command, / --status$/);
  const odd = await settingsFor({ urlFor: () => 'http://127.0.0.1:5555/hook/a%20b/' + TOK, revoke: () => {} });
  assert.match(odd.settings.statusLine.command, / --status$/, 'an id that could need quoting keeps the shim');
});

test('R1 brokerUrlParts / claudeStatusCommand: only our loopback URL shape; every part quote-free', () => {
  assert.deepEqual(brokerUrlParts('http://127.0.0.1:61234/hook/andy-mtuk4y4x/' + TOK), { port: 61234, agentId: 'andy-mtuk4y4x', token: TOK });
  for (const bad of [null, '', 'http://localhost:1/hook/a/' + TOK, 'http://127.0.0.1:1/mcp/a/' + TOK, 'http://127.0.0.1:1/hook/a b/' + TOK, "http://127.0.0.1:1/hook/a'b/" + TOK, 'http://127.0.0.1:1/hook/a/xyz']) {
    assert.equal(brokerUrlParts(bad), null, String(bad));
  }
  assert.equal(claudeStatusCommand('C:/h/bin/claude-status.sh', { port: 1, agentId: 'a1', token: TOK }), `. 'C:/h/bin/claude-status.sh' 1 a1 ${TOK}`);
});

test('R1 REAL: the script under Git bash with an EMPTY PATH (so no external program can run) delivers the status and prints the gauge', { skip: !HAVE_BASH }, async (t) => {
  const { rec, parts } = await broker(t);
  const file = path.join(fs.mkdtempSync(path.join(JAIL, 'sh-')), 'claude-status.sh');
  fs.writeFileSync(file, CLAUDE_STATUS_SH);
  const cmd = claudeStatusCommand(file.replace(/\\/g, '/'), parts);
  // LANG is UTF-8 on purpose: the script must count BYTES for Content-Length regardless.
  const r = await runStatusLine(cmd, JSON.stringify(STATUS), { PATH: '', LANG: 'C.UTF-8', LC_ALL: '' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '', 'nothing on stderr: every step was a builtin');
  assert.equal(r.out, 'ctx 45k/200k (23%)');
  assert.equal(rec.handled.length, 1);
  assert.equal(rec.handled[0].hook_event_name, 'Status');
  assert.equal(rec.handled[0].note, 'héllo ✓', 'UTF-8 intact (Content-Length counted in bytes)');
  assert.deepEqual(rec.models, [['a1', 'claude-opus-5-5']]);
  assert.equal(rec.capacity.length, 1);
  assert.ok(r.ms < 3000, `fast: ${r.ms} ms`);
});

test('R1 REAL: with the broker down the script prints nothing, exits 0, and writes nothing to stderr', { skip: !HAVE_BASH }, async () => {
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const file = path.join(fs.mkdtempSync(path.join(JAIL, 'sh-')), 'claude-status.sh');
  fs.writeFileSync(file, CLAUDE_STATUS_SH);
  const r = await runStatusLine(claudeStatusCommand(file.replace(/\\/g, '/'), { port, agentId: 'a1', token: TOK }), JSON.stringify(STATUS), { PATH: '' });
  assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
});

test('R1 STATIC: the script uses no external command (builtins, redirections and its own function only)', () => {
  const code = CLAUDE_STATUS_SH.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const words = new Set((code.match(/(?:^|[;{(|&]\s*|\b(?:do|then|else)\s+)([a-z_][a-z_-]*)/gm) || []).map((m) => m.replace(/^[;{(|&\s]*|^(do|then|else)\s+/, '').trim()));
  const BUILTIN = new Set(['local', 'while', 'read', 'do', 'done', 'exec', 'printf', 'return', 'unset', 'line', 'body', '__munder_status', 'if', 'then', 'fi', 'break']);
  for (const w of words) assert.ok(BUILTIN.has(w) || w.startsWith('__'), `unexpected command word: ${w}`);
  assert.doesNotMatch(code, /\b(cat|curl|wget|sed|awk|grep|tr|head|tail|nc|node|cmd|powershell|findstr)\b/);
});

// ── NO-GIT (the Human's decision, replacing R2) ───────────────────────────

const cp = require('node:child_process');
/** Every child_process entry point, intercepted: the git invocations made while `fn` runs. */
async function gitCallsDuring(fn) {
  const calls = [];
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];
  const real = {};
  for (const n of names) {
    real[n] = cp[n];
    cp[n] = function (cmd, ...rest) {
      const all = [String(cmd), ...(Array.isArray(rest[0]) ? rest[0].map(String) : [])].join(' ');
      if (/(^|[\\/\s"'])git(\.exe)?(\s|"|'|$)/i.test(all)) calls.push({ fn: n, cmd: all.slice(0, 120) });
      return real[n].call(this, cmd, ...rest);
    };
  }
  try { await fn(); } finally { for (const n of names) cp[n] = real[n]; }
  return calls;
}
const NOGIT_HIVE = () => loadTs('src/main/hive.ts').HiveManager;

test('NO-GIT: a new hive, agents, mail (send + outbox routing), tasks, role, rename, archive, session and model run ZERO git; no .git is created', async () => {
  const home = fs.mkdtempSync(path.join(JAIL, 'ng-'));
  const Hive = NOGIT_HIVE();
  const calls = await gitCallsDuring(async () => {
    const hive = new Hive(() => home);
    await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
    await hive.ensureAgent({ id: 'b2', name: 'B', provider: 'claude', cwd: home });
    for (let i = 0; i < 5; i++) hive.send({ to: 'b2', act: 'inform', subject: `m${i}`, body: 'hi' }, 'a1');
    // an agent-written outbox message, routed the way the router does it
    fs.writeFileSync(path.join(home, 'hive', 'agents', 'a1', 'outbox', 'x.json'), JSON.stringify({ id: 'x', to: 'b2', act: 'inform', subject: 's', body: 'b', from: 'a1' }));
    hive.routeOnce();
    hive.writeTasks([{ id: 't1', title: 'T', status: 'todo', dependsOn: [], priority: 3, createdAt: new Date().toISOString() }]);
    hive.patchAgentRole('a1', 'builder');
    hive.renameAgent('a1', 'Alpha');
    hive.recordSession('a1', 'sess-1');
    hive.recordModel('a1', 'claude-opus-5-5', undefined);
    hive.setArchived('b2', true);
    await new Promise((r) => setTimeout(r, 300));   // anything deferred would fire here
  });
  assert.deepEqual(calls, [], 'no git process of any kind');
  assert.equal(fs.existsSync(path.join(home, 'hive', '.git')), false, 'a new hive is not git-initialised');
  assert.equal(fs.readdirSync(path.join(home, 'hive', 'agents', 'b2', 'inbox')).filter((f) => f.endsWith('.json')).length, 6, 'and the mail was delivered');
  assert.ok(fs.existsSync(path.join(home, 'hive', 'tasks.json')));
});

test('NO-GIT: an EXISTING hive/.git is left exactly as it was (never deleted, never written)', async () => {
  const home = fs.mkdtempSync(path.join(JAIL, 'ng-'));
  const git = path.join(home, 'hive', '.git');
  fs.mkdirSync(path.join(git, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/master\n');
  fs.writeFileSync(path.join(git, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(home, 'hive', '.gitignore'), 'mine\n');
  const snap = () => { const out = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(home, f)] = fs.readFileSync(f, 'utf8') + '|' + fs.statSync(f).mtimeMs; } }; walk(git); out['.gitignore'] = fs.readFileSync(path.join(home, 'hive', '.gitignore'), 'utf8'); return out; };
  const before = snap();
  const calls = await gitCallsDuring(async () => {
    const hive = new (NOGIT_HIVE())(() => home);
    await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
    hive.send({ to: 'a1', act: 'inform', subject: 's', body: 'b' }, 'system');
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(snap(), before, 'the .git tree and the hive .gitignore are untouched');
});

test('NO-GIT: every agent\'s MINE ignore file (read by mempalace, not git) is still refreshed once per process, running or not', async () => {
  const home = fs.mkdtempSync(path.join(JAIL, 'ng-'));
  const idle = path.join(home, 'hive', 'agents', 'sleeper'); fs.mkdirSync(idle, { recursive: true });
  const hive = new (NOGIT_HIVE())(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const ig = fs.readFileSync(path.join(idle, '.gitignore'), 'utf8');
  assert.match(ig, /\.codex/, 'an agent that never spawns still gets its mine ignore');
});

test('NO-GIT STATIC: no git anywhere in the hive layer; the committer is gone; quit no longer waits on a flush', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  assert.doesNotMatch(src, /spawnSync\(|['"]git['"]|HiveCommitter|flushCommits|\bcommit\(/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'main', 'hiveCommitter.ts')), false);
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.doesNotMatch(idx, /flushCommits/);
});
