'use strict';

/**
 * MUNDER_DEV=1 clamp at the PERSISTENCE boundary (Andy M4 finding on 0d1441db:
 * the onboarding wizard persisted an out-of-tree typed path verbatim into
 * MunderDevData/userData/config.json because the clamp ran on read only).
 *
 * The wizard's path is: renderer OnboardingWizard -> ensureHarnessHome(home)
 * -> config:update IPC -> writeConfig(patch) -> persistConfig(next). This test
 * drives exactly writeConfig/ensureHarnessHome with MUNDER_DEV=1 set BEFORE the
 * module loads (DEV_ISOLATION is read at module load), then asserts what is on
 * disk, not just what readConfig returns.
 *
 * Kept in its own file: load-ts caches modules per process, so a DEV-mode
 * config.ts must not share a process with the non-DEV config tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MUNDER_DEV = '1';
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-devcfg-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };

const iso = loadTs('src/main/devIsolation.ts');
const { writeConfig, readConfig, ensureHarnessHome } = loadTs('src/main/config.ts');
const DEV_HOME = iso.devHarnessHome(iso.devDataRoot());
const onDisk = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));

test('DEV_ISOLATION is on for this process', () => {
  assert.equal(iso.DEV_ISOLATION, true);
});

test('wizard path: an out-of-tree harnessHome is clamped ON DISK, not only on read', () => {
  const typed = process.platform === 'win32' ? 'C:\\Elsewhere\\TypedByUser' : '/tmp/elsewhere-typed';
  const res = writeConfig({ harnessHome: typed, onboardingComplete: true });
  assert.equal(res.harnessHome, DEV_HOME, 'returned config is clamped');
  assert.equal(onDisk().harnessHome, DEV_HOME, 'config.json on disk is clamped');
  assert.equal(readConfig().harnessHome, DEV_HOME);
  assert.equal(fs.existsSync(typed), false, 'nothing was created at the typed path');
});

test('wizard path: even the Stable home C:\\Dunder cannot be persisted, and recentHives holds only the DEV root', () => {
  const stable = process.platform === 'win32' ? 'C:\\Dunder' : '/opt/dunder';
  writeConfig({ harnessHome: stable });
  assert.equal(onDisk().harnessHome, DEV_HOME);
  // The hive picker's history (recentHives) is clamped too — an out-of-tree
  // path must not be advertised in the DEV picker (Andy, 72f6180a spot-check).
  assert.deepEqual(onDisk().recentHives, [DEV_HOME]);
  assert.deepEqual(readConfig().recentHives, [DEV_HOME]);
});

test('a stale config.json with out-of-tree harnessHome and recentHives is clamped on the next read and on the next save', () => {
  const stale = { harnessHome: 'C:\\Dunder\\research\\experiments\\dev-isolation\\tmp-onboard-probe', recentHives: ['C:\\Dunder', 'C:\\Elsewhere'], onboardingComplete: true };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(stale), 'utf8');
  const r = readConfig();
  assert.equal(r.harnessHome, DEV_HOME);
  assert.deepEqual(r.recentHives, [DEV_HOME]);
  writeConfig({ notifications: true });
  assert.equal(onDisk().harnessHome, DEV_HOME);
  assert.deepEqual(onDisk().recentHives, [DEV_HOME]);
});

test('a later unrelated patch cannot un-clamp what is on disk', () => {
  writeConfig({ notifications: false });
  assert.equal(onDisk().harnessHome, DEV_HOME);
});

test('ensureHarnessHome ignores the typed folder and only creates the DEV root', () => {
  const typed = path.join(userData, 'never-created');
  const r = ensureHarnessHome(typed);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(typed), false);
});

// A fixture mirroring the REAL global ~/.codex/config.toml on this machine
// (key names and quoting styles verbatim; values shortened). This is the
// "generated config" test Dwight asked for: what a DEV agent's CODEX_HOME/
// config.toml is seeded with, before the munder-hive [[hooks.*]] tables are
// appended by hive.ts.
const GLOBAL_CODEX_TOML = [
  'model = "gpt-5"',
  '',
  '[windows]',
  'js_repl = false',
  '',
  "[projects.'c:\\users\\fiercepc']",
  'trust_level = "trusted"',
  '',
  '[projects."C:\\\\PrzEdit"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.node_repl]',
  'args = []',
  "command = 'C:\\Users\\FiercePC\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\abc\\bin\\node_repl.exe'",
  'startup_timeout_sec = 120',
  '',
  '[mcp_servers.node_repl.env]',
  'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "10000"',
  "NODE_REPL_TRUSTED_CODE_PATHS = 'C:\\Users\\FiercePC\\.codex;C:\\Users\\FiercePC\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\abc\\bin\\node_modules'",
  "CODEX_HOME = 'C:\\Users\\FiercePC\\.codex'",
  'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
  "NODE_REPL_TRUSTED_SERVICES = '{\"browser\":\"C:/Users/FiercePC/.codex/plugins/cache/x.mjs\"}'",
  'SKY_CUA_NATIVE_PIPE = "1"',
  "SKY_CUA_NATIVE_PIPE_DIRECTORY = '\\\\.\\pipe\\codex-computer-use-29c1'",
  'BASIC_QUOTED_PIPE = "\\\\\\\\.\\\\pipe\\\\codex-other"',
  '',
  '[features]',
  'hooks = true'
].join('\n');

test('generated DEV codex config: nested CODEX_HOME -> agent DEV home, named pipes DEV-distinct, trust tables gone, runtime paths untouched', () => {
  const agentHome = 'C:\\Dunder\\MunderDevData\\hive\\agents\\dev-jim-x1\\.codex';
  const suffix = 'dev-' + iso.hookPipeId(agentHome);
  const r = iso.sanitizeCodexConfigForDev(GLOBAL_CODEX_TOML, { codexHome: agentHome, pipeSuffix: suffix });
  assert.equal(r.droppedTables, 2);
  assert.equal(r.rewrittenHomes, 1);
  assert.equal(r.rewrittenPipes, 2);
  const t = r.text;
  // No trust list, no reference to the user's global home as CODEX_HOME.
  assert.equal(/\[projects/.test(t), false);
  assert.equal(/trust_level/.test(t), false);
  assert.match(t, /^CODEX_HOME = 'C:\\Dunder\\MunderDevData\\hive\\agents\\dev-jim-x1\\\.codex'$/m);
  assert.equal(/CODEX_HOME = 'C:\\Users/.test(t), false);
  // Pipes keep their prefix and gain a per-agent DEV suffix, in either quoting style.
  assert.match(t, new RegExp("^SKY_CUA_NATIVE_PIPE_DIRECTORY = '\\\\\\\\\\.\\\\pipe\\\\codex-computer-use-29c1-" + suffix + "'$", 'm'));
  assert.match(t, new RegExp('^BASIC_QUOTED_PIPE = "\\\\\\\\\\\\\\\\\\.\\\\\\\\pipe\\\\\\\\codex-other-' + suffix + '"$', 'm'));
  assert.equal(/codex-computer-use-29c1'$/m.test(t), false, 'the Stable pipe name must not survive verbatim');
  // Read-only runtime references are deliberately preserved (documented shared resources).
  assert.match(t, /^NODE_REPL_TRUSTED_CODE_PATHS = 'C:\\Users\\FiercePC\\\.codex;/m);
  assert.match(t, /^NODE_REPL_TRUSTED_SERVICES = /m);
  assert.match(t, /^command = 'C:\\Users\\FiercePC\\AppData\\Local\\OpenAI/m);
  // Everything else verbatim, in order.
  assert.match(t, /^model = "gpt-5"$/m);
  assert.match(t, /\[windows\]\njs_repl = false/);
  assert.match(t, /\[mcp_servers\.node_repl\]\nargs = \[\]/);
  assert.match(t, /\[features\]\nhooks = true/);
  // Idempotent: a second pass changes nothing (pipes already carry the suffix).
  const again = iso.sanitizeCodexConfigForDev(t, { codexHome: agentHome, pipeSuffix: suffix });
  assert.equal(again.text, t);
  assert.deepEqual([again.rewrittenHomes, again.rewrittenPipes, again.droppedTables], [1, 0, 0]);
  // Two DEV agents get different pipe suffixes.
  const other = 'C:\\Dunder\\MunderDevData\\hive\\agents\\dev-dwight-x2\\.codex';
  assert.notEqual(iso.hookPipeId(other), iso.hookPipeId(agentHome));
});

test('sanitizeCodexConfigForDev is a no-op shape-wise on a file with nothing to fix', () => {
  const src = 'model = "gpt-5"\n[features]\nhooks = true\n';
  const r = iso.sanitizeCodexConfigForDev(src, { codexHome: 'C:\\x', pipeSuffix: 'dev-abc' });
  assert.deepEqual(r, { text: src, rewrittenHomes: 0, rewrittenPipes: 0, droppedTables: 0 });
});
