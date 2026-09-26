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
 *   3b. (1.1.47 re-cut) the god SHAPE - a ~355 KB multi-bullet section at a non-oldest
 *      position in ~1 MB - converges under budget; the splitter must be seen to run.
 *   0. a ~1.1 MB backlog DIGS OUT across passes and ends under budget, with every
 *      single pass inside the prompt cap; and an UNFITTABLE memory is refused BY NAME
 *      (prompt-too-large) without spending an API call. Added after 1.1.47 shipped:
 *      this gate passed 18/18 on a 90 KB fixture while the floor held 430-944 KB files.
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

/** Mirrors reflect.ts. If either moves there, this gate must be re-read, not
 *  re-baselined - these are the numbers it exists to certify. */
const BUDGET_BYTES = 131_072;
const MAX_PROMPT_BYTES = 300_000;

/**
 * How big the dig-out fixture is.
 *
 * WHY IT IS THIS BIG NOW. Until 1.1.47 this gate used 40 small sections - about 90 KB -
 * and passed 18/18 while the real floor files were 430 KB, 601 KB and 944 KB. It
 * certified a size the floor does not have, so it could not see the defect that took
 * the release down: a prompt past the model's context window, refused with
 * 'prompt_too_long'. 110 sections is ~1.1 MB, at or above the largest real memory
 * observed (god's, 944,234 B on 2026-09-23).
 *
 * Lower it with CANARY_SECTIONS for a quick local run - but a RELEASE run uses the
 * default, because a gate that is cheaper than production is the bug this is fixing.
 */
const BACKLOG_SECTIONS = Number(process.env.CANARY_SECTIONS || 110);

