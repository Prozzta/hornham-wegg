'use strict';

/**
 * GATE-1 — the PACKAGED cold-boot wake canary.
 *
 * The 1.1.46 canary failed in the real app while the whole suite was green, because
 * nothing in the suite ever ran the packaged main against a real agent lifecycle. This
 * does: it launches the actual built app (dist/win-unpacked — the same app.asar the
 * installer ships) with stub TUIs standing in for the agent CLIs.
 *
 * THE STUBS ARE THE POINT. Each one emits a REAL SessionStart on boot and then sits at its
 * prompt without ever emitting a Stop — exactly the cold-boot state that deadlocked
 * 1.1.46, and a state no unit test can produce. It emits Stop only once a turn has
 * actually been typed into it.
 *
 * ISOLATION. It runs the packaged exe under MUNDER_DEV=1 — the project's own audited dev
 * isolation (devIsolation.ts), which moves userData, the harness home, the single-instance
 * lock and the hook pipe off Stable's, and REFUSES TO START if any resolved path overlaps.
 * Overriding APPDATA is not enough on Windows: Electron resolves userData through the
 * shell's known-folder API rather than the env var, and simply fails to boot. MUNDER_DEV=1
 * changes neither `app.isPackaged`, nor the asar, nor one line of the wake path — the run
 * is still the shipped artifact. The dev root is FIXED by that contract (the env override
 * was removed at Dwight's audit), so the canary borrows it and puts back what was there.
 *
 * EXCLUSIVE FLOOR-WIDE. Because that dev root is fixed, only one canary may run anywhere at
 * a time; a second would stash the first one's stash. A lockfile enforces it (canary-lock.cjs),
 * and a FAILED run keeps the lock marked dirty so the next run refuses rather than burying
 * the evidence it deliberately left behind. CANARY_FORCE=1 overrides.
 *
 * NOT part of `node --test`: it takes minutes and opens a window. Run it directly:
 *   npm run build && npx electron-builder --win --dir --publish never -c.npmRebuild=false
 *   node test/tools/packaged-wake-canary.cjs
 *
 * Exit code 0 = PASS.
 */
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } = require('node:fs');
const { join, resolve } = require('node:path');
const WebSocket = require('ws');
const lock = require('./canary-lock.cjs');

const REPO = resolve(__dirname, '..', '..');
const APP_EXE = join(REPO, 'dist', 'win-unpacked', 'Munder Difflin.exe');
const NUDGE_HEAD = 'You have new hive inbox message(s)';

// devIsolation.ts: the dev root is fixed by the mission contract (no env override).
const DEV_ROOT = 'C:\\Dunder\\MunderDevData';
const DEV_HIVE = join(DEV_ROOT, 'hive');
const DEV_USERDATA = join(DEV_ROOT, 'userData');
const DEV_ROSTER = join(DEV_ROOT, 'roster.json');
// The renderer's roster mirror prefers localStorage and falls back to roster.json. A
// previous run's empty localStorage would win over the seed, so it is stashed too.
const DEV_LOCALSTORAGE = join(DEV_USERDATA, 'Local Storage');
const LIVE_HIVE = 'C:\\Dunder\\hive';

// Boot grace 35s + quiescence 12s + a 15s beat, on top of the renderer's 2.5s auto-restore
// and the stub's own boot. Generous: a slow cold start must not read as a failed wake.
const BOOT_BUDGET_MS = 180_000;
const EVENT_BUDGET_MS = 90_000;
const DUP_WATCH_MS = 40_000;      // longer than two 15s beats
/** How long the worker stub stays mid-turn after a prompt — a long silent tool. */
const MID_TURN_MS = 45_000;
/** How long to watch, mid-turn, for a wake that must NOT happen (> two beats + quiescence). */
const D3_WATCH_MS = 30_000;
const POLL_MS = 1_000;
/** DevTools port, so the canary can get past the config chooser the way a human does. */
const CDP_PORT = 9333;

const WORKER = 'worker-canary';
const GOD = 'god';

