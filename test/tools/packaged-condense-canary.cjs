/**
 * GATE-4 — the PACKAGED condensation canary (condense-abort-fix-DESIGN.md).
 *
 * The 1.1.47 fix is proven in units on a fake clock with a fake child. That proves the
 * protocol; it does not prove the LAUNCH BOUNDARY. Packaged Electron does not inherit a
 * login shell's PATH, the configured `claude` on Windows is usually an npm `.cmd` shim
 * that Node refuses to exec directly, and the packaged app uses the user's real home and
 * real Claude configuration. So this runs the SHIPPED artifact and asks for one real
 * condensation end to end.
 *
 * Two passes, per the design:
 *   1. an oversized fixture memory condenses: one `condense` row, NOT `condense-abort`,
 *      a smaller file, and a backup of the original;
 *   2. the same again while OTHER transcripts in the same Claude project namespace are
 *      being written continuously - the shared-directory condition that made v1.1.46
 *      capture another agent's summary. The result must be unaffected.
 *
 * ISOLATION. MUNDER_DEV=1 puts the harness home, userData and hook pipe under the fixed
 * dev root; the live floor's hive is never opened and no live memory.md is touched. The
 * dev root is borrowed and put back, under the same floor-wide canary lock as GATE-1, so
 * the two can never run at once.
 *
 *   npm run build && npx electron-builder --win --dir --publish never -c.npmRebuild=false
 *   node test/tools/packaged-condense-canary.cjs
 *
 * Exit code 0 = PASS.
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, readdirSync } = fs;
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const WebSocket = require('ws');
const lock = require('./canary-lock.cjs');

const REPO = resolve(__dirname, '..', '..');
const APP_EXE = join(REPO, 'dist', 'win-unpacked', 'Munder Difflin.exe');
const CDP_PORT = 9223;
const POLL_MS = 500;

const DEV_ROOT = 'C:\\Dunder\\MunderDevData';
const DEV_HIVE = join(DEV_ROOT, 'hive');
const DEV_USERDATA = join(DEV_ROOT, 'userData');
const DEV_ROSTER = join(DEV_ROOT, 'roster.json');
const DEV_LOCALSTORAGE = join(DEV_USERDATA, 'Local Storage');
const AGENT = 'condense-canary';

const results = [];
const log = (m) => console.log(`[condense-canary] ${m}`);
const ok = (label, detail) => results.push({ ok: true, label, detail });
const bad = (label, detail) => results.push({ ok: false, label, detail });
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPORT = join(REPO, 'dist', 'condense-canary-report.txt');
/** Synchronous, and to a file too: a report that only lives in a pipe can vanish. */
function emitReport(passed) {
  const lines = ['', '─── GATE-4 packaged condensation canary ───'];
  for (const r of results) lines.push(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  (${r.detail})` : ''}`);
  lines.push('', `GATE-4: ${passed ? 'PASSED' : 'FAILED'}`, '');
  const text = lines.join('\n');
  try { fs.writeSync(1, text); } catch { /* stdout gone */ }
  try { fs.writeFileSync(REPORT, text); } catch { /* disk gone */ }
}

// Nothing may end this run silently.
for (const sig of ['uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { bad(`no ${sig}`, String(e && e.stack ? e.stack.split(String.fromCharCode(10))[0] : e)); emitReport(false); process.exitCode = 1; });
}
process.on('exit', (code) => { try { fs.writeSync(2, `[condense-canary] exiting with ${code}\n`); } catch { /* ignore */ } });

// ─── the fixture memory: well over budget, in the canonical three-region shape ───

const PINNED = '## \u{1F4CC} Durable facts (pinned \u2014 never condensed)';
const CONDENSED = '## \u{1F5DC} Condensed history';
const RECENT = '## Recent';
const CANARY_PIN = '- pinned: this line must survive the condensation byte-for-byte';

function fixtureMemory() {
  const out = ['# condense canary memory', '', PINNED, CANARY_PIN, '', CONDENSED,
    `Earlier history of this agent. ${'It shipped a release and wrote it down. '.repeat(300)}`, '', RECENT];
  for (let i = 0; i < 40; i++) {
    out.push(`## 2026-09-${String((i % 28) + 1).padStart(2, '0')} standup ${i}`);
    out.push(`Worked item ${i}: ${'a long line of recorded detail that needs compacting. '.repeat(40)}`);
    out.push('');
  }
  return out.join('\n');
}

/** Claude's project directory for a cwd - the shared namespace v1.1.46 read from. */
function projectDirFor(cwd) {
  // transcript.ts projectKey: EVERY non-alphanumeric becomes a dash.
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

// ─── dev-root custody (identical contract to the wake canary) ───

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
    try { renameSync(bak, orig); } catch (e) { console.error(`[condense-canary] could not restore ${orig}:`, e.message); }
  }
}

