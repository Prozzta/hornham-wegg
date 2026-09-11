'use strict';

/**
 * MUNDER_DEV=1 isolation helpers (src/main/devIsolation.ts) — pure, no electron.
 * The guard must reject every way a dev build could land on Stable's data:
 * a path equal to, inside, or containing a Stable path; a pipe name equal to
 * Stable's; and it must scrub the env a Stable agent terminal exports.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const iso = loadTs(path.resolve(__dirname, '../src/main/devIsolation.ts'));

const WIN = 'win32';
const STABLE_HIVE = 'C:\\Dunder\\hive';
const STABLE_USERDATA = 'C:\\Users\\FiercePC\\AppData\\Roaming\\munder-difflin';

test('DEV_ISOLATION is a boolean derived from MUNDER_DEV', () => {
  assert.equal(typeof iso.DEV_ISOLATION, 'boolean');
});

test('devDataRoot: default on win32, MUNDER_DEV_DATA override wins', () => {
  assert.equal(iso.devDataRoot({}, WIN), 'C:\\Dunder\\MunderDevData');
  assert.equal(iso.devDataRoot({ MUNDER_DEV_DATA: 'D:\\x\\devdata' }, WIN), path.resolve('D:\\x\\devdata'));
  assert.equal(iso.devDataRoot({ MUNDER_DEV_DATA: '   ' }, WIN), 'C:\\Dunder\\MunderDevData');
});

test('devPaths derive hive/palace/worktrees/userData under the root with a dev pipe marker', () => {
  const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
  assert.equal(p.userData, 'C:\\Dunder\\MunderDevData\\userData');
  assert.equal(p.harnessHome, 'C:\\Dunder\\MunderDevData');
  assert.equal(p.hiveRoot, 'C:\\Dunder\\MunderDevData\\hive');
  assert.equal(p.palace, 'C:\\Dunder\\MunderDevData\\palace');
  assert.equal(p.worktrees, 'C:\\Dunder\\MunderDevData\\worktrees');
  assert.match(p.pipeName, /^\\\\\.\\pipe\\munder-difflin-dev-[0-9a-f]{12}$/);
});

test('hookPipeId reproduces the live Stable pipe id for C:\\Dunder\\hive', () => {
  // Observed on the running Stable v0.4.5: \\.\pipe\munder-difflin-23c0d031569a
  assert.equal(iso.hookPipeId(STABLE_HIVE), '23c0d031569a');
  assert.equal(iso.hookPipeName(STABLE_HIVE, false, WIN), '\\\\.\\pipe\\munder-difflin-23c0d031569a');
});

test('isInside: equal, nested, case-insensitive on win32, and not a prefix false-positive', () => {
  assert.equal(iso.isInside('C:\\Dunder\\hive', 'C:\\Dunder\\hive', WIN), true);
  assert.equal(iso.isInside('c:\\dunder\\HIVE\\agents\\x', 'C:\\Dunder\\hive\\', WIN), true);
  assert.equal(iso.isInside('C:\\Dunder\\hive2', 'C:\\Dunder\\hive', WIN), false);
  assert.equal(iso.isInside('C:\\Dunder\\MunderDevData\\hive', 'C:\\Dunder\\hive', WIN), false);
});

test('canonicalPath/isInside: a differently-spelled Stable hive is still the Stable hive (realpath, not string)', (t) => {
  if (process.platform !== 'win32') { t.skip('needs the real C:\\Dunder\\hive'); return; }
  const fs = require('node:fs');
  if (!fs.existsSync(STABLE_HIVE)) { t.skip('C:\\Dunder\\hive not present on this host'); return; }
  // Forward slashes, lower case, trailing slash and a dot-segment all resolve to
  // the same directory and must be caught even though each has a different
  // sha1-derived pipe id.
  for (const spelling of ['C:/Dunder/hive', 'c:\\dunder\\HIVE', 'C:\\Dunder\\hive\\', 'C:\\Dunder\\.\\hive', 'C:\\Dunder\\MunderDevData\\..\\hive']) {
    assert.equal(iso.isInside(spelling, STABLE_HIVE, WIN), true, spelling);
    assert.notEqual(iso.hookPipeId(spelling), iso.hookPipeId(STABLE_HIVE), `${spelling} has a different pipe id`);
    const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
    p.hiveRoot = spelling;
    const v = iso.checkIsolation(p, [STABLE_HIVE], WIN);
    assert.ok(v.some((s) => s.startsWith('hiveRoot')), `${spelling}: ${v.join('|')}`);
  }
  // A not-yet-existing dev root canonicalises via its nearest existing ancestor.
  assert.equal(iso.canonicalPath('C:\\Dunder\\does-not-exist-zz\\hive', WIN), 'c:\\dunder\\does-not-exist-zz\\hive');
});

test('stableForbiddenPaths: literals + default userData + paths under Stable harnessHome, deduped', () => {
  const f = iso.stableForbiddenPaths({ defaultUserData: STABLE_USERDATA, stableHarnessHome: 'C:\\Dunder', platform: WIN });
  assert.ok(f.includes(STABLE_HIVE));
  assert.ok(f.includes('C:\\Dunder\\palace'));
  assert.ok(f.includes(STABLE_USERDATA));
  assert.ok(f.includes('C:\\Dunder\\roster.json'));
  assert.equal(new Set(f.map((p) => p.toLowerCase())).size, f.length, 'deduped');
});

test('checkIsolation: the intended dev layout passes against the real Stable set', () => {
  const forbidden = iso.stableForbiddenPaths({ defaultUserData: STABLE_USERDATA, stableHarnessHome: 'C:\\Dunder', platform: WIN });
  const v = iso.checkIsolation(iso.devPaths('C:\\Dunder\\MunderDevData', WIN), forbidden, WIN);
  assert.deepEqual(v, []);
});

test('checkIsolation: rejects a hive root inside Stable hive', () => {
  const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
  p.hiveRoot = 'C:\\Dunder\\hive';
  const v = iso.checkIsolation(p, [STABLE_HIVE], WIN);
  assert.ok(v.some((s) => s.startsWith('hiveRoot')), v.join('\n'));
});

test('checkIsolation: rejects a harnessHome that CONTAINS Stable hive (C:\\Dunder)', () => {
  const p = iso.devPaths('C:\\Dunder', WIN);
  const v = iso.checkIsolation(p, [STABLE_HIVE], WIN);
  assert.ok(v.some((s) => /harnessHome .* contains Stable path/.test(s)), v.join('\n'));
});

test('checkIsolation: rejects userData equal to Stable userData', () => {
  const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
  p.userData = STABLE_USERDATA;
  const v = iso.checkIsolation(p, [STABLE_USERDATA], WIN);
  assert.ok(v.some((s) => s.startsWith('userData')), v.join('\n'));
});

test('checkIsolation: rejects a pipe equal to Stable\'s and one without the dev marker', () => {
  const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
  p.pipeName = '\\\\.\\pipe\\munder-difflin-23c0d031569a';
  const v = iso.checkIsolation(p, [STABLE_HIVE], WIN);
  assert.ok(v.some((s) => /equals Stable's pipe/.test(s)), v.join('\n'));
  assert.ok(v.some((s) => /lacks the dev marker/.test(s)), v.join('\n'));
});

test('scrubInheritedEnv removes exactly the Stable identity keys and reports them', () => {
  const env = {
    HIVE_ROOT: 'C:\\Dunder\\hive', HIVE_SOCK: 'x', HIVE_NODE: 'y', HIVE_AUTO_APPROVE: '1', AGENT_ID: 'jim', AGENT_DIR: 'd',
    AGENT_NAME: 'Jim', MEMPALACE_PALACE_PATH: 'C:\\Dunder\\palace', MD_SLACK_REPLY_CONFIG: 's', CODEX_HOME: 'c',
    PI_CODING_AGENT_DIR: 'p', OPENCODE_CONFIG_DIR: 'o', GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'g', CRUSH_GLOBAL_CONFIG: 'cc',
    CRUSH_GLOBAL_DATA: 'cd', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', OTEL_METRICS_EXPORTER: 'otlp',
    PATH: 'keep', MEMPALACE_EMBEDDING_MODEL: 'minilm', CLAUDE_CONFIG_DIR: 'keep-too'
  };
  const removed = iso.scrubInheritedEnv(env);
  assert.deepEqual(removed.sort(), [...iso.STABLE_ENV_KEYS, 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRICS_EXPORTER'].sort());
  assert.equal(env.PATH, 'keep');
  assert.equal(env.MEMPALACE_EMBEDDING_MODEL, 'minilm');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'keep-too');
  for (const k of iso.STABLE_ENV_KEYS) assert.equal(k in env, false);
  assert.equal(Object.keys(env).some((k) => k.startsWith('OTEL_')), false);
});

test('devWindowTitle: marks DEV only when isolation is on', () => {
  assert.equal(iso.devWindowTitle('Munder Difflin', false), 'Munder Difflin');
  assert.equal(iso.devWindowTitle('Munder Difflin', true), 'Munder Difflin DEV');
  assert.equal(iso.devWindowTitle('Munder Difflin — Floor', true), 'Munder Difflin DEV — Floor');
});