const log = (...a) => console.log('[canary]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The main process's own pipe naming (hive.ts sockPath), including the dev marker. */
function pipeFor(hiveRoot, dev) {
  const id = createHash('sha1').update(hiveRoot).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\munder-difflin-${dev ? 'dev-' : ''}${id}`;
}

/**
 * A stand-in agent CLI. Emits SessionStart at boot and NOTHING else until a turn is typed
 * into it — no Stop, because no turn ever started. Each line it receives is appended to
 * its typed-log, and only then does it report the turn, the way a real agent does.
 *
 * The pipe path and agent id are baked in at generation time, so the stub never depends on
 * the app's env plumbing to know who it is.
 */
function stubSource(agentId, pipe, typedLog, stopDelayMs) {
  return `'use strict';
const net = require('net');
const fs = require('fs');
const AGENT_ID = ${JSON.stringify(agentId)};
const PIPE = ${JSON.stringify(pipe)};
const TYPED = ${JSON.stringify(typedLog)};
const SESSION = 'canary-' + AGENT_ID;
const STOP_DELAY_MS = ${Number(stopDelayMs) || 600};

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
    // A real turn just ran: report the prompt, then — after STOP_DELAY_MS, which stands in
    // for a long silent tool — the end of the turn, which is what releases the next wake.
    emit({ hook_event_name: 'UserPromptSubmit' });
    setTimeout(function () { emit({ hook_event_name: 'Stop' }); }, STOP_DELAY_MS);
  }
});
process.stdin.resume();
setInterval(function () {}, 1 << 30);
`;
}

/** Move anything already in the dev root aside, so a real dev session is never eaten. */
function stashDevRoot(stamp) {
  const moved = [];
  for (const p of [DEV_HIVE, join(DEV_USERDATA, 'config.json'), DEV_ROSTER, DEV_LOCALSTORAGE]) {
    if (!existsSync(p)) continue;
    const bak = `${p}.canary-bak-${stamp}`;
    renameSync(p, bak);
    moved.push([p, bak]);
  }
  return moved;
}

function restoreDevRoot(moved) {
  for (const [orig, bak] of moved) {
    try { rmSync(orig, { recursive: true, force: true }); } catch { /* nothing there */ }
    try { renameSync(bak, orig); } catch (e) { console.error(`[canary] could not restore ${orig}:`, e.message); }
  }
}

function seed(stubsDir) {
  mkdirSync(join(DEV_HIVE, 'agents'), { recursive: true });
  mkdirSync(DEV_USERDATA, { recursive: true });
  mkdirSync(stubsDir, { recursive: true });

  const pipe = pipeFor(DEV_HIVE, true);
  const agents = {};
  const typed = {};
  for (const id of [GOD, WORKER]) {
    const dir = join(DEV_HIVE, 'agents', id);
    for (const sub of ['inbox', join('inbox', '.done'), 'outbox', join('outbox', '.sent')]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    writeFileSync(join(dir, 'memory.md'), `# ${id}\n`);
    writeFileSync(join(dir, 'identity.md'), `# ${id}\n`);
    typed[id] = join(stubsDir, `typed-${id}.log`);
    writeFileSync(typed[id], '');
    const stub = join(stubsDir, `${id}.cjs`);
    // The worker holds its Stop, so the canary gets a REAL mid-turn window to prove D3 in.
    writeFileSync(stub, stubSource(id, pipe, typed[id], id === WORKER ? MID_TURN_MS : 600));
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
  writeFileSync(join(DEV_HIVE, 'registry.json'), JSON.stringify({ godId: GOD, agents }, null, 2));

  // hive.root() is <harnessHome>/hive, and MUNDER_DEV clamps the home to the dev root.
  writeFileSync(join(DEV_USERDATA, 'config.json'), JSON.stringify({
    harnessHome: DEV_ROOT,
    onboardingComplete: true,
    orchestratorMaySpawn: false,
    autoDeliveryPausedAgents: [],
    heartbeatSeeded: true,
    // Enabled and due immediately, so the run proves the heartbeat ARMS and TICKS rather
    // than inferring it from whether a message happened to be emitted.
    missions: [{ id: 'heartbeat', kind: 'heartbeat', enabled: true, intervalMs: 120000, quietThresholdMs: 300000, lastFiredAt: 0 }]
  }, null, 2));

  // The renderer restores its team from this mirror 2.5s after boot, through its OWN
  // spawn path — real terminal, real xterm, real prompt/input-state reporting. That
  // matters: the submit owner's READY gate and final revalidation are fail-closed on
  // those, so a headless PTY would fail the canary for reasons that are not the wake path.
  const restorable = Object.values(agents).map((a) => ({
    id: a.id,
    name: a.name,
    character: 'jim',
    accent: 'sky',
    description: 'canary stub',
    project: 'canary',
    tmuxTarget: '',
    cwd: a.cwd,
    status: 'idle',
    action: 'reconnecting…',
    progress: 0,
    ptyId: `pty-${a.id}`,
    command: a.command,
    provider: 'claude',
    role: a.role,
    isGod: a.isGod,
    currentStation: 'desk',
    archived: false
  }));
  writeFileSync(DEV_ROSTER, JSON.stringify({
    version: 1, savedAt: Date.now(), agents: [], archived: [], restorable, queues: {}, selectedId: null
  }, null, 2));

  return { pipe, typed };
}

