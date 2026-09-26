// HEAVY-SETTING-NOT-SHOWN (1.1.56 live): "Heavy jobs at once" saved as 2 (main's config.json had it,
// and the live lock read limit 2) but Settings showed the old value on reopen. Root cause: App
// handed SettingsModal the config snapshot it loaded ONCE at startup; the modal seeds its controls
// from that prop on mount and saves straight to main, so every setting saved since launch read stale.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-settings-fresh-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const { heavyLimit } = loadTs('src/main/heavyJob.ts');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

test('MAIN: heavyJobsAtOnce round-trips through the config file (2, Off, back to 1), and the lock reads it live', () => {
  for (const v of [2, 'off', 1]) {
    writeConfig({ heavyJobsAtOnce: v });
    assert.equal(readConfig().heavyJobsAtOnce, v, `saved ${v}`);
    assert.equal(heavyLimit(readConfig().heavyJobsAtOnce), v, 'the lock limit follows at once');
  }
});

test('SELECT: every value the setting can hold is an option of the select (String(v)), and the change handler maps back to the same value', () => {
  const ui = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(ui, /value=\{String\(heavyAtOnce\)\}/);
  assert.match(ui, /onChange=\{\(e\) => \{ void saveHeavyAtOnce\(e\.target\.value === 'off' \? 'off' : Number\(e\.target\.value\)\); \}\}/);
  const numbers = JSON.parse(ui.match(/\{(\[[\d, ]+\])\.map\(\(n\) => <option key=\{n\} value=\{String\(n\)\}>/)[1]);
  const options = ['off', ...numbers.map(String)];
  const fromOption = (s) => (s === 'off' ? 'off' : Number(s));
  for (const v of ['off', 1, 2, 3, 4, 6, 8]) {
    assert.ok(options.includes(String(v)), `${v} is selectable`);
    assert.equal(fromOption(String(v)), v, `${v} round-trips`);
  }
});

test('APP: Settings is mounted with a FRESH config read from main each time it opens (not the startup snapshot), so a saved value shows on reopen', () => {
  const app = read('src/renderer/src/App.tsx');
  // the modal gets the fresh copy, and only once it is in hand (it seeds its state on mount)
  assert.match(app, /\{settingsOpen && settingsConfig && \(\s*<SettingsModal\s+config=\{settingsConfig\}/);
  assert.ok(!/<SettingsModal\s+config=\{config\}/.test(app), 'never the startup snapshot');
  // re-read on every open; cleared on close so the next open reads again
  assert.match(app, /if \(!settingsOpen\) \{ setSettingsConfig\(null\); return; \}/);
  assert.match(app, /window\.cth\.getConfig\(\)\s*\.then\(\(fresh\) => \{ if \(!cancelled\) \{ setSettingsConfig\(fresh\); setConfig\(fresh\); \} \}\)/);
  assert.match(app, /\}, \[settingsOpen\]\);/);
});

test('SEED: the modal seeds "Heavy jobs at once" from the config it is handed (so the fresh copy decides what shows)', () => {
  const ui = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(ui, /useState<number \| 'off'>\(cfgX\.heavyJobsAtOnce \?\? 1\)/);
});
