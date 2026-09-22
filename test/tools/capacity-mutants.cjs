'use strict';

/**
 * Mutant runner for the capacity display milestone (v1.1.45 units #1, #2, #4, #5, #6, #7, #8, #11, #12, #13, #14, CAPUI-TIDY, the strip polish and CAPUI-MONITOR).
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
  'test/capacity-threshold.test.cjs', 'test/capacity-detail.test.cjs',
  'test/capacity-banner.test.cjs', 'test/capacity-toast.test.cjs',
  'test/capacity-composer-note.test.cjs', 'test/capacity-copy-guards.test.cjs',
  'test/capacity-tidy-pins.test.cjs', 'test/capacity-usage-push.test.cjs',
  'test/capacity-piedot.test.cjs', 'test/capacity-impact-push.test.cjs'];

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
const BANNER = 'src/renderer/src/components/CapacityLimitBanner.tsx';
const TOAST = 'src/main/capacityToast.ts';
const COMPOSER_STATUS = 'src/renderer/src/components/composerStatus.ts';
const COMPOSER = 'src/renderer/src/components/MessageQueueComposer.tsx';
const PANEL_CC = 'src/renderer/src/components/CommandCenterPanel.tsx';
const PIE = 'src/renderer/src/capacity/pieDot.ts';
const TOKENS = 'src/renderer/src/design/tokens.css';
const IMPACT_HOOK = 'src/renderer/src/hooks/useAgentImpact.ts';
const IMPACT_PUSH = 'src/main/agentImpactPush.ts';

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
    '      fiveHour.text = frame.text(shown);',
    '      fiveHour.text = frame.text(shown); fiveHour.meter = meterOf(fiveRemaining);'],
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
    'return { ...f.snap, capacityHold: f.gate.holds,',
    'return { ...f.snap, pools: capacityStrip.current(), capacityHold: f.gate.holds,'],
  // ── unit #2 + strip-polish: layout ───────────────────────────────────────────
  ['u2 blocked frame puts 5h before weekly', LAYOUT,
    "    if (pool.weekly) out.push({ kind: 'figure', key: 'weekly', role: 'weekly', text: pool.weekly.text, subordinate: false });\n    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });",
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });\n    if (pool.weekly) out.push({ kind: 'figure', key: 'weekly', role: 'weekly', text: pool.weekly.text, subordinate: false });"],
  ['u2 blocked 5h shown twice', LAYOUT,
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });\n    return out;",
    "    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });\n    out.push({ kind: 'figure', key: 'five-hour-2', role: 'five-hour', text: pool.fiveHour.text, subordinate: false });\n    return out;"],
  ['tidy P3 the dead compact form comes back into the contract', SHARED,
    "  { label: exactly('5h'), text },", "  { label: exactly('5h'), text, compactText: text },"],
  // ── unit #2 + strip-polish: view ─────────────────────────────────────────────
  ['u2 subordinate token in a positive colour', VIEW,
    "color: token.subordinate ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',",
    "color: token.subordinate ? 'var(--cth-status-success)' : 'var(--cth-ink-900)',"],
  ['u2 meter drawn as a progressbar', VIEW, "    <span role=\"meter\" aria-valuemin={0}", "    <span role=\"progressbar\" aria-valuemin={0}"],
  ['u2 UNKNOWN shares the healthy look (cold start drawn as a full green pie)', VIEW,
    "              <StateDot look={{ kind: 'SPOTTED' }} state=\"UNKNOWN\" name={emptyText} />",
    "              <StateDot look={{ kind: 'PIE', percent: 100 }} state=\"UNKNOWN\" name={emptyText} />"],
  ['polish UNKNOWN back to the pale ghost ink', VIEW,
    "UNKNOWN: 'var(--cth-ink-500)'", "UNKNOWN: 'var(--cth-status-ghost)'"],
  ['polish a state word is visible again', VIEW,
    '      <PoolDot pool={pool} />', '      <PoolDot pool={pool} />\n      <span>{pool.stateText}</span>'],
  ['polish healthy loses its shape', VIEW, "      {look.kind === 'STOP' ? <StopSvg />", "      {state === 'AVAILABLE' ? null : look.kind === 'STOP' ? <StopSvg />"],
  ['polish the shape loses its accessible name', VIEW, "    <span role=\"img\" aria-label={name} data-cap-state-token={state} data-cap-dot={look.kind}", "    <span role=\"img\" data-cap-state-token={state} data-cap-dot={look.kind}"],
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
  ['polish cold start draws no shape', VIEW, "              <StateDot look={{ kind: 'SPOTTED' }} state=\"UNKNOWN\" name={emptyText} />\n", ''],
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
    "  RESERVE_ONLY: {\n    text: (n) => `5h · ${n}% remaining · ordinary work held while Weekly is at 0%`,\n    note: 'ordinary work held while Weekly is at 0%'\n  }\n",
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
  // ── unit #6: the LIMITED entry banner ────────────────────────────────────────
  ['u6 every notice kind gets a banner', STRIP,
    "    if (n.kind === 'LIMIT_REACHED') out.banner = this.banner(pool);", '    out.banner = this.banner(pool);'],
  ['u6 causal wording without attribution', STRIP,
    '? `${name} reported a usage limit without naming which window.`', '? `${name} reports a usage limit reached.`'],
  ['u6 a figure in the banner', STRIP,
    'agents is paused until capacity returns. Queued', 'agents is paused until capacity returns (0% left). Queued'],
  ['u6 a dismissed banner still shows', MIRROR,
    "if (n && n.lifecycle === 'OPEN' && n.kind === 'LIMIT_REACHED' && n.banner)", "if (n && n.kind === 'LIMIT_REACHED' && n.banner)"],
  ['u6 a banner for a non-LIMITED notice', MIRROR,
    "if (n && n.lifecycle === 'OPEN' && n.kind === 'LIMIT_REACHED' && n.banner)", "if (n && n.lifecycle === 'OPEN' && (n.banner || n.kind))"],
  ['u6 dismissal kept locally, not in main', BANNER,
    'onDismiss={(id) => { void dismissCapacityNotice(id); }}', 'onDismiss={() => {}}'],
  ['u6 the schema allows a banner on any kind', SHARED,
    "    if (nt.kind !== 'LIMIT_REACHED') errors.push(`${at}.notice.banner: only an entry to LIMITED has a banner`);\n", ''],
  // ── unit #7: toast alignment (§13) ───────────────────────────────────────────
  ['u7 every transition toasts again', STRIP,
    "export const TOASTED_KINDS = ['LIMIT_REACHED', 'RECOVERED'] as const;",
    "export const TOASTED_KINDS = ['LIMIT_REACHED', 'RECOVERED', 'RESERVE_REACHED', 'RECOVERY_POSSIBLE'] as const;"],
  ['u7 the toast policy is ignored', STRIP,
    '    if (!(TOASTED_KINDS as readonly string[]).includes(intent.kind)) return null;\n', ''],
  ['u7 the toast ignores the notifications setting', TOAST,
    "  if (!deps.notificationsOn()) return 'SUPPRESSED';\n", ''],
  ['u7 a strip-only transition recorded as suppressed', TOAST,
    "  if (!toast) return 'STRIP_ONLY';", "  if (!toast) return 'SUPPRESSED';"],
  ['u7 main bypasses the presenter policy', INDEX,
    'capacityToast(capacityStrip.toastFor(intent, providerCapacity.tracker.pool(intent.poolKey)))',
    "capacityToast({ title: 'Provider capacity', body: intent.kind })"],
  ['u7 a figure in the recovery toast', STRIP,
    'agents has resumed.`', 'agents has resumed (100%).`'],
  // ── unit #11: composer capacity note (unconditional) ──────────────────────────
  ['u11 the empty queue hides the note again', COMPOSER_STATUS,
    "  if (i.queueLength === 0) return i.capacityNote && i.capacityEvidence !== 'NO_POOL' ? own(i.capacityNote) : null;",
    '  if (i.queueLength === 0) return null;'],
  ['u11 healthy is no longer silent', COMPOSER_STATUS,
    "  if (i.queueLength === 0) return i.capacityNote && i.capacityEvidence !== 'NO_POOL' ? own(i.capacityNote) : null;",
    "  if (i.queueLength === 0) return own(i.capacityNote ?? 'provider capacity healthy');"],
  ['u11 the empty-queue note is shown for NO_POOL again', COMPOSER_STATUS,
    " && i.capacityEvidence !== 'NO_POOL'", ''],
  ['u11 INTERFERED no longer escapes the empty queue', COMPOSER_STATUS,
    "  if (i.hold?.kind === 'INTERFERED') return { text: i.hold.hint, title: i.hold.title };\n", ''],
  ['u11 the empty queue shows the hold hint instead of the note', COMPOSER_STATUS,
    "  if (i.queueLength === 0) return i.capacityNote && i.capacityEvidence !== 'NO_POOL' ? own(i.capacityNote) : null;",
    '  if (i.queueLength === 0) return i.hold ? { text: i.hold.hint, title: i.hold.title } : i.capacityNote ? own(i.capacityNote) : null;'],
  ['u11 the moving queue loses its note', COMPOSER_STATUS,
    "one-by-one…${i.capacityNote ? ` (${i.capacityNote})` : ''}`", 'one-by-one…`'],
  ['u11 the composer bypasses composerStatus', COMPOSER,
    '  const status = composerStatus({ agentName: agent.name, queueLength: queue.length, idle, hold, block, capacityNote,',
    '  const status = queue.length === 0 ? null : composerStatus({ agentName: agent.name, queueLength: queue.length, idle, hold, block, capacityNote,'],
  // ── unit #12: vocabulary + geometry guards ─────────────────────────────────────
  ['u12 a cross-family word in the strip copy', STRIP,
    'unavailable while Weekly is exhausted`,', 'unavailable while Weekly is exhausted (the binding window)`,'],
  ['u12 a cross-family word in renderer-only copy', VIEW,
    'title="Provider details"', 'title="Provider details (tighter window first)"'],
  ['u12 a cross-family word in the hold wording', HOLD,
    "FRESH_NOT_HEALTHY: { state: 'provider capacity is limited',", "FRESH_NOT_HEALTHY: { state: 'provider capacity is limited (no headroom)',"],
  ['u12 a bare percentage in the detail panel', DETAIL,
    'out.text = `${w.label} · ${Math.floor(r)}% remaining`;', 'out.text = `${w.label} · remaining ${Math.floor(r)}%`;'],
  ['u12 a bare percentage in the Monitor usage line', USAGE_MAIN,
    'text: `${label} · ${displayPercent}% used`', 'text: `${displayPercent}% used · ${label}`'],
  ['u12 a figure in the banner', STRIP,
    'is paused until capacity returns. Queued messages wait; nothing is lost.`',
    'is paused until capacity returns (0% left). Queued messages wait; nothing is lost.`'],
  ['u12 a figure in the agent impact', HOLD,
    "impact('CAPACITY_LIMITED', 'paused', `${pool} limited`)", "impact('CAPACITY_LIMITED', 'paused', `${pool} limited (0%)`)"],
  ['u12 the shape shows its state word as text', VIEW, "      {look.kind === 'STOP' ? <StopSvg />", "      {name}{look.kind === 'STOP' ? <StopSvg />"],
  ['u12 a segmented usage gauge', USAGE_LINE,
    '      <CapacityMeter percent={view.usedPercent}',
    '      {Array.from({ length: 8 }, (_, i) => <span key={i} />)}\n      <CapacityMeter percent={view.usedPercent}'],
  ['u12 a second fill inside a capacity meter', VIEW, "        : wedge ? <path data-cap-fill=\"\" d={wedge} fill={fill} /> : null}",
    "        : wedge ? <><path data-cap-fill=\"\" d={wedge} fill={fill} /><path data-cap-fill=\"\" d={wedge} fill={fill} /></> : null}"],
  // ── CAPUI-TIDY: the deferred audit pins ───────────────────────────────────────
  ['tidy F6 a departed pool keeps its latch', STRIP,
    "    for (const k of [...this.latches.keys()]) if (!live.has(k.split('|')[0])) this.latches.delete(k);\n", ''],
  ['tidy F7 a Budget line polls usage anyway', USAGE_LINE,
    "    if (display === 'budget') { setView(null); return; }\n", ''],
  ['tidy F8 the restored gate dropped from the detail', DETAIL,
    "const current = pool.freshness === 'FRESH' && !restored;", "const current = pool.freshness === 'FRESH';"],
  ['tidy F9 an unmatched attributed id invents the Weekly cause', STRIP,
    '?.label ?? null\n      : null;', "?.label ?? 'Weekly'\n      : null;"],
  ['tidy F10 the x dismisses by pool id', BANNER,
    'onClick={() => onDismiss(it.noticeId)}', 'onClick={() => onDismiss(it.poolId)}'],
  ['tidy T7 the platform is checked before the setting', TOAST,
    "  if (!deps.notificationsOn()) return 'SUPPRESSED';\n  try {\n    if (!deps.supported()) return 'UNSUPPORTED';",
    "  try {\n    if (!deps.supported()) return 'UNSUPPORTED';\n    if (!deps.notificationsOn()) return 'SUPPRESSED';"],
  ['tidy M2 the not-applied clause dropped from the tooltip', PANEL_CC,
    " — not applied while this line shows 5H or Weekly'", "'"],
  // ── unit #13: the usage line is pushed, not polled (crit 15) ─────────────────────
  ['u13 the usage line polls again', USAGE_LINE,
    '    let pushed = false;\n', '    let pushed = false;\n    const iv = setInterval(() => {}, 5000); void iv;\n'],
  ['u13 dedupe keyed on something other than the rows (drops a real usage change)', USAGE_MAIN,
    '    const key = JSON.stringify(push.rows);', '    const key = JSON.stringify(push.rows.map((r) => r.agentId));'],
  ['u13 the usage push gated on the strip collectionRevision', INDEX,
    'onChange: () => { pushCapacityStrip(); pushAgentUsage(); pushAgentImpact(); }',
    'onChange: () => { const was = lastPushedCapacityStrip; pushCapacityStrip(); if (lastPushedCapacityStrip !== was) pushAgentUsage(); pushAgentImpact(); }'],
  ['u13 the display setter does not push', INDEX,
    '  const next = setAgentUsageDisplay(agentId, display);\n  pushAgentUsage();\n', '  const next = setAgentUsageDisplay(agentId, display);\n'],
  ['u13 an agent spawn does not push', INDEX,
    '    ptyProvider.set(opts.id, provider);\n    // A new agent with no reading yet makes its provider\'s membership unknown.\n    pushCapacityStrip();\n    pushAgentUsage();\n',
    '    ptyProvider.set(opts.id, provider);\n    // A new agent with no reading yet makes its provider\'s membership unknown.\n    pushCapacityStrip();\n'],
  ['u13 an agent leave does not push', INDEX,
    '    // Pool membership completeness can change when an agent leaves.\n    pushCapacityStrip();\n    pushAgentUsage();\n',
    '    // Pool membership completeness can change when an agent leaves.\n    pushCapacityStrip();\n'],
  ['u13 usage pushed on control:snapshot', INDEX,
    'w.webContents.send(CAPACITY_AGENT_USAGE_PUSH, push)', "w.webContents.send('control:snapshot', push)"],
  ['u13 a late mount answer overwrites a newer push', USAGE_LINE,
    'if (alive && !pushed) setView(pick(u));', 'if (alive) setView(pick(u));'],
  ['u13 Budget agents get pushed rows', USAGE_MAIN,
    '.filter((id) => isBudgetExempt(displays?.[id]))', ''],
  ['u13 F11 pushed flagged before the row check', USAGE_LINE,
    '      if (!alive || !row) return;\n      pushed = true;\n', '      pushed = true;\n      if (!alive || !row) return;\n'],
  ['u13 F12 dedupe keyed on views alone (agent ids dropped)', USAGE_MAIN,
    '    const key = JSON.stringify(push.rows);', '    const key = JSON.stringify(push.rows.map((r) => r.view));'],
  // ── unit #14: the pie-dot (human-approved look) ────────────────────────────────
  ["u14 the strip draws a bar again", VIEW,
    "  return <PieMeter percent={token.meter.remainingPercent} valueText={token.valueText} role={token.role} />;",
    "  return <CapacityMeter percent={token.meter.remainingPercent} valueText={token.valueText} color=\"red\" dataRole={token.role} />;"],
  ["u14 the wedge sweeps the USED share", PIE,
    "  const a = (p / 100) * 2 * Math.PI;",
    "  const a = (1 - p / 100) * 2 * Math.PI;"],
  ["u14 the colour ramp is inverted", PIE,
    "  const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));",
    "  const p = 100 - Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));"],
  ["u14 one colour for every figure", PIE,
    "  return `hsl(${mix(h0, h1)}, ${mix(s0, s1)}%, ${mix(l0, l1)}%)`;",
    "  return 'hsl(128, 55%, 32%)';"],
  ["u14 LIMITED drawn as a pie", PIE,
    "  if (pool.state === 'LIMITED') return { kind: 'STOP' };\n",
    ""],
  ["u14 never-read drawn as a plain ring", PIE,
    "  if (pool.state === 'UNKNOWN' || pool.presentation === 'UNKNOWN') return { kind: 'SPOTTED' };",
    "  if (pool.state === 'UNKNOWN' || pool.presentation === 'UNKNOWN') return { kind: 'RING' };"],
  ["u14 stale drawn as a live pie", PIE,
    "  if (pool.masked || pool.freshness.verdict === 'STALE') return { kind: 'DIMMED' };",
    "  if (pool.masked || pool.freshness.verdict === 'STALE') return { kind: 'PIE', percent: 50 };"],
  ["u14 stale no longer told apart from never-read", PIE,
    "  if (pool.masked || pool.freshness.verdict === 'STALE') return { kind: 'DIMMED' };\n",
    ""],
  ["u14 the dimmed dot carries a figure", VIEW,
    "      <circle cx={c} cy={c} r={c - 1.5} fill=\"#D6D1C8\"",
    "      <path data-cap-fill=\"\" d=\"M 10 10 L 10 1.5 A 8.5 8.5 0 0 1 18.5 10 Z\" fill=\"green\" />\n      <circle cx={c} cy={c} r={c - 1.5} fill=\"#D6D1C8\""],
  ["u14 the dot shrinks back to the glyph size", PIE,
    "export const PIE_DOT_SIZE = 20;",
    "export const PIE_DOT_SIZE = 14;"],
  ["u14 the A2 frame drawn as a stop sign", PIE,
    "  if (pool.presentation === 'BLOCKED_SUBORDINATE') return { kind: 'PIE', percent: 0 };",
    "  if (pool.presentation === 'BLOCKED_SUBORDINATE') return { kind: 'STOP' };"],
  ["u14 the empty pie loses its dark-red rim", VIEW,
    "stroke={percent === 0 ? remainingColor(0) : PIE_RIM}",
    "stroke={PIE_RIM}"],
  ["u14 the disc follows the dark theme (contrast lost)", PIE,
    "export const PIE_TRACK = '#F6F3E8';",
    "export const PIE_TRACK = '#1A1A1F';"],
  ["u14 the stop sign loses its white edge", VIEW,
    "fill={STOP_RED} stroke=\"#FFFFFF\" strokeWidth={0.8}",
    "fill={STOP_RED}"],
  ["u14 the banner goes back to a non-stop mark", BANNER,
    "<StateDot look={{ kind: 'STOP' }} state=\"LIMITED\" name={it.banner.title} />",
    "<StateDot look={{ kind: 'SPOTTED' }} state=\"LIMITED\" name={it.banner.title} />"],
  ["u14 the 5h pie drawn twice (lead dot + token)", LAYOUT,
    "if (normal && meter && role !== 'five-hour')",
    "if (normal && meter)"],
  // ── S4 reads tokens.css: a bar colour changed there is judged by the contrast test ──
  ["u14 a tokens.css dark bar colour loses contrast with the pie-dot", TOKENS,
    "  --cth-cream-100: #1D1D22;",
    "  --cth-cream-100: #E8E4DA;"],
  // ── CRIT-15-PRE: the impact string is pushed by main, never polled ──
  ["c15 the impact hook polls again", IMPACT_HOOK,
    "  if (first) read(agentId);\n",
    "  if (first) read(agentId);\n  setInterval(() => read(agentId), 2000);\n"],
  ["c15 a capacity publication does not push impacts", INDEX,
    "onChange: () => { pushCapacityStrip(); pushAgentUsage(); pushAgentImpact(); }",
    "onChange: () => { pushCapacityStrip(); pushAgentUsage(); }"],
  ["c15 an admission move does not push impacts", INDEX,
    "  onAdmission: () => pushAgentImpact()", "  onAdmission: () => {}"],
  ["c15 the runtime does not report a confirmed launch", RUNTIME,
    "    this.admission.confirmLaunch(decision);\n    this.admissionMoved();\n", "    this.admission.confirmLaunch(decision);\n"],
  ["c15 an unresolved reservation's lapse is never marked", RUNTIME,
    "    if (decision.grantId) this.armReservationLapse();\n", ""],
  ["c15 stop() leaves a lapse timer armed", RUNTIME,
    "    for (const handle of this.lapseTimers) this.clearTimer(handle);\n", ""],
  ["c15 impacts pushed on control:snapshot", INDEX,
    "w.webContents.send(AGENT_IMPACT_PUSH, push)", "w.webContents.send('control:snapshot', push)"],
  ["c15 impact dedupe drops a real change", IMPACT_PUSH,
    "    const key = JSON.stringify(push.rows);", "    const key = JSON.stringify(push.rows.map((r) => r.agentId));"],
  ["c15 a late mount answer overwrites a newer impact push", IMPACT_HOOK,
    "if (pushed.has(agentId) || !listeners.has(agentId)) return;", "if (!listeners.has(agentId)) return;"],
  ["c15 the snapshot does not register the agent for pushes", INDEX,
    "  impactWatched.add(agentId);\n", ""],
  ["c15 the floor switch does not push", INDEX,
    "  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });\n  pushAgentImpact();\n",
    "  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });\n"],
  ["c15 a submit outcome does not push", INDEX,
    "    pushAgentImpact();\n    if (r.outcome.kind === 'COMMITTED') return;", "    if (r.outcome.kind === 'COMMITTED') return;"],
  ["c15 a resolved interference does not push", INDEX,
    "  const resolved = ptyId ? automaticSubmit.resolveInterference(ptyId, how as InterferenceResolution) : false;\n  pushAgentImpact();\n",
    "  const resolved = ptyId ? automaticSubmit.resolveInterference(ptyId, how as InterferenceResolution) : false;\n"],
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
