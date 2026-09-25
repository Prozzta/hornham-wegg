'use strict';

/**
 * DEV ISOLATION OF L0's ONE ON-DISK ARTEFACT - the durable capacity-observation store.
 * (L0 milestone record item 10: the isolation gate was F1's 37 tests and L0 had added none.)
 *
 * The human's L0-TAIL ruling: "Keep the artifact under the existing userData / Dev-isolated
 * root so F1 isolation remains intact." Until now that was a COMMENT. Here it is held
 * against the REAL isolation guard (src/main/devIsolation.ts), in three layers, and each
 * says what it is worth:
 *
 *   PURE     `capacityStorePath` is the one function that decides where the file lives.
 *            Fed the Dev-isolated userData it must land INSIDE the Dev root and OUTSIDE
 *            every path the guard forbids - Stable's userData, Stable's hive, a provider's
 *            global home. Killers take the module, so a mutant can be handed to them.
 *   EFFECT   a real CapacityStore, a real tracker, a real write into a sandboxed userData:
 *            exactly one file appears, inside the sandbox, no temp sibling left behind,
 *            and an unwritable location is survived without writing anywhere else.
 *   STATIC   a tripwire over index.ts - a literal shape and no more: the store is built
 *            from `app.getPath('userData')` through that one function, exactly once, and
 *            AFTER the MUNDER_DEV bootstrap has repointed `userData`. It cannot prove that
 *            Electron honours `setPath`; nothing short of a real Dev launch can (item 12).
 *
 * It does NOT launch the app.
 *
 * HERMETIC, AND PROVEN SO. The first version of this file was REJECTED by Dwight: it passed
 * 10/0 in a Claude session and 8/2 in his Codex session, from the same checkout. A mutant
 * here reads `process.env.CODEX_HOME`; in a Claude session that variable is unset, in a Codex
 * session it is ALREADY SET - to a folder under C:\Dunder\hive - so the mutant was killed by
 * an earlier assertion than the one that names it. Green only in the environment it was
 * written in, and this time the environment was the PROVIDER of the agent running it. A fresh
 * checkout does not catch that. So: every killer runs inside `hermetic()`, which removes
 * every variable the code under test OR A MUTANT can read, lets the arm that tests the
 * environment set its own, and restores everything afterwards; and the file RE-RUNS ITSELF
 * as two registered tests - once with the provider variables unset, once with them set to
 * hostile paths INSIDE the hive - and both must be all-pass with every mutant dying by name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const iso = loadTs('src/main/devIsolation.ts');
const SRC = 'src/main/capacityPersistence.ts';
const REAL = loadTs(SRC);
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');

const WIN = 'win32';
const DEV_ROOT = 'C:\\Dunder\\MunderDevData';
const STABLE_USERDATA = 'C:\\Users\\FiercePC\\AppData\\Roaming\\munder-difflin';
const STABLE_HARNESS_HOME = 'C:\\Dunder';
/** Where a provider keeps its own global state. L0 READS from these; it must never WRITE there. */
const PROVIDER_HOMES = ['C:\\Users\\FiercePC\\.claude', 'C:\\Users\\FiercePC\\.codex'];

/** Everything the code under test, a mutant of it, or a provider session can put in the
 *  way. Removed before a killer runs; restored after, whatever the killer did to them. */
