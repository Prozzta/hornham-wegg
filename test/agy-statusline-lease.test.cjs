'use strict';

/**
 * AGY 1.1.48 commit 2 - the lease on Antigravity's GLOBAL statusline setting.
 *
 * Design of record: agents/dwight-mu32ztys/agy-1.1.48-DESIGN.md section 2.2-2.3, with one
 * evidence-driven change: the setting is `statusLine: {type, command, enabled}` - an
 * OBJECT - not the scalar `statusline` the design described (agy 1.2.8 binary struct tag
 * `json:"statusLine"`, and Oscar's working measurement config). The protocol is unchanged.
 *
 * EVERY TEST HERE RUNS IN A SANDBOXED GEMINI HOME UNDER THE TEMP DIR. Nothing in this file
 * may touch the real ~/.gemini: the module takes the home as a parameter precisely so a
 * test never has to, and the census at the bottom pins that no test reaches for homedir().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  acquireStatuslineLease, reconcileStatuslineLease, releaseStatuslineLease, AgyStatuslineOwner,
  statuslinePaths, installedValueFor, sameValue, writeStatuslineLocator, removeStatuslineLocator,
  STATUSLINE_KEY, STATUSLINE_DIAGNOSTICS
} = loadTs('src/main/agyStatuslineOwnership.ts');

// ─── sandbox ────────────────────────────────────────────────────────────────

/** A throwaway Gemini home with an antigravity-cli directory, and optional settings. */
function sandbox(t, settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lease-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = statuslinePaths(home);
  fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
  if (settings !== undefined) {
    fs.writeFileSync(paths.settings, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  return { home, paths };
}

let tokenSeq = 0;
/** 32-hex tokens, distinct and predictable. */
const token = () => (++tokenSeq).toString(16).padStart(32, '0');

/**
 * One Munder process. `live` is the shared set of (pid) values the fake OS considers
 * alive; `ambiguous` pids answer 'ambiguous'. Each process gets a distinct pid.
 */
function proc(home, world, opts = {}) {
  const pid = opts.pid ?? world.nextPid++;
  const started = opts.startedAt ?? 1000 + pid;
  world.live.add(`${pid}:${started}`);
  const reports = [];
  const env = {
    geminiHome: home,
    commandFor: opts.commandFor ?? ((tok) => `"C:/node.exe" "C:/hive/bin/agy-statusline.cjs" --owner ${tok} --locator "C:/hive/state/x.json"`),
    pid,
    processStartedAt: started,
    now: () => world.clock,
    randomToken: token,
    liveness: (p, s) => {
      if (world.ambiguous.has(p)) return 'ambiguous';
      return world.live.has(`${p}:${s}`) ? 'live' : 'dead';
    },
    sleep: (ms) => { world.slept.push(ms); },
    report: (code) => reports.push(code),
    crashAt: opts.crashAt
  };
  return { pid, started, env, reports, die: () => world.live.delete(`${pid}:${started}`) };
}
const worldOf = () => ({ nextPid: 100, live: new Set(), ambiguous: new Set(), clock: 1_000_000, slept: [] });

const readSettings = (paths) => JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
const readJournal = (paths) => JSON.parse(fs.readFileSync(paths.journal, 'utf8'));
const exists = (p) => fs.existsSync(p);
/** The installed command for whichever token the journal records. */
const installed = (paths) => readJournal(paths).installedValue;

const USER_SETTINGS = {
  model: 'Gemini 3.8 Flash (High)',
  trustedWorkspaces: ['C:\\work\\one'],
  permissions: { allow: ['command(dir)'] },
  someFutureKey: { nested: [1, 2, { deep: true }] }
};

// ─── new ownership and clean restore ────────────────────────────────────────

test('NEW OWNERSHIP: installs an OBJECT at `statusLine`, touching no other key', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const w = worldOf();
  const a = proc(home, w);
  const r = acquireStatuslineLease(a.env);

  assert.equal(r.captureEnabled, true);
  assert.equal(r.code, 'owned');
  const s = readSettings(paths);
  assert.equal(STATUSLINE_KEY, 'statusLine', 'camelCase: the key agy 1.2.8 actually reads');
  assert.deepEqual(Object.keys(s[STATUSLINE_KEY]).sort(), ['command', 'enabled', 'type']);
  assert.equal(s[STATUSLINE_KEY].type, 'command');
  assert.equal(s[STATUSLINE_KEY].enabled, true);
  assert.match(s[STATUSLINE_KEY].command, new RegExp(`--owner ${r.token}`), 'the owner token is in the command');
  for (const k of Object.keys(USER_SETTINGS)) assert.deepEqual(s[k], USER_SETTINGS[k], `unrelated key ${k} unchanged`);

  const j = readJournal(paths);
  assert.equal(j.phase, 'owned');
  assert.deepEqual(j.prior, { present: false });
  assert.equal(j.leases.length, 1);
  assert.equal(j.leases[0].pid, a.pid);
  assert.ok(!('trustedWorkspaces' in j) && !JSON.stringify(j).includes('C:\\\\work'),
    'the journal holds the one property, never the whole settings document');
});

test('CLEAN RESTORE, absent prior: the key is DELETED, everything else survives', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  assert.equal(releaseStatuslineLease(a.env, r.leaseId), 'restored');
  const s = readSettings(paths);
  assert.ok(!(STATUSLINE_KEY in s), 'there was no statusLine before, so there is none after');
  assert.deepEqual(s, USER_SETTINGS);
  assert.ok(!exists(paths.journal), 'the journal is gone');
});