function fixtureMemory(sectionCount = BACKLOG_SECTIONS) {
  const out = ['# condense canary memory', '', PINNED, CANARY_PIN, '', CONDENSED,
    `Earlier history of this agent. ${'It shipped a release and wrote it down. '.repeat(300)}`, '', RECENT];
  for (let i = 0; i < sectionCount; i++) {
    out.push(`## 2026-09-${String((i % 28) + 1).padStart(2, '0')} standup ${i}`);
    out.push(`Worked item ${i}: ${'a long line of recorded detail that needs compacting. '.repeat(190)}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * A memory whose OLDEST section alone is larger than one call may carry.
 *
 * A '## ' section is atomic - splitting one would put half a thought in the summary and
 * orphan the other half - so this input can never be condensed, at any size limit. The
 * only correct behaviour is to say so BY NAME and spend no API call. Before 1.1.47 the
 * equivalent input was discovered by spending the call and reading back 'claude exited 1'.
 */
function overflowMemory() {
  const giant = 'an indivisible wall of recorded detail. '.repeat(Math.ceil(MAX_PROMPT_BYTES / 39) + 500);
  const out = ['# condense canary memory', '', PINNED, CANARY_PIN, '', CONDENSED,
    'Earlier history of this agent.', '', RECENT];
  // PASS 3a: the giant goes FIRST (oldest) followed by EXACTLY reflectRecentKeep (12)
  // sections, so it is the ONLY evictable unit. Two ways to get this wrong, both lived:
  //  - fewer followers than recentKeep: every section is kept, evict is empty, and the
  //    gate reports 'nothing-to-evict' - a pass for the wrong reason;
  //  - more followers than recentKeep: since the 1.1.47 re-cut fix a single oversized
  //    LINE is passed over and the fittable sections behind it ARE condensed, so the
  //    'refused, byte-identical' assertions would fail (Jim's spec 3.6).
  out.push('## 2026-09-01 the indivisible one', giant, '');
  for (let i = 0; i < 12; i++) {
    out.push(`## 2026-09-${String((i % 27) + 2).padStart(2, '0')} standup ${i}`);
    out.push(`Worked item ${i}: ${'ordinary detail. '.repeat(50)}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * PASS 3b: the SHAPE of god's memory on 2026-09-23 - the case that blocked the 1.1.47
 * canary. A multi-bullet `## ` section of ~355 KB (larger than a whole pass may carry)
 * at the THIRD-oldest position among ~1 MB of ordinary sections. Before the fix the
 * planner stopped at it, the tiny pass ahead of it failed the whole-file not-smaller
 * rule, and the file could never move. Synthetic on purpose: an agent's real memory is
 * never a gate fixture.
 */
function godShapeMemory() {
  const out = ['# condense canary memory', '', PINNED, CANARY_PIN, '', CONDENSED,
    'Earlier history of this agent.', '', RECENT];
  for (let i = 0; i < 480; i++) {
    if (i === 2) {
      out.push('## 2026-09-10 11:25 Mission 2 COMPLETE');
      for (let b = 0; b < 312; b++) out.push(`- mission bullet ${b}: ${'a recorded finding with its evidence. '.repeat(29)}`);
      out.push('');
      continue;
    }
    out.push(`## 2026-09-${String((i % 28) + 1).padStart(2, '0')} note ${i}`);
    out.push(`Entry ${i}: ${'routine standup detail. '.repeat(55)}`);
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
    // FLAT keys, because that is what index.ts reads (`c.reflectRecentKeep ?? 12`).
    // This canary previously seeded a nested `reflect: { ... }` object, which the app
    // never looks at - so every setting here was inert. The "no autonomous loop"
    // guarantee below was fiction: the gate was relying on the 30-minute default
    // interval not happening to fire inside a two-minute run. It got the right answer
    // for the wrong reason, which is the kind of thing this file exists to catch.
    reflectEnabled: false,          // no autonomous loop: this canary drives reflectNow itself
    reflectIntervalMs: 3_600_000,
    reflectByteTriggerPct: 50,
    reflectSectionTrigger: 10,
    reflectRecentKeep: 12,          // pinned to the production default, not left to drift
    reflectMinBytes: 1024
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
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.CommandLine -like '*--output-format*json*' -and $_.CommandLine -like '*--session-id*' } | ForEach-Object { $_.ProcessId.ToString() + ' <<>> ' + $_.CommandLine }"
    ], { encoding: 'utf8', timeout: 30_000 });
    const map = new Map();
    for (const line of out.split('\n')) {
      const [pid, cmd] = line.trim().split(' <<>> ');
      if (pid) map.set(pid, (cmd || '').slice(0, 200));
    }
    return map;
  } catch (e) {
    // NOT an empty Map. An empty Map is indistinguishable from "nothing is running",
    // which is how a probe that had been broken for three runs kept reporting all-clear.
    throw new Error(`the lingering-child probe could not run: ${e && e.message ? e.message : e}`);
  }
}

/**
 * PROVE THE PROBE BEFORE TRUSTING IT.
 *
 * hiddenChildren() reads a PowerShell filter, and a filter that matches nothing answers
 * every question with "all clear". That is not hypothetical: this file shipped with
 * `$_.Name` replaced by a filesystem path, because the line was written through a shell
 * that expanded it. PowerShell treats the result as an unknown command - a NON-terminating
 * error - so the probe returned empty on every call and three consecutive runs reported
 * "no lingering child" having looked for nothing. Jim caught it with a decoy.
 *
 * So: spawn a decoy carrying the exact argv shape, require the probe to FIND it, and kill
 * it again. If this fails, the run fails - an unproven probe is worse than no probe,
 * because it reads as evidence.
 */
async function proveProbe() {
  const marker = 'canary-probe-self-test-' + process.pid;
  // The decoy must carry our argv shape AND survive long enough to be seen. It runs a
  // FILE, not `node -e`: everything after a script path is script arguments, whereas
  // after `-e` node still parses `--output-format` as its own option, rejects it with
  // "bad option" and exits instantly - a decoy that is never alive would make this
  // self-test fail for a reason that has nothing to do with the probe.
  const decoyJs = join(REPO, 'dist', `canary-probe-decoy-${process.pid}.js`);
  mkdirSync(join(REPO, 'dist'), { recursive: true });
  writeFileSync(decoyJs, 'setTimeout(() => {}, 120000);\n');
  const decoy = spawn(process.execPath, [decoyJs, '--output-format', 'json', '--session-id', marker],
    { stdio: 'ignore', windowsHide: true, detached: true });
  try {
    const found = await waitFor('the probe to see its own decoy', 30_000, async () => {
      const hit = [...hiddenChildren()].find(([, cmd]) => cmd.includes(marker));
      return hit ? hit[0] : null;
    }).catch(() => null);
    check(!!found, 'the lingering-child probe actually detects a child', found ? `found decoy pid ${found}` : 'THE PROBE IS BLIND - every clear result below is meaningless');
    return !!found;
  } finally {
    try { process.kill(decoy.pid); } catch { /* already gone */ }
    // Do not leave our own decoy behind to be found by the real check.
    await waitFor('the decoy to exit', 15_000, async () => ![...hiddenChildren()].some(([, c]) => c.includes(marker)) || null).catch(() => null);
    try { rmSync(decoyJs, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * The pids in `root`'s process tree, `root` included.
 *
 * WHY THIS EXISTS. hiddenChildren() matches `claude --print` ANYWHERE ON THE MACHINE,
 * which is right for proving the probe can see (the decoy below is a child of the
 * CANARY, not of the app) and wrong for deciding who leaked. On a floor where the
 * INSTALLED app is running, its own condensation children are born mid-run, so they
 * are absent from the `before` snapshot and get attributed to this canary - a FALSE
 * product finding on a gate whose comment invites you to believe it. Observed
 * 2026-09-24: two live children of
 * `%LOCALAPPDATA%\Programs\Munder Difflin\Munder Difflin.exe` failed this check while
 * the canary's own app, under dist\win-unpacked, had leaked nothing.
 *
 * An orphan whose parent is already gone is deliberately NOT claimed: its
 * ParentProcessId points at a dead pid that Windows may have reused, so attributing it
 * would be a guess. The app is still alive when this runs, so a child it leaked is
 * still reachable through it.
 */
function treeOf(root) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.ParentProcessId.ToString() }"
  ], { encoding: 'utf8', timeout: 30_000 });
  const parent = new Map();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(' ');
    if (pid) parent.set(pid, ppid);
  }
  const tree = new Set([String(root)]);
  // Repeat to a fixed point: Win32_Process is not ordered parents-first.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of parent) {
      if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; }
    }
  }
  return tree;
}

