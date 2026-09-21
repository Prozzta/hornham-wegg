'use strict';

/**
 * v1.1.45 unit #8 — the C2.8 capacity-display threshold: the input contract, its
 * persistence, and that the SETTING (not a constant) drives the strip's weekly reveal and
 * both windows' reset hints, live, as a presentation-only change.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const th = loadTs('src/shared/capacityThreshold.ts');

// ─── The input contract (C2.8, C2.11 crit 3) ───────────────────────────────────────

test('only integers 1-99 are valid; everything else is refused, never clamped or rounded', () => {
  for (const [v, want] of [[1, 1], [15, 15], [99, 99], ['15', 15], [' 42 ', 42], ['07', 7]]) {
    assert.equal(th.parseCapacityDisplayThreshold(v), want, `${JSON.stringify(v)}`);
  }
  for (const v of [0, 100, -1, 14.9, 15.5, NaN, Infinity, '', '  ', 'abc', '1.5', '15%', '-3', '0', '100', null, undefined, true, {}]) {
    assert.equal(th.parseCapacityDisplayThreshold(v), null, `${JSON.stringify(v)} must be refused (no off, no clamp)`);
  }
  assert.equal(th.DEFAULT_CAPACITY_DISPLAY_THRESHOLD, 15);
});

test('a stored value in force only when valid; an invalid stored value falls back to the default, not a repair', () => {
  assert.equal(th.capacityDisplayThresholdOf({ capacityWeeklyDisplayThreshold: 30 }), 30);
  for (const bad of [0, 150, 14.5, 'x', undefined]) {
    assert.equal(th.capacityDisplayThresholdOf({ capacityWeeklyDisplayThreshold: bad }), 15, `${bad} -> default, never clamped`);
  }
  assert.equal(th.capacityDisplayThresholdOf(null), 15);
});

// ─── Persistence ───────────────────────────────────────────────────────────────────

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cap-threshold-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const { readConfig, writeConfig, setCapacityDisplayThreshold } = loadTs('src/main/config.ts');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('persist: a valid value is written to disk and survives a restart (a fresh read of the file)', () => {
  writeConfig({ notifications: true });
  const returned = setCapacityDisplayThreshold(30);
  assert.equal(returned.capacityWeeklyDisplayThreshold, 30);
  const files = fs.readdirSync(userData, { recursive: true }).map(String).filter((f) => f.endsWith('config.json'));
  assert.ok(files.length >= 1, 'a config file exists');
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, files[0]), 'utf8'));
  assert.equal(onDisk.capacityWeeklyDisplayThreshold, 30, 'on disk, so a restart reads it back');
  assert.equal(th.capacityDisplayThresholdOf(readConfig()), 30);
  assert.equal(readConfig().notifications, true, 'nothing else is disturbed');
});

test('persist: invalid input is REFUSED and the stored value is left exactly as it was', () => {
  setCapacityDisplayThreshold(40);
  for (const bad of [0, 100, 14.9, '', 'abc', NaN, null, undefined]) {
    assert.throws(() => setCapacityDisplayThreshold(bad), /invalid capacity display threshold/);
    assert.equal(readConfig().capacityWeeklyDisplayThreshold, 40, `${JSON.stringify(bad)} did not replace the last valid value`);
  }
});

// ─── The SETTING drives the strip, live, presentation-only ─────────────────────────

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const T0 = 1_800_000_000_000;
const POOL = 'codex:a:codex';
const win = (id, kind, remaining) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: 100 - remaining, remainingPercent: remaining,
  resetsAt: kind === 'FIVE_HOUR' ? T0 + 3_600_000 : T0 + 86_400_000 * 3 });

/** A presenter wired EXACTLY as main wires it: the threshold read from the config store. */
function stripFromSetting() {
  let now = T0;
  let seq = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter({
    weeklyThreshold: () => th.capacityDisplayThresholdOf(readConfig()),
    formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 2)
  });
  const present = () => presenter.present({ snapshot: tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now }).pools[0];
  const read = (five, weekly) => {
    now += 1000;
    tracker.ingest({ poolKey: POOL, streamId: 's', sourceSequence: ++seq, provider: 'codex', accountScope: 'a', limitId: 'codex',
      source: 'codex-rollout', observedAt: now, receivedAt: now, windows: [win('five_hour', 'FIVE_HOUR', five), win('seven_day', 'SEVEN_DAY', weekly)],
      providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: null });
    return present();
  };
  return { read, present };
}

test('C2.11 crit 2 through the SETTING at 15: 14.9 reveals, 15.0 does not; 19.9 holds, 20.0 hides', () => {
  setCapacityDisplayThreshold(15);
  assert.ok(!('weekly' in stripFromSetting().read(80, 15.0)));
  const s = stripFromSetting();
  assert.equal(s.read(80, 14.9).weekly.reason, 'BELOW_DISPLAY_THRESHOLD');
  assert.equal(s.read(80, 19.9).weekly.reason, 'HYSTERESIS_HOLD');
  assert.ok(!('weekly' in s.read(80, 20.0)));
});

