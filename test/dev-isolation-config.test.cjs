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

// ─────────────────────────────────────────────────────────────────────────────
// F1 — DEV-SCOPED CODEX CREDENTIALS (research/F1-DEV-CODEX-CREDENTIALS.md §5.6)
//
// Two kinds of case, deliberately kept distinct:
//   PURE POLICY  (1-6)  the source decision and the destination bound, no fs effect.
//   EFFECT       (7-15) assert what is ON DISK afterwards, not just a return value —
//                       a predicate that says "would remove" proves nothing about
//                       whether the link went and the target survived.
//
// Every effect case runs in its own throwaway tree shaped like a real Dev hive
// (<root>/hive/agents/<id>/.codex/auth.json) because the destination bound requires
// exactly that shape. NO REAL CREDENTIAL IS EVER TOUCHED: the "external target" is a
// sentinel file in a temp directory, and its bytes are compared to prove the target
// survived. Nothing here reads, writes or links the user's ~/.codex.
// ─────────────────────────────────────────────────────────────────────────────

const F1_SENTINEL = 'external-credential-sentinel-not-a-real-token';

/** A throwaway Dev-shaped tree. Returns the dev root, the agent's .codex dir and
 *  the auth.json path inside it. */
function f1Tree(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-f1-' + name + '-'));
  const codexDir = path.join(root, 'hive', 'agents', 'dev-agent-1', '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  return { root, codexDir, authDest: path.join(codexDir, 'auth.json') };
}

/** An external "credential" well outside the dev root. A sentinel, never a real one. */
function f1External(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-f1-outside-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, F1_SENTINEL, 'utf8');
  assert.equal(iso.isInside(file, root), false, 'the sentinel must be outside the dev root');
  return file;
}

/** The identity of a reparse entry (junction or symlink): where it points, that it
 *  is still a link, and when it was last touched. Compared before/after a refusal to
 *  prove NON-MUTATION, which is the half of "refused, nothing touched" that a
 *  result-only assertion leaves unproven. lstat, never stat — the entry, not its
 *  target. */
function f1Reparse(entry) {
  const st = fs.lstatSync(entry);
  return {
    target: fs.readlinkSync(entry),
    isSymbolicLink: st.isSymbolicLink(),
    mtimeMs: st.mtimeMs
  };
}

/** Create a symlink, or skip the calling test LOUDLY if this host cannot.
 *  A silently skipped fail-closed test is worse than no test. */
function f1Link(t, target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (e) {
    t.skip('SKIPPED LOUDLY: this host cannot create symlinks/junctions (' + e.code + '), so this F1 case did NOT run');
    return false;
  }
}

// ── 1-2. Pure policy: the source decision ────────────────────────────────────

test('F1/1 codexAuthSeedSource returns null under DEV — the global credential is never a legal source', () => {
  assert.equal(iso.codexAuthSeedSource({ userCodexHome: 'C:\\Users\\X\\.codex', devIsolation: true }), null);
  // And with the module default, which is DEV in this file.
  assert.equal(iso.codexAuthSeedSource({ userCodexHome: 'C:\\Users\\X\\.codex' }), null);
});

test('F1/2 codexAuthSeedSource returns the global path when DEV is OFF — Stable is provably unchanged', () => {
  const src = iso.codexAuthSeedSource({ userCodexHome: path.join('C:', 'Users', 'X', '.codex'), devIsolation: false });
  assert.equal(src, path.join('C:', 'Users', 'X', '.codex', 'auth.json'));
});

// ── 3-5. Pure policy: the destination bound ──────────────────────────────────

test('F1/3 the destination bound accepts a well-formed DEV agent credential path', () => {
  const { root, authDest } = f1Tree('bound-ok');
  const r = iso.codexAuthDestBound({ authDest, devDataRoot: root });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
});

