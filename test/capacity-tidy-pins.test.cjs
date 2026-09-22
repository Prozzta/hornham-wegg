'use strict';

/**
 * v1.1.45 CAPUI-TIDY — the deferred pins from Jim's unit audits, so nothing ships unpinned.
 * Each one kills a census mutant (test/tools/capacity-mutants.cjs, "tidy").
 *
 *  F6  a pool that LEAVES the complete-replace snapshot loses its weekly latch: back at the
 *      same anchor inside the hysteresis band, weekly is HIDDEN, not held.
 *  F7  a Budget line never asks main for 5H/Weekly usage (poll only while it shows them).
 *  F8  a restored, unconfirmed pool offers NO current figure in the detail, EVEN IF its
 *      freshness verdict were FRESH (the validator could not catch that; only the gate does).
 *  F9  crit 16: an attributed window id that matches NO window never becomes a causal
 *      "<pool> reports the <window> limit reached"; the cause falls back to observational.
 *  F10 the banner's x dismisses by NOTICE id, not pool id (else it is a dead control).
 *  T7  setting OFF and platform unsupported: the notice records SUPPRESSED (setting first).
 *  M2  the token-limit editor says the limit is not applied while its line shows 5H/Weekly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter, DEFAULT_WEEKLY_DISPLAY_THRESHOLD, HYSTERESIS_BAND } = loadTs('src/main/capacityStrip.ts');
const { capacityDetailView } = loadTs('src/main/capacityDetail.ts');
const { deliverCapacityToast } = loadTs('src/main/capacityToast.ts');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct:codex';
const win = (id, kind, remaining, resetsAt) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt });
const std = (five, weekly) => [win('five_hour', 'FIVE_HOUR', five, T0 + 3_600_000), win('seven_day', 'SEVEN_DAY', weekly, T0 + 3 * 86_400_000)];
const obs = (seq, at, windows, over = {}) => ({ poolKey: POOL, streamId: 's', sourceSequence: seq, provider: 'codex', accountScope: 'acct',
  limitId: 'codex', source: 'codex-rollout', observedAt: at, receivedAt: at, windows,
  providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus', ...over });

// ─── F6 ─────────────────────────────────────────────────────────────────────────────

test('F6: a pool that left the snapshot comes back same-anchor at ~17% with weekly HIDDEN (its latch did not survive)', () => {
  const T = DEFAULT_WEEKLY_DISPLAY_THRESHOLD;
  const inBand = T + HYSTERESIS_BAND / 2 + 0.5;               // 17% at the default 15 / band 5
  assert.ok(inBand >= T && inBand < T + HYSTERESIS_BAND, 'the return value sits inside the hold band');
  let now = T0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter({ idKey: Buffer.alloc(32, 3) });
  const present = (snapshot) => presenter.present({ snapshot, membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now });
  now += 1000; tracker.ingest(obs(1, now, std(80, T - 1)));
  assert.ok(present(tracker.snapshot()).pools[0].weekly, 'revealed below the threshold');
  // Control: while the pool STAYS, the same in-band value is held (the latch works).
  now += 1000; tracker.ingest(obs(2, now, std(80, inBand)));
  assert.equal(present(tracker.snapshot()).pools[0].weekly?.reason, 'HYSTERESIS_HOLD', 'held while the pool stays');
  // The pool leaves the complete-replace snapshot...
  assert.equal(present({ ...tracker.snapshot(), pools: [] }).pools.length, 0);
  // ...and returns at the same anchor, same in-band value: hidden, re-evaluated from scratch.
  const back = present(tracker.snapshot()).pools[0];
  assert.ok(back, 'the pool is back');
  assert.ok(!('weekly' in back), 'weekly is HIDDEN: a departed pool\'s latch is gone');
});

// ─── F7 ─────────────────────────────────────────────────────────────────────────────

test('F7: a Budget line never calls capacityAgentUsage; 5H / Weekly poll it, and stop on cleanup', () => {
  const { useAgentUsageWindow } = loadTs('src/renderer/src/components/AgentUsageLine.tsx');
  const calls = [];
  const cleanups = [];
  const timers = [];
  const saved = { useEffect: React.useEffect, useState: React.useState, window: global.window,
    setInterval: global.setInterval, clearInterval: global.clearInterval };
  React.useEffect = (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c); };
  React.useState = (init) => [init, () => {}];
  global.window = { cth: { capacityAgentUsage: (id) => { calls.push(id); return new Promise(() => {}); } } };
  global.setInterval = (fn) => { timers.push(fn); return timers.length; };
  global.clearInterval = () => { timers.length = 0; };
  try {
    useAgentUsageWindow('a1', 'budget');
    assert.deepEqual(calls, [], 'Budget: no usage read at all');
    assert.equal(timers.length, 0, 'Budget: no poll scheduled');
    for (const display of ['fiveHour', 'weekly']) {
      calls.length = 0;
      useAgentUsageWindow('a1', display);
      assert.deepEqual(calls, ['a1'], `${display}: reads once now`);
      assert.equal(timers.length, 1, `${display}: and polls`);
      cleanups.pop()();
      assert.equal(timers.length, 0, `${display}: the poll stops on cleanup`);
    }
  } finally {
    React.useEffect = saved.useEffect; React.useState = saved.useState; global.window = saved.window;
    global.setInterval = saved.setInterval; global.clearInterval = saved.clearInterval;
  }
});

// ─── F8 ─────────────────────────────────────────────────────────────────────────────

test('F8: a restored, unconfirmed pool with numeric figures offers NO remainingPercent, and says "not current"', () => {
  const now = T0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  tracker.restore(obs(1, T0, std(80, 60)), null);
  const restored = tracker.pool(POOL);
  assert.equal(restored.stateReason, 'RESTORED_UNCONFIRMED');
  assert.ok(restored.windows.every((w) => typeof w.remainingPercent === 'number'), 'the figures are numeric');
  // Today the tracker ALSO ages a restored reading (staleAt = mono - 1), so freshness alone
  // already refuses it. The projection's `&& !restored` gate must hold on its own, so it is
  // pinned against a restored pool whose freshness verdict reads FRESH.
  assert.equal(restored.freshness, 'STALE');
  for (const pool of [restored, { ...restored, freshness: 'FRESH' }]) {
    const v = capacityDetailView({ pool, poolId: 'pool-x', poolLabel: 'Codex', presentation: 'UNKNOWN', members: [],
      membershipKnown: true, statusNote: null, now, formatTime: (t) => `@${t - T0}` });
    assert.equal(v.windows.length, 2);
    for (const w of v.windows) {
      assert.ok(!('remainingPercent' in w), `${pool.freshness} ${w.label}: no current figure`);
      assert.match(w.text, /% remaining · not current$/);
    }
  }
});

// ─── F9 ─────────────────────────────────────────────────────────────────────────────

test('F9 (crit 16): an attributed window id matching NO window gets the observational cause, never an invented one', () => {
  const presenter = new CapacityStripPresenter({ idKey: Buffer.alloc(32, 4) });
  const pool = { poolKey: POOL, provider: 'codex', accountScope: 'acct', limitId: 'codex', state: 'LIMITED',
    stateReason: 'PROVIDER_ATTRIBUTED_LIMITING', providerAttributedLimitingWindowId: 'no_such_window',
    windows: std(63, 0), freshness: 'FRESH', observedAt: T0 };
  const intent = { kind: 'LIMIT_REACHED', poolKey: POOL, provider: 'codex', from: 'AVAILABLE', to: 'LIMITED',
    stateReason: 'PROVIDER_ATTRIBUTED_LIMITING', limitEpochAt: null, identity: 'i', at: T0 };
  const toast = presenter.toastFor(intent, pool);
  assert.ok(!/reports the .* limit reached/.test(toast.body), `no invented attribution: "${toast.body}"`);
  assert.ok(!/Weekly|5h/.test(toast.body), 'no window is named at all');
  assert.match(toast.body, /^A limit on Codex is in effect and has not cleared yet\./);
  // Control: with the id matching a real window, the causal wording is used.
  const named = presenter.toastFor(intent, { ...pool, providerAttributedLimitingWindowId: 'seven_day' });
  assert.match(named.body, /^Codex reports the Weekly limit reached\./);
});

// ─── F10 ────────────────────────────────────────────────────────────────────────────

/** Walk a function-component element tree (no DOM) and collect elements matching `pick`. */
function find(node, pick, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => find(n, pick, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.type === 'function') return find(node.type(node.props), pick, out);
  if (pick(node)) out.push(node);
  find(node.props?.children, pick, out);
  return out;
}