test('CLEAN RESTORE, a user OBJECT prior: restored exactly, fields and all', (t) => {
  const prior = { type: 'command', command: 'my-own-statusline --fancy', enabled: false, padding: 2 };
  const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: prior });
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  assert.deepEqual(readJournal(paths).prior, { present: true, value: prior });
  releaseStatuslineLease(a.env, r.leaseId);
  assert.deepEqual(readSettings(paths).statusLine, prior);
});

test('CLEAN RESTORE, a non-object prior (an older tool wrote a string): kept verbatim', (t) => {
  const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: 'legacy-scalar-command' });
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  releaseStatuslineLease(a.env, r.leaseId);
  assert.equal(readSettings(paths).statusLine, 'legacy-scalar-command');
});

test('NO SETTINGS FILE: installed into a new file, and restore removes only our key', (t) => {
  const { home, paths } = sandbox(t);
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  assert.equal(r.code, 'owned');
  releaseStatuslineLease(a.env, r.leaseId);
  assert.deepEqual(readSettings(paths), {});
});

test('NO ANTIGRAVITY DIRECTORY: nothing is created, nothing is owned', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lease-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  assert.deepEqual(r, { captureEnabled: false, code: 'skipped-no-agy' });
  assert.deepEqual(fs.readdirSync(home), [], 'a user who never ran AGY gets no directory from us');
});

// ─── crash table ────────────────────────────────────────────────────────────

/**
 * Crash at each boundary, then start a NEW process (the crashed one is dead) and quit it
 * cleanly. Whatever the crash point, the user must end up with EXACTLY their original value.
 */
const CRASHES = [
  ['before the journal (nothing written)', null, 'owned'],
  ['after the prepared journal', 'after-journal-prepared', 'self-healed'],
  ['after settings were replaced', 'after-settings-replaced', 'adopted'],
  ['after the journal was promoted', 'after-journal-owned', 'adopted'],
  ['during restore, before the journal was deleted', 'after-restore-write', 'owned']
];

for (const [label, step, expectedOnRestart] of CRASHES) {
  test(`CRASH ${label}: the next start recovers, and a clean quit restores the ORIGINAL value`, (t) => {
    const original = { type: 'command', command: 'users-own', enabled: true };
    const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: original });
    const w = worldOf();
    const crash = (at) => (s) => { if (s === at) throw new Error(`simulated crash at ${s}`); };

    const first = proc(home, w, { crashAt: step && step !== 'after-restore-write' ? crash(step) : undefined });
    if (step === 'after-restore-write') {
      const r = acquireStatuslineLease(first.env);
      first.env.crashAt = crash(step);
      assert.throws(() => releaseStatuslineLease(first.env, r.leaseId), /simulated crash/);
    } else if (step) {
      assert.throws(() => acquireStatuslineLease(first.env), /simulated crash/);
    }
    first.die();
    assert.ok(!exists(paths.lock), 'a crash inside the lock still releases it (finally)');

    const second = proc(home, w);
    const r2 = acquireStatuslineLease(second.env);
    assert.equal(r2.code, expectedOnRestart);
    assert.equal(r2.captureEnabled, true);
    assert.deepEqual(readJournal(paths).prior, { present: true, value: original },
      'the ORIGINAL prior survives the crash - never re-recorded as our own value');

    assert.equal(releaseStatuslineLease(second.env, r2.leaseId), 'restored');
    assert.deepEqual(readSettings(paths).statusLine, original);
    assert.ok(!exists(paths.journal));
  });
}

