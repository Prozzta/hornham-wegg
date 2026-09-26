'use strict';
/**
 * MIDTURN-MAIL-BLIND L1 (1.1.55): an agent learns, DURING its turn, that new mail arrived in its
 * inbox after the turn began. It is named once each, on the same answering hooks the operator
 * steer already uses (Claude/Codex PostToolUse, AGY PreInvocation), merged into the single
 * additionalContext. Provider-neutral and no model-invoking hook: a directory listing per hook,
 * one small read per NEW file.
 *
 * HOME IS JAILED AND ASSERTED before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

async function floor(t, { steer } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-midturn-l1-'));
  const priorHome = process.env.HOME; const priorProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME must be jailed before HiveManager construction');
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
    hive.dispose(); fs.rmSync(home, { recursive: true, force: true });
  });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  const control = { takeSteer: (id) => (id === 'andy-1' ? (steer ?? null) : null), shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const server = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  const fire = (hook_event_name, extra = {}) => server.handle({ agent_id: 'andy-1', hook_event_name, session_id: 's1', ...extra });
  const ctx = (res) => res?.hookSpecificOutput?.additionalContext ?? '';
  return { hive, fire, ctx };
}

test('L1: mail delivered AFTER the turn began is named on the next PostToolUse, ONCE; the turn\'s own mail is never announced', async (t) => {
  const { hive, fire, ctx } = await floor(t);
  const before = hive.send({ to: 'andy-1', act: 'request', subject: 'the task this turn is about' }, 'god-1');
  fire('UserPromptSubmit');                                   // the turn begins: its own mail is known
  assert.equal(ctx(fire('PostToolUse', { tool_name: 'Bash' })), '', 'nothing new yet');
  const cancel = hive.send({ to: 'andy-1', act: 'request', subject: 'CANCEL: do not build it', supersedes: [before.id] }, 'god-1');
  const c = ctx(fire('PostToolUse', { tool_name: 'Bash' }));
  assert.match(c, /^<inbox-update>\n1 new message\(s\) arrived in your inbox during this turn:\n/);
  assert.ok(c.includes(`- from god-1: "CANCEL: do not build it" [${cancel.id}] (SUPERSEDES ${before.id})`), c);
  assert.ok(!c.includes('the task this turn is about'), 'the turn\'s own mail is not re-announced');
  assert.equal(ctx(fire('PostToolUse', { tool_name: 'Edit' })), '', 'announced ONCE');
});

test('L1: a new turn starts clean: mail that arrived between turns is the new turn\'s own (not announced)', async (t) => {
  const { hive, fire, ctx } = await floor(t);
  fire('UserPromptSubmit');
  fire('Stop');
  hive.send({ to: 'andy-1', act: 'inform', subject: 'arrived while idle' }, 'god-1');
  fire('UserPromptSubmit');                                   // the wake: this mail is the task
  assert.equal(ctx(fire('PostToolUse', { tool_name: 'Read' })), '');
});

test('L1 (AGY): no UserPromptSubmit - the first PreInvocation after a Stop begins the turn; a later PreInvocation announces; a ONE-WAY hook never takes it', async (t) => {
  const { hive, fire, ctx } = await floor(t);
  fire('Stop');
  fire('PreInvocation', { transport: 'pipe' });               // turn start (snapshot, no notice)
  hive.send({ to: 'andy-1', act: 'inform', subject: 'mid-turn news' }, 'god-1');
  assert.equal(ctx(fire('PostToolUse', { transport: 'pipe-oneway' })), '', 'one-way: its reply is never read');
  assert.match(ctx(fire('PreInvocation', { transport: 'pipe' })), /mid-turn news/, 'the answering PreInvocation takes it');
});

test('L1: a subagent\'s hook never takes the notice (it stays for the agent itself)', async (t) => {
  const { hive, fire, ctx } = await floor(t);
  fire('UserPromptSubmit');
  hive.send({ to: 'andy-1', act: 'inform', subject: 'for the agent' }, 'god-1');
  assert.equal(ctx(fire('PostToolUse', { provider_agent_id: 'sub-7' })), '');
  assert.match(ctx(fire('PostToolUse')), /for the agent/);
});

test('L1: merged with a steer in the ONE additionalContext (neither displaces the other); at most 5 listed', async (t) => {
  const { hive, fire, ctx } = await floor(t, { steer: 'OPERATOR: slow down' });
  fire('UserPromptSubmit');
  for (let i = 0; i < 7; i++) hive.send({ to: 'andy-1', act: 'inform', subject: `n${i}` }, 'god-1');
  const c = ctx(fire('PostToolUse'));
  assert.match(c, /OPERATOR: slow down/);
  assert.match(c, /7 new message\(s\)/);
  assert.equal((c.match(/^- from god-1/gm) || []).length, 5);
  assert.match(c, /- and 2 more/);
});

test('L1: state lost (an app restart mid-turn) re-opens QUIETLY: the first hook snapshots, it does not announce old unread mail', async (t) => {
  const { hive, fire, ctx } = await floor(t);
  hive.send({ to: 'andy-1', act: 'inform', subject: 'old unread' }, 'god-1');
  assert.equal(ctx(fire('PostToolUse')), '', 'no turn known: snapshot only');
  hive.send({ to: 'andy-1', act: 'inform', subject: 'truly new' }, 'god-1');
  const c = ctx(fire('PostToolUse'));
  assert.match(c, /truly new/);
  assert.ok(!c.includes('old unread'));
});
