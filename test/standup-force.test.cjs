'use strict';

/**
 * TE0 — the force path (`missions:runNow`).
 *
 * The delta gate can only ever SUPPRESS a dispatch, so it needs an override, and
 * before TE0 the Schedules panel had no run-now control of any kind: the only way
 * to make a mission fire was to wait out its interval. These arms pin the three
 * things that make the override real — it reaches main, it passes `forced`, and
 * the button exists for a human to press.
 *
 * The IPC handler and the fire() closure both need a live Electron main, so the
 * evidence here is STRUCTURAL, against the sources. That is weaker than running
 * it, and it is labelled that way rather than dressed up: what these arms catch
 * is the wiring being cut, not the runtime behaviour being wrong. The decision
 * layer's own `forced` branch is covered behaviourally in standup-delta.test.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const INDEX_TS = read('src', 'main', 'index.ts');
const PRELOAD_TS = read('src', 'preload', 'index.ts');
const PANEL_TSX = read('src', 'renderer', 'src', 'components', 'triggers', 'SchedulesSection.tsx');

test('STRUCTURAL: runNow forces the dispatch rather than merely firing it', () => {
  const handler = INDEX_TS.slice(
    INDEX_TS.indexOf("ipcMain.handle('missions:runNow'"),
    INDEX_TS.indexOf("ipcMain.handle('hive:textSearch'"));
  assert.ok(handler.length > 0, 'found the runNow handler');
  assert.match(handler, /entry\.fire\(true\)/,
    'forced=true is the whole point — fire() without it would be re-gated and could suppress');
  assert.match(handler, /return \{ ok: false, error: 'mission is not armed for dispatch' \}/,
    'an unarmed or unknown mission is refused, not silently ignored');
  assert.match(handler, /syncMissions\(\);/,
    're-sync, or the panel advertises a next run derived from a lastFiredAt the timer never honoured');
});

test('STRUCTURAL: every armed dispatch mission registers its fire, including weekly', () => {
  const sync = INDEX_TS.slice(
    INDEX_TS.indexOf('function syncMissions(): void {'),
    INDEX_TS.indexOf('// ─── Context trigger'));
  assert.ok(sync.length > 0, 'found syncMissions');
  const register = sync.indexOf('entry.fire = fire;');
  const weeklyBranch = sync.indexOf('if (weekly) {');
  assert.ok(register > 0, 'the fire is registered on the timer entry');
  assert.ok(register < weeklyBranch,
    'registered BEFORE the weekly branch, which returns early — a weekly mission needs run-now too');
  // Position alone is not enough: `if (!weekly) entry.fire = fire;` would still sit
  // above the branch and still leave every weekly mission without a run-now. The
  // registration has to be UNCONDITIONAL, so match the whole line.
  assert.match(sync, /\n\s*entry\.fire = fire;\r?\n/,
    'the registration is a statement of its own, not hung off a condition');
});

test('the bridge exposes runMissionNow', () => {
  assert.match(PRELOAD_TS, /runMissionNow: \(missionId: string\)/);
  assert.match(PRELOAD_TS, /ipcRenderer\.invoke\('missions:runNow', missionId\)/);
});

test('the Schedules row has a run-now control a human can actually find', () => {
  // The zero-UI alternative (a sentinel file the scheduler consumes) would have
  // satisfied "manual force" on paper while leaving the operator no way to
  // discover it. The button is the requirement.
  assert.match(PANEL_TSX, /window\.cth\.runMissionNow\(mission\.id\)/);
  assert.match(PANEL_TSX, /'run now'/);
  assert.match(PANEL_TSX, /ran === 'sent' \? 'sent' : ran === 'blocked' \? 'not armed'/,
    'and it reports back — a button that always looks the same cannot say it failed');
});
