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

test('wizard path: even the Stable home C:\\Dunder cannot be persisted', () => {
  const stable = process.platform === 'win32' ? 'C:\\Dunder' : '/opt/dunder';
  writeConfig({ harnessHome: stable });
  assert.equal(onDisk().harnessHome, DEV_HOME);
  // recentHives may still list what was typed — it is picker history, not a
  // path anything resolves against; the guard is on harnessHome.
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

test('sanitizeCodexConfigForDev drops nested CODEX_HOME keys and [projects.*] trust tables, keeps the rest', () => {
  const src = [
    'model = "gpt-5"',
    '',
    "[projects.'c:\\users\\fiercepc']",
    'trust_level = "trusted"',
    '',
    '[projects."C:\\\\PrzEdit"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.node_repl]',
    'command = "node"',
    '',
    '[mcp_servers.node_repl.env]',
    'CODEX_HOME = "C:\\\\Users\\\\FiercePC\\\\.codex"',
    'OTHER = "keep"',
    '',
    '[features]',
    'hooks = true'
  ].join('\n');
  const r = iso.sanitizeCodexConfigForDev(src);
  assert.equal(r.droppedTables, 2);
  assert.equal(r.droppedKeys, 1);
  assert.equal(/projects/.test(r.text), false);
  assert.equal(/trust_level/.test(r.text), false);
  assert.equal(/CODEX_HOME/.test(r.text), false);
  assert.match(r.text, /model = "gpt-5"/);
  assert.match(r.text, /\[mcp_servers\.node_repl\.env\]\nOTHER = "keep"/);
  assert.match(r.text, /\[features\]\nhooks = true/);
  // Idempotent and a no-op on clean input.
  assert.deepEqual(iso.sanitizeCodexConfigForDev(r.text), { text: r.text, droppedKeys: 0, droppedTables: 0 });
});
