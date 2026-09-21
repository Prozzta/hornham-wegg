'use strict';

/**
 * Static visual preview of the title-bar capacity strip, for the human's review.
 *
 * Every panel is a REAL pool object (real tracker -> real presenter -> presentPool)
 * rendered by the real CapacityStripView with react-dom/server, inside an approximation
 * of the 36px title bar (light-theme --cth-* token values inlined). The strip's own CSS
 * does the clipping, so what the browser clips here is what the app would clip. The
 * collapse level is chosen with an approximate text measure (no app fonts in a static
 * file): rough, but faithful to the rules.
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
const { presentPool } = loadTs('src/renderer/src/capacity/capacityStrip.ts');
const { chooseCollapseLevel } = loadTs('src/renderer/src/capacity/stripLayout.ts');
const { CapacityStripView } = loadTs('src/renderer/src/components/CapacityStrip.tsx');

const T0 = new Date(2026, 8, 21, 14, 5, 0).getTime();
const H = 3_600_000;
const win = (id, kind, remaining, resetsAt) => ({
  windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : kind === 'SEVEN_DAY' ? 10080 : null,
  usedPercent: remaining === null ? null : 100 - remaining, remainingPercent: remaining, resetsAt
});
const std = (five, weekly) => [win('five_hour', 'FIVE_HOUR', five, T0 + 25 * 60_000), win('seven_day', 'SEVEN_DAY', weekly, T0 + 67 * H)];

/**
 * One scenario = a list of pools, each { provider, account, windows, over, restore }.
 * `stale` ages the whole tracker past freshness after ingest.
 */
