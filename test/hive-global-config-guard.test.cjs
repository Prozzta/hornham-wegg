'use strict';

/**
 * AGY-HOOKS-GLOBAL-GUARD - only the LIVE hive may write the user's global provider config.
 *
 * WHAT HAPPENED. On 2026-09-23 a scratch probe built a `HiveManager` on a temp hive
 * without redirecting HOME and called `ensureAgent({ provider: 'antigravity' })`.
 * `installAgyHooks()` writes `join(homedir(), '.gemini')` unconditionally, so the human's
 * REAL global hook files were re-pointed at a temp hive that the probe then deleted -
 * breaking hook delivery for the live floor and for their own `agy` sessions. The probe
 * was not doing anything unreasonable; the writer was simply reachable from any
 * HiveManager at all.
 *
 * THE GUARD. A global write needs the hive's home to BE the configured harness home. The
 * predicate is injected and DEFAULT-CLOSED, so anything that builds a HiveManager without
 * supplying it - a probe, a test, a script - writes nothing global and says so.
 *
 * EVERY TEST HERE REDIRECTS HOME AND USERPROFILE AND ASSERTS THE REDIRECT before it
 * constructs a hive. That assertion is not ceremony: it is the exact step whose absence
 * caused the incident, so it runs before any hive object exists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { samePath } = loadTs('src/main/fs.ts');

/**
 * A sandbox whose HOME is a temp dir, asserted BEFORE any hive is built.
 *
 * `live` is the predicate the real app supplies (`index.ts`); omitting it is what every
 * probe and test does by accident, and the guard must hold for exactly that case.
 */
function sandbox(t, { live } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-guard-'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });

  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  // THE assertion the incident turned on. Nothing below may run without it.
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');

  const hiveHome = path.join(home, 'harness');
  const hive = live
    ? new HiveManager(() => hiveHome, undefined, {}, live)
    : new HiveManager(() => hiveHome);
  return { home, hiveHome, hive };
}

/** Every path under the redirected home that a global installer would create. */
const GLOBAL_PATHS = (home) => [
  path.join(home, '.gemini', 'config', 'hooks.json'),
  path.join(home, '.gemini', 'antigravity-cli', 'hooks.json'),
  path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
  path.join(home, '.gemini', 'antigravity-cli', '.munder-statusline-owner.json'),
  path.join(home, '.grok', 'hooks', 'munder-hive.json')
];
const globalsWritten = (home) => GLOBAL_PATHS(home).filter((p) => fs.existsSync(p));

/** Pre-create an Antigravity config dir, so the statusline lease has one to find. */
function seedAgyHome(home) {
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    JSON.stringify({ model: 'Gemini 3.8 Flash (High)' }, null, 2));
}

// ─── the incident, as a test ────────────────────────────────────────────────

