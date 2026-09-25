'use strict';

/**
 * Semantic memory must not be stuck on "getting ready" until the app restarts.
 *
 * start() runs once at boot and bails when mempalace isn't on PATH. Installing
 * it afterwards — the usual order, since the settings panel is where you learn
 * you need it — left nothing to re-invoke start(), so the mine loop never ran,
 * the palace (created by the first mine) never appeared, and the pill read
 * "On — getting ready…" forever while `available` correctly read true.
 *
 * The status poll notices the install, so the poll is what arms the loop.
 * `bin()` is stubbed here because the real one probes the machine's PATH, which
 * would make the outcome depend on whether the developer happens to have
 * mempalace installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

/** A manager over an empty temp home whose CLI resolution we control. */
function managerWithCli(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-'));
  const state = { bin: opts.bin ?? null, enabled: opts.enabled !== false };
  const memory = new MemoryManager(() => home, () => ({ enabled: state.enabled, model: 'minilm' }));
  memory.bin = () => state.bin; // the real one shells out to `which mempalace`
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { memory, state, home };
}

/** The mine loop is armed exactly when its interval handle exists. */
const armed = (memory) => memory.mineTimer !== null;

test('a poll before mempalace is installed reports "not available" and arms nothing', (t) => {
  const { memory } = managerWithCli(t);

  const status = memory.refresh();

  assert.equal(status.available, false);
  assert.equal(status.active, false);
  assert.equal(armed(memory), false);
});

test('a poll AFTER mempalace appears arms the mine loop that boot had to skip', (t) => {
  const { memory, state } = managerWithCli(t);

  memory.start();                    // boot: mempalace not installed yet
  assert.equal(armed(memory), false, 'nothing to start');

  state.bin = '/fake/bin/mempalace'; // the user installs it while the app runs
  const status = memory.refresh();

  assert.equal(status.available, true);
  assert.equal(status.active, true);
  assert.equal(armed(memory), true, 'this is what left the pill on "getting ready" forever');
});

test('polling again never starts a second mine loop', (t) => {
  const { memory } = managerWithCli(t, { bin: '/fake/bin/mempalace' });

  memory.refresh();
  const first = memory.mineTimer;
  memory.refresh();
  memory.refresh();

  assert.equal(memory.mineTimer, first, 'the palace permits a single writer — one loop only');
});

test('memory turned off in settings stays off however often it is polled', (t) => {
  const { memory } = managerWithCli(t, { bin: '/fake/bin/mempalace', enabled: false });

  const status = memory.refresh();

  assert.equal(status.available, true, 'the CLI is there…');
  assert.equal(status.enabled, false, '…but the user said no');
  assert.equal(armed(memory), false);
});

test('daemonless MemPalace exposes compatibility mining without disabling search', (t) => {
  const { memory } = managerWithCli(t, { bin: '/fake/bin/mempalace' });

  memory.daemonUnavailable = 'MemPalace has no daemon: using one-shot mining; upgrade to 3.7.1 or newer for the low-cost daemon';
  const status = memory.status();

  assert.equal(status.active, true, 'the available CLI still supports recall');
  assert.equal(status.miningMode, 'one-shot');
  assert.match(status.miningWarning, /one-shot mining/);
});

test('a diagnosed old daemon logs once and routes the mature job through one-shot mining', async (t) => {
  const { memory, home } = managerWithCli(t, { bin: '/fake/bin/mempalace' });
  const dir = path.join(home, 'hive', 'agents', 'old-cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), 'remember this');
  fs.writeFileSync(path.join(home, 'hive', 'registry.json'), JSON.stringify({ agents: { 'old-cli': {} } }));
  memory.mineState = { version: 1, entries: {} };
  memory.ensureDaemon = async () => false;
  let oneShots = 0;
  memory.mineOneShot = async () => { oneShots += 1; return true; };
  const messages = [];
  const originalError = console.error;
  console.error = (message) => messages.push(message);
  t.after(() => { console.error = originalError; });
  memory.markDaemonUnavailable('MemPalace has no daemon: using one-shot mining; upgrade to 3.7.1 or newer for the low-cost daemon');
  memory.markDaemonUnavailable('same diagnosis must not log twice');
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  await memory.mineNow();
  now += 60_000;
  await memory.mineNow();

  assert.equal(messages.length, 1, 'compatibility warning is one-time');
  assert.equal(oneShots, 1, 'changed memory is not silently lost on an old CLI');
});