function seed() {
  const dir = join(DEV_HIVE, 'agents', AGENT);
  mkdirSync(dir, { recursive: true });
  mkdirSync(DEV_USERDATA, { recursive: true });
  writeFileSync(join(dir, 'memory.md'), fixtureMemory());
  writeFileSync(join(dir, 'identity.md'), `# ${AGENT}\n`);
  writeFileSync(join(DEV_HIVE, 'registry.json'), JSON.stringify({ godId: AGENT, agents: {} }, null, 2));
  writeFileSync(join(DEV_USERDATA, 'config.json'), JSON.stringify({
    harnessHome: DEV_ROOT,
    onboardingComplete: true,
    orchestratorMaySpawn: false,
    // No autonomous loop: this canary drives reflectNow explicitly, so the only
    // condensation in the log is the one it asked for.
    reflect: { enabled: false, intervalMs: 3_600_000, byteTriggerPct: 50, sectionTrigger: 10, recentKeep: 5, minBytes: 1024 }
  }, null, 2));
  // No restorable agents: this gate needs no terminals, and spawning none keeps the run
  // to exactly one hidden child - the one under test.
  writeFileSync(DEV_ROSTER, JSON.stringify({
    version: 1, savedAt: Date.now(), agents: [], archived: [], restorable: [], queues: {}, selectedId: null
  }, null, 2));
  return join(dir, 'memory.md');
}

const rows = () => {
  const p = join(DEV_HIVE, 'log.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

async function waitFor(label, budgetMs, fn) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await sleep(POLL_MS);
  }
}

/** Hidden print-mode processes alive right now, as pid -> command line. Matched on OUR
 *  argv shape, so an ordinary agent's terminal cannot be mistaken for one. */
function hiddenChildren() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { C:/Dunder/_work/andy-rel147.Name -ne 'powershell.exe' -and $_.CommandLine -like '*--output-format*json*' -and $_.CommandLine -like '*--session-id*' } | ForEach-Object { $_.ProcessId.ToString() + ' <<>> ' + $_.CommandLine }"
    ], { encoding: 'utf8', timeout: 30_000 });
    const map = new Map();
    for (const line of out.split('\n')) {
      const [pid, cmd] = line.trim().split(' <<>> ');
      if (pid) map.set(pid, (cmd || '').slice(0, 200));
    }
    return map;
  } catch { return new Map(); }
}

/** A child still winding down a second after its stream closed is not a leak; one still
 *  there after the settle window is. Poll rather than sample once - the first run of
 *  this canary flagged a pid that had already exited by the time it was looked up. */
async function lingeringAfterSettle(before, settleMs = 20_000) {
  const until = Date.now() + settleMs;
  for (;;) {
    const left = new Map([...hiddenChildren()].filter(([pid]) => !before.has(pid)));
    if (!left.size || Date.now() > until) return left;
    await sleep(1000);
  }
}

// ─── CDP ───

async function attach() {
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(POLL_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* devtools not listening yet */ }
  }
  if (!page) throw new Error('no DevTools page target - could not drive the UI');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
  let id = 0;
  const send = (method, params) => new Promise((done) => {
    const msgId = ++id;
    const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === msgId) { ws.off('message', onMsg); done(m.result); } };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  await send('Runtime.enable', {});
  return { ws, send };
}