// ─── external edits ─────────────────────────────────────────────────────────

test('EXTERNAL EDIT while owned: quit NEVER restores over it (adopted-user-edit)', (t) => {
  const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: { type: 'command', command: 'orig', enabled: true } });
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  const edited = { ...readSettings(paths), statusLine: { type: 'command', command: 'the-users-new-choice', enabled: true } };
  const bytes = JSON.stringify(edited, null, 4);
  fs.writeFileSync(paths.settings, bytes);

  assert.equal(releaseStatuslineLease(a.env, r.leaseId), 'adopted-user-edit');
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), bytes, 'byte-for-byte untouched');
  assert.ok(!exists(paths.journal));
});

test('EXTERNAL EDIT seen before a spawn: relinquished, and capture STAYS OFF for the run', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const a = proc(home, worldOf());
  const owner = new AgyStatuslineOwner(a.env);
  assert.equal(owner.ensure(), true);
  const ours = installed(paths);

  fs.writeFileSync(paths.settings, JSON.stringify({ ...USER_SETTINGS, statusLine: { type: 'command', command: 'mine', enabled: true } }));
  assert.equal(owner.ensure(), false, 'the override is detected before the spawn');
  assert.ok(!exists(paths.journal), 'our lease is relinquished');

  // Even if the value later reads as ours again, this run does not take it back.
  fs.writeFileSync(paths.settings, JSON.stringify({ ...USER_SETTINGS, statusLine: ours }));
  const before = fs.readFileSync(paths.settings, 'utf8');
  assert.equal(owner.ensure(), false, 'once overridden, disabled for the rest of the run');
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), before, 'and nothing is written');
});

// The old AUTO-DISABLE test pinned the BUG Jim found: it read AGY's enabled:false rewrite
// as a user edit and deleted the journal, losing the user's prior statusline for good.
// See the FIX 1 tests at the end of this file for the corrected behaviour.

test('KEY ORDER is not an edit: agy rewriting the object in a different order is still ours', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  const v = readSettings(paths).statusLine;
  const reordered = { enabled: v.enabled, command: v.command, type: v.type };
  fs.writeFileSync(paths.settings, JSON.stringify({ statusLine: reordered, ...USER_SETTINGS }));
  assert.equal(reconcileStatuslineLease(a.env, r.leaseId), 'intact');
  assert.equal(releaseStatuslineLease(a.env, r.leaseId), 'restored');
  assert.ok(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!sameValue([1, 2], [2, 1]), 'array order is data, and still matters');
});

// ─── concurrent instances ───────────────────────────────────────────────────

test('TWO LIVE INSTANCES: the first quit keeps the value; the LAST quit restores it', (t) => {
  const original = 'users-own-scalar';
  const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: original });
  const w = worldOf();
  const a = proc(home, w);
  const b = proc(home, w);
  const ra = acquireStatuslineLease(a.env);
  const rb = acquireStatuslineLease(b.env);
  assert.equal(ra.code, 'owned');
  assert.equal(rb.code, 'adopted');
  assert.equal(rb.token, ra.token, 'one lease generation, one installed value');
  assert.equal(readJournal(paths).leases.length, 2);

  assert.equal(releaseStatuslineLease(a.env, ra.leaseId), 'released');
  assert.notEqual(readSettings(paths).statusLine, original, 'B still needs it');
  assert.equal(releaseStatuslineLease(b.env, rb.leaseId), 'restored');
  assert.equal(readSettings(paths).statusLine, original);
});

