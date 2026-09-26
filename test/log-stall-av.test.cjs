'use strict';

/**
 * LOG-STALL-AV (Jim, MAIL-AV-152; 1.1.53). The mail/Write/Read antivirus pain was synchronous
 * appendFileSync on Electron main into a 74 MB log.jsonl and a 21 MB cost-ledger.jsonl, never
 * rotated, rescanned on every open/close (~390-460 ms and ~0.9 scanner CPU-s per row, ~30 rows
 * per message).
 *  F1  the app keeps both files OPEN (one open, then writeSync per row: 0.01-0.06 ms).
 *  F2  both rotate at 8 MB; log keeps 8 rotated, the ledger keeps all; a pre-existing oversize
 *      file becomes a never-deleted legacy file; logTail and the lifetime-cost fold read across.
 *  F3  event-path wake rows are logged on edges only (< 5 per message), the rest counted.
 * Jim's audit (LOG-STALL-AUDIT-153), god's root fix: keep-open is the DEFAULT; HiveManager.dispose()
 * releases the descriptors and runs before reset's rm, change-home's copy, and quit (B1/B3);
 * provider-status also logs when it changes (B2); the rotated fd closes asynchronously (N2); the
 * live file is recreated inside the rotation (N3); legacy only before any rotation (N5).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'logstall-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { AppendFile, rotatedFiles, filesInOrder, APPEND_ROTATE_BYTES, LOG_KEEP_ROTATED } = loadTs('src/main/appendLog.ts');
const { CostLedgerTotals } = loadTs('src/main/costLifetime.ts');
const { planWakeRow, newWakeRowState, takeFolded, forgetWakeRows } = loadTs('src/main/wakeRowPolicy.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const dir = () => fs.mkdtempSync(path.join(JAIL, 'd-'));
const rows = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);

// ── F1 ────────────────────────────────────────────────────────────────────

test('F1: keepOpen = ONE open for many rows; every row is on disk the moment append returns, in order', () => {
  const p = path.join(dir(), 'log.jsonl');
  let opens = 0;
  const f = new AppendFile(p, { keepOpen: true, onOpen: () => { opens += 1; } });
  for (let i = 0; i < 50; i++) {
    f.append(JSON.stringify({ i }) + '\n');
    assert.equal(rows(p).length, i + 1, 'visible immediately (no buffer to flush)');
  }
  assert.equal(opens, 1, 'one open for 50 rows (each open is an antivirus rescan)');
  assert.equal(f.isOpen, true);
  assert.deepEqual(rows(p).map((l) => JSON.parse(l).i), [...Array(50).keys()]);
  f.close();
  assert.equal(f.isOpen, false);
  f.append('{"after":1}\n');
  assert.equal(opens, 2, 'reopens after a close');
  f.close();
});

test('F1 (B3): keep-open is the DEFAULT; keepOpen:false holds no descriptor between rows', () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  const def = new AppendFile(p);
  def.append('{}\n');
  assert.equal(def.isOpen, true, 'the default is the production path');
  def.close();
  let opens = 0;
  const f = new AppendFile(p, { keepOpen: false, onOpen: () => { opens += 1; } });
  for (let i = 0; i < 3; i++) f.append('{}\n');
  assert.equal(opens, 3); assert.equal(f.isOpen, false);
  fs.rmSync(d, { recursive: true, force: true });   // deletable: nothing held
});

test('F1 (B1/B3): a HiveManager holds its log open by default; dispose() releases it so the hive folder can be deleted (reset) or copied', { skip: process.platform !== 'win32' }, async () => {
  const home = dir();
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  hive.appendLog({ kind: 'x' });
  // Without dispose, Windows leaves the open file delete-pending and the rm fails: the reset bug.
  assert.throws(() => fs.rmSync(path.join(home, 'hive'), { recursive: true, force: true }), /ENOTEMPTY|EBUSY|EPERM/);
  hive.dispose();
  hive.dispose();   // idempotent
  fs.rmSync(path.join(home, 'hive'), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(home, 'hive')), false, 'after dispose the whole hive folder goes');
});

test('F1 wiring (B1/B3): no opt-in call; dispose() runs before reset\'s rm, before change-home\'s copy, and at quit', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(idx, /keepAppendFilesOpen\(/, 'the default is the app\'s path: nothing to turn on');
  assert.match(idx, /const finish = \(\): void => \{ try \{ hive\.dispose\(\); \}/);
  const reset = idx.slice(idx.indexOf("ipcMain.handle('app:resetAll'"));
  const disposeAt = reset.indexOf('hive.dispose();'), rmAt = reset.indexOf('rmSync(dir,');
  assert.ok(disposeAt > 0 && rmAt > disposeAt, 'reset: dispose, then rm');
  const change = idx.slice(idx.indexOf("ipcMain.handle('config:changeHome'"));
  const dAt = change.indexOf('hive.dispose();'), cpAt = change.indexOf('cpSync(src,');
  assert.ok(dAt > 0 && cpAt > dAt, 'change home: dispose, then copy');
});

test('F1 GATE (Jim\'s probe): with a large pre-existing log, an app append is sub-millisecond (it was ~390-460 ms)', async () => {
  const home = dir();
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const log = path.join(home, 'hive', 'log.jsonl');
  const big = Buffer.alloc(20 * 1024 * 1024, 0x20); big[big.length - 1] = 0x0a;
  hive.dispose();   // the file is replaced under the manager: a fresh open, as in a new process
  fs.writeFileSync(log, big);
  const ms = [];
  for (let i = 0; i < 40; i++) { const t0 = process.hrtime.bigint(); hive.appendLog({ kind: 'probe', i }); ms.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  hive.dispose();
  ms.sort((a, b) => a - b);
  assert.ok(ms[20] < 2, `p50 ${ms[20].toFixed(3)} ms`);
  const legacy = rotatedFiles(log).filter((r) => r.legacy);
  assert.equal(legacy.length, 1, 'the 20 MB file went to a legacy file');
  assert.equal(fs.statSync(legacy[0].path).size, big.length, 'every byte of it kept');
});

// ── F2 ────────────────────────────────────────────────────────────────────

test('F2: rotation at the cap; the live file stays under it; rotated names sort in write order; log retention keeps N; legacy is never pruned', () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  fs.writeFileSync(p, 'L'.repeat(2000) + '\n');   // pre-existing, over the test cap
  let t = 1000;
  const f = new AppendFile(p, { capBytes: 1000, keep: 3, keepOpen: true, now: () => ++t });
  for (let i = 0; i < 120; i++) f.append(JSON.stringify({ i, pad: 'x'.repeat(40) }) + '\n');
  f.close();
  const rot = rotatedFiles(p);
  assert.equal(rot.filter((r) => r.legacy).length, 1, 'the legacy file is kept');
  assert.equal(fs.readFileSync(rot.find((r) => r.legacy).path, 'utf8'), 'L'.repeat(2000) + '\n', 'byte-identical');
  assert.equal(rot.filter((r) => !r.legacy).length, 3, 'retention: 3 rotated');
  assert.ok(fs.statSync(p).size < 1000);
  for (const r of rot) assert.match(path.basename(r.path), /^log\.(legacy-)?\d+\.jsonl$/);
  const order = filesInOrder(p);
  assert.equal(order.at(-1), p, 'the live file is last');
  const seq = order.filter((x) => !/legacy/.test(x)).flatMap(rows).map((l) => JSON.parse(l).i);
  for (let k = 1; k < seq.length; k++) assert.equal(seq[k], seq[k - 1] + 1, 'contiguous, in order, no row lost or duplicated in what is kept');
  assert.equal(seq.at(-1), 119);
});

test('F2 (N3): the live file exists again the instant a rotation returns, with keepOpen on or off', () => {
  for (const keepOpen of [true, false]) {
    const d = dir(); const p = path.join(d, 'log.jsonl');
    let t = 0;
    const f = new AppendFile(p, { capBytes: 200, keepOpen, now: () => ++t });
    let rotations = 0;
    for (let i = 0; i < 40; i++) {
      const before = rotatedFiles(p).length;
      f.append(JSON.stringify({ i, pad: 'x'.repeat(30) }) + '\n');
      if (rotatedFiles(p).length > before) { rotations += 1; assert.ok(fs.existsSync(p), `recreated inside the rotation (keepOpen ${keepOpen})`); assert.equal(fs.statSync(p).size, 0); }
    }
    f.close();
    assert.ok(rotations >= 3);
  }
});

test('F2 (N2): the rotated file\'s descriptor is closed ASYNCHRONOUSLY (its antivirus scan off main); rows stay complete', async () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  const realClose = fs.close, realCloseSync = fs.closeSync;
  let asyncCloses = 0, syncCloses = 0;
  fs.close = (fd, cb) => { asyncCloses += 1; return realClose(fd, cb); };
  fs.closeSync = (fd) => { syncCloses += 1; return realCloseSync(fd); };
  let t = 0;
  try {
    const f = new AppendFile(p, { capBytes: 300, keep: Infinity, now: () => ++t });
    for (let i = 0; i < 30; i++) f.append(JSON.stringify({ i, pad: 'y'.repeat(30) }) + '\n');
    const rotations = rotatedFiles(p).length;
    assert.ok(rotations >= 3);
    assert.equal(asyncCloses, rotations, 'one async close per rotation');
    assert.equal(syncCloses, 0, 'no synchronous close on the append path');
    f.close();
  } finally { fs.close = realClose; fs.closeSync = realCloseSync; }
  await new Promise((r) => setTimeout(r, 50));
  const all = filesInOrder(p).flatMap(rows).map((l) => JSON.parse(l).i);
  assert.deepEqual(all, [...Array(30).keys()]);
});

test('F2 (N5): an oversize live file AFTER rotation has begun (its rename was busy) rotates normally and is pruned; only a pre-rotation file is legacy', () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  fs.writeFileSync(path.join(d, 'log.1000.jsonl'), '{"old":1}\n');
  fs.writeFileSync(p, 'B'.repeat(2000) + '\n');   // over the cap, but rotation already ran here
  let t = 5000;
  const f = new AppendFile(p, { capBytes: 1000, keep: 1, now: () => ++t });
  f.append('{"x":1}\n');
  f.close();
  const rot = rotatedFiles(p);
  assert.equal(rot.filter((r) => r.legacy).length, 0, 'not legacy');
  assert.equal(rot.length, 1, 'retention applied to it');
  assert.equal(rows(p).length, 1, 'the row landed in the fresh live file');
});

test('F2: the cost ledger keeps EVERY rotated file (Infinity)', () => {
  const d = dir(); const p = path.join(d, 'cost-ledger.jsonl');
  let t = 0;
  const f = new AppendFile(p, { capBytes: 300, keep: Infinity, keepOpen: true, now: () => ++t });
  for (let i = 0; i < 100; i++) f.append(JSON.stringify({ agent_id: 'a', session_id: 's', usd: i }) + '\n');
  f.close();
  const all = filesInOrder(p).filter((x) => fs.existsSync(x)).flatMap(rows).map((l) => JSON.parse(l).usd);
  assert.deepEqual(all, [...Array(100).keys()], 'nothing pruned');
});

test('F2: logTail across rotation returns exactly the naive tail of the concatenated log', async () => {
  const home = dir();
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const live = path.join(home, 'hive', 'log.jsonl');
  // Two rotated files + the live one, as the app writes them.
  fs.writeFileSync(path.join(home, 'hive', 'log.1000.jsonl'), [1, 2, 3].map((i) => JSON.stringify({ i })).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'hive', 'log.2000.jsonl'), [4, 5].map((i) => JSON.stringify({ i })).join('\n') + '\n');
  fs.writeFileSync(live, [6, 7].map((i) => JSON.stringify({ i })).join('\n') + '\n');
  assert.deepEqual(hive.logTail(4).map((r) => r.i), [4, 5, 6, 7]);
  assert.deepEqual(hive.logTail(100).map((r) => r.i), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(hive.logTail(2).map((r) => r.i), [6, 7]);
  hive.dispose();
});

test('F2: the lifetime cost folded across rotations, INCLUDING a rotation mid-fold, equals the fold of one file', async () => {
  const d = dir(); const p = path.join(d, 'cost-ledger.jsonl');
  // A realistic stream: cumulative per-session samples with a restart (the counter drops).
  const stream = [];
  for (let i = 1; i <= 60; i++) stream.push({ agent_id: 'a', session_id: 's1', usd: i * 0.1 });
  for (let i = 1; i <= 30; i++) stream.push({ agent_id: 'a', session_id: 's1', usd: i * 0.05 });   // reset
  for (let i = 1; i <= 40; i++) stream.push({ agent_id: 'b', session_id: 's2', usd: i * 0.2 });
  const one = path.join(d, 'one.jsonl');
  fs.writeFileSync(one, stream.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ref = new CostLedgerTotals(); await ref.refreshFully(one);

  let t = 0;
  const f = new AppendFile(p, { capBytes: 700, keep: Infinity, keepOpen: true, now: () => ++t });
  const got = new CostLedgerTotals();
  for (let i = 0; i < stream.length; i++) {
    f.append(JSON.stringify(stream[i]) + '\n');
    if (i % 17 === 0) await got.refresh(p);   // fold while it grows and rotates
  }
  f.close();
  await got.refreshFully(p);
  assert.ok(rotatedFiles(p).length >= 5, 'it really rotated');
  assert.equal(got.ready, true);
  assert.ok(Math.abs(got.floorTotal() - ref.floorTotal()) < 1e-9, `${got.floorTotal()} vs ${ref.floorTotal()}`);
  assert.ok(Math.abs(got.usdFor('a') - ref.usdFor('a')) < 1e-9);
  assert.ok(Math.abs(got.usdFor('b') - ref.usdFor('b')) < 1e-9);
  // Incremental, not a re-read: every rotated file is remembered as done, and a refresh with
  // nothing new reads nothing (a re-read of the whole rotated ledger every beat would be the
  // very cost this change removes).
  assert.equal(got.doneIds.size, rotatedFiles(p).length, 'each rotated file folded once and remembered');
  const before = got.floorTotal();
  const realConsume = got.consume.bind(got); let consumed = 0;
  got.consume = (b) => { consumed += b.length; return realConsume(b); };
  await got.refresh(p); await got.refresh(p);
  assert.equal(consumed, 0, 'nothing re-read');
  assert.equal(got.floorTotal(), before);
});

// ── F3 ────────────────────────────────────────────────────────────────────

/** One delivered message as the live floor logs it (Jim's per-message mix, MAIL-AV-152). */
function messageSequence(agent) {
  const s = [];
  s.push(['delivery', { agentId: agent, messageId: 'm', fresh: true }]);
  s.push(['observer', { agentId: agent, messageId: 'm', bridge: true }]);
  s.push(['schedule', { agentId: agent, cause: 'delivery', took: 'armed' }]);
  for (let k = 0; k < 5; k++) {
    s.push(['enter', { agentId: agent, cause: 'hook', mode: 'event' }]);
    s.push(['facts', { agentId: agent, cause: 'hook', mode: 'event', idleMs: 10 * k, paused: false }]);
    s.push(['no-claim', { agentId: agent, cause: 'hook', mode: 'event', why: 'active', inboxIds: 1 }]);
    s.push(['schedule', { agentId: agent, cause: 'hook', took: 'coalesced' }]);
  }
  for (let k = 0; k < 8; k++) s.push(['hook', { agentId: agent, event: k % 2 ? 'PostToolUse' : 'PreToolUse', edge: null }]);
  s.push(['hook', { agentId: agent, event: 'Stop', edge: 'idle' }]);
  s.push(['enter', { agentId: agent, cause: 'hook', mode: 'event' }]);
  s.push(['facts', { agentId: agent, cause: 'hook', mode: 'event', idleMs: 0 }]);
  s.push(['claim', { agentId: agent, cause: 'hook', mode: 'event', ids: 1, requestId: 'r' }]);
  s.push(['submit', { agentId: agent, cause: 'hook', mode: 'event', requestId: 'r' }]);
  s.push(['settle', { agentId: agent, cause: 'hook', mode: 'event', outcome: 'COMMITTED', requestId: 'r' }]);
  return s;
}