/**
 * PROVE THE TREE FILTER BEFORE TRUSTING IT, in both directions.
 *
 * Narrowing the leak check to the app's tree is what stops a FALSE product finding -
 * and a narrowing that matches nothing would make the check blind, which is the same
 * failure proveProbe() exists to catch, one level down. So: spawn a decoy in the argv
 * shape, parented to the CANARY rather than to the app, and require that the probe
 * SEES it (not blind) while the app's tree REFUSES it (not machine-wide). One decoy
 * answers both questions, because only a filter that discriminates can pass both.
 */
async function proveTreeFilter(appPid) {
  const marker = 'canary-tree-filter-self-test-' + process.pid;
  const decoyJs = join(REPO, 'dist', `canary-tree-decoy-${process.pid}.js`);
  mkdirSync(join(REPO, 'dist'), { recursive: true });
  writeFileSync(decoyJs, 'setTimeout(() => {}, 120000);\n');
  const decoy = spawn(process.execPath, [decoyJs, '--output-format', 'json', '--session-id', marker],
    { stdio: 'ignore', windowsHide: true, detached: true });
  try {
    const seen = await waitFor('the probe to see the tree-filter decoy', 30_000, async () => {
      const hit = [...hiddenChildren()].find(([, cmd]) => cmd.includes(marker));
      return hit ? hit[0] : null;
    }).catch(() => null);
    check(!!seen, 'tree filter: the probe still SEES a decoy anywhere on the machine',
      seen ? `decoy pid ${seen}` : 'THE PROBE IS BLIND - the leak check below proves nothing');
    check(!!seen && !treeOf(appPid).has(seen),
      "tree filter: and the app's tree REFUSES a decoy it did not father",
      seen ? `decoy ${seen} not in the tree of app ${appPid}` : 'no decoy to test with');
  } finally {
    try { process.kill(decoy.pid); } catch { /* already gone */ }
    await waitFor('the tree-filter decoy to exit', 15_000,
      async () => ![...hiddenChildren()].some(([, c]) => c.includes(marker)) || null).catch(() => null);
    try { rmSync(decoyJs, { force: true }); } catch { /* ignore */ }
  }
}