test('DEAD LEASE ADOPTION: an instance killed without quitting is pruned; the prior is kept', (t) => {
  const original = { type: 'command', command: 'before-munder', enabled: true };
  const { home, paths } = sandbox(t, { statusLine: original });
  const w = worldOf();
  const a = proc(home, w);
  acquireStatuslineLease(a.env);
  a.die(); // no release

  const b = proc(home, w);
  const rb = acquireStatuslineLease(b.env);
  assert.equal(rb.code, 'adopted');
  assert.deepEqual(readJournal(paths).leases.map((l) => l.pid), [b.pid], 'the dead lease is pruned');
  assert.equal(releaseStatuslineLease(b.env, rb.leaseId), 'restored');
  assert.deepEqual(readSettings(paths).statusLine, original);
});

test('PID REUSE, FAIL CLOSED: a lease whose pid is alive but unprovable withholds the restore', (t) => {
  // We cannot prove a live pid is still the Munder that took the lease. So it COUNTS as a
  // live lease: the last provable owner quits without restoring. Wrong direction would be
  // restoring the user's value out from under an instance that is still running.
  const { home, paths } = sandbox(t, { statusLine: 'orig' });
  const w = worldOf();
  const a = proc(home, w);
  const b = proc(home, w);
  acquireStatuslineLease(a.env);
  const rb = acquireStatuslineLease(b.env);
  a.die();
  w.ambiguous.add(a.pid); // the pid is back, as something we cannot identify
  assert.equal(releaseStatuslineLease(b.env, rb.leaseId), 'released');
  assert.notEqual(readSettings(paths).statusLine, 'orig', 'no restore under an ambiguous lease');
  assert.ok(exists(paths.journal), 'the journal remains for a later run to settle');
});

// ─── the lock ───────────────────────────────────────────────────────────────

test('LOCK held by a LIVE process: bounded wait, then lock-busy - no mutation', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const w = worldOf();
  const holder = proc(home, w);
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: holder.pid, processStartedAt: holder.started, createdAt: 0 }));
  const before = fs.readFileSync(paths.settings, 'utf8');
  const a = proc(home, w);
  const r = acquireStatuslineLease(a.env);
  assert.deepEqual(r, { captureEnabled: false, code: 'lock-busy' });
  assert.ok(w.slept.length > 0 && w.slept.length <= 20, `bounded: ${w.slept.length} waits`);
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), before);
  assert.ok(exists(paths.lock), 'a live holder\'s lock is never broken');
});

test('LOCK held by a DEAD process: pruned, and the acquire proceeds', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const w = worldOf();
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: 9999, processStartedAt: 1, createdAt: 0 }));
  const a = proc(home, w);
  assert.equal(acquireStatuslineLease(a.env).code, 'owned');
});

test('LOCK held by an AMBIGUOUS process, or unreadable: never broken, capture disabled', (t) => {
  for (const content of ['not json at all', JSON.stringify({ pid: 4242, processStartedAt: 1, createdAt: 0 })]) {
    const { home, paths } = sandbox(t, USER_SETTINGS);
    const w = worldOf();
    w.ambiguous.add(4242);
    fs.writeFileSync(paths.lock, content);
    const before = fs.readFileSync(paths.settings, 'utf8');
    const r = acquireStatuslineLease(proc(home, w).env);
    assert.deepEqual(r, { captureEnabled: false, code: 'lock-ambiguous' });
    assert.equal(fs.readFileSync(paths.settings, 'utf8'), before);
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), content, 'the lock is left exactly as found');
  }
});

// ─── malformed inputs and races ─────────────────────────────────────────────

test('MALFORMED SETTINGS: no mutation, no journal, one diagnostic', (t) => {
  for (const bad of ['{ "model": "x", ', '[1,2,3]', '"a string"', 'null']) {
    const { home, paths } = sandbox(t, bad);
    const a = proc(home, worldOf());
    assert.deepEqual(acquireStatuslineLease(a.env), { captureEnabled: false, code: 'malformed-settings' });
    assert.equal(fs.readFileSync(paths.settings, 'utf8'), bad, 'byte-for-byte');
    assert.ok(!exists(paths.journal));
    assert.deepEqual(a.reports, ['malformed-settings']);
  }
});