/** The app parks on the harness chooser until a config is OPENED. */
async function openTheConfig(send) {
  return waitFor('the config chooser to accept an open', 60_000, async () => {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const b = [...document.querySelectorAll('button,[role=button]')]
          .find(x => (x.textContent||'').trim().toLowerCase() === 'open');
        if (!b) return null;
        b.click();
        return 'clicked';
      })()`,
      returnByValue: true
    });
    return r && r.result ? r.result.value : null;
  });
}

async function reflect(send) {
  const r = await send('Runtime.evaluate', {
    expression: `window.cth.reflectNow(${JSON.stringify(AGENT)}).then(v => JSON.stringify(v), e => 'ERR ' + String(e))`,
    awaitPromise: true,
    returnByValue: true
  });
  const v = r && r.result ? r.result.value : null;
  if (typeof v !== 'string' || v.startsWith('ERR ')) throw new Error(`reflectNow failed: ${v}`);
  return JSON.parse(v);
}

function backupsFor() {
  const root = join(DEV_HIVE, 'backups');
  if (!existsSync(root)) return [];
  const found = [];
  for (const stamp of readdirSync(root)) {
    const p = join(root, stamp, AGENT, 'memory.md');
    if (existsSync(p)) found.push(p);
  }
  return found;
}

// ─── the two passes ───

async function pass(send, memPath, label, { decoys = false } = {}) {
  writeFileSync(memPath, fixtureMemory());
  const before = readFileSync(memPath, 'utf8');
  const abortsBefore = rows().filter((r) => r.kind === 'condense-abort').length;

  let stop = null;
  if (decoys) {
    // The v1.1.46 condition: OTHER sessions writing into the same Claude project
    // directory throughout, each newer than anything ours writes. The old selector took
    // the newest file here; the new path must not look at this directory at all.
    const dir = projectDirFor(DEV_ROOT);
    mkdirSync(dir, { recursive: true });
    let n = 0;
    const timer = setInterval(() => {
      const body = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '{"condensed":"ANOTHER AGENT SUMMARY - MUST NEVER BE USED","hoist":[]}' }] }
      });
      for (const who of ['god', 'jim', 'andy']) {
        try { writeFileSync(join(dir, `decoy-${who}-${n}.jsonl`), `${body}\n`); } catch { /* ignore */ }
      }
      n += 1;
    }, 250);
    stop = () => { clearInterval(timer); return dir; };
  }

  log(`${label}: asking the packaged app to condense ${Math.round(before.length / 1024)} KB...`);
  const t0 = Date.now();
  let out;
  try {
    out = await reflect(send);
  } finally {
    if (stop) stop();
  }
  const took = Math.round((Date.now() - t0) / 1000);
  const after = readFileSync(memPath, 'utf8');
  const condenseRows = rows().filter((r) => r.kind === 'condense' && r.agentId === AGENT);
  const aborts = rows().filter((r) => r.kind === 'condense-abort');

  check(Array.isArray(out) && out.length === 1 && out[0].condensed === true,
    `${label}: reflectNow reports a CONDENSE`, JSON.stringify(out));
  check(aborts.length === abortsBefore,
    `${label}: no condense-abort`, `${aborts.length - abortsBefore} new${aborts.length ? ` (${aborts.map((a) => a.reason).join(',')})` : ''}`);
  check(condenseRows.length >= 1, `${label}: a condense row reached log.jsonl`, `${condenseRows.length} row(s), ${took}s`);
  check(after.length < before.length, `${label}: memory.md got smaller`,
    `${before.length} -> ${after.length} bytes`);
  check(after.includes(CANARY_PIN), `${label}: the pinned line survived byte-for-byte`);
  check(backupsFor().length >= 1, `${label}: the original was backed up`, backupsFor().slice(-1)[0] || 'none');
  check(!after.includes('MUST NEVER BE USED') && !after.includes('ANOTHER AGENT'),
    `${label}: no other session's text reached this memory`);
  return after;
}

