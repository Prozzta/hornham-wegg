'use strict';

/**
 * Mutant runner for the capacity display milestone (v1.1.45 units #1, #2 and #5).
 *
 * WHY IT IS COMMITTED (Jim's audit, F2). A mutant count that lives in someone's
 * scratchpad cannot be reproduced, and a count nobody can reproduce is not evidence.
 *
 * Each mutant injects ONE named defect into ONE source file, runs the capacity test
 * files, and must turn them RED. The file is always restored in `finally`, even on a
 * crash. An anchor that is missing or not unique is reported as INERT and counts as a
 * failure of the run, because a mutant that edits nothing proves nothing.
 *
 * Anchors are matched on LF-normalised text and the file is written back with its
 * original line endings (this repo is core.autocrlf=true, so CRLF and LF checkouts
 * must both work).
 *
 * Usage (from the repo root):
 *   node test/tools/capacity-mutants.cjs            run all
 *   node test/tools/capacity-mutants.cjs <prefix>   run the mutants whose name starts with <prefix>
 * Exit 0 only when every selected mutant was killed.
 *
 * NOT a *.test.cjs file on purpose: it rewrites sources, so it must never run inside
 * the ordinary suite.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TESTS = ['test/capacity-strip-contract.test.cjs', 'test/capacity-strip-ui.test.cjs',
  'test/capacity-agent-impact.test.cjs', 'test/delivery-hold.test.cjs'];

const STRIP = 'src/main/capacityStrip.ts';
const SHARED = 'src/shared/capacityStrip.ts';
const MIRROR = 'src/renderer/src/capacity/capacityStrip.ts';
const LAYOUT = 'src/renderer/src/capacity/stripLayout.ts';
const VIEW = 'src/renderer/src/components/CapacityStrip.tsx';
const RUNTIME = 'src/main/capacityRuntime.ts';
const TRACKER = 'src/main/providerCapacityTracker.ts';
const INDEX = 'src/main/index.ts';
const IMPACT_VIEW = 'src/renderer/src/components/agentImpactView.ts';
const CARD = 'src/renderer/src/components/AgentCard.tsx';
const HOLD = 'src/shared/deliveryHold.ts';

/** [name, file, from, to] */
const MUTANTS = [
  // ── unit #1: presenter ────────────────────────────────────────────────────────
  ['u1 no hysteresis hold', STRIP,
    "else if (latch.shown && value < Math.min(100, T + HYSTERESIS_BAND)) banded = 'HYSTERESIS_HOLD';", ''],
  ['u1 hold band uses <=', STRIP,
    'value < Math.min(100, T + HYSTERESIS_BAND)', 'value <= Math.min(100, T + HYSTERESIS_BAND)'],
  ['u1 entry uses <= T', STRIP, 'if (value < T) {', 'if (value <= T) {'],
  ['u1 no re-anchor reset', STRIP,
    'if (latch.anchor !== wk.resetsAt) latch = { shown: false, anchor: wk.resetsAt };', ''],
  ['u1 hidden weekly sent anyway', STRIP,
    'return banded ? { reason: banded, window: wk } : null;',
    "return banded ? { reason: banded, window: wk } : (wk ? { reason: 'HYSTERESIS_HOLD', window: wk } : null);"],
  ['u1 display rounds to nearest', STRIP,
    'displayPercent: Math.floor(remaining)', 'displayPercent: Math.round(remaining)'],
  ['u1 meter in the blocked frame', STRIP,
    'fiveHour.compactText = frame.compactText(shown);',
    'fiveHour.compactText = frame.compactText(shown); fiveHour.meter = meterOf(fiveRemaining);'],
  ['u1 pool id not opaque', STRIP,
    'poolId: `pool-${this.opaque(pool.poolKey)}`', 'poolId: `pool-${pool.poolKey}`'],
  ['u1 revision never moves', STRIP, ': prev.revision + 1;', ': prev.revision;'],
  ['u1 notice never retires', STRIP,
    'if (n.to !== pool.state) { this.notices.delete(pool.poolKey); return undefined; }', ''],
  ['u1 expired view keeps the live weekly', STRIP,
    'if (exp.weekly && live.weekly) freshness.expired.weekly = exp.weekly;',
    'if (live.weekly) freshness.expired.weekly = live.weekly;'],
  // Jim's surviving mutant from the unit #1 audit; F1's test exists to kill it.
  ['u1 F1 expired guard drops the live-weekly check', STRIP,
    'if (exp.weekly && live.weekly) freshness.expired.weekly = exp.weekly;',
    'if (exp.weekly) freshness.expired.weekly = exp.weekly;'],
  // ── unit #1: schema ───────────────────────────────────────────────────────────
  ['u1 schema allows extra props', SHARED,
    'if (!(key in required) && !(key in optional)) errors.push(`${at}.${key}: property not allowed`);', ''],
  ['u1 schema allows present-undefined optional', SHARED,
    'if (key in v) check(v[key], `${at}.${key}`, errors);', 'if (v[key] !== undefined) check(v[key], `${at}.${key}`, errors);'],
  ['u1 schema drops the no-meter-outside-NORMAL rule', SHARED,
    "if (five && 'meter' in five) errors.push", 'if (false) errors.push'],
  // ── unit #1: mirror + mask ────────────────────────────────────────────────────
  ['u1 mirror accepts an equal revision', MIRROR,
    'next.collectionRevision <= held.collectionRevision', 'next.collectionRevision < held.collectionRevision'],
  ['u1 mirror skips validation', MIRROR, "if (validateCapacityStrip(value).length) return 'INVALID';", ''],
  ['u1 mask fires at the deadline', MIRROR, 'now <= f.expiresAt', 'now < f.expiresAt'],
  // ── unit #1: runtime, tracker, main wiring ────────────────────────────────────
  ['u1 publish does not notify the display', RUNTIME,
    '    if (intents.length) this.deps.deliver(intents);\n    this.deps.onChange?.();',
    '    if (intents.length) this.deps.deliver(intents);'],
  ['u1 membership move not notified', RUNTIME, 'else if (moved) this.deps.onChange?.();', ''],
  ['u1 freshUntil ignores the monotonic deadline', TRACKER,
    'return now + (rec.staleAt - monoNow);', 'return now + 1;'],
  ['u1 control:snapshot carries pool data', INDEX,
    'return { ...snap, capacityHold: gate.holds,',
    'return { ...snap, pools: capacityStrip.current(), capacityHold: gate.holds,'],
  // ── unit #2: layout ───────────────────────────────────────────────────────────
  ['u2 collapse drops resets before meters', LAYOUT,
    "const meters = level < 1 && pool.presentation === 'NORMAL';\n  const resets = level < 2 && pool.presentation === 'NORMAL';",
    "const meters = level < 2 && pool.presentation === 'NORMAL';\n  const resets = level < 1 && pool.presentation === 'NORMAL';"],
  ['u2 never compacts', LAYOUT, 'const compact = level >= 3;', 'const compact = false;'],
  ['u2 blocked frame puts 5h before weekly', LAYOUT,
    "    if (pool.weekly && weeklyText) out.push({ kind: 'figure', key: 'weekly', role: 'weekly', text: weeklyText, subordinate: false });\n    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: fiveText, subordinate: true });",
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: fiveText, subordinate: true });\n    if (pool.weekly && weeklyText) out.push({ kind: 'figure', key: 'weekly', role: 'weekly', text: weeklyText, subordinate: false });"],
  ['u2 blocked 5h shown twice', LAYOUT,
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: fiveText, subordinate: true });\n    return out;",
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: fiveText, subordinate: true });\n    out.push({ kind: 'figure', key: 'five-hour-2', role: 'five-hour', text: pool.fiveHour.compactText, subordinate: false });\n    return out;"],
  ['u2 level choice always full', LAYOUT, 'if (total <= available) return level;', 'return 0;'],
  ['u2 weekly compact text ignored', LAYOUT,
    'const weeklyText = pool.weekly ? (compact ? pool.weekly.compactText : pool.weekly.text) : null;',
    'const weeklyText = pool.weekly ? pool.weekly.text : null;'],
  // ── unit #2: view ─────────────────────────────────────────────────────────────
  ['u2 subordinate token in a positive colour', VIEW,
    "color: token.subordinate ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',",
    "color: token.subordinate ? 'var(--cth-status-success)' : 'var(--cth-ink-900)',"],
  ['u2 meter drawn as a progressbar', VIEW, 'role="meter"', 'role="progressbar"'],
  ['u2 UNKNOWN shares the healthy token', VIEW, "UNKNOWN: '◌'", "UNKNOWN: '●'"],
  ['u2 UNKNOWN shares the healthy colour', VIEW,
    "UNKNOWN: 'var(--cth-status-ghost)'", "UNKNOWN: 'var(--cth-status-success)'"],
  ['u2 connected strip skips the mask', VIEW,
    'const pools = selectPools(collection).map((p) => presentPool(p, now));',
    'const pools = selectPools(collection).map((p) => ({ ...p, masked: false }));'],
  ['u2 strip grows instead of clipping', VIEW,
    "flex: '1 1 auto', minWidth: 0, height: 36, overflow: 'hidden',", "flex: '1 1 auto', minWidth: 0,"],
  ['u2 empty collection drawn', VIEW,
    '  if (!pools.length) return null;', "  if (!pools.length) return <span>Capacity unknown</span>;"],
  // ── A2 (human ruling): the RESERVE_ONLY held frame ───────────────────────────
  ['a2 RESERVE_ONLY frame removed', STRIP,
    "  RESERVE_ONLY: {\n    text: (n) => `5h · ${n}% remaining · ordinary work held while Weekly is at 0%`,\n    compactText: (n) => `5h ${n}% · held by Weekly 0%`\n  }\n",
    ''],
  ['a2 RESERVE_ONLY frame uses the causal LIMITED copy', STRIP,
    "text: (n) => `5h · ${n}% remaining · ordinary work held while Weekly is at 0%`,",
    "text: (n) => `5h · ${n}% remaining · unavailable while Weekly is exhausted`,"],
  ['a2 frame ignores the 5h-above-zero precondition', STRIP,
    'const frame = known && fiveRemaining !== null && fiveRemaining > 0',
    'const frame = known && fiveRemaining !== null'],
  // ── unit #5: agent-card impact ────────────────────────────────────────────────
  ['u5 wrong pool label (provider name instead of the strip label)', INDEX,
    'poolLabel: pool ? capacityStrip.labelOf(pool) : null', 'poolLabel: pool ? pool.provider : null'],
  ['u5 impact not sent on the snapshot', INDEX,
    'capacityEvidence: gate.evidence, interfered, impact };', 'capacityEvidence: gate.evidence, interfered };'],
  ['u5 "idle" leaks while held', IMPACT_VIEW,
    "export const RESTING_STATUSES: readonly StatusKind[] = ['idle', 'success'];",
    "export const RESTING_STATUSES: readonly StatusKind[] = ['success'];"],
  ['u5 impact shown over a working agent', IMPACT_VIEW,
    'if (!impact || !RESTING_STATUSES.includes(status)) return', 'if (!impact) return'],
  ['u5 card badge ignores the impact', CARD,
    '<PixelBadge status={held.status} label={held.label}', "<PixelBadge status={typing ? 'typing' : status} label={undefined}"],
  ['u5 unknown-capacity hold reads idle', HOLD,
    "  return impact('CAPACITY_UNKNOWN', 'waiting', `${pool} capacity unknown`);", '  return null;'],
  // ── unit #2: presenter copy used by the strip ─────────────────────────────────
  ['u2 weekly compact text drops its label', STRIP,
    "case 'HYSTERESIS_HOLD': return `Weekly ${display}%`;", "case 'HYSTERESIS_HOLD': return `${display}%`;"]
];