test('CORRUPT JOURNAL: quarantined for evidence, settings untouched', (t) => {
  for (const bad of ['{ not json', JSON.stringify({ schema: 2 }), JSON.stringify({ schema: 1, phase: 'owned', token: 'short' })]) {
    const { home, paths } = sandbox(t, USER_SETTINGS);
    fs.writeFileSync(paths.journal, bad);
    const before = fs.readFileSync(paths.settings, 'utf8');
    const a = proc(home, worldOf());
    assert.deepEqual(acquireStatuslineLease(a.env), { captureEnabled: false, code: 'corrupt-journal' });
    assert.equal(fs.readFileSync(paths.settings, 'utf8'), before);
    assert.ok(!exists(paths.journal));
    assert.ok(fs.readdirSync(path.dirname(paths.journal)).some((f) => f.includes('.corrupt-')),
      'moved aside, not destroyed');
  }
});

test('A JOURNAL FOR A VALUE THAT IS NOT OURS (and not the preimage): relinquished, not written', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const w = worldOf();
  const a = proc(home, w);
  acquireStatuslineLease(a.env);
  a.die();
  fs.writeFileSync(paths.settings, JSON.stringify({ ...USER_SETTINGS, statusLine: 'someone-else' }));
  const before = fs.readFileSync(paths.settings, 'utf8');
  const r = acquireStatuslineLease(proc(home, w).env);
  assert.deepEqual(r, { captureEnabled: false, code: 'external-override' });
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), before);
  assert.ok(!exists(paths.journal));
});

test('CAS: settings changing under us ONCE is retried from the new state', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  let calls = 0;
  const a = proc(home, worldOf(), {
    commandFor: (tok) => {
      // Runs between reading settings and writing them: the race window.
      if (calls++ === 0) fs.writeFileSync(paths.settings, JSON.stringify({ ...USER_SETTINGS, statusLine: 'raced-in' }));
      return `node shim --owner ${tok}`;
    }
  });
  const r = acquireStatuslineLease(a.env);
  assert.equal(r.code, 'owned');
  assert.deepEqual(readJournal(paths).prior, { present: true, value: 'raced-in' },
    'the prior is what was there when we actually wrote');
});

test('CAS: settings changing under us TWICE disables capture with no mutation', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  let n = 0;
  const a = proc(home, worldOf(), {
    commandFor: (tok) => {
      fs.writeFileSync(paths.settings, JSON.stringify({ ...USER_SETTINGS, statusLine: `race-${++n}` }));
      return `node shim --owner ${tok}`;
    }
  });
  assert.deepEqual(acquireStatuslineLease(a.env), { captureEnabled: false, code: 'cas-conflict' });
  assert.equal(readSettings(paths).statusLine, 'race-2', 'the other writer\'s value stands');
  assert.ok(!exists(paths.journal), 'no prepared journal is left behind');
});

// ─── the owner, and the locator ─────────────────────────────────────────────

test('OWNER: skipped-no-agy is NOT sticky - an AGY spawn later in the run can take the lease', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lease-late-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const owner = new AgyStatuslineOwner(proc(home, worldOf()).env);
  assert.equal(owner.ensure(), false);
  fs.mkdirSync(path.join(home, 'antigravity-cli')); // the first AGY spawn creates it
  assert.equal(owner.ensure(), true);
  assert.match(owner.ownerToken(), /^[0-9a-f]{32}$/);
  owner.release();
  owner.release(); // idempotent
});

test('LOCATOR: written atomically; removed only while its token still matches', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-locator-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state', 'agy-statusline-endpoint.json');
  writeStatuslineLocator(file, { sock: '\\\\.\\pipe\\x', pid: 1, processStartedAt: 2, token: 'a'.repeat(32), createdAt: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
    { schema: 1, sock: '\\\\.\\pipe\\x', pid: 1, processStartedAt: 2, token: 'a'.repeat(32), createdAt: 3 });
  removeStatuslineLocator(file, 'b'.repeat(32));
  assert.ok(exists(file), 'another lease generation\'s locator is not ours to remove');
  removeStatuslineLocator(file, 'a'.repeat(32));
  assert.ok(!exists(file));
});

test('DIAGNOSTICS: every report is a code from the closed set', (t) => {
  const { home } = sandbox(t, USER_SETTINGS);
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  releaseStatuslineLease(a.env, r.leaseId);
  assert.deepEqual(a.reports, ['owned', 'restored']);
  for (const c of a.reports) assert.ok(STATUSLINE_DIAGNOSTICS.includes(c));
});