async function main() {
  if (!existsSync(APP_EXE)) {
    console.error(`FAIL: ${APP_EXE} not found. Build it first:\n  npm run build && npx electron-builder --win --dir --publish never -c.npmRebuild=false`);
    process.exit(1);
  }
  const stamp = Date.now();
  try {
    lock.acquire(DEV_ROOT);
  } catch (e) {
    if (e.canaryLocked) { console.error(`\n[condense-canary] REFUSING TO START\n\n${e.message}\n`); process.exit(2); }
    throw e;
  }
  const moved = stashDevRoot(stamp);
  lock.noteStash(DEV_ROOT, moved.map(([, bak]) => bak));
  if (moved.length) log(`stashed ${moved.length} existing dev path(s); they are restored at the end`);

  const before = hiddenChildren();
  let app = null;
  let ws = null;
  let failed = false;
  let decoyDir = null;
  try {
    const memPath = seed();
    app = spawn(APP_EXE, [`--remote-debugging-port=${CDP_PORT}`], {
      env: { ...process.env, MUNDER_DEV: '1' },
      stdio: 'ignore',
      windowsHide: false,
      // Its own process group: the app's Windows quit sweep kills TREES on purpose, and
      // the canary must never be inside one it asked for.
      detached: true
    });
    app.unref();
    log('packaged app launched (MUNDER_DEV=1)');

    const cdp = await attach();
    ws = cdp.ws;
    await openTheConfig(cdp.send);
    log('config opened');

    // Prove it is the 1.1.47 artifact, not a stale build or the live install. The app
    // writes one app-start row per launch; that row is the authoritative statement.
    const start = await waitFor('the app-start row', 60_000, () => rows().find((r) => r.kind === 'app-start') || null);
    check(start.packaged === true, 'runs PACKAGED', `packaged=${start.packaged}`);
    check(start.version === '1.1.47', 'the artifact reports 1.1.47', `version=${start.version}`);

    await pass(cdp.send, memPath, 'PASS 1 (quiet)');
    await pass(cdp.send, memPath, 'PASS 2 (other transcripts changing)', { decoys: true });
    decoyDir = projectDirFor(DEV_ROOT);

    const left = await lingeringAfterSettle(before);
    check(left.size === 0, 'no hidden print-mode child outlived the run',
      left.size ? [...left].map(([pid, cmd]) => pid + ': ' + cmd).join(' | ') : 'none');
  } catch (e) {
    failed = true;
    bad('the canary ran to completion', e.message);
  }

  // Emitted here, BEFORE any teardown: the first run lost its whole report to whatever
  // ended the process during cleanup, which is the one moment a report has to survive.
  const passed = results.every((r) => r.ok) && !failed;
  emitReport(passed);

  try { ws?.close(); } catch { /* already closed */ }
  // ONLY the handle we spawned. A taskkill by image name would also match the LIVE
  // floor app, which has the same executable name, and /T would take its whole tree -
  // the agents and the shell that started this run. Ask the app to quit, then insist.
  if (app) { try { app.kill(); } catch { /* gone */ } }
  await sleep(2500);
  if (app) { try { app.kill('SIGKILL'); } catch { /* gone */ } }
  await sleep(1000);
  // The decoys are ours and live in the DEV root’s own project namespace; clear them.
  if (decoyDir && existsSync(decoyDir)) {
    for (const f of readdirSync(decoyDir)) {
      if (f.startsWith('decoy-')) { try { rmSync(join(decoyDir, f), { force: true }); } catch { /* ignore */ } }
    }
  }

  if (passed) {
    restoreDevRoot(moved);
    lock.release(DEV_ROOT);
  } else {
    // Leave the evidence in place and say exactly what is displaced, like GATE-1 does.
    lock.release(DEV_ROOT, { dirty: true, stashed: moved.map(([, bak]) => bak) });
    try { fs.writeSync(2, `\nThe dev root is deliberately NOT restored so the failure can be read.\n${moved.map(([o, b]) => `  ${b}  ->  ${o}`).join('\n')}\n`); } catch { /* ignore */ }
  }
  process.exitCode = passed ? 0 : 1;
}

main().catch((e) => { console.error('[condense-canary] crashed:', e); process.exit(1); });