test('F1/4 the destination bound rejects any basename other than auth.json', () => {
  const { root, codexDir } = f1Tree('bound-name');
  const r = iso.codexAuthDestBound({ authDest: path.join(codexDir, 'auth.json.bak'), devDataRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /basename is not auth\.json/);
});

test('F1/5 the destination bound requires a STRICT descendant — the agents dir itself is refused', () => {
  const { root } = f1Tree('bound-strict');
  const agents = path.join(root, 'hive', 'agents');
  // Directly in the agents dir: inside, but NOT strictly below an agent home.
  const r = iso.codexAuthDestBound({ authDest: path.join(agents, 'auth.json'), devDataRoot: root });
  assert.equal(r.ok, false, 'isInside() is true for an exact match, so strictness must be explicit');
  assert.match(r.reason, /not inside a DEV agent home/);
  // And somewhere else entirely.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'md-f1-elsewhere-'));
  const r2 = iso.codexAuthDestBound({ authDest: path.join(elsewhere, 'auth.json'), devDataRoot: root });
  assert.equal(r2.ok, false);
});

// ── 6. The guard that keeps the policy load-bearing ──────────────────────────

/** Every EXECUTABLE line that names a credential file, anywhere in the relevant
 *  source set, must be one of a very small set of known-good shapes. Anything else
 *  is a candidate second seed path and is reported with its file and line.
 *
 *  An ALLOWLIST, not a blocklist, and deliberately not line-local: the earlier
 *  version of this guard only rejected `homedir()` when it appeared on the SAME
 *  line as the filename, so the original split construction —
 *    const userHome = join(homedir(), '.codex');
 *    const authSrc  = join(userHome, 'auth.json');
 *  — would have sailed straight through it while the policy function sat unused
 *  beside it. A guard that reformatting can side-step is not a guard. */
function f1CredentialLineViolations(source, label) {
  const ALLOWED = [
    // The DESTINATION inside the agent's own Codex home. Not a source.
    /^const authDest = join\(home, 'auth\.json'\);$/,
    // The policy function's own body — the single legal construction of a source.
    /^return join\(opts\.userCodexHome, 'auth\.json'\);$/,
    // The basename check in the destination bound, and its refusal message.
    /^if \(lib\.basename\(opts\.authDest\) !== 'auth\.json'\) \{$/,
    /^return \{ ok: false, reason: `destination basename is not auth\.json: \$\{opts\.authDest\}` \};$/
  ];
  const out = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!/auth\.json/.test(line)) return;
    if (!line || line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) return;
    if (ALLOWED.some((re) => re.test(line))) return;
    out.push(label + ':' + (i + 1) + ' ' + line);
  });
  return out;
}

test('F1/6 no second global-credential seed path bypasses codexAuthSeedSource', () => {
  // B-02's "the allowlist is load-bearing", applied to credential SOURCES: the policy
  // only helps if it is the ONLY way a global credential source is ever produced.
  const files = ['hive.ts', 'devIsolation.ts', 'index.ts', 'config.ts'];
  const violations = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');
    violations.push(...f1CredentialLineViolations(src, f));
  }
  assert.deepEqual(violations, [], 'unrecognised credential-path construction(s) outside the policy');

  // The guard must be able to CATCH the bypass, not merely pass on today's source —
  // otherwise it proves nothing. Feed it the exact split construction Dwight named.
  const bypass = [
    "const userHome = join(homedir(), '.codex');",
    "const authSrc = join(userHome, 'auth.json');",
    'const x = codexAuthSeedSource({ userCodexHome: userHome });'
  ].join('\n');
  const caught = f1CredentialLineViolations(bypass, 'synthetic');
  assert.equal(caught.length, 1, 'the guard must reject a split bypass even with a policy call sitting beside it');
  assert.match(caught[0], /join\(userHome, 'auth\.json'\)/);

  // And the real assignment must FLOW THROUGH the policy, not merely coexist with it.
  const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(
    hive,
    /const\s+authSrc\s*=\s*codexAuthSeedSource\(/,
    'the authSrc assignment itself must come from the policy function'
  );
});

// ── 7-8. Effect: an external link is removed, its TARGET survives ────────────

test('F1/7 an external ABSOLUTE link is removed and the target is untouched', (t) => {
  const { root, authDest } = f1Tree('abs');
  const target = f1External(root);
  if (!f1Link(t, target, authDest, 'file')) return;

  const r = iso.migrateCodexAuthLink({ authDest, devDataRoot: root, devIsolation: true });
  assert.deepEqual(r, { ok: true, action: 'removed-outside-link' });
  assert.equal(fs.existsSync(authDest), false, 'the link entry must be gone');
  // The point of the whole exercise: the external credential itself is untouched.
  assert.equal(fs.existsSync(target), true, 'the external target must NOT be deleted');
  assert.equal(fs.readFileSync(target, 'utf8'), F1_SENTINEL, 'the external target must NOT be modified');
});

