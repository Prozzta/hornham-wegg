'use strict';

/**
 * Pre-M1 event-wake bridge, commit 3 — regression pins (plan section D). Each one fails if
 * a removed hazard comes back; each is also a census mutant in
 * test/tools/inbox-wake-mutants.cjs:
 *   a god exclusion in reconciliation; an isGod field or branch; a direct PTY write in
 *   the wake path; announcing before COMMITTED; the renderer's inbox-wake producer
 *   (useHive effect #3); a second submit implementation in the reconciliation beat;
 *   the delivery edge firing before the durable write.
 * And the one thing that must stay: ordinary queued messages still drain in the renderer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const src = (f) => codeOnly(readSource(f), path.basename(f));
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, a); return s.slice(i, s.indexOf(b, i)); };

test('no god exclusion anywhere in the wake path (reconciliation covers EVERY live agent)', () => {
  const index = src('src/main/index.ts');
  const beat = between(index, 'function runWorkerWakeBeat', 'function armAlwaysOnBeats');
  assert.ok(!/godId/.test(beat), 'agentId === reg.godId must not come back');
  for (const f of ['src/main/workerWake.ts', 'src/main/inboxWakeBridge.ts']) {
    assert.ok(!/\bisGod\b|\bgodId\b/.test(src(f)), `${f}: no isGod / godId`);
  }
});

test('no direct PTY write in the wake path: the bridge submits through the owner only', () => {
  const index = src('src/main/index.ts');
  const wiring = between(index, 'inboxWake = new InboxWakeBridge(', 'const hookServer = new HookServer(');
  assert.ok(!/ptyManager\.write|\.write\(/.test(wiring), 'the bridge wiring types nothing itself');
  assert.match(wiring, /submit: \(req\) => automaticSubmit\.submit\(req\)/);
  for (const f of ['src/main/workerWake.ts', 'src/main/inboxWakeBridge.ts']) {
    assert.ok(!/ptyManager|\.write\(|sendToOwner/.test(src(f)), `${f}: no terminal access`);
  }
});

test('ids are announced ONLY in settle(), and only for COMMITTED / HUMAN_HANDLED / ALREADY_HANDLED', () => {
  const wake = src('src/main/workerWake.ts');
  const claim = between(wake, '  claim(f: WorkerWakeFacts', '\n  }\n');
  assert.ok(!/announced\.add/.test(claim), 'a claim never announces');
  const { WorkerWakeWatchdog } = loadTs('src/main/workerWake.ts');
  const c = new WorkerWakeWatchdog();
  c.noteHook('a', 'Stop', '', 1);
  c.noteDelivery('a', 'm1');
  const k = c.claim({ agentId: 'a', ptyId: 'p', lastOutputAt: 0, autoDeliveryPaused: false, paused: false, halted: false }, 'delivery', 'event', 1);
  assert.deepEqual(c.state('a').announced, [], 'in flight is not announced');
  c.settle(k, 'ABORTED');
  assert.deepEqual(c.state('a').announced, []);
});

test('the renderer HINTS but never SUBMITS an inbox wake; ordinary queued messages still drain', () => {
  const hive = src('src/renderer/src/hooks/useHive.ts');
  assert.ok(!/inboxNudgeText/.test(hive), 'no nudge text is built in the renderer');
  assert.ok(!/precondition: 'inbox-nonempty'/.test(hive), 'no inbox-wake item is enqueued by the renderer');
  assert.ok(!/const nudged = useRef/.test(hive), 'its dedup ref is gone');
  // god's ruling (A): the 4s loop is BACK as a trigger, and that is the line to hold.
  // A hint carries no payload and no decision, so main keeps the one claim and the one
  // stable request id; a second SUBMITTER would make a second request id for the same
  // inbox edge, and the owner — idempotent on requestId only — would turn that into a
  // second real turn. Pin the distinction, not the absence.
  assert.match(hive, /window\.cth\.hiveRequestInboxWake\(a\.id\)/, 'the renderer hint calls main');
  assert.ok(!/autoSubmit.*inbox|submitInboxWake|admissionClass: 'CAPACITY_GATED'[^}]*inbox/i.test(hive),
    'the renderer never submits an inbox wake itself');
  const hint = between(hive, 'INBOX_HINT_MS)', '}, [config?.onboardingComplete]);');
  assert.ok(!/inboxNudgeText|enqueueMessage|autoSubmit/.test(hint),
    'the hint loop builds no text, queues nothing and submits nothing');
  // Effect #4 - the ordinary queue drain - stays, including its inbox precondition check.
  assert.match(hive, /checkPrecondition\(next, \(\) => window\.cth\.hiveInbox\(srcId\)\)/);
  assert.match(hive, /enqueueMessage\(/, 'the renderer still queues its own sends (e.g. /compact)');
});

test('the renderer HINT reaches the terminal only through the one main-owned wake path', () => {
  const index = src('src/main/index.ts');
  const handler = between(index, "ipcMain.handle('hive:requestInboxWake'", '});');
  // A hint must not submit, type, or build a payload — everything that decides what the
  // agent is told stays on main's one path, under main's one stable request id.
  assert.ok(!/automaticSubmit|ptyManager|inboxNudgeText/.test(handler),
    'the hint handler never submits, types, or builds nudge text');
  assert.match(handler, /inboxWake\?\.requestInboxWake\(id, 'renderer', 'reconcile'\)/,
    'it asks the one path, in reconcile mode so a cold-booted agent is recoverable');
  assert.match(handler, /typeof id !== 'string'/, 'and it validates what the renderer sent');
});

test('the reconciliation beat has no submit of its own', () => {
  const beat = between(src('src/main/index.ts'), 'function runWorkerWakeBeat', 'function armAlwaysOnBeats');
  assert.ok(!/\.submit\(|ptyManager|inboxNudgeText/.test(beat));
  assert.match(beat, /inboxWake\.reconcileAll\(live\)/);
});

test('the delivery edge fires only AFTER the durable inbox write', async (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-wake-pin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const seen = [];
  hive.setDeliveryObserver(({ agentId, messageId }) => {
    seen.push(fs.existsSync(path.join(home, 'hive', 'agents', agentId, 'inbox', `${messageId}.json`)));
  });
  hive.send({ id: 'p1', to: 'jim-1', act: 'inform', subject: 's' }, 'god-1');
  assert.deepEqual(seen, [true], 'the file is on disk when the observer runs');
});

test('the Stop hook reply stays non-blocking (no drainForStop, no decision:block)', () => {
  const hooks = src('src/main/hooks.ts');
  const stop = between(hooks, "if ((event === 'Stop' || event === 'SubagentStop') && agentId) {", '\n    }\n');
  assert.ok(!/drainForStop|decision/.test(stop));
  assert.match(stop, /return \{\};/);
});
