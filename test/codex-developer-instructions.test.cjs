'use strict';
/**
 * AGY-STARTUP-TURN, the Codex half (god andycodexok). Codex used to get the hive protocol as a
 * POSITIONAL first prompt (`codex "<protocol>"`, and `codex resume <sid> "<protocol>"`): a first
 * USER turn at every spawn. Codex's real instruction channel is the `developer_instructions`
 * config key (a developer-role message, not a turn). The Codex probe (codex-cli 0.154.0,
 * 2026-09-26) confirmed it: control NONE vs the marker, SessionStart/UserPromptSubmit/Stop hooks
 * fire, `exec resume` keeps it, and the rollout holds it as a developer item with no reply before
 * the first real prompt. The hive already writes each Codex agent its own CODEX_HOME config.toml,
 * so the protocol goes there, and the positional prompt is dropped.
 *
 * HOME IS REDIRECTED AND ASSERTED before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { providerPreset } = loadTs('src/shared/agentProvider.ts');

function sandbox(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dev-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  if (seed !== undefined) fs.writeFileSync(path.join(home, '.codex', 'config.toml'), seed);
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive };
}
const SEED = 'model = "gpt-5-codex"\n\n[projects."C:\\\\PrzEdit"]\ntrust_level = "trusted"\n\n[mcp_servers.x]\ncommand = "x"\n';

test('CODEX spawns without a first user turn: NO positional protocol; the protocol is developer_instructions in its own CODEX_HOME (top-level, valid TOML, the seed kept)', async (t) => {
  const s = sandbox(t, SEED);
  const inj = await s.hive.ensureAgent({ id: 'dwight-mu32ztys', name: 'Dwight', provider: 'codex', cwd: s.home });
  assert.ok(!inj.args.some((a) => /HIVE PROTOCOL/.test(a)), `no positional protocol: ${JSON.stringify(inj.args.map((a) => a.slice(0, 30)))}`);
  assert.ok(inj.args.includes('--dangerously-bypass-hook-trust'), 'the hooks still run');
  const cfgText = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');
  const cfg = toml.parse(cfgText);
  assert.match(cfg.developer_instructions, /^You are "Dwight" \(dwight-mu32ztys\)/);
  assert.match(cfg.developer_instructions, /HIVE PROTOCOL/);
  assert.equal(cfg.model, 'gpt-5-codex', 'the user\'s seed is kept');
  assert.equal(cfg.projects['C:\\PrzEdit'].trust_level, 'trusted');
  assert.ok(cfgText.indexOf('developer_instructions') < cfgText.indexOf('[projects.'), 'top-level: before the first table');
  assert.ok(cfg.hooks && cfg.hooks.Stop, 'the lifecycle hooks are still wired');
});

test('CODEX: a single-line developer_instructions in the user seed is REPLACED (one key, no duplicate); one inside a [table] is left alone', async (t) => {
  const s = sandbox(t, 'developer_instructions = "be terse"\nmodel = "m"\n\n[profiles.p]\ndeveloper_instructions = "profile-scoped"\n');
  const inj = await s.hive.ensureAgent({ id: 'o1', name: 'Oscar', provider: 'codex', cwd: s.home });
  const text = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');
  const cfg = toml.parse(text); // a duplicate top-level key would throw here
  assert.match(cfg.developer_instructions, /You are "Oscar"/);
  assert.equal(cfg.profiles.p.developer_instructions, 'profile-scoped');
  assert.ok(!text.includes('be terse'));
});

test('CODEX: a MULTI-LINE developer_instructions in the seed cannot be replaced safely -> the positional prompt stays (the old path), the seed untouched', async (t) => {
  const s = sandbox(t, "developer_instructions = '''\nline one\nline two\n'''\nmodel = \"m\"\n");
  const inj = await s.hive.ensureAgent({ id: 'o2', name: 'Oz', provider: 'codex', cwd: s.home });
  assert.ok(inj.args.some((a) => /HIVE PROTOCOL/.test(a)), 'fallback: the positional prompt');
  const cfg = toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assert.equal(cfg.developer_instructions, 'line one\nline two\n');
});

test('CODEX: no user config at all still works (the key alone, then the hooks)', async (t) => {
  const s = sandbox(t, undefined);
  const inj = await s.hive.ensureAgent({ id: 'c1', name: 'Cee', provider: 'codex', cwd: s.home });
  const cfg = toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assert.match(cfg.developer_instructions, /You are "Cee"/);
  assert.ok(!inj.args.some((a) => /HIVE PROTOCOL/.test(a)));
});

test('withCodexDeveloperInstructions: TOML-escapes quotes, backslashes, newlines and control chars (round-trips through a TOML parser)', () => {
  const tricky = 'A "quoted" C:\\path\\x line\nnext\ttab \u001b esc — dash';
  const out = HiveManager.withCodexDeveloperInstructions('[t]\nk = 1\n', tricky);
  assert.equal(toml.parse(out).developer_instructions, tricky);
  assert.equal(toml.parse(out).t.k, 1);
});

test('PRESET: codex uses the developer_instructions channel; the positional prompt stays as the fallback only; grok is unchanged (a known gap: not installable here)', () => {
  assert.equal(providerPreset('codex').systemPromptChannel, 'codex-developer-instructions');
  assert.equal(providerPreset('codex').positionalInitialPrompt, true);
  assert.equal(providerPreset('grok').systemPromptChannel, undefined);
});