test('the SETTING drives the weekly reveal AND both reset hints; a change applies live and moves presentation only', () => {
  setCapacityDisplayThreshold(15);
  const s = stripFromSetting();
  const before = s.read(45, 40);
  assert.ok(!('weekly' in before), 'at T=15, weekly 40% is hidden');
  assert.ok(!('resetText' in before.fiveHour), 'at T=15, a 45% 5h has no reset hint');
  setCapacityDisplayThreshold(50);
  const after = s.present();
  assert.equal(after.weekly.reason, 'BELOW_DISPLAY_THRESHOLD', 'at T=50, weekly 40% is revealed - by the SETTING');
  assert.equal(after.weekly.resetText, 'reset expected ~@259200000', 'and carries its reset hint');
  assert.equal(after.fiveHour.resetText, 'reset expected ~@3600000', 'the 5h at 45% gets its reset hint too');
  assert.equal(after.domainRevision, before.domainRevision, 'presentation only: the domain revision is untouched');
  assert.equal(after.revision, before.revision + 1, 'the presentation revision moves once');
  setCapacityDisplayThreshold(15);
});

test('main wiring: the presenter reads the setting (lazily, then cached); the setter refreshes it and pushes live', () => {
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(main, /\(capacityDisplayThreshold \?\?= capacityDisplayThresholdOf\(readConfig\(\)\)\)/);
  assert.match(main, /new CapacityStripPresenter\(\{ weeklyThreshold: capacityThresholdNow \}\)/);
  const start = main.indexOf("ipcMain.handle('config:setCapacityDisplayThreshold'");
  const handler = main.slice(start, main.indexOf('});', start));
  assert.ok(start > 0);
  assert.match(handler, /const next = setCapacityDisplayThreshold\(value\);\s*capacityDisplayThreshold = capacityDisplayThresholdOf\(next\);\s*pushCapacityStrip\(\);/);
  assert.match(readSource('src/preload/index.ts'), /ipcRenderer\.invoke\('config:setCapacityDisplayThreshold', value\)/);
  const strip = codeOnly(readSource('src/main/capacityStrip.ts'), 'capacityStrip.ts');
  assert.ok(!/\b15\b/.test(strip), 'no literal 15 left in the presenter: the default lives in shared/capacityThreshold.ts');
});

// ─── The control ───────────────────────────────────────────────────────────────────

const ui = loadTs('src/renderer/src/components/CapacityDisplaySetting.tsx');

test('the control: set only a valid integer; invalid shows a message and keeps the stored value', () => {
  assert.deepEqual(ui.decideThresholdCommit('30', 15), { kind: 'save', value: 30 });
  assert.deepEqual(ui.decideThresholdCommit('15', 15), { kind: 'unchanged' });
  for (const bad of ['0', '100', '14.9', '', 'off', '-5', '15%']) {
    const d = ui.decideThresholdCommit(bad, 22);
    assert.equal(d.kind, 'invalid', `${bad}`);
    assert.equal(d.message, 'Enter a whole number from 1 to 99. The current value (22) is unchanged.');
  }
});

test('the copy: C2.8-derived, no forbidden label or claim, no off switch', () => {
  const html = renderToStaticMarkup(React.createElement(ui.CapacityDisplaySetting));
  assert.ok(html.includes('Provider capacity display'));
  assert.ok(html.includes('Show provider capacity detail below'));
  assert.ok(html.includes('% remaining'));
  assert.match(html, /value="15"/, 'shows the default until main answers');
  const copy = Object.values(ui.CAPACITY_DISPLAY_COPY).filter((v) => typeof v === 'string').join(' ');
  for (const forbidden of [/weekly limit threshold/i, /binding threshold/i, /safety threshold/i, /circuit-breaker threshold/i,
    /becomes binding/i, /safe above/i, /(pause|hold|route) below/i, /disable weekly limits/i, /weekly warning threshold/i]) {
    assert.ok(!forbidden.test(copy), `C2.8 forbids ${forbidden}`);
  }
  assert.match(copy, /Display only: it does not change provider limits, scheduling, routing, circuit breakers, or determine which window is limiting\./);
  assert.ok(!/\boff\b/i.test(html), 'there is no off state');
});

test('placement (C2.8): Settings -> General, directly after Notifications, not beside the breaker or budget', () => {
  const settings = codeOnly(readSource('src/renderer/src/components/SettingsModal.tsx'), 'SettingsModal.tsx');
  const notif = settings.indexOf('Desktop notifications');
  const cap = settings.indexOf('<CapacityDisplaySetting />');
  const next = settings.indexOf('Scheduled auto-compact') >= 0 ? settings.indexOf('Scheduled auto-compact') : Infinity;
  const budget = settings.indexOf('floor token budget');
  assert.ok(notif > 0 && cap > notif, 'after Notifications');
  assert.ok(!/<div|<section/.test(settings.slice(settings.indexOf('</PixelButton>', notif), cap).replace(/<div style=\{\{ height: 1[^>]*\/>/, '').replace(/<\/div>/g, '')),
    'nothing but the section divider sits between Notifications and it');
  assert.ok(cap < next || next === Infinity);
  assert.ok(budget < 0 || Math.abs(budget - cap) > 2000, 'not adjacent to the breaker budget controls');
});