test('F1/8 an external RELATIVE link is resolved against the link dir, removed, target untouched', (t) => {
  const { root, codexDir, authDest } = f1Tree('rel');
  const target = f1External(root);
  const rel = path.relative(codexDir, target);
  assert.ok(!path.isAbsolute(rel), 'the fixture must actually be a relative target');
  if (!f1Link(t, rel, authDest, 'file')) return;

  const r = iso.migrateCodexAuthLink({ authDest, devDataRoot: root, devIsolation: true });
  assert.deepEqual(r, { ok: true, action: 'removed-outside-link' });
  assert.equal(fs.existsSync(authDest), false);
  assert.equal(fs.readFileSync(target, 'utf8'), F1_SENTINEL);
});

// ── 9-10. Effect: what must be PRESERVED ─────────────────────────────────────

test('F1/9 a regular Dev-owned credential file is preserved byte-for-byte', () => {
  const { root, authDest } = f1Tree('regular');
  fs.writeFileSync(authDest, 'dev-owned-placeholder', 'utf8');
  const r = iso.migrateCodexAuthLink({ authDest, devDataRoot: root, devIsolation: true });
  assert.deepEqual(r, { ok: true, action: 'preserved-regular' });
  // Deleting this would log the user out of Dev on every single spawn.
  assert.equal(fs.readFileSync(authDest, 'utf8'), 'dev-owned-placeholder');
});

test('F1/10 an INSIDE-Dev link and its target are both preserved', (t) => {
  const { root, authDest } = f1Tree('inside');
  const inner = path.join(root, 'dev-owned-auth.json');
  fs.writeFileSync(inner, 'dev-owned-placeholder', 'utf8');
  if (!f1Link(t, inner, authDest, 'file')) return;

  const r = iso.migrateCodexAuthLink({ authDest, devDataRoot: root, devIsolation: true });
  assert.deepEqual(r, { ok: true, action: 'preserved-inside-link' });
  assert.equal(fs.lstatSync(authDest).isSymbolicLink(), true, 'the inside-Dev link must survive');
  assert.equal(fs.readFileSync(inner, 'utf8'), 'dev-owned-placeholder');
});

// ── 11. Effect: Stable never enters this code ────────────────────────────────

test('F1/11 with DEV OFF even an external link is left completely untouched', (t) => {
  const { root, authDest } = f1Tree('devoff');
  const target = f1External(root);
  if (!f1Link(t, target, authDest, 'file')) return;

  const r = iso.migrateCodexAuthLink({ authDest, devDataRoot: root, devIsolation: false });
  assert.deepEqual(r, { ok: true, action: 'skipped-not-dev' });
  assert.equal(fs.lstatSync(authDest).isSymbolicLink(), true, 'Stable behaviour must be unchanged');
  assert.equal(fs.readFileSync(target, 'utf8'), F1_SENTINEL);
});

// ── 12-13. Effect: the confinement refusals ──────────────────────────────────

test('F1/12 a parent reparse escape whose target EXISTS is refused, nothing touched', (t) => {
  const { root } = f1Tree('escape');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-f1-escapedir-'));
  const target = path.join(outsideDir, 'auth.json');
  fs.writeFileSync(target, F1_SENTINEL, 'utf8');
  // An agent home whose .codex is a junction pointing OUT of the dev root.
  const agentHome = path.join(root, 'hive', 'agents', 'dev-agent-2');
  fs.mkdirSync(agentHome, { recursive: true });
  const codexDir = path.join(agentHome, '.codex');
  if (!f1Link(t, outsideDir, codexDir, 'junction')) return;

  // "Refused, nothing touched" is two claims. The refusal is the easy half; on the
  // one destructive path in F1, NON-MUTATION is the half that matters, so capture the
  // reparse entry itself before and compare after.
  const before = f1Reparse(codexDir);
  const targetBefore = fs.lstatSync(target);

  const r = iso.migrateCodexAuthLink({ authDest: path.join(codexDir, 'auth.json'), devDataRoot: root, devIsolation: true });
  assert.equal(r.ok, false, 'a parent that resolves outside the dev root must refuse');
  assert.match(r.reason, /not inside a DEV agent home/);

  const after = f1Reparse(codexDir);
  assert.deepEqual(after, before, 'the parent reparse entry must be untouched by a refusal');
  assert.equal(fs.readFileSync(target, 'utf8'), F1_SENTINEL, 'the external target bytes must be unchanged');
  assert.equal(fs.lstatSync(target).mtimeMs, targetBefore.mtimeMs, 'the external target must not even be rewritten');
});