test('F3 GATE: one delivered message logs < 5 rows in all (the hive message row + 3 wake rows; it was ~30), and every folded row is counted', () => {
  const st = newWakeRowState();
  const seq = messageSequence('a1');
  const logged = seq.map(([stage, f]) => [stage, planWakeRow(st, stage, f)]).filter(([, r]) => r);
  assert.ok(seq.length >= 28, `the input is the ~30-row mix (${seq.length})`);
  assert.ok(1 + logged.length < 5, `message + ${logged.length} wake rows: ${logged.map(([s]) => s).join(',')}`);
  assert.deepEqual(logged.map(([s]) => s), ['no-claim', 'hook', 'settle']);
  const settle = logged[2][1];
  assert.deepEqual(settle.claim, { cause: 'hook', mode: 'event', ids: 1, requestId: 'r' }, 'the settle carries its claim');
  assert.equal(logged[0][1].why, 'active');
  assert.ok(logged[0][1].facts, 'the refusal carries its facts');
  const folded = takeFolded(st);
  const total = Object.values(folded).reduce((a, b) => a + b, 0);
  assert.equal(total + logged.length + 1, seq.length + 1, 'every row is either logged or counted');
  assert.equal(takeFolded(st), null, 'the summary clears');
});

test('F3: the edges that must survive: a lifecycle edge, a refusal whose REASON changes (with its facts), a claim, a settle, a missing bridge, a throw', () => {
  const st = newWakeRowState();
  assert.equal(planWakeRow(st, 'hook', { agentId: 'a', event: 'PreToolUse', edge: null }), null);
  assert.ok(planWakeRow(st, 'hook', { agentId: 'a', event: 'Stop', edge: 'idle' }));
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'idle', edge: true }));
  // B2: a non-edge reading logs when the status CHANGES (the AGY diagnosis needed the refused
  // idle ticks), identical repeats fold, agents are independent; a non-edge Stop logs too.
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'running', edge: false }), 'changed: logged');
  assert.equal(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'running', edge: false }), null, 'same again: folded');
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'idle', edge: false }), 'a refused idle after running: logged');
  assert.equal(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'idle', edge: false }), null);
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'z', status: 'idle', edge: false }), 'per agent');
  assert.ok(planWakeRow(st, 'hook', { agentId: 'a', event: 'Stop', edge: false }), 'a non-edge Stop logs');
  forgetWakeRows(st, 'a');
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'idle', edge: false }), 'forget clears the last status (N4)');
  planWakeRow(st, 'facts', { agentId: 'a', paused: true, idleMs: 5 });
  const r1 = planWakeRow(st, 'no-claim', { agentId: 'a', why: 'paused', inboxIds: 2 });
  assert.deepEqual(r1.facts, { paused: true, idleMs: 5 }, 'the refusal carries the state it was refused in');
  assert.equal(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'paused', inboxIds: 3 }), null, 'the same reason again is folded');
  assert.ok(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'active', inboxIds: 3 }), 'a new reason is an edge');
  assert.equal(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'paused', inboxIds: 3 }), null, 'a FLAPPING reason already logged since the last claim is folded');
  assert.equal(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'active', inboxIds: 3 }), null);
  assert.ok(planWakeRow(st, 'no-claim', { agentId: 'b', why: 'active', inboxIds: 1 }), 'agents are independent');
  assert.equal(planWakeRow(st, 'claim', { agentId: 'a', ids: 1 }), null, 'a claim rides on its outcome row');
  assert.ok(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'active', inboxIds: 1 }), 'after a claim the same reason logs again');
  assert.deepEqual(planWakeRow(st, 'settle', { agentId: 'a', outcome: 'COMMITTED' }).claim, { ids: 1 });
  planWakeRow(st, 'claim', { agentId: 'a', ids: 2 });
  assert.deepEqual(planWakeRow(st, 'submit-threw', { agentId: 'a', error: 'x' }).claim, { ids: 2 }, 'a failed submit carries its claim too');
  assert.equal(planWakeRow(st, 'delivery', { agentId: 'a', messageId: 'm', fresh: true }), null, 'a fresh delivery is the message row');
  assert.ok(planWakeRow(st, 'delivery', { agentId: 'a', messageId: 'm', fresh: false }), 'a RE-delivery logs');
  assert.ok(planWakeRow(st, 'observer', { agentId: 'a', bridge: false }), 'a missing bridge is the case observer exists for');
  assert.ok(planWakeRow(st, 'beat', { live: 2, agents: 'a,b' }));
  assert.equal(planWakeRow(st, 'beat', { live: 2, agents: 'a,b' }), null, 'the same beat again is folded');
  assert.ok(planWakeRow(st, 'beat', { live: 3, agents: 'a,b,c' }), 'a changed beat logs');
  for (const s of ['throw', 'stall', 'codex-rollout', 'heartbeat', 'bridge-built']) {
    assert.ok(planWakeRow(st, s, { agentId: 'a' }), s);
  }
  assert.ok(planWakeRow(st, 'schedule', { agentId: '', took: 'no-agent-id' }), 'an anomaly logs');
});

