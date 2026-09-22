'use strict';

/**
 * Static visual preview of the title-bar capacity strip, for the human's review.
 *
 * Every panel is a REAL pool object (real tracker -> real presenter -> presentPool)
 * rendered by the real CapacityStripView with react-dom/server, inside a replica of the
 * 36px title bar AT A GIVEN WINDOW WIDTH (the bar's own padding, logo, version badge and
 * right-hand buttons are approximated, so the strip gets roughly the room it gets in the
 * app). The strip ships its own CSS; a small inline script does exactly what the app
 * component does on resize — measure the overflow and hand the travel to that CSS — so
 * an overflowing strip really scrolls here, pauses on hover, and stays still under
 * prefers-reduced-motion. Light-theme token values are inlined; fonts are approximate.
 *
 * Usage: node test/tools/capacity-strip-preview.cjs [output.html]
 *   default output: ../CAPUI-STRIP-PREVIEW.html beside the repo (C:/Dunder when the repo
 *   is a C:/Dunder/_work checkout). Not a test; writes one file and nothing else.
 */
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('../load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { CAPACITY_EMPTY_TEXT } = loadTs('src/shared/capacityStrip.ts');
const { presentPool } = loadTs('src/renderer/src/capacity/capacityStrip.ts');
const { CapacityStripView, SCROLL_PX_PER_S, StateDot, PieMeter } = loadTs('src/renderer/src/components/CapacityStrip.tsx');
const { remainingColor } = loadTs('src/renderer/src/capacity/pieDot.ts');

const T0 = new Date(2026, 8, 21, 14, 5, 0).getTime();
const H = 3_600_000;
const win = (id, kind, remaining, resetsAt) => ({
  windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : kind === 'SEVEN_DAY' ? 10080 : null,
  usedPercent: remaining === null ? null : 100 - remaining, remainingPercent: remaining, resetsAt
});
const std = (five, weekly, fiveReset = T0 + 25 * 60_000) =>
  [win('five_hour', 'FIVE_HOUR', five, fiveReset), win('seven_day', 'SEVEN_DAY', weekly, T0 + 67 * H)];

/** One scenario = pools ({ provider, windows, over, restore }); `stale` ages everything. */
function scenario(pools, { stale = false } = {}) {
  let now = T0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter();
  let seq = 0;
  for (const p of pools) {
    const obs = {
      poolKey: `${p.provider}:acct:${p.provider}`, streamId: p.provider, sourceSequence: ++seq,
      provider: p.provider, accountScope: 'acct', limitId: p.provider,
      source: p.provider === 'claude' ? 'claude-status-line' : 'codex-rollout',
      observedAt: now - 60_000 * (p.ageMin ?? 0), receivedAt: now, windows: p.windows,
      providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: null,
      ...(p.over || {})
    };
    if (p.restore) tracker.restore(obs, null); else tracker.ingest(obs);
  }
  if (stale) { now += L0_SEM_POLICY.liveTtlMs + 30 * 60_000; tracker.evaluate(); }
  const c = presenter.present({ snapshot: tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now });
  return { pools: c.pools.map((p) => presentPool(p, now)), emptyText: c.emptyText };
}

const TOKENS = `
  --cth-cream-100:#FFF8E7; --cth-cream-200:#F4E9C7; --cth-paper-100:#FCFAF0; --cth-paper-200:#F0EAD2;
  --cth-ink-900:#1A1320; --cth-ink-700:#3D2E4A; --cth-ink-500:#6B5878; --cth-ink-300:#A899B5;
  --cth-status-thinking:#4F9FAF; --cth-status-working:#DCAB3C; --cth-status-waiting:#6D87D6;
  --cth-status-blocked:#D96A62; --cth-status-success:#5CA97A; --cth-status-looping:#D6903F; --cth-status-ghost:#D9D3DE;
  --cth-font-ui:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;`;

function panel(title, note, view, windowWidth) {
  const strip = renderToStaticMarkup(React.createElement(CapacityStripView, view));
  return `
<section>
  <h2>${title}</h2>
  <p class="note">${note} <span class="meta">window ${windowWidth}px</span></p>
  <div class="bar" style="width:${windowWidth}px">
    <span class="logo">Munder Difflin</span><span class="badge">v1.0.45</span>
    <div class="cap-strip-host" data-cap-strip="" data-overflow="false" tabindex="0">${strip}</div>
    <span class="drag"></span>
    <span class="btn">☾</span><span class="btn">⚙</span><span class="btn">⛶</span>
  </div>
</section>`;
}

const codex = (windows, over, extra = {}) => ({ provider: 'codex', windows, over, ...extra });
const claude = (windows, over) => ({ provider: 'claude', windows, over });
const ATTRIB = { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' };
const MIN = 1280;   // the app's minimum window width
const FULL = 1920;

/** Unit #14: the pie-dot on its own, larger than life, so the look can be judged. */
const dot = (el) => renderToStaticMarkup(el);
const cell = (svg, label, sub = '') => `<div class="cell"><div class="big">${svg}</div><div class="lab">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
const spectrum = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 0].map((p) =>
  cell(dot(React.createElement(PieMeter, { percent: p, valueText: `${p}%`, role: 'demo' })), `${p}% remaining`, remainingColor(p))).join('');
const specials = [
  cell(dot(React.createElement(StateDot, { look: { kind: 'STOP' }, state: 'LIMITED', name: 'Limited' })), 'LIMIT reached', 'stop sign, not a pie'),
  cell(dot(React.createElement(StateDot, { look: { kind: 'SPOTTED' }, state: 'UNKNOWN', name: 'Unknown' })), 'UNKNOWN / no reading', 'black-and-white spotted'),
  cell(dot(React.createElement(StateDot, { look: { kind: 'DIMMED', percent: null }, state: 'AVAILABLE', name: 'Available' })), 'STALE (default, today)', 'dimmed, dashed rim, no wedge'),
  cell(dot(React.createElement(StateDot, { look: { kind: 'DIMMED', percent: 72 }, state: 'AVAILABLE', name: 'Available' })), 'STALE with last-known 72%', 'dimmed pie: needs a contract change (see note)'),
  cell(dot(React.createElement(StateDot, { look: { kind: 'SPOTTED' }, state: 'AVAILABLE', name: 'Available' })), 'STALE, alternative', 'the spotted look instead'),
  cell(dot(React.createElement(StateDot, { look: { kind: 'RING' }, state: 'AVAILABLE', name: 'Available' })), 'known state, no figure', 'empty ring (rare)')
].join('');
const LEGEND = `
<section class="legend">
  <h2>The pie-dot (unit #14), drawn larger than life (shown at 2x)</h2>
  <p class="note">The filled wedge IS the remaining share (a full disc = 100% left). Its colour follows the same figure, on one smooth scale from green at 100% to dark red at 0%. The number stays as text on the row. In the strip, each dot is 20px (the old glyph was 14px) and the bar is gone.</p>
  <div class="row">${spectrum}</div>
  <div class="row">${specials}</div>
</section>`;

const panels = [
  panel('Cold start — no reading yet (F3)', 'Before any provider has reported: the unknown shape and main\'s text, never an empty bar.',
    { pools: [], emptyText: CAPACITY_EMPTY_TEXT }, MIN),
  panel('Healthy — two pools', 'Each pool leads with its 5h pie (green, nearly full) and the figure. No bar. No state words. No reset hints: both are above the threshold (15%).',
    scenario([codex(std(80.6, 60)), claude(std(91, 55))]), MIN),
  panel('Reset hint below the threshold', 'Codex 5h at 10%: a thin dark-orange wedge, and its reset expectation appears. Claude at 91%: none.',
    scenario([codex(std(10, 60)), claude(std(91, 55))]), MIN),
  panel('Weekly revealed', 'Weekly at 14.9% is below the threshold: it gets its own (red-orange) pie, figure and reset hint, inline.',
    scenario([codex(std(80, 14.9))]), MIN),
  panel('Exhausted / blocked (provider-attributed)', 'LIMIT: the stop sign; weekly primary; ONE subordinate 5h token. No pie for the unusable 5h figure.',
    scenario([codex(std(63, 0), ATTRIB)]), MIN),
  panel('A2: reserve only, weekly at 0% (not attributed)', 'Not a provider limit, so no stop sign: an EMPTY pie (weekly at 0%) with its dark-red rim, and the held frame with observational copy.',
    scenario([codex(std(63, 0))]), MIN),
  panel('UNKNOWN (fresh reading, no usable numbers)', 'The spotted dot; no pie at all; the status is stated.',
    scenario([codex([win('five_hour', 'FIVE_HOUR', null, null), win('seven_day', 'SEVEN_DAY', 60, null)])]), MIN),
  panel('Stale', 'The reading aged out. TODAY this draws the SPOTTED dot: a stale reading is forced to UNKNOWN, and the strip is told nothing that separates it from "no reading" (the same text as the panel above). The DIMMED look in the legend needs main to say "stale" - see the note to god.',
    scenario([codex(std(80, 60))], { stale: true }), MIN),
  panel('Stale + open limit epoch (A1)', 'The stop sign stays (the tracker\'s state is kept); the figures are removed.',
    // 5h reset beyond the staleness gap: a PASSED reset would (correctly) move the epoch to RECOVERING.
    scenario([codex(std(80, 60, T0 + 3 * H), { providerReachedType: 'usage' })], { stale: true }), MIN),
  panel('Restored after restart', 'Evidence survived a restart but no live reading has confirmed it yet.',
    scenario([codex(std(80, 60), undefined, { restore: true, ageMin: 5 })]), MIN),
  panel('Busy — two pools, everything showing, full-screen window', 'Both weekly rows revealed and every reset hint showing, on a 1920px window. This much text may overflow even here; if it does, it scrolls.',
    scenario([codex(std(12, 9.5)), claude(std(8, 13))]), FULL),
  panel('Busy — the same two pools at the minimum window: SCROLLS', 'Wider than the room: the whole strip glides back and forth, holding at each end (hover to pause; no motion under reduced-motion, scroll by hand instead).',
    scenario([codex(std(12, 9.5)), claude(std(8, 13))]), MIN),
  panel('Two pools, one blocked, at the minimum window', 'Blocked Codex beside a low Claude.',
    scenario([codex(std(63, 0), ATTRIB), claude(std(8, 13))]), MIN)
];

// The same measurement the app component makes (CapacityStrip.tsx), for the static page.
const MEASURE = `
(function () {
  function measure(host) {
    var track = host.querySelector('[data-cap-track]');
    if (!track) return;
    var d = Math.max(0, Math.ceil(track.scrollWidth - host.clientWidth));
    host.dataset.overflow = d > 0 ? 'true' : 'false';
    host.style.setProperty('--cap-scroll', (-d) + 'px');
    host.style.setProperty('--cap-scroll-duration', Math.max(6, Math.round(d / ${SCROLL_PX_PER_S}) + 3) + 's');
  }
  var hosts = document.querySelectorAll('.cap-strip-host');
  hosts.forEach(measure);
  window.addEventListener('resize', function () { hosts.forEach(measure); });
})();`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Capacity strip preview</title>
<style>
  :root {${TOKENS} }
  body { margin: 0; padding: 24px 16px 48px; background: #FFFDF5; color: var(--cth-ink-900); font-family: var(--cth-font-ui); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lead { color: var(--cth-ink-500); font-size: 13px; margin: 0 0 24px; max-width: 980px; }
  section { margin: 0 0 22px; }
  h2 { font-size: 14px; margin: 0 0 2px; }
  .note { font-size: 12px; color: var(--cth-ink-500); margin: 0 0 6px; }
  .meta { color: var(--cth-ink-300); margin-left: 6px; }
  .frame { overflow-x: auto; }
  .bar { height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 12px 0 96px; box-sizing: border-box;
    background: linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%);
    border: 1px solid var(--cth-ink-300); overflow: hidden; font-family: var(--cth-font-ui); font-size: 12px; }
  .logo { font-weight: 700; font-size: 14px; white-space: nowrap; flex-shrink: 0; }
  .badge { font-size: 12px; color: var(--cth-ink-500); flex-shrink: 0; }
  .drag { flex: 1 1 0; min-width: 0; }
  .btn { width: 28px; height: 28px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
    background: var(--cth-paper-100); box-shadow: inset 0 0 0 1px var(--cth-ink-300); border-radius: 2px; }
  .cap-strip-host { outline: 1px dashed rgba(107,88,120,.35); outline-offset: -1px; }
  .legend .row { display: flex; flex-wrap: wrap; gap: 10px 14px; margin: 8px 0 10px; }
  .cell { width: 92px; text-align: center; }
  .big { display: inline-block; transform: scale(2); transform-origin: center; margin: 12px 0 14px; }
  .lab { font-size: 11px; color: var(--cth-ink-900); }
  .sub { font-size: 10px; color: var(--cth-ink-500); line-height: 1.3; }
</style></head>
<body>
<h1>Title-bar capacity strip — visual preview (unit #14: the pie-dot)</h1>
<p class="lead">Every panel is a real pool object from the real tracker and presenter, rendered by the real strip component
inside a replica of the 36px title bar at the stated window width (the app's minimum is 1280px). The bar is gone: each figure
is a PIE-DOT whose wedge and colour are the remaining share (green at 100% to dark red at 0%). A provider limit is a stop sign;
no reading is a spotted dot; an aged reading is a dimmed dot. There are still no state words (screen readers hear them). Reset hints appear only
below the threshold (15% for now). A strip wider than its room scrolls; hover pauses it. The dashed outline is the strip's own
box. Light theme, approximate fonts. Generated ${new Date().toISOString()} by test/tools/capacity-strip-preview.cjs.</p>
${LEGEND}
${panels.map((p) => `<div class="frame">${p}</div>`).join('\n')}
<script>${MEASURE}</script>
</body></html>
`;

const out = process.argv[2] || path.resolve(__dirname, '..', '..', '..', '..', 'CAPUI-STRIP-PREVIEW.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} chars, ${panels.length} panels)`);