test('A NON-LIVE HIVE WRITES NOTHING GLOBAL - the incident, with no predicate supplied', (t) => {
  const s = sandbox(t);                       // exactly what the probe did
  seedAgyHome(s.home);
  const before = fs.readFileSync(path.join(s.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8');

  s.hive.installAgyHooks();
  s.hive.installGrokHooks();
  s.hive.startAgyStatusline();

  assert.deepEqual(globalsWritten(s.home).filter((p) => !p.endsWith(`antigravity-cli${path.sep}settings.json`)), [],
    'not one global file may be created');
  assert.equal(fs.readFileSync(path.join(s.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'), before,
    'and the settings that were already there are byte-identical');
  assert.ok(!fs.existsSync(path.join(s.home, '.grok')), 'no ~/.grok is created either');
});

test('A DIFFERENT hive root is refused even WITH a live predicate - it is the wrong hive', (t) => {
  // The dangerous case is not "no predicate", it is "a predicate that says no". A second
  // hive on the same machine must not be able to take the user's global config.
  const s = sandbox(t, { live: (home) => samePath(home, path.join(os.tmpdir(), 'some-other-configured-home')) });
  seedAgyHome(s.home);
  s.hive.installAgyHooks();
  s.hive.installGrokHooks();
  s.hive.startAgyStatusline();
  assert.deepEqual(globalsWritten(s.home).filter((p) => !p.endsWith(`antigravity-cli${path.sep}settings.json`)), []);
});

test('THE LIVE HIVE STILL INSTALLS - the guard refuses the wrong hive, not the feature', (t) => {
  const s = sandbox(t, { live: (home) => samePath(home, path.join(os.tmpdir(), 'x')) || true });
  seedAgyHome(s.home);

  s.hive.installAgyHooks();
  s.hive.installGrokHooks();

  const agyConfig = path.join(s.home, '.gemini', 'config', 'hooks.json');
  const agyCli = path.join(s.home, '.gemini', 'antigravity-cli', 'hooks.json');
  const grok = path.join(s.home, '.grok', 'hooks', 'munder-hive.json');
  for (const p of [agyConfig, agyCli, grok]) assert.ok(fs.existsSync(p), `expected ${p}`);
  // agy loads from antigravity-cli but TRIGGERS from config (antigravity-cli#49): both.
  for (const p of [agyConfig, agyCli]) {
    const group = JSON.parse(fs.readFileSync(p, 'utf8'))['munder-hive'];
    assert.ok(group && group.Stop, 'the munder-hive group is installed');
    assert.ok(group.Stop[0].command.includes(s.hiveHome),  // FLAT (Y2: AGY's documented Stop shape)
      'and it points at THIS hive, not another');
  }
});

test('THE LIVE PREDICATE IS THE REAL ONE: samePath against the configured home', (t) => {
  // As index.ts wires it: `(home) => samePath(home, readConfig().harnessHome)`.
  const s = sandbox(t, { live: (home) => samePath(home, path.join(s0.home, 'harness')) });
  const s0 = s;                                // the configured home IS this hive's home
  seedAgyHome(s.home);
  s.hive.installAgyHooks();
  assert.ok(fs.existsSync(path.join(s.home, '.gemini', 'config', 'hooks.json')));
});

test('THE STATUSLINE LEASE obeys the same gate, and installs for the live hive', (t) => {
  const s = sandbox(t, { live: () => true });
  seedAgyHome(s.home);
  s.hive.startAgyStatusline();
  // Startup takes nothing (the lease is taken on an AGY spawn), so what we assert here is
  // that it got far enough to write its shim into the hive - the global settings are
  // untouched until a spawn, and a refused hive never even gets this far.
  assert.ok(fs.existsSync(path.join(s.hiveHome, 'hive', 'bin', 'agy-statusline.cjs')),
    'the live hive writes its own shim');
});

test('A REFUSED hive does not even write its statusline shim', (t) => {
  const s = sandbox(t);
  seedAgyHome(s.home);
  s.hive.startAgyStatusline();
  assert.ok(!fs.existsSync(path.join(s.hiveHome, 'hive', 'bin', 'agy-statusline.cjs')));
});

// ─── samePath, the predicate's comparison ───────────────────────────────────

test('samePath: a trailing separator, a redundant segment and (on Windows) case are the same path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'same-'));
  try {
    assert.ok(samePath(dir, dir));
    assert.ok(samePath(dir, dir + path.sep), 'a trailing separator is not a different directory');
    assert.ok(samePath(dir, path.join(dir, 'sub', '..')), 'a normalized path is the same path');
    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.ok(samePath(dir.toUpperCase(), dir.toLowerCase()), 'case-insensitive filesystem');
    }
    assert.ok(!samePath(dir, path.join(dir, 'child')), 'a child is NOT the same directory');
    assert.ok(!samePath(dir, null) && !samePath(null, dir) && !samePath(undefined, undefined));
    assert.ok(!samePath('', ''), 'empty is not a home');
    assert.ok(!samePath('relative/path', 'relative/path'), 'a relative path can never be a harness home');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('samePath: a symlinked home IS the same home - the one thing normalization must do', (t) => {
  // The same rule capacityScope follows: two spellings that resolve to one directory are
  // one directory. This is the only normalization samePath performs itself, since
  // expandTilde has already made the path absolute and collapsed `..`.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'real-home');
  const link = path.join(root, 'linked-home');
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, link, 'junction'); } catch (e) { t.skip(`cannot create a link here: ${e.code}`); return; }
  assert.ok(samePath(link, real), 'a symlink to the configured home IS the configured home');
  assert.ok(!samePath(link, root), 'and it is still not its parent');
});

test('samePath: a home that does not exist yet still compares sanely', () => {
  const missing = path.join(os.tmpdir(), 'not-created-yet-harness-home');
  assert.ok(samePath(missing, missing + path.sep));
  assert.ok(!samePath(missing, missing + '-other'));
});

// ─── the wiring ─────────────────────────────────────────────────────────────

test('WIRING: index.ts supplies the predicate, and it is the ONLY place that does', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.ok(index.includes('(home) => samePath(home, readConfig().harnessHome)'),
    'the live hive compares its home against the CONFIGURED home, read fresh');

  const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  assert.ok(hive.includes('private isLiveHarnessHome: (home: string) => boolean = () => false'),
    'and the default refuses - a HiveManager built anywhere else writes nothing global');

  // Every global writer goes through the gate. If a new one appears, it must be added
  // here deliberately: this list is the census.
  // AGY-STARTUP-TURN (1.1.55): the per-agent agy custom agent (write + removal) is global too.
  for (const fn of ['private installAgyHooks(): void {', 'private installGrokHooks(): void {', 'private installAgyAgent(', '  removeAgyAgent(agentId: string): void {']) {
    const body = hive.slice(hive.indexOf(fn), hive.indexOf(fn) + 400);
    assert.ok(body.includes('this.mayWriteGlobalConfig('), `${fn} must consult the gate`);
  }
  const statusline = hive.slice(hive.indexOf('  startAgyStatusline(): void {'), hive.indexOf('  reconcileAgyStatusline(): void {'));
  assert.ok(statusline.includes('this.mayWriteGlobalConfig('), 'the statusline lease consults the gate');

  // The CALL sites that reach the user's home. Comment lines are excluded - one of them
  // says the word `homedir()` while explaining why there is no second path to it, and
  // counting prose would make this census pass or fail on an edit to a sentence.
  const homedirCalls = hive.split('\n')
    .filter((l) => l.includes('homedir()') && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  assert.deepEqual(homedirCalls.map((l) => l.trim()), [
    "return join(homedir(), '.gemini', 'config', 'agents', HiveManager.agyAgentName(agentId));", // agyAgentDir: only installAgyAgent/removeAgyAgent, both gated above
    "const gem = join(homedir(), '.gemini');",           // installAgyHooks - gated above
    "const userHome = join(homedir(), '.codex');",       // Codex READS the credential (F1 policy)
    "const hookDir = join(homedir(), '.grok', 'hooks');" // installGrokHooks - gated above
  ], 'a new path to the user home appeared: gate it, or add it here deliberately');
});

test('WIRING: the dev build is still refused, and says so', (t) => {
  // DEV_ISOLATION is read at module load, so this asserts the code path rather than
  // re-importing under MUNDER_DEV=1: the gate checks it FIRST, before the home compare.
  const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  const gate = hive.slice(hive.indexOf('private mayWriteGlobalConfig('), hive.indexOf('private mayWriteGlobalConfig(') + 900);
  assert.ok(gate.indexOf('DEV_ISOLATION') < gate.indexOf('isLiveHarnessHome'), 'dev is checked first');
  assert.ok(gate.includes("kind: 'global-config-skipped'"), 'and a refusal is logged, never silent');
});
