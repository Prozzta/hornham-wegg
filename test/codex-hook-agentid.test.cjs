'use strict';

/**
 * CODEX-HOOK-AGENTID (Jim's card, god's scope): a hook payload can carry the PROVIDER's own
 * agent_id: Codex's hook schemas include agent_id/agent_type on tool, prompt and compact
 * hooks, which is how a subagent's hooks are tagged. The shim used to fill agent_id only
 * when it was absent, so a subagent's hook arrived under an id the hive does not know:
 * the real agent's halt gate, breaker and activity missed it.
 *
 * Now the shim ALWAYS stamps the hive's id and keeps the provider's value as
 * provider_agent_id. HookServer attributes such a hook to the agent, but keeps it out of
 * the agent's OWN session bookkeeping: no session id or transcript recorded, no wake
 * lifecycle transition, and a subagent's Stop is not the agent's Stop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { HOOK_SHIM } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const HIVE_ID = 'oscar-mu3300lb';
const CODEX_SUB = '019a2f3e-5c1d-7b40-9d2e-subagent0001';

/** Run the REAL shim: payload on stdin, a local socket as HIVE_SOCK. Returns what arrived. */
async function throughShim(payload, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agentid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'cth-hook.cjs');
  fs.writeFileSync(shim, HOOK_SHIM);
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\md-agentid-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(dir, 's.sock');
  let got = null;
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) { got = JSON.parse(buf.split('\n')[0]); c.end('{}'); }
    });
  });
  await new Promise((r) => server.listen(sock, r));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [shim], { env: { ...process.env, AGENT_ID: HIVE_ID, HIVE_SOCK: sock }, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(JSON.stringify(payload));
    });
  } finally {
    server.close();
  }
  assert.ok(got, 'the shim delivered the payload');
  return got;
}

test('SHIM: a Codex subagent\'s own agent_id no longer wins: the hive id is stamped, the provider\'s is kept', async (t) => {
  const got = await throughShim({ hook_event_name: 'PreToolUse', agent_id: CODEX_SUB, agent_type: 'explorer', turn_id: 'turn-sub', tool_name: 'shell' }, t);
  assert.equal(got.agent_id, HIVE_ID);
  assert.equal(got.provider_agent_id, CODEX_SUB);
  assert.equal(got.turn_id, 'turn-sub', 'the rest of the payload is untouched');
});

test('SHIM: the agent\'s own hooks are unchanged (no agent_id, or our own) and carry no provider_agent_id', async (t) => {
  const plain = await throughShim({ hook_event_name: 'Stop', turn_id: 'turn-1' }, t);
  assert.equal(plain.agent_id, HIVE_ID);
  assert.equal('provider_agent_id' in plain, false);
  const same = await throughShim({ hook_event_name: 'Stop', agent_id: HIVE_ID }, t);
  assert.equal(same.agent_id, HIVE_ID);
  assert.equal('provider_agent_id' in same, false);
});

test('STATIC: the Pi and OpenCode bridges stamp the hive id the same way', () => {
  const hive = codeOnly(readSource('src/main/hive.ts'));
  const stamps = hive.match(/payload\.agent_id = AGENT \|\| payload\.agent_id \|\| null;/g) ?? [];
  const keeps = hive.match(/if \(payload\.agent_id && payload\.agent_id !== AGENT\) payload\.provider_agent_id = payload\.agent_id;/g) ?? [];
  assert.equal(stamps.length, 2, 'Pi + OpenCode');
  assert.equal(keeps.length, 2);
  assert.doesNotMatch(hive, /payload\.agent_id = payload\.agent_id \|\| AGENT;/, 'the old provider-wins form is gone');
});

/** A HookServer with every observable recorded. */
function server({ halt = false } = {}) {
  const rec = { events: [], sessions: [], sent: [] };
  const hive = { sockPath: () => null, codexHomeFor: () => null, recordSession: (a, s) => rec.sessions.push([a, s]), appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const web = { send: (ch, m) => rec.sent.push({ ch, ...m }) };
  const control = { shouldHalt: () => halt, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => web, () => ({}), control, undefined, undefined,
    (agentId, event, message, fullyIdle, turnId) => rec.events.push({ agentId, event, turnId }));
  return { s, rec };
}

test('HOOKSERVER: the subagent hook THROUGH THE SHIM is attributed to the right agent, and stays out of its own session', async (t) => {
  const payload = await throughShim({ hook_event_name: 'PostToolUse', agent_id: CODEX_SUB, turn_id: 'turn-sub', session_id: 'sub-session', transcript_path: 'C:/sub/rollout.jsonl', tool_name: 'shell' }, t);
  const { s, rec } = server();
  s.handle(payload);
  assert.deepEqual(rec.sent.filter((m) => m.ch === 'hive:hookEvent').map((m) => [m.agentId, m.event]), [[HIVE_ID, 'PostToolUse']], 'shown on the right agent');
  assert.deepEqual(rec.events, [], 'no wake-lifecycle transition from a subagent (its turn is not ours)');
  assert.deepEqual(rec.sessions, [], 'the subagent\'s session id is never recorded as ours (resume would resume IT)');
  assert.equal(s.transcriptPath(HIVE_ID), undefined, 'nor its transcript');
});

test('HOOKSERVER: a subagent\'s Stop is not the agent\'s Stop (no idle, no lifecycle, no emit)', () => {
  const { s, rec } = server();
  for (const event of ['Stop', 'SubagentStop']) s.handle({ hook_event_name: event, agent_id: HIVE_ID, provider_agent_id: CODEX_SUB });
  assert.deepEqual(rec.events, []);
  assert.deepEqual(rec.sent.filter((m) => m.ch === 'hive:hookEvent'), [], 'the renderer reads any Stop as THIS agent going idle');
});

test('HOOKSERVER: the halt gate now reaches a subagent\'s tool call (it used to arrive under a foreign id)', () => {
  const { s } = server({ halt: true });
  const res = s.handle({ hook_event_name: 'PreToolUse', agent_id: HIVE_ID, provider_agent_id: CODEX_SUB, tool_name: 'shell' });
  assert.equal(res.continue, false);
});

test('HOOKSERVER: the agent\'s OWN hooks are unchanged: lifecycle, session and Stop all still apply', () => {
  const { s, rec } = server();
  s.handle({ hook_event_name: 'UserPromptSubmit', agent_id: HIVE_ID, turn_id: 't1', session_id: 'own-session', transcript_path: 'C:/own.jsonl' });
  s.handle({ hook_event_name: 'Stop', agent_id: HIVE_ID, turn_id: 't1' });
  assert.deepEqual(rec.events.map((e) => [e.agentId, e.event, e.turnId]), [[HIVE_ID, 'UserPromptSubmit', 't1'], [HIVE_ID, 'Stop', 't1']]);
  assert.deepEqual(rec.sessions, [[HIVE_ID, 'own-session']]);
  assert.equal(s.transcriptPath(HIVE_ID), 'C:/own.jsonl');
  assert.ok(rec.sent.some((m) => m.ch === 'hive:hookEvent' && m.event === 'Stop'));
});
