'use strict';
/**
 * AGY-STARTUP-TURN (1.1.55; god andyagystart/andyagyprobe/andycodexok). An AGY spawn used to get
 * the hive protocol as `agy -i "<protocol>"`: a first USER turn, which AGY ran as a task at every
 * spawn (read memory.md + the inbox + the roster, ran wake-up, appended a status block). Claude
 * gets the same text as a SYSTEM prompt and starts idle. The fix: agy's own system channel, a
 * per-agent Markdown custom agent (~/.gemini/config/agents/<name>/agent.md, H1 body = system
 * prompt) selected with `agy --agent <name>`, and NO initial prompt. The shape was confirmed on
 * the live CLI (the AGY probe, 2026-09-26).
 *
 * EVERY TEST REDIRECTS HOME AND ASSERTS IT before building a hive (the 2026-09-23 incident).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { providerPreset } = loadTs('src/shared/agentProvider.ts');
const REPO = path.resolve(__dirname, '..');

function sandbox(t, { live = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-idle-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  const hiveHome = path.join(home, 'harness');
  const hive = live ? new HiveManager(() => hiveHome, undefined, {}, () => true) : new HiveManager(() => hiveHome);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hiveHome, hive };
}
const agentFile = (home, id) => path.join(home, '.gemini', 'config', 'agents', `munder-${id}`, 'agent.md');

test('AGY spawns IDLE: `--agent munder-<id>` and NO initial prompt; the protocol is the custom agent\'s system prompt', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'phyllis-mu11xldm', name: 'Phyllis', provider: 'antigravity', cwd: s.home });
  assert.ok(!inj.args.includes('-i') && !inj.args.includes('--prompt-interactive'), `no initial-prompt flag: ${JSON.stringify(inj.args)}`);
  assert.ok(!inj.args.some((a) => /HIVE PROTOCOL/.test(a)), 'the protocol is NOT on argv (no first user turn)');
  const i = inj.args.indexOf('--agent');
  assert.ok(i >= 0, `--agent passed: ${JSON.stringify(inj.args)}`);
  assert.equal(inj.args[i + 1], 'munder-phyllis-mu11xldm');
  const md = fs.readFileSync(agentFile(s.home, 'phyllis-mu11xldm'), 'utf8');
  assert.match(md, /^---\nname: munder-phyllis-mu11xldm\ndescription: ".*Written by the Munder Difflin app.*"\nmainAgent: true\ninheritCustomizations: true\n---\n\n# Phyllis \(phyllis-mu11xldm\), a Munder Difflin hive agent\n\n/);
  assert.match(md, /HIVE PROTOCOL/);
  assert.match(md, /You are "Phyllis" \(phyllis-mu11xldm\)/);
  assert.equal((md.match(/^# /gm) || []).length, 1, 'exactly ONE H1 section');
});

test('AGY custom agent: rewritten only when the prompt changes (temp + rename); unchanged = untouched', async (t) => {
  const s = sandbox(t);
  await s.hive.ensureAgent({ id: 'a1', name: 'Ann', provider: 'antigravity', cwd: s.home });
  const f = agentFile(s.home, 'a1');
  const t0 = new Date(Date.now() - 60_000);
  fs.utimesSync(f, t0, t0);
  await s.hive.ensureAgent({ id: 'a1', name: 'Ann', provider: 'antigravity', cwd: s.home });
  assert.equal(fs.statSync(f).mtimeMs, t0.getTime(), 'the same prompt: not rewritten');
  await s.hive.ensureAgent({ id: 'a1', name: 'Anna', provider: 'antigravity', cwd: s.home });
  assert.match(fs.readFileSync(f, 'utf8'), /# Anna \(a1\)/, 'a changed prompt: regenerated');
  assert.equal(fs.existsSync(`${f}.tmp`), false);
});

test('AGY custom agent: YAML-safe (JSON-quoted strings) and a prompt line starting with # cannot open a second section', () => {
  const md = HiveManager.agyAgentMarkdown({ id: 'x1', name: 'Odd: "name"' }, 'line one\n# not a heading\n## neither');
  assert.match(md, /^name: munder-x1$/m);
  assert.match(md, /^description: "Munder Difflin hive agent Odd: \\"name\\" \(x1\): /m);
  assert.equal((md.match(/^# /gm) || []).length, 1);
  assert.match(md, /^\\# not a heading$/m);
  assert.match(md, /^\\## neither$/m);
  assert.equal(HiveManager.agyAgentName('Weird_ID.9'), 'munder-weird-id-9');
});

test('A NON-LIVE hive (dev build, a probe, another hive) writes NO global agent and falls back to `-i` (the old path)', async (t) => {
  const s = sandbox(t, { live: false });
  const inj = await s.hive.ensureAgent({ id: 'a1', name: 'Ann', provider: 'antigravity', cwd: s.home });
  assert.equal(fs.existsSync(path.join(s.home, '.gemini', 'config', 'agents')), false);
  assert.equal(inj.args[0], '-i');
  assert.match(inj.args[1], /HIVE PROTOCOL/);
});

test('Someone else\'s agent under our name is never overwritten (fallback to -i) and never removed', async (t) => {
  const s = sandbox(t);
  const f = agentFile(s.home, 'a1');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '---\nname: munder-a1\n---\n# mine\n');
  const inj = await s.hive.ensureAgent({ id: 'a1', name: 'Ann', provider: 'antigravity', cwd: s.home });
  assert.equal(inj.args[0], '-i');
  assert.equal(fs.readFileSync(f, 'utf8'), '---\nname: munder-a1\n---\n# mine\n');
  s.hive.removeAgyAgent('a1');
  assert.ok(fs.existsSync(f), 'not ours: kept');
});

test('removeAgyAgent: our agent leaves with the agent (killed or archived); a non-live hive removes nothing', async (t) => {
  const s = sandbox(t);
  await s.hive.ensureAgent({ id: 'a1', name: 'Ann', provider: 'antigravity', cwd: s.home });
  assert.ok(fs.existsSync(agentFile(s.home, 'a1')));
  s.hive.removeAgyAgent('a1');
  assert.equal(fs.existsSync(path.dirname(agentFile(s.home, 'a1'))), false);
  s.hive.removeAgyAgent('never-existed'); // no throw
});

test('WIRING (index.ts): the PTY teardown removes the agy agent for an antigravity agent only when no other PTY of it is alive', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /if \(leftProvider === 'antigravity' && !\[\.\.\.ptyToAgent\.values\(\)\]\.includes\(agentId\)\) \{\s*try \{ hive\.removeAgyAgent\(agentId\); \}/);
  // and the resume path still appends agy's --conversation <id> to the same args
  assert.match(src, /if \(sid && rf\) \{[\s\S]{0,200}args\.push\(rf, sid\)/);
  assert.equal(providerPreset('antigravity').resumeFlag, '--conversation');
});

test('PRESET: antigravity uses the custom-agent system channel; `-i` stays only as the fallback; other providers unchanged', () => {
  const agy = providerPreset('antigravity');
  assert.equal(agy.systemPromptChannel, 'agy-custom-agent');
  assert.equal(agy.initialPromptFlag, '-i');
  for (const id of ['gemini', 'codex', 'grok', 'qwen']) assert.equal(providerPreset(id).systemPromptChannel, undefined, id);
});
