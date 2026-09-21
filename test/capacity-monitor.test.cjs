'use strict';

/**
 * v1.1.45 CAPUI-MONITOR — the Monitor line choice (Budget / 5H / Weekly), its budget
 * exemption, and the per-agent usage projection.
 *
 * THE EXEMPTION IS THE RISKY PART, so it is tested first and against the real breaker:
 * an agent whose line shows 5H or Weekly is FULLY outside the budget (god's floor-blame
 * ruling). Its own per-agent cap is skipped, it can never be blamed for a floor cap,
 * and it does not count toward the floor totals. The behaviour-safety arms still apply
 * to it, and the choice takes effect on the next beat because config is read live.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { CircuitBreaker } = loadTs('src/main/breaker.ts');
const usage = loadTs('src/shared/agentUsage.ts');

const T0 = 1_000_000_000_000;
const sample = (agentId, tokens, usd = 0) =>
  ({ agentId, sessionId: 's', ts: T0, input: tokens, output: 0, cacheRead: 0, cacheCreation: 0, model: 'm', usd });

function breakerWith(over) {
  let cfg = { enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5, tokenVelocityPerMin: 1e12, ...over };
  const b = new CircuitBreaker(() => cfg);
  return { b, set: (o) => { cfg = { ...cfg, ...o }; } };
}
const beat = (b, inputs) => Object.fromEntries(b.tick(inputs.map(([id, tok, usd]) => ({ agentId: id, sample: sample(id, tok, usd), progressing: true })), T0)
  .map((d) => [d.state.agentId, d.state]));

// ─── The exemption rule ─────────────────────────────────────────────────────────

test('only an explicit 5H or Weekly exempts; absent, budget and anything malformed stay under the budget', () => {
  assert.equal(usage.isBudgetExempt('fiveHour'), true);
  assert.equal(usage.isBudgetExempt('weekly'), true);
  for (const v of [undefined, null, 'budget', 'FIVEHOUR', 'five_hour', '', 1, true, {}]) {
    assert.equal(usage.isBudgetExempt(v), false, `${JSON.stringify(v)} must not switch a limit off`);
  }
  assert.deepEqual([...usage.AGENT_USAGE_DISPLAYS], ['budget', 'fiveHour', 'weekly']);
});

// ─── The breaker: per-agent cap ─────────────────────────────────────────────────

test('per-agent cap: skipped for a 5H or Weekly agent, applied for Budget/absent', () => {
  for (const [display, trips] of [[undefined, true], ['budget', true], ['fiveHour', false], ['weekly', false], ['bogus', true]]) {
    const { b } = breakerWith({ agentTokenCaps: { jim: 100 }, agentUsageDisplay: display === undefined ? {} : { jim: display } });
    const s = beat(b, [['jim', 500]]).jim;
    assert.equal(s.level !== 'healthy', trips, `display ${display}: per-agent cap ${trips ? 'applies' : 'is skipped'}`);
    if (trips) assert.match(s.reason, /token limit/);
  }
});

// ─── The breaker: floor caps, blame over NON-exempt agents only ─────────────────

test('floor token cap: an exempt agent is never blamed and does not count toward the floor total', () => {
  // Without exemption: 900+200+100 = 1200 > 500, and the top spender jim is blamed.
  let { b } = breakerWith({ costCapTokens: 500 });
  assert.match(beat(b, [['jim', 900], ['pam', 200], ['dwight', 100]]).jim.reason, /token cap/);
  // jim exempt: the floor is pam + dwight = 300, under 500, so NOBODY is blamed.
  ({ b } = breakerWith({ costCapTokens: 500, agentUsageDisplay: { jim: 'weekly' } }));
  const out = beat(b, [['jim', 900], ['pam', 200], ['dwight', 100]]);
  for (const id of ['jim', 'pam', 'dwight']) assert.equal(out[id].level, 'healthy', `${id} is not blamed: the floor total excludes jim`);
  // Cap 250: the non-exempt floor (300) is over it, so the top NON-exempt spender pam is blamed, never jim.
  ({ b } = breakerWith({ costCapTokens: 250, agentUsageDisplay: { jim: 'fiveHour' } }));
  const over = beat(b, [['jim', 900], ['pam', 200], ['dwight', 100]]);
  assert.equal(over.jim.level, 'healthy', 'the exempt agent is never blamed');
  assert.match(over.pam.reason, /token cap: floor total over 250 tokens/);
  assert.equal(over.dwight.level, 'healthy');
});

test('floor $ cap: the same — exempt agents are outside the total and the blame', () => {
  let { b } = breakerWith({ costCapUsd: 5, agentUsageDisplay: { jim: 'weekly' } });
  const out = beat(b, [['jim', 0, 9], ['pam', 0, 2], ['dwight', 0, 1]]);
  for (const id of ['jim', 'pam', 'dwight']) assert.equal(out[id].level, 'healthy', `${id}: non-exempt floor $3 is under $5`);
  ({ b } = breakerWith({ costCapUsd: 2.5, agentUsageDisplay: { jim: 'weekly' } }));
  const over = beat(b, [['jim', 0, 9], ['pam', 0, 2], ['dwight', 0, 1]]);
  assert.equal(over.jim.level, 'healthy');
  assert.match(over.pam.reason, /cost cap/);
});

test('behaviour-safety arms still apply to an exempt agent (looping)', () => {
  const { b } = breakerWith({ agentUsageDisplay: { jim: 'fiveHour' } });
  for (let i = 0; i < 9; i++) b.recordToolUse('jim', 'Bash', { command: 'same' });
  assert.match(beat(b, [['jim', 10]]).jim.reason, /looping/, 'exemption is from the BUDGET only');
});

test('the choice applies on the NEXT beat, no restart (config is read live)', () => {
  const { b, set } = breakerWith({ agentTokenCaps: { jim: 100 } });
  assert.notEqual(beat(b, [['jim', 500]]).jim.level, 'healthy', 'under Budget the cap trips');
  set({ agentUsageDisplay: { jim: 'fiveHour' } });
  const next = beat(b, [['jim', 500]]).jim;
  assert.notEqual(next.reason, '', 'sanity');
  assert.match(next.reason, /recovering/, 'the next beat no longer trips on the budget: it recovers');
  set({ agentUsageDisplay: {} });
  assert.match(beat(b, [['jim', 500]]).jim.reason, /token limit/, 'back to Budget, the cap applies again');
});

// ─── Persistence: the config setter ─────────────────────────────────────────────

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-display-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const { readConfig, writeConfig, setAgentUsageDisplay } = loadTs('src/main/config.ts');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('persist: 5H/Weekly are stored per agent against the latest config; Budget is stored as ABSENT', () => {
  writeConfig({ agentUsageDisplay: { existing: 'weekly' }, agentTokenCaps: { jim: 100 } });
  setAgentUsageDisplay('jim', 'fiveHour');
  setAgentUsageDisplay('pam', 'weekly');
  assert.deepEqual(readConfig().agentUsageDisplay, { existing: 'weekly', jim: 'fiveHour', pam: 'weekly' });
  setAgentUsageDisplay('pam', 'budget');
  assert.deepEqual(readConfig().agentUsageDisplay, { existing: 'weekly', jim: 'fiveHour' }, 'budget = the default = absent');
  assert.deepEqual(readConfig().agentTokenCaps, { jim: 100 }, 'the per-agent cap itself is kept, only not applied');
});

test('persist: an invalid agent or value never reaches the config', () => {
  writeConfig({ agentUsageDisplay: { jim: 'weekly' } });
  for (const [id, v] of [['', 'weekly'], ['  ', 'fiveHour'], [7, 'weekly'], ['jim', 'FIVEHOUR'], ['jim', undefined], ['jim', 'monthly']]) {
    assert.throws(() => setAgentUsageDisplay(id, v), /invalid agent usage display/);
  }
  assert.deepEqual(readConfig().agentUsageDisplay, { jim: 'weekly' });
});

test('main wiring: the breaker gets agentUsageDisplay live, and the setter has its own IPC', () => {
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(main, /agentTokenCaps: c\.agentTokenCaps,\s*agentUsageDisplay: c\.agentUsageDisplay/);
  assert.match(main, /ipcMain\.handle\('config:setAgentUsageDisplay', \(_evt, agentId: unknown, display: unknown\) =>\s*setAgentUsageDisplay\(agentId, display\)/);
  assert.match(readSource('src/preload/index.ts'), /ipcRenderer\.invoke\('config:setAgentUsageDisplay', agentId, display\)/);
});

// ─── (iii) The usage projection, on its OWN channel ──────────────────────────────

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { agentUsageView } = loadTs('src/main/capacityAgentUsage.ts');
const TU = 1_800_000_000_000;
const ACCOUNT = 'acct-SECRET-9d2';
const POOL = `codex:${ACCOUNT}:codex`;
const uwin = (id, kind, remaining) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining, resetsAt: TU + 3_600_000 });
function trackedPool(five, weekly, { stale = false, restore = false, windows } = {}) {
  let now = TU;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const obs = { poolKey: POOL, streamId: 's', sourceSequence: 1, provider: 'codex', accountScope: ACCOUNT, limitId: 'codex',
    source: 'codex-rollout', observedAt: TU, receivedAt: TU,
    windows: windows ?? [uwin('five_hour', 'FIVE_HOUR', five), uwin('seven_day', 'SEVEN_DAY', weekly)],
    providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: null };
  if (restore) tracker.restore(obs, null); else tracker.ingest(obs);
  if (stale) { now += L0_SEM_POLICY.liveTtlMs + 10; tracker.evaluate(); }
  return { pool: tracker.pool(POOL), now };
}
const fmt = (t) => `@${t - TU}`;

test('usage: USED is computed in main as 100 - remaining, rounded UP (never understated)', () => {
  const { pool, now } = trackedPool(80.6, 60);
  const v = agentUsageView(pool, now, fmt);
  assert.deepEqual(usage.validateAgentUsageView(v), []);
  assert.equal(v.fiveHour.kind, 'USAGE');
  assert.ok(Math.abs(v.fiveHour.usedPercent - 19.4) < 1e-9);
  assert.equal(v.fiveHour.displayPercent, 20, '80.6 remaining reads 20 used: it pairs with the strip 80 remaining');
  assert.equal(v.fiveHour.text, '5h · 20% used');
  assert.equal(v.fiveHour.state, 'AVAILABLE');
  assert.equal(v.weekly.text, 'Weekly · 40% used');
});

test('usage: anything that is not a fresh, valid reading is TEXT with no figure', () => {
  assert.deepEqual(agentUsageView(null, TU, fmt), {
    fiveHour: { kind: 'TEXT', text: '5h · no reading yet' }, weekly: { kind: 'TEXT', text: 'Weekly · no reading yet' } });
  const stale = trackedPool(80, 60, { stale: true });
  assert.deepEqual(agentUsageView(stale.pool, stale.now, fmt).fiveHour, { kind: 'TEXT', text: '5h · usage unknown · last update @0' });
  const restored = trackedPool(80, 60, { restore: true });
  assert.deepEqual(agentUsageView(restored.pool, restored.now, fmt).weekly, { kind: 'TEXT', text: 'Weekly · no live reading since restart' });
  const noWeekly = trackedPool(0, 0, { windows: [uwin('five_hour', 'FIVE_HOUR', 70)] });
  assert.deepEqual(agentUsageView(noWeekly.pool, noWeekly.now, fmt).weekly, { kind: 'TEXT', text: 'Weekly · not reported' });
  const invalid = trackedPool(0, 0, { windows: [uwin('five_hour', 'FIVE_HOUR', 70), uwin('seven_day', 'SEVEN_DAY', null)] });
  const iv = agentUsageView(invalid.pool, invalid.now, fmt);
  assert.equal(iv.weekly.kind, 'TEXT', 'a missing figure is never drawn as a bar');
  for (const v of [agentUsageView(null, TU, fmt), agentUsageView(stale.pool, stale.now, fmt), iv]) {
    assert.deepEqual(usage.validateAgentUsageView(v), []);
  }
});

test('usage schema: additionalProperties false; no pool key, account, remaining or threshold can ride along', () => {
  const { pool, now } = trackedPool(80, 60);
  const v = agentUsageView(pool, now, fmt);
  const json = JSON.stringify(v);
  assert.ok(!json.includes(ACCOUNT) && !json.includes(POOL), 'no account identifier on the usage channel');
  const bad = (fn) => { const c = JSON.parse(json); fn(c); return usage.validateAgentUsageView(c); };
  const cases = [
    ['a pool key', (c) => { c.poolKey = POOL; }],
    ['a remaining figure', (c) => { c.fiveHour.remainingPercent = 80; }],
    ['a threshold', (c) => { c.weekly.threshold = 15; }],
    ['a figure on text', (c) => { c.weekly = { kind: 'TEXT', text: 'x', usedPercent: 1 }; }],
    ['used rounded DOWN', (c) => { c.fiveHour.usedPercent = 19.4; c.fiveHour.displayPercent = 19; }],
    ['an out-of-range figure', (c) => { c.fiveHour.usedPercent = 120; }],
    ['a missing window', (c) => { delete c.weekly; }]
  ];
  for (const [name, fn] of cases) assert.notDeepEqual(bad(fn), [], `must reject ${name}`);
});

test('usage channel: its OWN invoke, validated before answering; control:snapshot still carries no pool data', () => {
  assert.equal(usage.CAPACITY_AGENT_USAGE, 'capacity:agentUsage');
  assert.match(readSource('src/preload/index.ts'), /ipcRenderer\.invoke\('capacity:agentUsage', agentId\)/);
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const start = main.indexOf('ipcMain.handle(CAPACITY_AGENT_USAGE');
  const handler = main.slice(start, main.indexOf('});', start));
  assert.ok(start > 0);
  assert.match(handler, /providerCapacity\.poolKeyOf\(agentId\)/, 'the agent OWN pool, from its own readings');
  assert.match(handler, /validateAgentUsageView\(view\)/);
  const snap = main.slice(main.indexOf("ipcMain.handle('control:snapshot'"));
  const snapHandler = snap.slice(0, snap.indexOf('});'));
  assert.ok(!/agentUsage|usedPercent|capacityAgentUsage/.test(snapHandler), 'C2.9: no usage data on control:snapshot');
});

// ─── (iv) The Monitor line ─────────────────────────────────────────────────────

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const line = loadTs('src/renderer/src/components/AgentUsageLine.tsx');
const { STRIP_GEOMETRY } = loadTs('src/renderer/src/capacity/stripLayout.ts');
const html = (el) => renderToStaticMarkup(el);

test('the usage bar is the STRIP meter (40x6, continuous), never the 96x8 budget or context bar', () => {
  const { pool, now } = trackedPool(80.6, 60);
  const out = html(React.createElement(line.UsageWindowFigure, { view: agentUsageView(pool, now, fmt).fiveHour }));
  assert.match(out, /role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="19\.[0-9]+" aria-valuetext="5h · 20% used" data-cap-meter="usage"/);
  assert.match(out, new RegExp(`width:${STRIP_GEOMETRY.meter}px;height:6px`));
  assert.ok(!/width:96px|height:8px/.test(out), 'crit 5: not the context or budget geometry');
  assert.ok(out.includes('5h · 20% used'));
});

test('no reading, stale, not reported: text only, no fill', () => {
  for (const view of [agentUsageView(null, TU, fmt).fiveHour, { kind: 'TEXT', text: 'Weekly · not reported' }, null]) {
    const out = html(React.createElement(line.UsageWindowFigure, { view }));
    assert.ok(!/role="meter"|data-cap-meter/.test(out), `no bar for ${JSON.stringify(view)}`);
  }
});

test('the select: budget (default), 5H, Weekly, and its tooltip says 5H and Weekly put the agent OUTSIDE the budget', () => {
  assert.deepEqual(line.USAGE_DISPLAY_OPTIONS.map((o) => o.value), ['budget', 'fiveHour', 'weekly']);
  const out = html(React.createElement(line.AgentUsageSelect, { value: 'weekly', onChange: () => {} }));
  assert.match(out, /<option value="budget">budget<\/option><option value="fiveHour">5H<\/option><option value="weekly" selected="">Weekly<\/option>/);
  assert.match(line.USAGE_SELECT_TITLE, /OUTSIDE the budget/);
  assert.match(line.USAGE_SELECT_TITLE, /Provider capacity limits still apply/);
});

test('Floor tab: select only for Claude and Codex; Budget keeps the old line; 5H and Weekly swap in the usage; persisted via main', () => {
  const cc = codeOnly(readSource('src/renderer/src/components/CommandCenterPanel.tsx'), 'CommandCenterPanel.tsx');
  assert.match(cc, /const usageCapable = agentProvider === 'claude' \|\| agentProvider === 'codex';/);
  assert.match(cc, /const usageDisplay: AgentUsageDisplay = usageCapable \? \(agentUsageDisplay\[a\.id\] \?\? 'budget'\) : 'budget';/);
  assert.match(cc, /\{usageCapable\s*\? <AgentUsageSelect value=\{usageDisplay\} onChange=\{\(v\) => setUsageDisplay\(a\.id, v\)\} \/>/);
  assert.match(cc, /\{usageDisplay === 'budget' \? \(/);
  assert.match(cc, /<AgentUsageWindow agentId=\{a\.id\} display=\{usageDisplay\} \/>/);
  assert.match(cc, /window\.cth\.setAgentUsageDisplay\(id, display\)/);
  assert.match(cc, /setAgentUsageDisplayMap\(c\.agentUsageDisplay \?\? \{\}\)/, 'loaded from the persisted config');
  const settings = readSource('src/renderer/src/components/SettingsModal.tsx');
  assert.match(settings, /Agents set to 5H or Weekly on the Monitor tab are OUTSIDE the budget/, 'the Settings budget says what it bounds');
  const fsx = require('node:fs');
  const root = path.join(__dirname, '..', 'src', 'renderer', 'src');
  const readers = [];
  const walk = (dir) => {
    for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(e.name) && /capacityAgentUsage\(/.test(codeOnly(readSource(f), e.name))) {
        readers.push(path.relative(root, f).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  assert.deepEqual(readers, ['components/AgentUsageLine.tsx'], 'one reader of the usage channel');
});