test('F10: the banner x dismisses by NOTICE id (not pool id), and the connected banner forwards it to main', () => {
  const { CapacityLimitBannerView } = loadTs('src/renderer/src/components/CapacityLimitBanner.tsx');
  const got = [];
  const items = [{ poolId: 'pool-aaa', noticeId: 'notice-bbb', banner: { title: 't', cause: 'c', consequence: 'q' } }];
  const tree = CapacityLimitBannerView({ items, onDismiss: (id) => got.push(id) });
  const buttons = find(tree, (n) => n.type === 'button' && typeof n.props.onClick === 'function');
  assert.equal(buttons.length, 1, 'one dismiss control');
  buttons[0].props.onClick();
  assert.deepEqual(got, ['notice-bbb'], 'the dismissal names the notice');
  const src = codeOnly(readSource('src/renderer/src/components/CapacityLimitBanner.tsx'), 'CapacityLimitBanner.tsx');
  assert.match(src, /onDismiss=\{\(id\) => \{ void dismissCapacityNotice\(id\); \}\}/, 'the connected banner forwards that id to main');
  const hook = codeOnly(readSource('src/renderer/src/capacity/useCapacityStrip.ts'), 'useCapacityStrip.ts');
  assert.match(hook, /export function dismissCapacityNotice\(noticeId: string\)/);
});

// ─── T7 ─────────────────────────────────────────────────────────────────────────────

test('T7: notifications OFF on an unsupported platform records SUPPRESSED - the setting is checked first', () => {
  let asked = 0;
  const d = deliverCapacityToast({ title: 'Codex limited', body: 'x' },
    { notificationsOn: () => false, supported: () => { asked++; return false; }, show: () => { throw new Error('never'); } });
  assert.equal(d, 'SUPPRESSED');
  assert.equal(asked, 0, 'the platform is not even asked while the setting is off');
});

// ─── M2 ─────────────────────────────────────────────────────────────────────────────

test('M2: the token-limit editor tooltip says the limit is not applied while the line shows 5H or Weekly', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CommandCenterPanel.tsx'), 'CommandCenterPanel.tsx');
  assert.match(src, /title=\{`Set this agent's total token limit\$\{usageCapable \? ' — not applied while this line shows 5H or Weekly' : ''\}`\}/);
  assert.match(src, /<TokenLimitEditor value=\{agentCap\} onSet=\{\(t\) => setAgentCap\(a\.id, t\)\} usageCapable=\{usageCapable\} \/>/,
    'fed by the same usageCapable that offers the 5H / Weekly select');
});