test('F1/13 a DANGLING parent reparse point is refused — the lexical fallback must NOT rescue it', (t) => {
  // Dwight, design section 7.4 finding 2. canonicalPath() swallows any realpath
  // failure and rebuilds the path from the nearest existing ancestor, so a dangling
  // parent would look lexically in-root and pass a check it must fail. The bound
  // therefore requires a DIRECT realpathSync.native success on the parent.
  const { root } = f1Tree('dangling');
  const agentHome = path.join(root, 'hive', 'agents', 'dev-agent-3');
  fs.mkdirSync(agentHome, { recursive: true });
  const codexDir = path.join(agentHome, '.codex');
  const missing = path.join(os.tmpdir(), 'md-f1-does-not-exist-' + Date.now());
  if (!f1Link(t, missing, codexDir, 'junction')) return;

  const before = f1Reparse(codexDir);
  assert.equal(fs.existsSync(missing), false, 'the fixture must start with a genuinely dangling target');

  const r = iso.migrateCodexAuthLink({ authDest: path.join(codexDir, 'auth.json'), devDataRoot: root, devIsolation: true });
  assert.equal(r.ok, false, 'an unresolvable parent is ambiguity, and ambiguity must refuse');
  assert.match(r.reason, /could not resolve the credential directory/);

  const after = f1Reparse(codexDir);
  assert.deepEqual(after, before, 'the dangling reparse entry must be untouched by a refusal');
  // It must refuse WITHOUT helpfully creating what was missing.
  assert.equal(fs.existsSync(missing), false, 'the missing target must REMAIN absent');
});

// ── 14-15. Effect: fail-closed shape, and the postcondition ──────────────────

test('F1/14 an ambiguous destination RETURNS a blocking result rather than throwing', () => {
  // Returned, not thrown, is the whole point: spawnAgentCore wraps ensureAgent in a
  // best-effort catch, so a thrown migration error would be logged and the spawn
  // would CONTINUE on the unsafe state. Only a returned refusal survives that catch.
  const { root, authDest } = f1Tree('ambiguous');
  fs.mkdirSync(authDest); // a directory where a credential should be: unrecognised.
  let r;
  assert.doesNotThrow(() => { r = iso.migrateCodexAuthLink({ authDest, devDataRoot: root, devIsolation: true }); });
  assert.equal(r.ok, false);
  assert.match(r.reason, /neither a regular file nor a symbolic link/);
  assert.equal(typeof r.reason, 'string', 'the refusal must carry a reason the caller can surface');
});

test('F1/15 after a successful removal the safe postcondition holds', (t) => {
  const { root, authDest } = f1Tree('postcond');
  const target = f1External(root);
  if (!f1Link(t, target, authDest, 'file')) return;

  assert.equal(iso.migrateCodexAuthLink({ authDest, devDataRoot: root, devIsolation: true }).ok, true);
  // Absent, a regular file, or an inside-Dev link — nothing else is acceptable.
  let kindOk = false;
  try {
    const st = fs.lstatSync(authDest);
    kindOk = st.isFile() || (st.isSymbolicLink() && iso.isInside(fs.realpathSync(authDest), root));
  } catch (e) {
    kindOk = e.code === 'ENOENT';
  }
  assert.equal(kindOk, true, 'the postcondition must hold after removal');
  // Re-running is idempotent and still safe.
  assert.deepEqual(iso.migrateCodexAuthLink({ authDest, devDataRoot: root, devIsolation: true }), { ok: true, action: 'absent' });
});