test('F3 wiring: wakeDiag counts EVERY row in telemetry first, then the breadcrumb de-dup, then the edge policy; the folded counts are written once per minute; other log rows (app-start, palace-*, hook-transport) never pass through it', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const body = /function wakeDiag\([\s\S]*?\n\}/.exec(idx)[0];
  const order = ['wakeTelemetry.note(', 'shouldLogBreadcrumb(', 'takeFolded(', 'planWakeRow('].map((k) => body.indexOf(k));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `order ${order}`);
  assert.match(body, /hive\.appendLog\(\{ kind: 'wake-folded', minute: wakeFoldedMinute, counts \}\)/);
  assert.match(body, /if \(row\) hive\.appendLog\(\{ kind: 'wake', stage, \.\.\.row \}\)/);
  const stall = /diag: \(stage, fields\) => \{[\s\S]*?\n  \}/.exec(idx)[0];
  assert.match(stall, /wakeDiag\(stage, fields\);[\s\S]*noteWakeRefusal/, 'the stall watchdog still sees every refusal');
  assert.match(idx, /try \{ workerWake\.forget\(agentId, id\); \} catch \{[^}]*\}\s*try \{ forgetWakeRows\(wakeRows, agentId\); \}/, 'N4: an agent that leaves the floor is forgotten by the row policy too');
});
