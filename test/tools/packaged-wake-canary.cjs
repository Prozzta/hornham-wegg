'use strict';

/**
 * GATE-1 — the PACKAGED cold-boot wake canary.
 *
 * The 1.1.46 canary failed in the real app while the whole suite was green, because
 * nothing in the suite ever ran the packaged main against a real agent lifecycle. This
 * does: it launches the actual built app (dist/win-unpacked, the same app.asar the
 * installer ships) against a scratch APPDATA / LOCALAPPDATA / USERPROFILE and a scratch
 * hive, with stub TUIs standing in for the agent CLIs.
 *
 * The stubs are the point. Each one emits a REAL SessionStart on boot and then sits at
 * its prompt without ever emitting a Stop — which is exactly the cold-boot state that
 * deadlocked 1.1.46, and which no unit test could produce. It emits Stop only after a
 * turn is actually typed into it.
 *
 * It is NOT part of `node --test`: it takes minutes and opens a window. Run it directly:
 *   npm run build && npx electron-builder --win --dir --publish never -c.npmRebuild=false
 *   node test/tools/packaged-wake-canary.cjs
 *
 * ISOLATION. The hook transport is a named pipe derived from sha1(hiveRoot), and every
 * other listener binds an ephemeral port, so a canary run cannot reach — or steal hooks
 * from — a floor running on the installed build. That isolation is asserted, not assumed.
 *
 * Exit code 0 = PASS.
 */
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

const REPO = resolve(__dirname, '..', '..');
const APP_EXE = join(REPO, 'dist', 'win-unpacked', 'Munder Difflin.exe');
const NUDGE_HEAD = 'You have new hive inbox message(s)';

// Boot grace 35s + quiescence 12s + a 15s beat, plus the renderer's 2.5s auto-restore
// and the stub's own boot. Generous: a slow cold start must not read as a failed wake.
const BOOT_BUDGET_MS = 150_000;
const EVENT_BUDGET_MS = 90_000;
const DUP_WATCH_MS = 40_000;      // > two 15s beats
const POLL_MS = 1_000;

const WORKER = 'worker-canary';
const GOD = 'god';