/** A child still winding down a second after its stream closed is not a leak; one still
 *  there after the settle window is. Poll rather than sample once - the first run of
 *  this canary flagged a pid that had already exited by the time it was looked up.
 *  Scoped to `appPid`'s tree: see treeOf() for why machine-wide is a false alarm. */
async function lingeringAfterSettle(before, appPid, settleMs = 20_000) {
  const until = Date.now() + settleMs;
  for (;;) {
    const tree = treeOf(appPid);
    const left = new Map([...hiddenChildren()]
      .filter(([pid]) => !before.has(pid) && tree.has(pid)));
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

async function pass(send, memPath, label, { decoys = false, make = fixtureMemory, digOut = false } = {}) {
  writeFileSync(memPath, make());
  const before = readFileSync(memPath, 'utf8');
  const backupsBefore = new Set(backupsFor());
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
  if (digOut) {
    // THE 1.1.47 REGRESSION, stated as two assertions. One call cannot carry a backlog
    // this size, so the file has to walk down across passes - and it has to ARRIVE.
    const passes = Array.isArray(out) && out[0] ? out[0].passes : 0;
    check(passes > 1, `${label}: took MORE THAN ONE pass to dig out`, `passes=${passes}`);
    check(after.length <= BUDGET_BYTES, `${label}: ended UNDER budget`,
      `${before.length} -> ${after.length} bytes (budget ${BUDGET_BYTES})`);
    const big = condenseRows.filter((r) => typeof r.promptBytes === 'number' && r.promptBytes > MAX_PROMPT_BYTES);
    check(big.length === 0, `${label}: EVERY pass stayed inside the ${MAX_PROMPT_BYTES} B cap`,
      big.length ? big.map((r) => r.promptBytes).join(',') : `max ${Math.max(0, ...condenseRows.map((r) => r.promptBytes || 0))} B`);
  }
  check(backupsFor().length >= 1, `${label}: the original was backed up`, backupsFor().slice(-1)[0] || 'none');
  // "A backup exists" is not "the ORIGINAL was backed up" - on a multi-pass run the check
  // above happily prints the LAST pass's backup (Jim N2). This pass's FIRST backup must be
  // the pre-image, byte for byte: that is what a lost-memory recovery would reach for.
  const firstOfThisPass = backupsFor().filter((b) => !backupsBefore.has(b) && /-p1[\\/]/.test(b));
  check(firstOfThisPass.length === 1 && readFileSync(firstOfThisPass[0], 'utf8') === before,
    `${label}: this pass's FIRST backup (-p1) is the pre-image byte-for-byte`, firstOfThisPass[0] || 'none');
  check(!after.includes('MUST NEVER BE USED') && !after.includes('ANOTHER AGENT'),
    `${label}: no other session's text reached this memory`);

  // fix3 (1.1.47 blocker) — NO MODEL-AUTHORED `## ` REACHED THE FILE.
  //
  // Jim's T5 asked for the stub to carry a `## ` heading in one pass, but this gate calls
  // the REAL model: what it emits cannot be dictated, so a seeded heading is not a thing
  // this canary can assert. The INVARIANT is model-independent and is exactly what god's
  // live abort violated, so it is checked on EVERY pass instead of one: the condensed
  // region must contain no `## ` line at all. A model-authored heading there does not
  // render - it ENDS the region and spills the rest into recent, which is the
  // recent-count-mismatch that blocked the release. If the model emitted one, the
  // sanitizer demoted it and this still holds; if the sanitizer were removed, the pass
  // above would already have failed with an abort, and this says why.
  const condensedRegion = (() => {
    const i = after.indexOf(CONDENSED);
    if (i < 0) return null;
    const rest = after.slice(i + CONDENSED.length);
    const j = rest.indexOf('\n## ');
    return j < 0 ? rest : rest.slice(0, j);
  })();
  const stray = (condensedRegion ?? '').split('\n').filter((l) => l.startsWith('## '));
  check(condensedRegion !== null && stray.length === 0,
    `${label}: no model-authored '## ' heading survived into the condensed region`,
    stray.length ? stray.join(' | ') : 'clean');
  // And the structure the re-parse depends on is still exactly one of each region heading.
  for (const [name, heading] of [['pinned', PINNED], ['condensed', CONDENSED], ['recent', RECENT]]) {
    check(after.split(`\n${heading}`).length - 1 === 1,
      `${label}: exactly one ${name} region heading`, `${after.split(`\n${heading}`).length - 1}`);
  }
  return after;
}

/**
 * The input that CANNOT be condensed, and must say so by name for free.
 *
 * This is the case the old gate had no way to express: it only ever asked "did a
 * condense happen?", so "it failed, and nobody can tell you why" scored the same as a
 * clean refusal. Here the abort reason and the absence of an API call are the result.
 */
async function overflowPass(send, memPath) {
  writeFileSync(memPath, overflowMemory());
  const before = readFileSync(memPath, 'utf8');
  const condenseBefore = rows().filter((r) => r.kind === 'condense' && r.agentId === AGENT).length;
  const abortsBefore = rows().filter((r) => r.kind === 'condense-abort').length;

  log(`PASS 3: asking the packaged app to condense an UNFITTABLE ${Math.round(before.length / 1024)} KB memory...`);
  const t0 = Date.now();
  const out = await reflect(send);
  const took = Date.now() - t0;

  const aborts = rows().filter((r) => r.kind === 'condense-abort').slice(abortsBefore);
  const after = readFileSync(memPath, 'utf8');
  const condenseAfter = rows().filter((r) => r.kind === 'condense' && r.agentId === AGENT).length;

  check(Array.isArray(out) && out.length === 1 && out[0].condensed === false,
    'PASS 3: reflectNow REFUSES the unfittable memory', JSON.stringify(out));
  // Guard the guard: 'nothing-to-evict' is also a refusal, and it would mean the
  // giant section never reached the planner - the gate passing while testing nothing.
  check(Array.isArray(out) && out[0] && out[0].reason !== 'nothing-to-evict',
    'PASS 3: the fixture actually reaches the eviction planner', out[0] && out[0].reason);
  check(Array.isArray(out) && out[0] && out[0].reason === 'prompt-too-large',
    'PASS 3: the refusal is NAMED prompt-too-large', out[0] && out[0].reason);
  check(aborts.length === 1 && aborts[0].reason === 'prompt-too-large',
    'PASS 3: log.jsonl carries the NAMED abort, not a bare "claude exited 1"',
    aborts.map((a) => `${a.reason}: ${a.detail || ''}`).join(' | ') || 'none');
  check(condenseAfter === condenseBefore, 'PASS 3: no condense row was written');
  check(after === before, 'PASS 3: memory.md is BYTE-IDENTICAL - a refusal touches nothing');
  // The pre-flight refusal happens before the spawn. A round trip to the model - even a
  // rejected one - took ~2.8 s when this was measured by hand; 2 s is a generous floor.
  check(took < 2_000, 'PASS 3: refused WITHOUT spending an API call', `${took} ms`);
}

/**
 * PASS 3b - the god shape converges. Guard-the-guard: a condense row must report `split`,
 * or the gate could pass without the oversized section ever reaching the splitter.
 */
async function godShapePass(send, memPath) {
  writeFileSync(memPath, godShapeMemory());
  const before = readFileSync(memPath, 'utf8');
  const rowsBefore = rows().length;
  log(`PASS 3b: the god SHAPE - a ~355 KB section at the third-oldest position in ${Math.round(before.length / 1024)} KB...`);
  const t0 = Date.now();
  const out = await reflect(send);
  const took = Math.round((Date.now() - t0) / 1000);
  const after = readFileSync(memPath, 'utf8');
  const mine = rows().slice(rowsBefore).filter((r) => r.agentId === AGENT);
  const passes = mine.filter((r) => r.kind === 'condense');
  const aborts = mine.filter((r) => r.kind === 'condense-abort');
  const giant = before.split('\n').find((l) => l.startsWith('## 2026-09-10 11:25'));

  check(before.length > 900_000, 'PASS 3b: the fixture is god-sized', `${before.length} bytes`);
  check(Array.isArray(out) && out[0] && out[0].condensed === true && out[0].reason === 'condensed',
    'PASS 3b: reflectNow reports a CONDENSE', JSON.stringify(out));
  check(aborts.length === 0, 'PASS 3b: no condense-abort (no not-smaller stall)',
    aborts.map((a) => `${a.reason}: ${a.detail || ''}`).join(' | ') || 'none');
  check(passes.some((r) => (r.split || 0) >= 1), 'PASS 3b: the oversized section REACHED the splitter',
    passes.map((r) => `split=${r.split}`).join(',') || 'no condense rows');
  check(after.length <= BUDGET_BYTES, 'PASS 3b: converged UNDER budget',
    `${before.length} -> ${after.length} bytes in ${passes.length} passes, ${took}s`);
  check(passes.every((r) => typeof r.promptBytes === 'number' && r.promptBytes <= MAX_PROMPT_BYTES),
    `PASS 3b: EVERY pass stayed inside the ${MAX_PROMPT_BYTES} B cap`,
    `max ${Math.max(0, ...passes.map((r) => r.promptBytes || 0))} B`);
  check(after.includes(CANARY_PIN), 'PASS 3b: the pinned line survived byte-for-byte');
  // A derived heading may only exist while part of the giant is still verbatim.
  const derived = (after.match(/ \(continued \d+\/\d+\)$/gm) || []).length;
  check(derived === 0 || after.includes(giant), 'PASS 3b: (continued k/n) headings only for an untaken remainder',
    `${derived} derived heading(s)`);
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

  // Before anything else: prove the instrument, then take the baseline with it.
  await proveProbe();
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

    // Prove it is the 1.1.55 artifact, not a stale build or the live install. The app
    // writes one app-start row per launch; that row is the authoritative statement.
    const start = await waitFor('the app-start row', 60_000, () => rows().find((r) => r.kind === 'app-start') || null);
    check(start.packaged === true, 'runs PACKAGED', `packaged=${start.packaged}`);
    check(start.version === '1.1.55', 'the artifact reports 1.1.55', `version=${start.version}`);

    // PASS 1 carries the full ~1.1 MB backlog: this is the dig-out proof.
    await pass(cdp.send, memPath, 'PASS 1 (quiet, full backlog)', { digOut: true });
    // PASS 2 is the v1.1.46 transcript-race check, and that race has nothing to do with
    // size - so it runs a smaller fixture deliberately, to keep the gate's API spend
    // proportionate. The size question is PASS 1's job and PASS 3's.
    await pass(cdp.send, memPath, 'PASS 2 (other transcripts changing)',
      { decoys: true, make: () => fixtureMemory(20) });
    await overflowPass(cdp.send, memPath);
    await godShapePass(cdp.send, memPath);
    decoyDir = projectDirFor(DEV_ROOT);

    await proveTreeFilter(app.pid);
    const left = await lingeringAfterSettle(before, app.pid);
    // If this fires with a proven probe AND the child is in THIS app's tree, it is a
    // PRODUCT finding, not a canary one: a hidden condensation child outliving its run
    // is a leak in the shipped app. Both halves are load-bearing - before the tree
    // filter this fired on the INSTALLED app's children and blamed the build under test.
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