// THE BASELINE MUST BE GREEN. Against already-failing tests every mutant "dies", and a
// kill that the unmutated code would also have scored is not evidence of anything.
const baseline = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8' });
if (baseline.status !== 0) {
  console.log('BASELINE RED: the unmutated capacity tests fail, so no mutant result would mean anything.');
  process.exit(2);
}

const only = process.argv[2];
const selected = MUTANTS.filter(([name]) => !only || name.startsWith(only));
let killed = 0;
let inert = 0;
for (const [name, file, from, to] of selected) {
  const abs = path.join(ROOT, file);
  const original = fs.readFileSync(abs, 'utf8');
  const crlf = original.includes('\r\n');
  const lf = original.replace(/\r\n/g, '\n');
  const at = lf.indexOf(from);
  if (at < 0 || lf.indexOf(from, at + 1) >= 0) {
    inert++;
    console.log(`INERT     ${name}  (anchor ${at < 0 ? 'missing' : 'not unique'} in ${file})`);
    continue;
  }
  let mutated = lf.slice(0, at) + to + lf.slice(at + from.length);
  if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
  try {
    fs.writeFileSync(abs, mutated);
    const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8' });
    const fails = (String(r.stdout).match(/^# fail (\d+)/m) || [])[1] ?? '?';
    const dead = r.status !== 0;
    if (dead) killed++;
    console.log(`${dead ? 'KILLED  ' : 'SURVIVED'}  ${name}  (failing tests: ${fails})`);
  } finally {
    fs.writeFileSync(abs, original);
  }
}
console.log(`\n${killed}/${selected.length} killed${inert ? `, ${inert} INERT` : ''}`);
process.exit(killed === selected.length ? 0 : 1);