test('THE SHAPE LIVES IN ONE PLACE: installedValueFor is the only statusLine constructor', () => {
  assert.deepEqual(installedValueFor('cmd'), { type: 'command', command: 'cmd', enabled: true });
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'agyStatuslineOwnership.ts'), 'utf8');
  assert.equal((codeOnly(src).match(/type: 'command'/g) ?? []).length, 1);
});

// ─── Jim's c2 audit (agents/jim-mtujpe28/agy-c1c2-AUDIT.md) ────────────────

const { buildStatuslineCommand, recoverStatuslineLeftovers, isOurs, isAutoDisabled,
  LOCK_ABANDONED_MS, LEASE_STALE_MS } = loadTs('src/main/agyStatuslineOwnership.ts');

/** AGY's own auto-disable: OUR object, rewritten with enabled:false. */
function agyAutoDisables(paths) {
  const s = readSettings(paths);
  s.statusLine = { ...s.statusLine, enabled: false };
  fs.writeFileSync(paths.settings, JSON.stringify(s, null, 2));
}
const PRIOR = { type: 'command', command: 'my-own-statusline.sh', enabled: true };

test('FIX 1: AGY auto-disable then release RESTORES the prior byte-for-byte, and names it', (t) => {
  const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: PRIOR });
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  agyAutoDisables(paths);
  assert.equal(releaseStatuslineLease(a.env, r.leaseId), 'restored', 'our command is ours, enabled or not');
  assert.deepEqual(readSettings(paths).statusLine, PRIOR, 'the user gets THEIR statusline back');
  assert.ok(a.reports.includes('agy-auto-disabled'), 'and the auto-disable is visible, not silent');
  assert.ok(!exists(paths.journal));
});

test('FIX 1: auto-disable then reconcile then release - capture goes off, but the prior is still owed', (t) => {
  const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: PRIOR });
  const owner = new AgyStatuslineOwner(proc(home, worldOf()).env);
  assert.equal(owner.ensure(), true);
  agyAutoDisables(paths);
  assert.equal(owner.ensure(), false, 'capture is off for the run');
  assert.equal(owner.ownerToken(), null, 'so the locator is withdrawn');
  assert.ok(owner.holdsLease(), 'but the lease is KEPT');
  assert.ok(exists(paths.journal), 'and so is the journal - the only copy of the prior');
  owner.release();
  assert.deepEqual(readSettings(paths).statusLine, PRIOR);
});

test('FIX 1: a REAL user edit - a DIFFERENT command - is still adopted untouched', (t) => {
  const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: PRIOR });
  const a = proc(home, worldOf());
  const r = acquireStatuslineLease(a.env);
  const s = readSettings(paths);
  s.statusLine = { type: 'command', command: 'their-brand-new-choice', enabled: false };
  const bytes = JSON.stringify(s, null, 3);
  fs.writeFileSync(paths.settings, bytes);
  assert.equal(releaseStatuslineLease(a.env, r.leaseId), 'adopted-user-edit');
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), bytes, 'byte-for-byte');
});

test('FIX 1: an auto-disabled leftover at acquire - prior given back FIRST, then a fresh lease', (t) => {
  const { home, paths } = sandbox(t, { statusLine: PRIOR });
  const w = worldOf();
  const a = proc(home, w);
  const ra = acquireStatuslineLease(a.env);
  agyAutoDisables(paths);
  a.die();
  const b = proc(home, w);
  const rb = acquireStatuslineLease(b.env);
  assert.equal(rb.code, 'owned', 'a new generation');
  assert.notEqual(rb.token, ra.token);
  assert.deepEqual(readJournal(paths).prior, { present: true, value: PRIOR },
    'the prior recorded is the USER\'s value - never our disabled command');
  assert.ok(b.reports.includes('agy-auto-disabled'));
  releaseStatuslineLease(b.env, rb.leaseId);
  assert.deepEqual(readSettings(paths).statusLine, PRIOR);
});

