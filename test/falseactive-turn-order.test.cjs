'use strict';

/**
 * FALSEACTIVE-STALL-2 part A: a Codex tool hook that arrives AFTER its own turn's Stop
 * must not re-open that turn.
 *
 * Live (1.1.50, Oscar, 2026-09-25): Codex's last tool finished 20:12:15.67 and the turn
 * completed at 20:12:25.27, but the app RECEIVED a PreToolUse at 20:12:23.9 and a
 * PostToolUse at 20:12:30.6. Each hook is its own short-lived shim process on the pipe, so
 * arrival order is not event order. Read as a fresh edge, a straggler after the Stop sets
 * the lifecycle active again, and nothing closes it: the turn's Stop has already come and
 * gone. Every wake is then refused as lifecycle-active, forever.
 *
 * Codex stamps turn_id on UserPromptSubmit / PreToolUse / PostToolUse / Stop (read from the
 * payload schemas embedded in codex 0.154). A Stop now records its turn as closed; a
 * Pre/PostToolUse naming a closed turn is ignored.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { WorkerWakeWatchdog, WORKER_WAKE_BOOT_GRACE_MS } = loadTs('src/main/workerWake.ts');

const T0 = 1_790_359_800_000;          // ~20:10, the live window
const A = 'oscar';
const TURN = '01a0d9c2-c9cc-7832-a345-76fd68f1d74e';
const NEXT = '01a0d9f4-6443-73e1-bc78-cdd7067fb492';
const facts = { agentId: A, ptyId: 'pty-oscar', lastOutputAt: T0, autoDeliveryPaused: false, paused: false, halted: false, inhibited: false };
const after = T0 + WORKER_WAKE_BOOT_GRACE_MS * 10;

function midTurn() {
  const c = new WorkerWakeWatchdog();
  c.noteHook(A, 'UserPromptSubmit', undefined, T0, undefined, TURN);
  c.noteHook(A, 'PreToolUse', undefined, T0 + 5_000, undefined, TURN);
  c.noteHook(A, 'PostToolUse', undefined, T0 + 10_000, undefined, TURN);
  assert.equal(c.state(A).lifecycle, 'active');
  return c;
}

test('THE LIVE SEQUENCE: Stop, then that turn\'s PreToolUse + PostToolUse stragglers -> still idle, and the mail is delivered', () => {
  const c = midTurn();
  assert.equal(c.noteHook(A, 'Stop', undefined, T0 + 25_000, undefined, TURN), true, 'Stop is the retry edge');
  // The stragglers, exactly as they arrived on the live floor: after the Stop.
  assert.equal(c.noteHook(A, 'PreToolUse', undefined, T0 + 23_900 + 2_000, undefined, TURN), false);
  assert.equal(c.noteHook(A, 'PostToolUse', undefined, T0 + 30_600, undefined, TURN), false);
  assert.equal(c.state(A).lifecycle, 'idle', 'a straggler of a finished turn must not re-open it');
  c.noteDelivery(A, 'burst-1');
  const claim = c.claim(facts, 'delivery', 'event', after);
  assert.ok(claim, `the burst is deliverable (refused: ${c.whyNoClaim(A)})`);
});

test('a NEW turn still opens: its UserPromptSubmit and tool events are live', () => {
  const c = midTurn();
  c.noteHook(A, 'Stop', undefined, T0 + 25_000, undefined, TURN);
  c.noteHook(A, 'UserPromptSubmit', undefined, T0 + 60_000, undefined, NEXT);
  assert.equal(c.state(A).lifecycle, 'active', 'a new prompt opens a new turn');
  c.noteHook(A, 'Stop', undefined, T0 + 70_000, undefined, NEXT);
  c.noteHook(A, 'PreToolUse', undefined, T0 + 71_000, undefined, 'a-third-turn');
  assert.equal(c.state(A).lifecycle, 'active', 'a tool event of a turn that has NOT ended is live');
});

test('UserPromptSubmit naming a closed turn still opens (a prompt is never a straggler)', () => {
  const c = midTurn();
  c.noteHook(A, 'Stop', undefined, T0 + 25_000, undefined, TURN);
  c.noteHook(A, 'UserPromptSubmit', undefined, T0 + 26_000, undefined, TURN);
  assert.equal(c.state(A).lifecycle, 'active');
});

test('no turn_id (Claude, and anything else): unchanged, a late tool event still marks active', () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook(A, 'UserPromptSubmit', undefined, T0);
  c.noteHook(A, 'Stop', undefined, T0 + 1_000);
  c.noteHook(A, 'PostToolUse', undefined, T0 + 2_000);
  assert.equal(c.state(A).lifecycle, 'active', 'without a turn id nothing can be proven stale, so D3 stands');
});

test('a Stop the provider says is not terminal (fully_idle false) closes nothing', () => {
  const c = midTurn();
  assert.equal(c.noteHook(A, 'Stop', undefined, T0 + 25_000, false, TURN), false);
  c.noteHook(A, 'PostToolUse', undefined, T0 + 26_000, undefined, TURN);
  assert.equal(c.state(A).lifecycle, 'active', 'the turn is still running, so its tool events are live');
});

test('the closed-turn memory is bounded, and an evicted turn is simply no longer recognised', () => {
  const c = new WorkerWakeWatchdog();
  for (let i = 0; i < 40; i++) {
    c.noteHook(A, 'UserPromptSubmit', undefined, T0 + i * 10, undefined, `t${i}`);
    c.noteHook(A, 'Stop', undefined, T0 + i * 10 + 5, undefined, `t${i}`);
  }
  c.noteHook(A, 'PostToolUse', undefined, T0 + 1_000, undefined, 't39');
  assert.equal(c.state(A).lifecycle, 'idle', 'a recent closed turn is remembered');
  c.noteHook(A, 'PostToolUse', undefined, T0 + 1_001, undefined, 't0');
  assert.equal(c.state(A).lifecycle, 'active', 'the oldest was evicted: bounded memory, fail back to the old behaviour');
});

// ─── wiring: turn_id must actually travel payload -> HookServer -> bridge -> coordinator ───
const { readSource, codeOnly } = require('./read-source.cjs');

test('WIRING: the payload turn_id reaches noteHook (HookServer -> index -> bridge -> coordinator)', () => {
  const hooks = codeOnly(readSource('src/main/hooks.ts'));
  assert.match(hooks, /turn_id\?: string;/, 'the payload type carries turn_id');
  assert.match(hooks, /this\.onEvent\?\.\(agentId, event, p\.message, [^;]*typeof p\.turn_id === 'string' && p\.turn_id \? p\.turn_id : undefined\);/,
    'the HookServer forwards the payload turn_id to its observer');
  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /\(agentId, event, message, fullyIdle, turnId\) => inboxWake\?\.onHook\(agentId, event, message, fullyIdle, turnId\)/);
  const bridge = codeOnly(readSource('src/main/inboxWakeBridge.ts'));
  assert.match(bridge, /onHook\(agentId: string \| undefined, event: string \| undefined, message: string \| undefined, fullyIdle\?: boolean, turnId\?: string\): void \{/);
  assert.match(bridge, /coordinator\.noteHook\(agentId, event, message, this\.deps\.now\(\), fullyIdle, turnId\)/);
});