function scenario(pools, { stale = false } = {}) {
  let now = T0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter();
  let seq = 0;
  for (const p of pools) {
    const limitId = p.provider;
    const obs = {
      poolKey: `${p.provider}:${p.account}:${limitId}`, streamId: p.account, sourceSequence: ++seq,
      provider: p.provider, accountScope: p.account, limitId,
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
  return c.pools.map((p) => presentPool(p, now));
}

const measure = (s) => s.length * 6.4;
const TOKENS = `
  --cth-cream-100:#FFF8E7; --cth-cream-200:#F4E9C7; --cth-paper-100:#FCFAF0; --cth-paper-200:#F0EAD2;
  --cth-ink-900:#1A1320; --cth-ink-700:#3D2E4A; --cth-ink-500:#6B5878; --cth-ink-300:#A899B5;
  --cth-status-thinking:#4F9FAF; --cth-status-waiting:#6D87D6; --cth-status-blocked:#D96A62;
  --cth-status-success:#5CA97A; --cth-status-ghost:#D9D3DE;
  --cth-font-ui:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;`;

function panel(title, note, pools, width) {
  const level = chooseCollapseLevel(pools, width, measure);
  const strip = renderToStaticMarkup(React.createElement(CapacityStripView, { pools, level }));
  return `
<section>
  <h2>${title}</h2>
  <p class="note">${note} <span class="meta">strip width ${width}px · collapse level ${level}</span></p>
  <div class="bar">
    <span class="chrome">Munder Difflin · v1.0.45 · auto mode off</span>
    <div class="strip" style="width:${width}px">${strip}</div>
    <span class="chrome btns">☾ ⚙ ⛶</span>
  </div>
</section>`;
}

const codex = (windows, over, extra = {}) => ({ provider: 'codex', account: 'a', windows, over, ...extra });
const ATTRIB = { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' };
const FULL = 760;   // ≈ the strip's share of the title bar at the 1280px minimum window

const panels = [
  panel('Healthy', 'Continuous meter, 5h figure, reset expectation. Weekly hidden (60%).',
    scenario([codex(std(80.6, 60))]), FULL),
  panel('Weekly revealed', 'Weekly at 14.9% is below the display threshold (15), so its row appears inline.',
    scenario([codex(std(80, 14.9))]), FULL),
  panel('Exhausted / blocked (provider-attributed)', 'C2.7: LIMITED, weekly primary, ONE subordinate 5h token. No meters.',
    scenario([codex(std(63, 0), ATTRIB)]), FULL),
  panel('A2: Reserve only, weekly at 0% (not attributed)', 'The human\'s A2 ruling: the held frame with observational copy.',
    scenario([codex(std(63, 0))]), FULL),
  panel('UNKNOWN (fresh reading, no usable numbers)', 'No meter primitive at all; the status is stated.',
    scenario([codex([win('five_hour', 'FIVE_HOUR', null, null), win('seven_day', 'SEVEN_DAY', 60, null)])]), FULL),
  panel('Stale', 'The reading aged out: no number, no bar, absolute last-update time (A3).',
    scenario([codex(std(80, 60))], { stale: true }), FULL),
  panel('Stale + open limit epoch (A1)', 'State stays Limited (the tracker\'s), figures removed, C2.6 "Weekly capacity unknown".',
    // 5h reset beyond the staleness gap: a PASSED reset would (correctly) move the epoch to RECOVERING.
    scenario([codex([win('five_hour', 'FIVE_HOUR', 80, T0 + 3 * H), win('seven_day', 'SEVEN_DAY', 60, T0 + 67 * H)],
      { providerReachedType: 'usage' })], { stale: true }), FULL),
  panel('Restored after restart', 'Evidence survived a restart but no live reading has confirmed it.',
    scenario([codex(std(80, 60), undefined, { restore: true, ageMin: 5 })]), FULL),
  panel('Three pools: Codex, Codex 2, Claude', 'Two Codex accounts are two pools (A9 label "Codex 2"); plus a Claude pool.',
    scenario([codex(std(72, 40)), { provider: 'codex', account: 'b', windows: std(35, 12) }, { provider: 'claude', account: 'c', windows: std(91, 55) }]), FULL),
  panel('Three pools on a wide window (1920px)', 'With room, the full form: meters, figures and reset hints for every pool.',
    scenario([codex(std(72, 40)), { provider: 'codex', account: 'b', windows: std(35, 12) }, { provider: 'claude', account: 'c', windows: std(91, 55) }]), 1400),
  panel('Three pools, one blocked — at the minimum window width', 'The collapse picks the least-collapsed level that fits.',
    scenario([codex(std(63, 0), ATTRIB), { provider: 'codex', account: 'b', windows: std(35, 12) }, { provider: 'claude', account: 'c', windows: std(91, 55) }]), FULL),
  panel('Compact (level 3), three pools', 'Meters, then reset hints, dropped; both figures compacted. 5h is never dropped.',
    scenario([codex(std(72, 40)), { provider: 'codex', account: 'b', windows: std(35, 12) }, { provider: 'claude', account: 'c', windows: std(91, 55) }]), 470),
  panel('Below the compact width (unsupported) — N2', 'Whole tokens move to the hidden second line: nothing is cut in half, but a later pool can disappear entirely. No "+N more" marker exists (it would need a main-owned string).',
    scenario([codex(std(72, 40)), { provider: 'codex', account: 'b', windows: std(35, 12) }, { provider: 'claude', account: 'c', windows: std(91, 55) }]), 300)
];

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Capacity strip preview</title>
<style>
  :root {${TOKENS} }
  body { margin: 0; padding: 24px 16px 48px; background: #FFFDF5; color: var(--cth-ink-900); font-family: var(--cth-font-ui); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lead { color: var(--cth-ink-500); font-size: 13px; margin: 0 0 24px; max-width: 900px; }
  section { margin: 0 0 22px; }
  h2 { font-size: 14px; margin: 0 0 2px; }
  .note { font-size: 12px; color: var(--cth-ink-500); margin: 0 0 6px; }
  .meta { color: var(--cth-ink-300); margin-left: 6px; }
  .bar { height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 12px;
    background: linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%);
    border: 1px solid var(--cth-ink-300); overflow: hidden; width: max-content; max-width: 100%; }
  .chrome { font-size: 13px; color: var(--cth-ink-500); white-space: nowrap; flex-shrink: 0; }
  .btns { letter-spacing: 10px; }
  .strip { flex: 0 0 auto; min-width: 0; height: 36px; overflow: hidden; display: flex; flex-wrap: wrap;
    align-items: center; align-content: flex-start; column-gap: 16px; font-family: var(--cth-font-ui); font-size: 12px;
    outline: 1px dashed rgba(107,88,120,.35); outline-offset: -1px; }
</style></head>
<body>
<h1>Title-bar capacity strip — visual preview (v1.1.45 unit #2)</h1>
<p class="lead">Every panel is a real pool object from the real tracker and presenter, rendered by the real strip component. Light theme,
approximate fonts. The dashed outline marks the strip's own box inside the title bar. Generated ${new Date().toISOString()} by
test/tools/capacity-strip-preview.cjs.</p>
${panels.join('\n')}
</body></html>
`;

const out = process.argv[2] || path.resolve(__dirname, '..', '..', '..', '..', 'CAPUI-STRIP-PREVIEW.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes, ${panels.length} panels)`);