test('FIX 1: auto-disabled while another instance is live - no capture here, and that owner restores', (t) => {
  const { home, paths } = sandbox(t, { statusLine: PRIOR });
  const w = worldOf();
  const a = proc(home, w);
  const ra = acquireStatuslineLease(a.env);
  agyAutoDisables(paths);
  const b = proc(home, w);
  assert.deepEqual(acquireStatuslineLease(b.env), { captureEnabled: false, code: 'agy-auto-disabled' });
  assert.equal(releaseStatuslineLease(a.env, ra.leaseId), 'restored');
  assert.deepEqual(readSettings(paths).statusLine, PRIOR);
});

test('isOurs / isAutoDisabled: the command decides, not the flag - and only OUR command', () => {
  const ours = { type: 'command', command: 'node shim --owner abc', enabled: true };
  assert.ok(isOurs({ ...ours, enabled: false }, ours));
  assert.ok(isAutoDisabled({ ...ours, enabled: false }, ours));
  assert.ok(!isAutoDisabled(ours, ours), 'intact is not auto-disabled');
  assert.ok(!isOurs({ ...ours, command: 'node shim --owner xyz' }, ours), 'another generation is not ours');
  assert.ok(!isOurs('node shim --owner abc', ours), 'a scalar is not our object');
});

test('FIX 2: an EMPTY lock older than a minute is recovered as abandoned', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const w = worldOf();
  w.clock = Date.now();
  fs.writeFileSync(paths.lock, '');
  const old = (Date.now() - LOCK_ABANDONED_MS - 5_000) / 1000;
  fs.utimesSync(paths.lock, old, old);
  const a = proc(home, w);
  assert.equal(acquireStatuslineLease(a.env).code, 'owned', 'the wedge is gone');
  assert.ok(a.reports.includes('lock-abandoned-recovered'));
});

test('FIX 2: a FRESH empty lock still refuses - it may be a holder mid-write', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const w = worldOf();
  w.clock = Date.now();
  fs.writeFileSync(paths.lock, '');
  assert.deepEqual(acquireStatuslineLease(proc(home, w).env), { captureEnabled: false, code: 'lock-ambiguous' });
});

test('FIX 2: a failed holder write never leaves the lock behind', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const a = proc(home, worldOf(), { crashAt: (s) => { if (s === 'after-lock-open') throw new Error('disk full'); } });
  assert.throws(() => acquireStatuslineLease(a.env), /disk full/);
  assert.ok(!exists(paths.lock), 'no empty lock to wedge the next start');
});

test('FIX 3: a lease unseen for 24 h is pruned even though its pid still answers', (t) => {
  // The owner crashed and Windows recycled its pid: kill(pid, 0) says "alive" forever.
  const { home, paths } = sandbox(t, { statusLine: PRIOR });
  const w = worldOf();
  const a = proc(home, w);
  const b = proc(home, w);
  acquireStatuslineLease(a.env);
  const rb = acquireStatuslineLease(b.env);
  w.ambiguous.add(a.pid);                 // unprovable, not dead
  w.clock += LEASE_STALE_MS + 60_000;
  // b stays fresh by heartbeating; a never does.
  const j = readJournal(paths);
  j.leases = j.leases.map((l) => (l.id === rb.leaseId ? { ...l, lastSeen: w.clock } : l));
  fs.writeFileSync(paths.journal, JSON.stringify(j));
  assert.equal(releaseStatuslineLease(b.env, rb.leaseId), 'restored', 'the stale lease no longer withholds the restore');
  assert.ok(b.reports.includes('lease-stale-pruned'));
  assert.deepEqual(readSettings(paths).statusLine, PRIOR);
});

test('FIX 3: a heartbeat keeps a long-lived instance\'s lease alive', (t) => {
  const { home, paths } = sandbox(t, { statusLine: PRIOR });
  const w = worldOf();
  const a = proc(home, w);
  const b = proc(home, w);
  const ownerA = new AgyStatuslineOwner(a.env);
  assert.equal(ownerA.ensure(), true);
  const rb = acquireStatuslineLease(b.env);
  w.clock += LEASE_STALE_MS - 60_000;
  ownerA.heartbeat();                      // an hourly beat
  w.clock += 2 * 60_000;                   // now past 24 h since A's lease was taken
  assert.equal(releaseStatuslineLease(b.env, rb.leaseId), 'released', 'A is still there: no restore under it');
  assert.notDeepEqual(readSettings(paths).statusLine, PRIOR);
});

