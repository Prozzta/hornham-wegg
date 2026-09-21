'use strict';

/**
 * v1.1.45 unit #5 — agent-card impact: the wiring and the rendering.
 *
 * The WORDING (one blessed string per hold kind, never idle, no figure, nothing when
 * nothing is held) is pinned beside deliveryHold's own wording, with its killers and
 * mutant census, in test/delivery-hold.test.cjs. This file pins what surrounds it:
 * main names the pool with the strip's OWN label and takes no pool data onto the
 * per-agent snapshot, and the renderer shows main's string where "idle" would have been.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { agentImpactOf } = loadTs('src/shared/deliveryHold.ts');
const { impactBadge, RESTING_STATUSES } = loadTs('src/renderer/src/components/agentImpactView.ts');
const { PixelBadge } = loadTs('src/renderer/src/components/PixelBadge.tsx');

const T0 = 1_800_000_000_000;
const obs = (account, reached) => ({
  poolKey: `codex:${account}:codex`, streamId: account, sourceSequence: 1, provider: 'codex', accountScope: account,
  limitId: 'codex', source: 'codex-rollout', observedAt: T0, receivedAt: T0,
  windows: [
    { windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300, usedPercent: 40, remainingPercent: 60, resetsAt: T0 + 3_600_000 },
    { windowId: 'seven_day', kind: 'SEVEN_DAY', label: 'Weekly', windowMinutes: 10080, usedPercent: 50, remainingPercent: 50, resetsAt: T0 + 86_400_000 }
  ],
  providerAttributedLimitingWindowId: null, providerReachedType: reached ? 'usage' : null, ordinaryUsageAllowed: null, planType: null
});

const held = (poolLabel, state = 'LIMITED') =>
  agentImpactOf({ interfered: false, autoDeliveryPaused: false, capacityHold: true,
    capacityEvidence: 'FRESH_NOT_HEALTHY', poolState: state, poolLabel });

// ─── Main: the pool is named with the strip's own label ─────────────────────────

test('the card names a pool EXACTLY as the strip does — a second Codex account reads "Codex 2" on both', () => {
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => T0, () => T0);
  tracker.ingest(obs('acct-a', false));
  tracker.ingest(obs('acct-b', true));
  const presenter = new CapacityStripPresenter({ idKey: Buffer.alloc(32, 3) });
  const strip = presenter.present({ snapshot: tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now: T0 });
  const b = tracker.pool('codex:acct-b:codex');
  assert.equal(b.state, 'LIMITED');
  const label = presenter.labelOf(b);
  assert.equal(label, 'Codex 2');
  assert.ok(strip.pools.some((p) => p.poolLabel === label), 'the strip shows the same label for that pool');
  assert.equal(held(label).text, 'paused · Codex 2 limited');
  assert.equal(presenter.labelOf(tracker.pool('codex:acct-a:codex')), 'Codex', 'the first account keeps the plain label');
});

test('main: control:snapshot carries the impact, built from its OWN settled facts and a pool LABEL only', () => {
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const start = main.indexOf("ipcMain.handle('control:snapshot'");
  const handler = main.slice(start, main.indexOf('});', start));
  assert.match(handler, /agentImpactFor\(snap\.autoDeliveryPaused, gate, interfered !== null, probed\.poolKey\)/,
    'the impact is derived from the same gate, pause and INTERFERED the snapshot reports');
  assert.match(handler, /return \{ \.\.\.snap, capacityHold: gate\.holds, capacityEvidence: gate\.evidence, interfered, impact \}/);
  const fnStart = main.indexOf('function agentImpactFor(');
  const fn = main.slice(fnStart, main.indexOf('\n}\n', fnStart));
  assert.ok(fnStart > 0);
  assert.match(fn, /poolLabel: pool \? capacityStrip\.labelOf\(pool\) : null/, 'the strip presenter\'s label, nothing invented');
  assert.match(fn, /poolState: pool\?\.state \?\? null/);
  assert.ok(!/current\(\)|presentCapacityStrip|weekly|fiveHour|remainingPercent|windows|resetsAt|freshness/.test(fn),
    'agent-scoped: no pool DATA (figures, windows, resets, freshness) on the per-agent snapshot');
});

// ─── Renderer: main's string where "idle" would have been ─────────────────────────

test('a held resting agent shows main\'s leading word as its badge and main\'s string as its context', () => {
  const impact = held('Codex');
  for (const status of RESTING_STATUSES) {
    const v = impactBadge(status, impact);
    assert.equal(v.label, 'paused');
    assert.equal(v.status, 'blocked');
    assert.equal(v.impactText, 'paused · Codex limited');
    const html = renderToStaticMarkup(React.createElement(PixelBadge, { status: v.status, label: v.label }));
    assert.ok(!/\bidle\b/.test(html), `a held agent's badge must not read idle: ${html}`);
    assert.ok(html.includes('paused'));
  }
  const waiting = agentImpactOf({ interfered: false, autoDeliveryPaused: false, capacityHold: true,
    capacityEvidence: 'RECOVERING', poolState: 'RECOVERING', poolLabel: 'Codex' });
  assert.equal(impactBadge('idle', waiting).status, 'waiting');
});

test('unchanged when nothing is held, and unchanged for a working agent or a user draft', () => {
  assert.deepEqual(impactBadge('idle', null), { status: 'idle', impactText: null });
  const impact = held('Codex');
  for (const status of ['working', 'thinking', 'typing', 'blocked', 'compacting']) {
    assert.deepEqual(impactBadge(status, impact), { status, impactText: null }, `${status} keeps its own badge`);
  }
});

test('the card and both Command Center badges read the impact; one poller serves them all', () => {
  const card = codeOnly(readSource('src/renderer/src/components/AgentCard.tsx'), 'AgentCard.tsx');
  assert.match(card, /impactBadge\(typing \? 'typing' : status, useAgentImpact\(agentId\)\)/);
  assert.match(card, /<PixelBadge status=\{held\.status\} label=\{held\.label\}/);
  assert.match(card, /const infoLine = held\.impactText \?\?/);
  assert.match(codeOnly(readSource('src/renderer/src/components/AgentStrip.tsx'), 'AgentStrip.tsx'), /agentId=\{a\.id\}/);
  const cc = codeOnly(readSource('src/renderer/src/components/CommandCenterPanel.tsx'), 'CommandCenterPanel.tsx');
  assert.match(cc, /<AgentImpactBadge agentId=\{agent\.id\} status=\{agent\.status\} \/>/);
  assert.match(cc, /<AgentImpactBadge agentId=\{a\.id\} status=\{armed \? 'looping' : a\.status\} showText \/>/);
  assert.ok(!/<PixelBadge status=\{(agent|a)\.status\}/.test(cc), 'no row badge bypasses the impact');
  // Only the one poller reads `.impact` off the snapshot.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'src', 'renderer', 'src');
  const readers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(e.name) && /\?\.impact\b|\bs\.impact\b|snapshot\.impact/.test(codeOnly(readSource(f), e.name))) {
        readers.push(path.relative(root, f).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  assert.deepEqual(readers, ['hooks/useAgentImpact.ts']);
});