const AMBIENT = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'MUNDER_DEV', 'MUNDER_DEV_DATA'];
function hermetic(fn) {
  const saved = Object.fromEntries(AMBIENT.map((k) => [k, process.env[k]]));
  for (const k of AMBIENT) delete process.env[k];
  try { return fn(); }
  finally { for (const k of AMBIENT) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

const K = {};

K.theStoreLivesInsideTheDevIsolatedRoot = (mod) => {
  const paths = iso.devPaths(iso.devDataRoot(WIN), WIN);
  const file = mod.capacityStorePath(paths.userData);
  assert.equal(file, 'C:\\Dunder\\MunderDevData\\userData\\capacity-observations.json', 'under MUNDER_DEV=1 the store is a child of the Dev userData, by name');
  for (const f of [file, `${file}.tmp`]) {
    assert.equal(iso.isInside(f, paths.userData, WIN), true, `${f} is INSIDE the Dev-isolated userData`);
    assert.equal(iso.isInside(f, DEV_ROOT, WIN), true, `${f} is INSIDE the Dev-isolated root`);
  }
};

K.theStoreCanNeverResolveOntoStableOrAProviderHome = (mod) => {
  const paths = iso.devPaths(iso.devDataRoot(WIN), WIN);
  const forbidden = [...iso.stableForbiddenPaths({ defaultUserData: STABLE_USERDATA, stableHarnessHome: STABLE_HARNESS_HOME, platform: WIN }), ...PROVIDER_HOMES];
  assert.ok(forbidden.length >= 7, 'precondition: the REAL guard\u2019s forbidden list, plus the provider homes');
  const file = mod.capacityStorePath(paths.userData);
  for (const bad of forbidden) {
    for (const f of [file, `${file}.tmp`]) {
      assert.equal(iso.isInside(f, bad, WIN), false, `THE STORE NEVER RESOLVES INSIDE ${bad}`);
      assert.equal(iso.isInside(bad, f, WIN), false, `and never CONTAINS ${bad}`);
    }
  }
  // The path is a function of its argument AND NOTHING ELSE: the environment a Stable agent
  // terminal exports, and the process's own home, must not be able to move it.
  // (The caller's `hermetic()` started this killer with all of these REMOVED and will restore them.)
  Object.assign(process.env, { APPDATA: 'C:\\Users\\FiercePC\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\FiercePC', HOME: 'C:\\Users\\FiercePC', CODEX_HOME: PROVIDER_HOMES[1], CLAUDE_CONFIG_DIR: PROVIDER_HOMES[0] });
  assert.equal(mod.capacityStorePath(paths.userData), file, 'NO ENVIRONMENT VARIABLE CAN MOVE THE STORE: same argument, same path');
  // And it follows its argument: Stable's userData in, Stable's file out. The isolation is
  // the ARGUMENT's - which is exactly why index.ts is pinned below.
  assert.equal(iso.isInside(mod.capacityStorePath(STABLE_USERDATA), STABLE_USERDATA, WIN), true);
};

for (const [name, killer] of Object.entries(K)) test(`capacity store isolation: ${name}`, () => hermetic(() => killer(REAL)));

// ---- EFFECT: a real write into a sandboxed userData -----------------------------------------
const T0 = 1_800_000_000_000;
const observation = () => ({
  poolKey: 'codex:acct-a:codex', provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s/a.jsonl', sourceSequence: 1,
  observedAt: T0, receivedAt: T0,
  windows: [{ windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300, usedPercent: 20, remainingPercent: 80, resetsAt: T0 + 3_600_000 }],
  providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus'
});
const tree = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name))).sort();

test('EFFECT: a real save writes exactly ONE file, inside the sandboxed userData, and leaves no temp sibling', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'l0-iso-'));
  const userData = path.join(sandbox, 'userData');
  const decoy = path.join(sandbox, 'stable-userData');
  fs.mkdirSync(userData); fs.mkdirSync(decoy);
  try {
    const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => T0, () => 0);
    assert.equal(tracker.ingest(observation()), true, 'precondition: the tracker ACCEPTED the reading (a rejected fixture would save nothing and prove nothing)');
    const store = new REAL.CapacityStore(REAL.capacityStorePath(userData), tracker, 5_000, () => T0);
    const saved = store.saveNow();
    assert.equal(saved.written, 1, 'precondition: one pool was written');
    assert.deepEqual(tree(sandbox), ['stable-userData', 'userData', path.join('userData', 'capacity-observations.json')].sort(),
      'THE WHOLE SANDBOX holds exactly one new file, in userData; the decoy beside it is untouched; no .tmp is left');
    const text = fs.readFileSync(path.join(userData, 'capacity-observations.json'), 'utf8');
    assert.ok(!text.includes(sandbox) && !/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(text), 'and the file itself carries no filesystem path');
    // Restart: a second store reads it back from the same place, and from nowhere else.
    const again = new ProviderCapacityTracker(L0_SEM_POLICY, () => T0 + 1, () => 1);
    assert.equal(new REAL.CapacityStore(REAL.capacityStorePath(userData), again, 5_000, () => T0 + 1).restore(), 1);
    assert.equal(new REAL.CapacityStore(REAL.capacityStorePath(decoy), again, 5_000, () => T0 + 1).restore(), 0, 'a store pointed elsewhere finds nothing: there is no second copy');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('EFFECT: a location that cannot be written is SURVIVED - nothing is written anywhere else instead', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'l0-iso-'));
  try {
    const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => T0, () => 0);
    tracker.ingest(observation());
    const missing = path.join(sandbox, 'no-such-dir', 'userData');
    const warn = console.warn; console.warn = () => {};
    try { assert.doesNotThrow(() => new REAL.CapacityStore(REAL.capacityStorePath(missing), tracker, 5_000, () => T0).saveNow()); }
    finally { console.warn = warn; }
    assert.deepEqual(tree(sandbox), [], 'NO FALLBACK LOCATION: a failed write creates no directory and no file - not here, and so not in a home or temp directory either');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