test('FIX 4: STARTUP TAKES NOTHING - no journal, nothing touched, nothing created', (t) => {
  const { home, paths } = sandbox(t, USER_SETTINGS);
  const before = fs.readFileSync(paths.settings, 'utf8');
  const listing = fs.readdirSync(path.dirname(paths.settings)).sort();
  assert.equal(recoverStatuslineLeftovers(proc(home, worldOf()).env), 'nothing-to-recover');
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.settings)).sort(), listing, 'not even a lock file');
});

test('FIX 4: STARTUP GIVES BACK a lease a dead run left installed (enabled or auto-disabled)', (t) => {
  for (const disable of [false, true]) {
    const { home, paths } = sandbox(t, { ...USER_SETTINGS, statusLine: PRIOR });
    const w = worldOf();
    const a = proc(home, w);
    acquireStatuslineLease(a.env);
    if (disable) agyAutoDisables(paths);
    a.die();
    assert.equal(recoverStatuslineLeftovers(proc(home, w).env), 'orphan-restored');
    assert.deepEqual(readSettings(paths).statusLine, PRIOR);
    assert.ok(!exists(paths.journal));
  }
});

test('FIX 4: a LIVE instance\'s lease is left alone at startup', (t) => {
  const { home, paths } = sandbox(t, { statusLine: PRIOR });
  const w = worldOf();
  acquireStatuslineLease(proc(home, w).env);
  const before = fs.readFileSync(paths.settings, 'utf8');
  assert.equal(recoverStatuslineLeftovers(proc(home, w).env), 'nothing-to-recover');
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), before);
});

test('FIX 4: released when the last AGY agent leaves, and leased again on the next spawn', (t) => {
  const { home, paths } = sandbox(t, { statusLine: PRIOR });
  const owner = new AgyStatuslineOwner(proc(home, worldOf()).env);
  assert.equal(owner.ensure(), true);
  owner.release();                                        // the last AGY agent left
  assert.deepEqual(readSettings(paths).statusLine, PRIOR, 'the user has it back at once');
  assert.equal(owner.ensure(), true, 'a later AGY spawn leases again');
  assert.notDeepEqual(readSettings(paths).statusLine, PRIOR);
});

test('QUOTING: the command is UNQUOTED, and any path agy would mangle refuses the lease', () => {
  // agy 1.2.9 passes quote characters literally: `-File '"C:/.../x.ps1"' ... Illegal characters in path`.
  assert.equal(buildStatuslineCommand('C:\\hive\\bin\\hive-node.cmd', 'C:\\hive\\bin\\agy-statusline.cjs', 'a'.repeat(32),
    'C:\\hive\\state\\agy-statusline-endpoint.json'),
    `C:\\hive\\bin\\hive-node.cmd C:\\hive\\bin\\agy-statusline.cjs --owner ${'a'.repeat(32)} --locator C:\\hive\\state\\agy-statusline-endpoint.json`);
  for (const bad of ['C:\\Program Files\\x.cmd', 'C:\\"quoted"\\x', "C:\\it's\\x", '', 'C:\\tab\there']) {
    assert.equal(buildStatuslineCommand(bad, 's', 't', 'l'), null, JSON.stringify(bad));
    assert.equal(buildStatuslineCommand('n', 's', 't', bad), null, JSON.stringify(bad));
  }
});

/** Source with comment lines removed, so a census counts code and not prose about it. */
function codeOnly(src) {
  return src.split('\n').filter((l) => {
    const s = l.trim();
    return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
  }).join('\n');
}

test('SANDBOX CENSUS: this file never reaches the real Gemini home', () => {
  // Everything ABOVE this test - the census must not match its own assertions.
  const me = fs.readFileSync(__filename, 'utf8');
  const code = codeOnly(me.slice(0, me.indexOf("test('SANDBOX CENSUS")));
  assert.ok(!/homedir\(/.test(code), 'no test may resolve the real home directory');
  assert.ok(!/geminiHome\(/.test(code), 'and none may call the production Gemini-home resolver');
  assert.ok(!/\.gemini/.test(code), 'nor name the real Gemini directory');
});