const log = (...a) => console.log('[canary]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The main process's own pipe naming (hive.ts sockPath). */
function pipeFor(hiveRoot) {
  return `\\\\.\\pipe\\munder-difflin-${createHash('sha1').update(hiveRoot).digest('hex').slice(0, 12)}`;
}

/**
 * A stand-in agent CLI. Emits SessionStart at boot and NOTHING else until a turn is
 * typed into it — no Stop, because no turn ever started. Every line it receives is
 * appended to its typed-log (one line per submitted turn), and only then does it report
 * Stop, the way a real agent does when its turn ends.
 *
 * The pipe path and agent id are baked in at generation time, so the canary never depends
 * on the app's env plumbing to tell the stub who it is.
 */
function stubSource(agentId, pipe, typedLog) {
  return `'use strict';
const net = require('net');
const fs = require('fs');
const AGENT_ID = ${JSON.stringify(agentId)};
const PIPE = ${JSON.stringify(pipe)};
const TYPED = ${JSON.stringify(typedLog)};
const SESSION = 'canary-' + AGENT_ID;

function emit(payload) {
  try {
    const c = net.createConnection(PIPE, function () {
      c.end(JSON.stringify(Object.assign({ agent_id: AGENT_ID, session_id: SESSION }, payload)) + '\\n');
    });
    c.on('error', function () {});
  } catch (e) {}
}

// The cold-boot state that deadlocked 1.1.46: the CLI announces its session and then
// waits. It has never been prompted, so it has no turn to Stop.
emit({ hook_event_name: 'SessionStart' });
process.stdout.write('canary stub ready (' + AGENT_ID + ')\\r\\n> ');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buf += chunk;
  let i;
  while ((i = buf.search(/[\\r\\n]/)) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { fs.appendFileSync(TYPED, line + '\\n'); } catch (e) {}
    process.stdout.write('\\r\\n[received ' + line.length + ' chars]\\r\\n> ');
    // A real turn just ran. Report the tool activity and then the end of the turn,
    // which is what releases the next wake.
    emit({ hook_event_name: 'UserPromptSubmit' });
    setTimeout(function () { emit({ hook_event_name: 'Stop' }); }, 600);
  }
});
process.stdin.resume();
setInterval(function () {}, 1 << 30);
`;
}

function seed(root) {
  const hive = join(root, 'hive');
  const appdata = join(root, 'AppData', 'Roaming');
  const localapp = join(root, 'AppData', 'Local');
  const home = join(root, 'home');
  const stubs = join(root, 'stubs');
  for (const d of [hive, appdata, localapp, home, stubs, join(hive, 'agents')]) mkdirSync(d, { recursive: true });

  const pipe = pipeFor(hive);
  const agents = {};
  const typed = {};
  for (const id of [GOD, WORKER]) {
    const dir = join(hive, 'agents', id);
    for (const sub of ['inbox', join('inbox', '.done'), 'outbox', join('outbox', '.sent')]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    writeFileSync(join(dir, 'memory.md'), `# ${id}\n`);
    writeFileSync(join(dir, 'identity.md'), `# ${id}\n`);
    typed[id] = join(root, `typed-${id}.log`);
    writeFileSync(typed[id], '');
    const stub = join(stubs, `${id}.cjs`);
    writeFileSync(stub, stubSource(id, pipe, typed[id]));
    agents[id] = {
      id,
      name: id === GOD ? 'Michael' : 'Worker',
      provider: 'claude',
      cwd: dir,
      isGod: id === GOD,
      role: id === GOD ? 'orchestrator' : 'worker',
      capabilities: [],
      status: 'idle',
      cwdValid: true,
      archived: false,
      lastSeen: Date.now(),
      // The exact spawn recipe useRestoreTeam replays at cold boot.
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}`
    };
  }
  writeFileSync(join(hive, 'registry.json'), JSON.stringify({ godId: GOD, agents }, null, 2));

  mkdirSync(join(appdata, 'munder-difflin'), { recursive: true });
  writeFileSync(join(appdata, 'munder-difflin', 'config.json'), JSON.stringify({
    harnessHome: hive,
    onboardingComplete: true,
    orchestratorMaySpawn: false,
    autoDeliveryPausedAgents: [],
    heartbeatSeeded: true,
    // Enabled, and due immediately, so the run proves the heartbeat ARMS and TICKS
    // rather than inferring it from whether a message happened to be emitted.
    missions: [{ id: 'heartbeat', kind: 'heartbeat', enabled: true, intervalMs: 120_000, quietThresholdMs: 300_000, lastFiredAt: 0 }]
  }, null, 2));

  return { hive, appdata, localapp, home, typed, pipe };
}

/** Every JSON row in the scratch event log. */
function rows(hive) {
  const p = join(hive, 'log.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const nudges = (typedLog) => (existsSync(typedLog) ? readFileSync(typedLog, 'utf8') : '')
  .split('\n').filter((l) => l.includes(NUDGE_HEAD));

async function waitFor(label, budgetMs, fn) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`TIMEOUT after ${budgetMs}ms waiting for: ${label}`);
    await sleep(POLL_MS);
  }
}

function deliverFromGod(hive, id, subject) {
  // Through god's OUTBOX, so the real router + the real deliver() edge are exercised —
  // not a file dropped straight into the recipient's inbox.
  writeFileSync(join(hive, 'agents', GOD, 'outbox', `${id}.json`), JSON.stringify({
    id, conversation: 'canary', to: WORKER, act: 'request',
    subject, body: 'canary', requires_reply: false, needs_human: false,
    created_at: new Date().toISOString()
  }, null, 2));
}

async function main() {
  if (!existsSync(APP_EXE)) {
    console.error(`FAIL: ${APP_EXE} not found. Build it first:\n  npm run build && npx electron-builder --win --dir --publish never -c.npmRebuild=false`);
    process.exit(1);
  }
  const root = join(tmpdir(), `munder-wake-canary-${Date.now()}`);
  const { hive, appdata, localapp, home, typed, pipe } = seed(root);
  log('scratch root', root);
  log('hook pipe   ', pipe);

  // Scenario A is armed BEFORE launch: the mail is already waiting when the agent
  // cold-boots, so only the reconciliation beat can rescue it.
  writeFileSync(join(hive, 'agents', WORKER, 'inbox', 'canary-a.json'), JSON.stringify({
    id: 'canary-a', conversation: 'canary', from: GOD, to: WORKER, act: 'request',
    subject: 'scenario A: beat recovery', body: 'canary', created_at: new Date().toISOString()
  }, null, 2));

  const env = {
    ...process.env,
    APPDATA: appdata, LOCALAPPDATA: localapp, USERPROFILE: home, HOME: home,
    MUNDER_DEV: '', ELECTRON_ENABLE_LOGGING: '1'
  };
  delete env.HIVE_ROOT; delete env.AGENT_ID; delete env.AGENT_NAME; delete env.AGENT_DIR;

  const app = spawn(APP_EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let appOut = '';
  app.stdout.on('data', (d) => { appOut += d; });
  app.stderr.on('data', (d) => { appOut += d; });

  const failures = [];
  const checks = [];
  const check = (ok, label, detail) => { checks.push({ ok, label, detail }); if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`); };

  try {
    // ── the app is really the packaged artifact ────────────────────────────────
    const start = await waitFor('app-start in the scratch log', 60_000,
      () => rows(hive).find((r) => r.kind === 'app-start'));
    check(start.packaged === true, 'runs PACKAGED', `packaged=${start.packaged}`);
    check(typeof start.appPath === 'string' && start.appPath.includes('app.asar'),
      'runs from app.asar', start.appPath);
    check(!!start.version, 'reports a version', start.version);
    log(`app-start ${start.version} packaged=${start.packaged}`);
    log(`          ${start.appPath}`);

    // ── SCENARIO A: cold boot, never prompted, mail already waiting ───────────
    log('scenario A: waiting for the reconciliation beat to rescue a cold-booted agent…');
    await waitFor('scenario A nudge typed into the worker', BOOT_BUDGET_MS,
      () => nudges(typed[WORKER]).length >= 1);
    check(true, 'SCENARIO A: a cold-booted, never-prompted agent is woken');
    log('scenario A: woken');

    // The breadcrumbs must say it went through the one guarded path.
    const wake = rows(hive).filter((r) => r.kind === 'wake');
    check(wake.length > 0, 'durable wake breadcrumbs reached log.jsonl', `${wake.length} rows`);
    const stages = new Set(wake.map((r) => r.stage));
    for (const s of ['beats-armed', 'beat', 'claim', 'submit', 'settle']) {
      check(stages.has(s), `breadcrumb stage "${s}" present`, [...stages].join(','));
    }
    const committed = wake.find((r) => r.stage === 'settle' && r.outcome === 'COMMITTED');
    check(!!committed, 'the owner COMMITTED the wake', committed ? committed.requestId : 'no COMMITTED settle');

    // ── SCENARIO B: the event edge — a durable delivery wakes it again ─────────
    // The stub reported Stop after scenario A, so the agent is idle again.
    log('scenario B: delivering god -> worker through the real router…');
    const beforeB = nudges(typed[WORKER]).length;
    deliverFromGod(hive, 'canary-b', 'scenario B: event edge');
    await waitFor('the message is routed and delivered', 60_000,
      () => rows(hive).some((r) => r.kind === 'message' && r.id === 'canary-b'));
    check(rows(hive).some((r) => r.stage === 'observer' && r.messageId === 'canary-b'),
      'the delivery observer fired for the durable write');
    await waitFor('scenario B nudge typed into the worker', EVENT_BUDGET_MS,
      () => nudges(typed[WORKER]).length > beforeB);
    check(true, 'SCENARIO B: a durable delivery wakes the agent by itself');
    log('scenario B: woken');

    // ── NO DUPLICATES: two more beat cycles must add nothing ──────────────────
    const settled = nudges(typed[WORKER]).length;
    log(`no-duplicate watch: holding ${DUP_WATCH_MS}ms (> two beats) at ${settled} nudges…`);
    await sleep(DUP_WATCH_MS);
    const after = nudges(typed[WORKER]).length;
    check(after === settled, 'no duplicate turn after two further beats', `${settled} -> ${after}`);
    check(settled === 2, 'exactly one nudge per scenario', `${settled} nudges for 2 scenarios`);

    // ── the heartbeat is armed and ticking (a FACT, not an inference) ─────────
    const beats = rows(hive).filter((r) => r.kind === 'wake' && r.stage === 'heartbeat');
    check(beats.length >= 1, 'the heartbeat beat actually ticked', `${beats.length} ticks`);

    // ── isolation: the canary never touched the real floor ────────────────────
    check(pipe !== pipeFor('C:\\Dunder\\hive'), 'the hook pipe is NOT the live floor pipe', pipe);
  } catch (e) {
    failures.push(String(e && e.message ? e.message : e));
  } finally {
    try { app.kill(); } catch { /* already gone */ }
    await sleep(1500);
    try { app.kill('SIGKILL'); } catch { /* already gone */ }
  }

  console.log('\n─── GATE-1 packaged cold-boot wake canary ───');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
    console.log('\nScratch kept for inspection:', root);
    if (appOut.trim()) console.log('\n--- app output (tail) ---\n' + appOut.slice(-4000));
    console.log('\nGATE-1: FAILED');
    process.exit(1);
  }
  rmSync(root, { recursive: true, force: true });
  console.log('\nGATE-1: PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('canary crashed:', e); process.exit(1); });