// ---- STATIC tripwires (a literal shape; see the header) -------------------------------------
test('STATIC: index.ts builds the store ONCE, from app userData through capacityStorePath, AFTER the Dev bootstrap repointed it', () => {
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.equal(index.split('new CapacityStore(').length - 1, 1, 'one store');
  const built = index.indexOf("new CapacityStore(\n  capacityStorePath(app.getPath('userData')),");
  assert.ok(built >= 0, 'built from app.getPath(\'userData\') through the one path function - no literal path, no join of its own');
  const repointed = index.indexOf("app.setPath('userData', paths.userData);");
  assert.ok(repointed >= 0 && repointed < built, 'and the MUNDER_DEV bootstrap repoints userData EARLIER in the file than the store is built');
  assert.equal(index.split('capacity-observations').length - 1, 0, 'the file name appears nowhere in index.ts: nobody can build a second path to it there');
  const persistence = codeOnly(readSource(SRC), 'capacityPersistence.ts');
  assert.ok(!/node:os|homedir|tmpdir|process\.env|getPath/.test(persistence),
    'capacityPersistence.ts knows no home directory, no temp directory, no environment and no Electron path: the only place it can write is the path it is handed');
});

test('STATIC: nothing else L0 added to production can create a file', () => {
  // The L0-added production modules, written out. Every one of them is checked for a
  // write; only the persistence module may have one. (READS of provider state - the Codex
  // rollout tail, the Claude status line - are not writes and are not isolation's subject.)
  const added = ['automaticSubmit.ts', 'automaticSubmitWiring.ts', 'capacityAdmission.ts', 'capacityEnvelope.ts', 'capacityNormalize.ts',
    'capacityNotify.ts', 'capacityRuntime.ts', 'capacityScope.ts', 'codexRolloutCapacity.ts', 'providerCapacityTracker.ts'].map((f) => `src/main/${f}`)
    .concat(['deliveryHold.ts', 'inputOrigin.ts', 'inputProvenance.ts', 'promptState.ts', 'providerCapacity.ts'].map((f) => `src/shared/${f}`))
    .concat(['src/renderer/src/components/inputOrigin.ts']);
  const WRITES = /writeFile|appendFile|createWriteStream|mkdirSync|mkdir\(|mkdtemp|renameSync|copyFile|symlink|localStorage|sessionStorage|indexedDB/;
  for (const f of added) assert.ok(!WRITES.test(codeOnly(readSource(f), f)), `${f} creates nothing on disk and stores nothing in the browser`);
  const persistence = codeOnly(readSource(SRC), 'capacityPersistence.ts');
  assert.deepEqual([...persistence.matchAll(/\b(writeFileSync|renameSync|unlinkSync)\(/g)].map((m) => m[1]), ['writeFileSync', 'renameSync', 'unlinkSync'],
    'and the persistence module writes in exactly one place: temp sibling, rename, and the clean-up of that sibling');
});

// ---- MUTANT CENSUS ----------------------------------------------------------------------------
const MUTANTS = [
  { name: 'the path built from the NON-isolated app data directory',
    edits: [['  return join(userData, CAPACITY_STORE_FILE);', "  return join(process.env.APPDATA || 'C:\\\\Users\\\\FiercePC\\\\AppData\\\\Roaming', 'munder-difflin', CAPACITY_STORE_FILE);"]],
    killer: 'theStoreLivesInsideTheDevIsolatedRoot', dies: /under MUNDER_DEV=1 the store is a child of the Dev userData/ },
  { name: 'the path escaping its userData by one level',
    edits: [['  return join(userData, CAPACITY_STORE_FILE);', "  return join(userData, '..', '..', 'hive', CAPACITY_STORE_FILE);"]],
    killer: 'theStoreLivesInsideTheDevIsolatedRoot', dies: /under MUNDER_DEV=1 the store is a child of the Dev userData/ },
  { name: 'an environment variable allowed to move the store',
    edits: [['  return join(userData, CAPACITY_STORE_FILE);', '  return join(process.env.CODEX_HOME || userData, CAPACITY_STORE_FILE);']],
    killer: 'theStoreCanNeverResolveOntoStableOrAProviderHome', dies: /NO ENVIRONMENT VARIABLE CAN MOVE THE STORE/ }
];
const MUTANT_DIR = path.join(__dirname, '.mutants-dev-isolation-capacity');

test('MUTANT CENSUS: every mutant applies exactly once, and dies at the assertion that names its guarantee', async (t) => {
  const source = readSource(SRC);
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, mutant] of MUTANTS.entries()) {
      await t.test(`mutant: ${mutant.name}`, () => {
        hermetic(() => K[mutant.killer](REAL));
        let text = source;
        for (const [from, to] of mutant.edits) {
          assert.equal(text.split(from).length - 1, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE`);
          text = text.replace(from, () => to);
        }
        text = text.replace(/from '\.\/(\w+)'/g, "from '../../src/main/$1'").replace(/from '\.\.\/shared\//g, "from '../../src/shared/");
        const file = path.join(MUTANT_DIR, `m${i}.ts`);
        fs.writeFileSync(file, text, 'utf8');
        const mod = loadTs(path.relative(path.resolve(__dirname, '..'), file));
        let died = null;
        try { hermetic(() => K[mutant.killer](mod)); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong assertion`);
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});

// ---- THE FILE RE-RUNS ITSELF under both ambient environments a validator can have ----------
const RERUN = 'L0_ISO_CAPACITY_RERUN';
const AMBIENTS = {
  'a CLAUDE-like session: the provider variables UNSET': { CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined },
  'a CODEX-like session: the provider variables set to HOSTILE paths INSIDE the hive': {
    CODEX_HOME: 'C:/Dunder/hive/agents/x/.codex', CLAUDE_CONFIG_DIR: 'C:/Dunder/hive/agents/x/.claude',
    APPDATA: 'C:/Dunder/hive/agents/x/AppData', HOME: 'C:/Dunder/hive/agents/x', USERPROFILE: 'C:/Dunder/hive/agents/x'
  }
};
for (const [label, vars] of Object.entries(AMBIENTS)) {
  test(`HERMETIC: this whole file passes, every mutant dying BY NAME, under ${label}`, (t) => {
    if (process.env[RERUN]) { t.skip('this IS the re-run'); return; }
    const env = { ...process.env, [RERUN]: '1' };
    delete env.NODE_TEST_CONTEXT; // set by the outer runner; a nested runner that inherits it reports nothing readable
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete env[k]; else env[k] = v; }
    const r = require('node:child_process').spawnSync(process.execPath, ['--test', __filename], { env, encoding: 'utf8' });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, `the file is NOT HERMETIC under ${label}:\n${out.split('\n').filter((l) => /not ok|error:/.test(l)).join('\n')}`);
    assert.match(out, /# fail 0/);
    assert.match(out, /# pass 10\b/, 'the 10 tests really ran in the child (2 re-run tests skip themselves there)');
  });
}