/** Every JSON row in the dev event log. */
function rows() {
  const p = join(DEV_HIVE, 'log.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const nudges = (typedLog) => (existsSync(typedLog) ? readFileSync(typedLog, 'utf8') : '')
  .split('\n').filter((l) => l.includes(NUDGE_HEAD));

async function waitFor(label, budgetMs, fn) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`TIMEOUT after ${budgetMs}ms waiting for: ${label}`);
    await sleep(POLL_MS);
  }
}

/** Through god's OUTBOX, so the real router and the real deliver() edge are exercised —
 *  not a file dropped straight into the recipient's inbox. */
function deliverFromGod(id, subject) {
  writeFileSync(join(DEV_HIVE, 'agents', GOD, 'outbox', `${id}.json`), JSON.stringify({
    id, conversation: 'canary', to: WORKER, act: 'request',
    subject, body: 'canary', requires_reply: false, needs_human: false,
    created_at: new Date().toISOString()
  }, null, 2));
}


/**
 * A fresh profile opens on the harness-config chooser, and nothing — not the roster
 * restore, not a single spawn — happens until a config is actually OPENED. That is a real
 * step a human performs, so the canary performs it too, through the real UI, rather than
 * faking its way past it. Everything after this point is the app doing its own work.
 */
async function openTheConfig() {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(POLL_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* devtools not listening yet */ }
  }
  if (!page) throw new Error('no DevTools page target — could not drive the UI');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
  let id = 0;
  const send = (method, params) => new Promise((done) => {
    const msgId = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === msgId) { ws.off('message', onMsg); done(m.result); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  await send('Runtime.enable', {});

  // Click the chooser's "open" for the CURRENT config (the dev root we seeded).
  const clicked = await waitFor('the config chooser to accept an open', 60_000, async () => {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const b = [...document.querySelectorAll('button,[role=button]')]
          .find(x => (x.textContent||'').trim().toLowerCase() === 'open');
        if (!b) return 'no-button';
        b.click();
        return 'clicked';
      })()`,
      returnByValue: true
    });
    const v = r && r.result ? r.result.value : null;
    return v === 'clicked' ? v : null;
  });
  ws.close();
  return clicked;
}

async function main() {
  if (!existsSync(APP_EXE)) {
    console.error(`FAIL: ${APP_EXE} not found. Build it first:\n  npm run build && npx electron-builder --win --dir --publish never -c.npmRebuild=false`);
    process.exit(1);
  }
  const stamp = Date.now();
  const stubsDir = join(REPO, 'dist', `canary-stubs-${stamp}`);

  // BEFORE anything is moved: one canary at a time, floor-wide.
  try {
    lock.acquire(DEV_ROOT);
  } catch (e) {
    if (e.canaryLocked) { console.error(`
[canary] REFUSING TO START

${e.message}
`); process.exit(2); }
    throw e;
  }
  const moved = stashDevRoot(stamp);
  lock.noteStash(DEV_ROOT, moved.map(([, bak]) => bak));
  if (moved.length) log(`stashed ${moved.length} existing dev path(s); they are restored at the end`);

  const { pipe, typed } = seed(stubsDir);
  log('dev hive  ', DEV_HIVE);
  log('hook pipe ', pipe);

  // Scenario A is armed BEFORE launch: the mail is already waiting when the agent cold-
  // boots, so only the reconciliation path can rescue it.
  writeFileSync(join(DEV_HIVE, 'agents', WORKER, 'inbox', 'canary-a.json'), JSON.stringify({
    id: 'canary-a', conversation: 'canary', from: GOD, to: WORKER, act: 'request',
    subject: 'scenario A: cold-boot recovery', body: 'canary', created_at: new Date().toISOString()
  }, null, 2));

  const env = { ...process.env, MUNDER_DEV: '1', ELECTRON_ENABLE_LOGGING: '1' };
  for (const k of ['HIVE_ROOT', 'AGENT_ID', 'AGENT_NAME', 'AGENT_DIR', 'HIVE_SOCK']) delete env[k];

  const app = spawn(APP_EXE, [`--remote-debugging-port=${CDP_PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let appOut = '';
  app.stdout.on('data', (d) => { appOut += d; });
  app.stderr.on('data', (d) => { appOut += d; });

  const failures = [];
  const checks = [];
  const check = (ok, label, detail) => {
    checks.push({ ok, label, detail });
    if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    check(pipe !== pipeFor(LIVE_HIVE, false), 'the hook pipe is NOT the live floor pipe', pipe);

    // ── it really is the packaged artifact ─────────────────────────────────────
    const start = await waitFor('app-start in the dev log', 90_000,
      () => rows().find((r) => r.kind === 'app-start'));
    check(start.packaged === true, 'runs PACKAGED', `packaged=${start.packaged}`);
    check(typeof start.appPath === 'string' && start.appPath.includes('app.asar'),
      'runs from app.asar', start.appPath);
    check(!!start.version, 'reports a version', start.version);
    log(`app-start ${start.version} packaged=${start.packaged}`);
    log(`          ${start.appPath}`);

    await openTheConfig();
    log('config opened; the app restores its team from here on its own');

    // ── SCENARIO A: cold boot, never prompted, mail already waiting ───────────
    log('scenario A: waiting for a cold-booted, never-prompted agent to be woken…');
    await waitFor('scenario A nudge typed into the worker', BOOT_BUDGET_MS,
      () => nudges(typed[WORKER]).length >= 1);
    check(true, 'SCENARIO A: a cold-booted, never-prompted agent IS woken');
    log('scenario A: woken');

    const wake = rows().filter((r) => r.kind === 'wake');
    check(wake.length > 0, 'durable wake breadcrumbs reached log.jsonl', `${wake.length} rows`);
    const stages = new Set(wake.map((r) => r.stage));
    for (const s of ['beats-armed', 'beat', 'claim', 'submit', 'settle']) {
      check(stages.has(s), `breadcrumb stage "${s}" present`, [...stages].join(','));
    }
    const committed = wake.find((r) => r.stage === 'settle' && r.outcome === 'COMMITTED');
    check(!!committed, 'the owner COMMITTED the wake', committed ? committed.requestId : 'no COMMITTED settle');

    // ── SCENARIO B + D3 BOTH WAYS, in the packaged app ───────────────────────
    // Scenario A's nudge started a turn, and the worker stub holds its Stop for
    // MID_TURN_MS. So this delivery lands while a turn is genuinely running — the exact
    // situation D3 exists for. It must be OBSERVED and CLAIMED BY NOBODY until Stop, and
    // then delivered. Nothing is mocked: real router, real hooks, real owner, real Enter.
    log('scenario B + D3: delivering god -> worker MID-TURN through the real router…');
    const beforeB = nudges(typed[WORKER]).length;
    deliverFromGod('canary-b', 'scenario B: event edge, delivered mid-turn');
    await waitFor('the message is routed and delivered', 60_000,
      () => rows().some((r) => r.kind === 'message' && r.id === 'canary-b'));
    check(rows().some((r) => r.kind === 'wake' && r.stage === 'observer' && r.messageId === 'canary-b'),
      'the delivery observer fired for the durable write');

    // D3, the safety direction: no typing into a live turn, through two beats.
    log(`D3: watching ${D3_WATCH_MS}ms for a wake that must NOT happen…`);
    await sleep(D3_WATCH_MS);
    const midTurn = nudges(typed[WORKER]).length;
    check(midTurn === beforeB, 'D3: a live turn is NEVER typed into, however long it is silent',
      `${beforeB} -> ${midTurn}`);
    const refusals = rows().filter((r) => r.kind === 'wake' && r.stage === 'no-claim'
      && r.agentId === WORKER && String(r.why).startsWith('lifecycle-active'));
    check(refusals.length > 0, 'D3: and the refusal names the live turn as the reason',
      refusals.length ? String(refusals[refusals.length - 1].why) : 'no lifecycle-active refusal');

    // D3, the liveness direction: Stop releases it, and the mail is delivered after all.
    await waitFor('scenario B nudge typed once the turn ends', EVENT_BUDGET_MS,
      () => nudges(typed[WORKER]).length > beforeB);
    check(true, 'SCENARIO B: a durable delivery wakes the agent once its turn ENDS');
    log('scenario B + D3: held mid-turn, delivered after Stop');

    // ── NO DUPLICATES: two more beat cycles must add nothing ─────────────────
    const settled = nudges(typed[WORKER]).length;
    log(`no-duplicate watch: holding ${DUP_WATCH_MS}ms (> two beats) at ${settled} nudges…`);
    await sleep(DUP_WATCH_MS);
    const after = nudges(typed[WORKER]).length;
    check(after === settled, 'no duplicate turn after two further beats', `${settled} -> ${after}`);
    check(settled === 2, 'exactly one nudge per scenario', `${settled} nudges for 2 scenarios`);

    // ── the heartbeat is armed and ticking (a FACT, not an inference) ─────────
    const beats = rows().filter((r) => r.kind === 'wake' && r.stage === 'heartbeat');
    check(beats.length >= 1, 'the heartbeat beat actually ticked', `${beats.length} ticks`);
  } catch (e) {
    failures.push(String(e && e.message ? e.message : e));
  } finally {
    try { app.kill(); } catch { /* already gone */ }
    await sleep(2000);
    try { app.kill('SIGKILL'); } catch { /* already gone */ }
    await sleep(500);
  }

  const failed = failures.length > 0;
  if (failed) {
    // Keep the evidence where it is; a failed canary is a thing to read, not to tidy.
    // The lock stays, marked DIRTY and naming the stash, so the next run refuses to bury it.
    lock.release(DEV_ROOT, { dirty: true, stashed: moved.map(([, bak]) => bak) });
    log('dev root LEFT IN PLACE for inspection:', DEV_HIVE);
    log('stubs + typed logs:', stubsDir);
    log('lock kept DIRTY — the next canary run will refuse until the .canary-bak paths are restored');
  } else {
    try { rmSync(DEV_HIVE, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(join(DEV_USERDATA, 'config.json'), { force: true }); } catch { /* best effort */ }
    try { rmSync(DEV_ROSTER, { force: true }); } catch { /* best effort */ }
    try { rmSync(DEV_LOCALSTORAGE, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(stubsDir, { recursive: true, force: true }); } catch { /* best effort */ }
    restoreDevRoot(moved);
    lock.release(DEV_ROOT);
  }

  console.log('\n─── GATE-1 packaged cold-boot wake canary ───');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
  if (failed) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
    if (moved.length) console.log(`\nNOTE: ${moved.length} stashed dev path(s) were NOT restored (suffix .canary-bak-${stamp}).`);
    if (appOut.trim()) console.log('\n--- app output (tail) ---\n' + appOut.slice(-4000));
    console.log('\nGATE-1: FAILED');
    process.exit(1);
  }
  console.log('\nGATE-1: PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('canary crashed:', e); process.exit(1); });
