'use strict';

/**
 * Mutant runner for the capacity display milestone (v1.1.45 units #1, #2, #4, #5, #8, the strip polish and CAPUI-MONITOR).
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
  'test/capacity-agent-impact.test.cjs', 'test/delivery-hold.test.cjs', 'test/capacity-monitor.test.cjs',
  'test/capacity-threshold.test.cjs', 'test/capacity-detail.test.cjs'];

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
const APP = 'src/renderer/src/App.tsx';
const BREAKER = 'src/main/breaker.ts';
const USAGE = 'src/shared/agentUsage.ts';
const USAGE_MAIN = 'src/main/capacityAgentUsage.ts';
const USAGE_LINE = 'src/renderer/src/components/AgentUsageLine.tsx';
const PANEL = 'src/renderer/src/components/CommandCenterPanel.tsx';
const CONFIG = 'src/main/config.ts';
const THRESHOLD = 'src/shared/capacityThreshold.ts';
const THRESHOLD_UI = 'src/renderer/src/components/CapacityDisplaySetting.tsx';
const DETAIL = 'src/main/capacityDetail.ts';
const DETAIL_SCHEMA = 'src/shared/capacityDetail.ts';
const DETAIL_PANEL = 'src/renderer/src/components/CapacityDetailPanel.tsx';
const SETTINGS = 'src/renderer/src/components/SettingsModal.tsx';

/** [name, file, from, to] */
const MUTANTS = [
  // ── unit #1: presenter ────────────────────────────────────────────────────────
  ['u1 no hysteresis hold (weekly reveal and reset hints share the band)', STRIP,
    "else if (latch.shown && value < Math.min(100, T + HYSTERESIS_BAND)) out = 'HOLD';", ''],
  ['u1 hold band uses <=', STRIP,
    'value < Math.min(100, T + HYSTERESIS_BAND)', 'value <= Math.min(100, T + HYSTERESIS_BAND)'],
  ['u1 entry uses <= T', STRIP, 'if (value < T) {', 'if (value <= T) {'],
  ['u1 no re-anchor reset', STRIP,
    'if (latch.anchor !== anchor) latch = { shown: false, anchor };', ''],
  ['u1 hidden weekly sent anyway', STRIP,
    'return banded ? { reason: banded, window: wk } : null;',
    "return banded ? { reason: banded, window: wk } : (wk ? { reason: 'HYSTERESIS_HOLD', window: wk } : null);"],
  ['u1 display rounds to nearest', STRIP,
    'displayPercent: Math.floor(remaining)', 'displayPercent: Math.round(remaining)'],
  ['u1 meter in the blocked frame', STRIP,
    'fiveHour.compactText = frame.compactText(shown);',
    'fiveHour.compactText = frame.compactText(shown); fiveHour.meter = meterOf(fiveRemaining);'],
  ['u1 pool id not opaque', STRIP,
    'return `pool-${this.opaque(poolKey)}`;', 'return `pool-${poolKey}`;'],
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
  // ── unit #2 + strip-polish: layout ───────────────────────────────────────────
  ['u2 blocked frame puts 5h before weekly', LAYOUT,
    "    if (pool.weekly) out.push({ kind: 'figure', key: 'weekly', role: 'weekly', text: pool.weekly.text, subordinate: false });\n    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });",
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });\n    if (pool.weekly) out.push({ kind: 'figure', key: 'weekly', role: 'weekly', text: pool.weekly.text, subordinate: false });"],
  ['u2 blocked 5h shown twice', LAYOUT,
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });\n    return out;",
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });\n    out.push({ kind: 'figure', key: 'five-hour-2', role: 'five-hour', text: pool.fiveHour.compactText, subordinate: false });\n    return out;"],
  ['polish strip draws the compact form', LAYOUT,
    "  window('five-hour', pool.fiveHour.text, pool.fiveHour.meter, pool.fiveHour.resetText);",
    "  window('five-hour', pool.fiveHour.compactText, pool.fiveHour.meter, pool.fiveHour.resetText);"],
  // ── unit #2 + strip-polish: view ─────────────────────────────────────────────
  ['u2 subordinate token in a positive colour', VIEW,
    "color: token.subordinate ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',",
    "color: token.subordinate ? 'var(--cth-status-success)' : 'var(--cth-ink-900)',"],
  ['u2 meter drawn as a progressbar', VIEW, 'role="meter"', 'role="progressbar"'],
  ['u2 UNKNOWN shares the healthy token', VIEW, "UNKNOWN: '◌'", "UNKNOWN: '●'"],
  ['polish UNKNOWN back to the pale ghost ink', VIEW,
    "UNKNOWN: 'var(--cth-ink-500)'", "UNKNOWN: 'var(--cth-status-ghost)'"],
  ['polish a state word is visible again', VIEW,
    '      <StateShape state={pool.state} name={pool.stateText} />',
    '      <StateShape state={pool.state} name={pool.stateText} />\n      <span>{pool.stateText}</span>'],
  ['polish healthy loses its shape', VIEW,
    '      {STATE_TOKEN[state]}', "      {state === 'AVAILABLE' ? '' : STATE_TOKEN[state]}"],
  ['polish the shape loses its accessible name', VIEW, '      aria-label={name}\n', ''],
  ['u2 connected strip skips the mask', VIEW,
    'const pools = selectPools(collection).map((p) => presentPool(p, now));',
    'const pools = selectPools(collection).map((p) => ({ ...p, masked: false }));'],
  ['polish marquee runs even when it fits', VIEW,
    '.cap-strip-host[data-overflow="true"] .cap-strip-track {\n  animation:', '.cap-strip-track {\n  animation:'],
  ['polish no pause on hover', VIEW,
    '.cap-strip-host:hover .cap-strip-track, .cap-strip-host:focus-within .cap-strip-track { animation-play-state: paused; }\n', ''],
  ['polish reduced motion still animates', VIEW,
    '  .cap-strip-host[data-overflow="true"] .cap-strip-track { animation: none; }\n', ''],
  ['polish the row grows instead of scrolling', VIEW,
    '.cap-strip-host { flex: 0 1 auto; min-width: 0; height: 36px; overflow: hidden;',
    '.cap-strip-host { flex: 0 1 auto; min-width: 0;'],
  ['polish scroll stops short of the last pixel', VIEW,
    'Math.max(0, Math.ceil(trackWidth - hostWidth))', 'Math.max(0, Math.floor(trackWidth - hostWidth))'],
  ['polish overflow never flagged', VIEW,
    "el.dataset.overflow = d > 0 ? 'true' : 'false';", "el.dataset.overflow = 'false';"],
  ['polish cold start draws no shape', VIEW,
    '              <StateShape state="UNKNOWN" name={emptyText} />\n', ''],
  ['polish cold start ignores main\'s emptyText', VIEW,
    'emptyText={collection?.emptyText ?? CAPACITY_EMPTY_TEXT}', 'emptyText={CAPACITY_EMPTY_TEXT}'],
  ['polish auto-mode label back in the title bar', APP,
    '        <CapacityStrip />',
    "        <span>{config.autoMode ? 'auto mode on' : 'auto mode off'}</span>\n        <CapacityStrip />"],
  // ── strip-polish: presenter ──────────────────────────────────────────────────
  ['polish 5h reset hint shown above the threshold', STRIP,
    "\n        && this.band(`${pool.poolKey}|reset|five`, fiveRemaining, five.resetsAt, T) !== null", ''],
  ['polish weekly reset hint ungated', STRIP,
    " && this.band(`${pool.poolKey}|reset|weekly`, remaining, r, T) !== null", ''],
  ['polish reset hints share the weekly latch (one key)', STRIP,
    "this.band(`${pool.poolKey}|reset|five`, fiveRemaining", "this.band(pool.poolKey, fiveRemaining"],
  ['polish a second-account ordinal comes back', STRIP,
    '    return PROVIDER_LABEL[pool.provider];', '    return `${PROVIDER_LABEL[pool.provider]} 1`;'],
  ['polish emptyText not sent', STRIP,
    '        emptyText: CAPACITY_EMPTY_TEXT,\n        pools\n', '        pools\n'],
  // ── A2 (human ruling): the RESERVE_ONLY held frame ───────────────────────────
  ['a2 RESERVE_ONLY frame removed', STRIP,
    "  RESERVE_ONLY: {\n    text: (n) => `5h · ${n}% remaining · ordinary work held while Weekly is at 0%`,\n    compactText: (n) => `5h ${n}% · held by Weekly 0%`,\n    note: 'ordinary work held while Weekly is at 0%'\n  }\n",
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
  // ── CAPUI-MONITOR: the budget exemption (the risky part) ──────────────────────
  ['mon floor total counts exempt agents', BREAKER,
    'const budgeted = inputs.filter((i) => !exempt(i.agentId));', 'const budgeted = inputs;'],
  ['mon per-agent cap applies to an exempt agent', BREAKER,
    'const perAgentCap = budgetExempt ? undefined : cfg.agentTokenCaps?.[input.agentId];',
    'const perAgentCap = cfg.agentTokenCaps?.[input.agentId];'],
  ['mon exemption never reaches evaluate()', BREAKER,
    '        exempt(input.agentId)\n      );', '        false\n      );'],
  ['mon any non-budget value exempts (malformed switches a limit off)', USAGE,
    "  return display === 'fiveHour' || display === 'weekly';", "  return display !== 'budget' && display !== undefined;"],
  ['mon the breaker never sees the choice', INDEX,
    '    agentUsageDisplay: c.agentUsageDisplay\n  };', '  };'],
  ['mon Budget stored explicitly instead of as absent', CONFIG,
    '  if (display === \'budget\') delete agentUsageDisplay[agentId];\n  else agentUsageDisplay[agentId] = display;',
    '  agentUsageDisplay[agentId] = display;'],
  // ── CAPUI-MONITOR: the usage projection and its channel ──────────────────────
  ['mon used rounded down (usage understated)', USAGE_MAIN,
    'const displayPercent = 100 - Math.floor(r);', 'const displayPercent = Math.round(100 - r);'],
  ['mon a stale reading drawn as a figure', USAGE_MAIN,
    "  if (pool.freshness !== 'FRESH') {", "  if (false) {"],
  ['mon the usage schema allows extra properties', USAGE,
    '  const errors = Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${at}.${k}: property not allowed`);',
    '  const errors: string[] = [];'],
  ['mon usage rides on control:snapshot', INDEX,
    'capacityEvidence: gate.evidence, interfered, impact };', 'capacityEvidence: gate.evidence, interfered, impact, agentUsage: null };'],
  // ── CAPUI-MONITOR: the Monitor line ─────────────────────────────────────────
  ['mon the select offered to every provider', PANEL,
    "const usageCapable = agentProvider === 'claude' || agentProvider === 'codex';", 'const usageCapable = true;'],
  ['mon the usage bar is not the strip meter', USAGE_LINE,
    '<CapacityMeter percent={view.usedPercent} valueText={view.text} color={STATE_COLOR[view.state]} dataRole="usage" />',
    '<span style={{ width: 96, height: 8 }} />'],
  ['mon text-only usage draws a bar', USAGE_LINE,
    "  if (view.kind === 'TEXT') {", "  if (view.kind === 'TEXT' && false) {"],
  // ── unit #8: the C2.8 threshold setting ─────────────────────────────────────
  ['u8 the presenter ignores the setting', INDEX,
    'new CapacityStripPresenter({ weeklyThreshold: capacityThresholdNow })', 'new CapacityStripPresenter()'],
  ['u8 the setter does not refresh the threshold in force', INDEX,
    '  capacityDisplayThreshold = capacityDisplayThresholdOf(next);\n', ''],
  ['u8 the setter does not push the strip live', INDEX,
    '  capacityDisplayThreshold = capacityDisplayThresholdOf(next);\n  pushCapacityStrip();',
    '  capacityDisplayThreshold = capacityDisplayThresholdOf(next);'],
  ['u8 out-of-range input clamped instead of refused', THRESHOLD,
    '  if (!Number.isInteger(n) || n < MIN_CAPACITY_DISPLAY_THRESHOLD || n > MAX_CAPACITY_DISPLAY_THRESHOLD) return null;',
    '  n = Math.min(MAX_CAPACITY_DISPLAY_THRESHOLD, Math.max(MIN_CAPACITY_DISPLAY_THRESHOLD, Math.round(n)));'],
  ['u8 zero (an off state) allowed', THRESHOLD,
    'export const MIN_CAPACITY_DISPLAY_THRESHOLD = 1;', 'export const MIN_CAPACITY_DISPLAY_THRESHOLD = 0;'],
  ['u8 an invalid stored value is repaired by clamping', THRESHOLD,
    '  return parseCapacityDisplayThreshold(config?.capacityWeeklyDisplayThreshold) ?? DEFAULT_CAPACITY_DISPLAY_THRESHOLD;',
    '  return Math.min(99, Math.max(1, Math.round(Number(config?.capacityWeeklyDisplayThreshold)) || DEFAULT_CAPACITY_DISPLAY_THRESHOLD));'],
  ['u8 invalid input overwrites the stored value', CONFIG,
    "  if (t === null) throw new Error('invalid capacity display threshold');",
    '  if (t === null) return persistConfig({ ...readConfig(), capacityWeeklyDisplayThreshold: DEFAULT_THRESHOLD_MUTANT });\n  const DEFAULT_THRESHOLD_MUTANT = 15;'],
  ['u8 the control saves an invalid entry', THRESHOLD_UI,
    "  if (t === null) return { kind: 'invalid', message: CAPACITY_DISPLAY_COPY.invalid(stored) };",
    "  if (t === null) return { kind: 'save', value: stored };"],
  ['u8 a forbidden label', THRESHOLD_UI,
    "  title: 'Provider capacity display',", "  title: 'Weekly limit threshold',"],
  // ── unit #4: the provider details panel ─────────────────────────────────────
  ['u4 a stale figure is offered to a meter', DETAIL,
    "const current = pool.freshness === 'FRESH' && !restored;", 'const current = !restored;'],
  ['u4 a known-inapplicable window is listed', DETAIL,
    "    .filter((w) => applicabilityOf(w) !== 'INAPPLICABLE')\n", ''],
  ['u4 the blocked relationship is dropped', DETAIL,
    "const blocked = i.presentation === 'BLOCKED_SUBORDINATE' ? blockedFrameNote(pool.state) : null;", 'const blocked = null as string | null;'],
  ['u4 unknown membership reads as known', DETAIL,
    "    ? 'Membership unknown'", "    ? 'Shared by 0 agents'"],
  ['u4 a passed reset still reads as expected', DETAIL,
    'out.resetText = w.resetsAt > now ?', 'out.resetText = true ?'],
  ['u4 the detail schema allows extra properties', DETAIL_SCHEMA,
    'return Object.keys(o).filter((k) => !allowed.includes(k)).map(', 'return Object.keys(o).filter(() => false).map('],
  ['u4 the schema lets a stale pool offer a figure', DETAIL_SCHEMA,
    "    errors.push('$.windows: a stale pool offers no current figure');\n", ''],
  ['u4 the detail is built from the strip object', INDEX,
    'const pool = providerCapacity.snapshot().pools.find((p) => capacityStrip.poolIdOf(p.poolKey) === poolId);',
    'const pool = providerCapacity.snapshot().pools.find((p) => capacityStrip.current().pools.some((q) => q.poolId === poolId) && !!p);'],
  ['u4 the status note bypasses the composer wording', INDEX,
    '  return capacityStateNote(gate.evidence);', '  return gate.evidence;'],
  ['u4 a switch shows the previous pool', DETAIL_PANEL,
    '    setView(null);                                  // a switch never shows the previous pool\n', ''],
  ['u4 a removed pool keeps the panel open', DETAIL_PANEL,
    '  useEffect(() => { if (gone) closeCapacityDetail(); }, [gone]);\n', ''],
  ['u4 a strip pool is not clickable', VIEW,
    '      onClick={() => openCapacityDetail(pool.poolId)}\n', ''],
  ['u4 the Settings link is missing', SETTINGS,
    '<CapacityDisplaySetting onOpenDetails={() => { if (openFirstCapacityDetail()) onClose(); }} />', '<CapacityDisplaySetting />'],
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
