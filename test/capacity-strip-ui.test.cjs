'use strict';

/**
 * v1.1.45 — the title-bar capacity strip, as amended at the human's strip review
 * (2026-09-21): state as a coloured SHAPE only (no state words), stronger colours, full
 * content that SCROLLS on overflow (replacing the C2.10 collapse ladder), reset hints
 * only below the threshold, a drawn cold-start chip (F3), and no auto-mode label.
 *
 * Every fixture is a REAL pool object: real tracker -> real presenter -> the renderer's
 * presentPool, then rendered with react-dom/server. Order follows the spec's own (§20):
 * UNKNOWN / stale / cold start FIRST, then the healthy path, then the weekly and
 * exhausted frames, then scrolling and structure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { CAPACITY_EMPTY_TEXT } = loadTs('src/shared/capacityStrip.ts');
const { presentPool } = loadTs('src/renderer/src/capacity/capacityStrip.ts');
const layout = loadTs('src/renderer/src/capacity/stripLayout.ts');
const { poolTokens } = layout;
const { CapacityStripView, STATE_COLOR, STRIP_CSS, scrollDistance, sweepSeconds } =
  loadTs('src/renderer/src/components/CapacityStrip.tsx');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct-a:codex';
const win = (id, kind, remaining, resetsAt) => ({
  windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : kind === 'SEVEN_DAY' ? 10080 : null,
  usedPercent: remaining === null ? null : 100 - remaining, remainingPercent: remaining, resetsAt
});
let seq = 0;
const obs = (at, windows, over = {}) => ({
  poolKey: POOL, streamId: 's', sourceSequence: ++seq, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', observedAt: at, receivedAt: at, windows,
  providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus', ...over
});
const std = (five, weekly) => [win('five_hour', 'FIVE_HOUR', five, T0 + 3_600_000), win('seven_day', 'SEVEN_DAY', weekly, T0 + 3 * 86_400_000)];

/** A real pool object, optionally aged past freshness. Returns the presented pool. */
function pool(windows, over = {}, { stale = false } = {}) {
  let now = T0 + 1000;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter({ formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 1) });
  tracker.ingest(obs(now, windows, over));
  if (stale) { now += L0_SEM_POLICY.liveTtlMs + 10; tracker.evaluate(); }
  const c = presenter.present({ snapshot: tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now });
  assert.equal(c.pools.length, 1);
  return presentPool(c.pools[0], now);
}

const render = (pools, emptyText = CAPACITY_EMPTY_TEXT) =>
  renderToStaticMarkup(React.createElement(CapacityStripView, { pools, emptyText }));
/** The VISIBLE text nodes (the <style> block and attributes such as aria-label excluded). */
const visibleNodes = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, '|')
  .split('|').map((s) => s.trim()).filter(Boolean);
const count = (s, re) => (s.match(re) || []).length;

const HEALTHY = () => pool(std(80.6, 60));
const LOW_5H = () => pool(std(10, 60));
const REVEALED = () => pool(std(80, 14.9));
const BLOCKED = () => pool(std(63, 0), { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' });
const HELD_A2 = () => pool(std(63, 0));
const STALE = () => pool(std(80, 60), {}, { stale: true });
const ALL = [HEALTHY, LOW_5H, REVEALED, BLOCKED, HELD_A2, STALE];

// ─── UNKNOWN / stale / cold start FIRST (§20) ───────────────────────────────────

test('stale pool: NO meter primitive — no track, no fill, no aria value — only main\'s text', () => {
  const p = STALE();
  assert.equal(p.presentation, 'UNKNOWN');
  const html = render([p]);
  assert.ok(!/role="(meter|progressbar)"|aria-valuenow|data-cap-meter/.test(html), 'an empty bar is a drawn claim of zero');
  assert.ok(!/\d+%/.test(visibleNodes(html).join(' ')), 'stale removes the number');
  assert.ok(visibleNodes(html).includes('5h · Capacity unknown · last update @1000'), 'absolute last-update time (A3)');
  assert.ok(html.includes('data-cap-state-token="UNKNOWN"'));
});

test('C2.6 split: applicable-but-unknown weekly says "Weekly capacity unknown", text only', () => {
  const p = pool(std(80, 60), { providerReachedType: 'usage' }, { stale: true });
  assert.equal(p.state, 'LIMITED', 'A1: the tracker state is kept verbatim');
  assert.equal(p.weekly.reason, 'UNKNOWN_CAPACITY');
  const html = render([p]);
  assert.ok(visibleNodes(html).includes('Weekly capacity unknown'));
  assert.ok(!/role="meter"/.test(html));
  assert.ok(html.includes('data-cap-state-token="LIMITED"'), 'the shape says LIMITED; no word does');
});

test('C2.6 split: unknown applicability says "Additional limit status unknown", text only', () => {
  const p = pool([win('five_hour', 'FIVE_HOUR', 80, T0 + 3_600_000), win('mystery', 'OTHER', 40, null)],
    { providerReachedType: 'usage' });
  assert.equal(p.weekly.reason, 'UNKNOWN_APPLICABILITY');
  const html = render([p]);
  assert.ok(visibleNodes(html).includes('Additional limit status unknown'));
  assert.equal(count(html, /data-cap-meter="weekly"/g), 0);
});

test('F3 cold start: no pools draws the unknown shape and main\'s emptyText — never nothing', () => {
  const html = render([]);
  assert.ok(html.includes('data-cap-empty'));
  assert.ok(html.includes('data-cap-state-token="UNKNOWN"'));
  assert.deepEqual(visibleNodes(html), ['Capacity unknown']);
  assert.ok(html.includes('data-cap-dot="SPOTTED"'), 'unit #14: the spotted dot is drawn');
  assert.ok(!/role="meter"|\d/.test(visibleNodes(html).join(' ')), 'no figure, no meter');
  assert.ok(visibleNodes(render([], 'from main')).includes('from main'), 'the text is main\'s, not the renderer\'s');
  const src = codeOnly(readSource('src/renderer/src/components/CapacityStrip.tsx'), 'CapacityStrip.tsx');
  assert.match(src, /emptyText=\{collection\?\.emptyText \?\? CAPACITY_EMPTY_TEXT\}/,
    'the connected strip uses main\'s emptyText, and the shared constant only before main has answered');
});

test('the expiry mask degrades a healthy row to UNKNOWN with no meter', () => {
  const p = HEALTHY();
  const html = render([presentPool(p, p.freshness.expiresAt + 1)]);
  assert.ok(!/role="meter"/.test(html));
  assert.ok(!/\d+%/.test(visibleNodes(html).join(' ')));
  assert.ok(html.includes('data-cap-state-token="UNKNOWN"'));
});

// ─── State = a coloured shape, never a word ───────────────────────────────────────

test('NO state word is visible in any state — the shape carries it, named for screen readers only', () => {
  for (const make of ALL) {
    const p = make();
    const html = render([p]);
    const nodes = visibleNodes(html);
    assert.ok(!nodes.includes(p.stateText), `"${p.stateText}" must not be visible text (${p.presentation})`);
    for (const word of ['Available', 'Limited', 'Reserve only', 'Recovering', 'Approaching limit']) {
      assert.ok(!nodes.includes(word), `no bare state word "${word}"`);
    }
    assert.match(html, new RegExp(`role="img" aria-label="${p.stateText}" data-cap-state-token="${p.state}"`),
      'the shape carries the state word as its accessible name');
    assert.match(html, /data-cap-dot="(PIE|STOP|SPOTTED|DIMMED|RING)"[^>]*>(<span[^>]*>)?<svg/, 'every state shows its dot, healthy included (unit #14)');
  }
});

test('colours (the Monitor usage bar and detail rows): six DISTINCT theme tokens; UNKNOWN is strong neutral ink, never ghost and never healthy', () => {
  assert.equal(new Set(Object.values(STATE_COLOR)).size, 6, 'every state has its own colour');
  assert.notEqual(STATE_COLOR.UNKNOWN, STATE_COLOR.AVAILABLE);
  assert.ok(!Object.values(STATE_COLOR).some((c) => /ghost|idle/.test(c)), 'no pale ghost/idle ink carries a state (V3)');
  assert.equal(STATE_COLOR.UNKNOWN, 'var(--cth-ink-500)');
  for (const c of Object.values(STATE_COLOR)) assert.match(c, /^var\(--cth-/, 'theme tokens, so the dark theme follows');
});

// ─── Healthy path ─────────────────────────────────────────────────────────────

test('healthy: mark, label, green dot, ONE continuous meter, the 5h figure — and no reset hint above the threshold', () => {
  const html = render([HEALTHY()]);
  const nodes = visibleNodes(html);
  assert.ok(nodes.includes('Codex'));
  assert.ok(html.includes('data-cap-dot="PIE"'), 'unit #14: the 5h pie leads');
  assert.ok(html.includes('data-cap-state-token="AVAILABLE"'));
  assert.equal(count(html, /role="meter"/g), 1);
  assert.match(html, /role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80.6" aria-valuetext="5h · 80% remaining"/);
  assert.ok(nodes.includes('5h · 80% remaining'));
  assert.ok(!/data-cap-reset/.test(html), 'reset hint only below the threshold');
  assert.ok(html.includes('<svg'), 'the provider mark is drawn');
});

test('reset hint: drawn for the 5h window when it is BELOW the threshold', () => {
  const html = render([LOW_5H()]);
  assert.ok(visibleNodes(html).includes('reset expected ~@3600000'));
  assert.equal(count(html, /data-cap-reset="five-hour"/g), 1);
});

test('weekly revealed: its own meter and text, with its reset (below threshold) — the 5h beside it has none', () => {
  const p = REVEALED();
  assert.equal(p.weekly.reason, 'BELOW_DISPLAY_THRESHOLD');
  const html = render([p]);
  assert.equal(count(html, /role="meter"/g), 2);
  assert.ok(visibleNodes(html).includes('Weekly · 14% remaining'));
  assert.equal(count(html, /data-cap-reset="weekly"/g), 1);
  assert.equal(count(html, /data-cap-reset="five-hour"/g), 0);
});

test('crit 1: every fixture shows a 5h value or status, and no bare percentage exists', () => {
  for (const make of ALL) {
    const nodes = visibleNodes(render([make()]));
    assert.ok(nodes.some((n) => /^5h[ ·]/.test(n)), JSON.stringify(nodes));
    for (const n of nodes) if (/\d+%/.test(n)) assert.match(n, /^(5h|Weekly)\b/, `a percentage must carry its window: "${n}"`);
  }
});

// ─── The exhausted frames (C2.7, crit 14-15, A2) ────────────────────────────────

for (const [name, make, token] of [['attributed LIMITED', BLOCKED, 'LIMITED'], ['A2 RESERVE_ONLY held', HELD_A2, 'RESERVE_ONLY']]) {
  test(`crit 14/15 (${name}): the shape, weekly primary, then ONE subordinate 5h token; no meter, no positive colour`, () => {
    const p = make();
    assert.equal(p.presentation, 'BLOCKED_SUBORDINATE');
    const html = render([p]);
    assert.equal(count(html, /data-cap-figure="five-hour"/g), 1);
    assert.equal(count(html, /data-cap-subordinate="true"/g), 1);
    assert.equal(count(visibleNodes(html).join('|'), /63%/g), 1, 'the 5h figure appears exactly once');
    assert.ok(!/role="(meter|progressbar)"|aria-value|data-cap-meter|data-cap-reset/.test(html));
    assert.ok(!html.includes('--cth-status-success'), 'no positive-capacity colour anywhere');
    const iShape = html.indexOf(`data-cap-state-token="${token}"`);
    const iWeekly = html.indexOf('data-cap-figure="weekly"');
    const iFive = html.indexOf('data-cap-figure="five-hour"');
    assert.ok(iShape >= 0 && iShape < iWeekly && iWeekly < iFive, 'state shape, weekly, then 5h');
    const five = html.match(/data-cap-figure="five-hour"[^>]*>([^<]*)</)[1];
    assert.match(five, /63%.*(unavailable while Weekly is exhausted|ordinary work held while Weekly is at 0%)/,
      'the blocker is in the SAME atomic string');
  });
}

// ─── Full content + scroll-on-overflow (replaces C2.10's collapse) ─────────────

test('the layout draws main\'s FULL strings only — no collapse, no compact form, no composed wording', () => {
  assert.equal(layout.chooseCollapseLevel, undefined, 'the C2.10 collapse ladder is gone (human override)');
  assert.equal(layout.COLLAPSE_LEVELS, undefined);
  for (const make of ALL) {
    const p = make();
    const allowed = new Set([p.fiveHour.text, p.fiveHour.resetText, p.weekly?.text, p.weekly?.resetText].filter(Boolean));
    for (const t of poolTokens(p)) {
      const s = t.kind === 'meter' ? t.valueText : t.text;
      assert.ok(allowed.has(s), `"${s}" is not one of main's full strings`);
    }
  }
});

test('scroll: travel is exactly the overflow (zero when it fits), at a gentle speed', () => {
  assert.equal(scrollDistance(300, 200), 100);
  assert.equal(scrollDistance(199.2, 200), 0, 'fits: no travel');
  assert.equal(scrollDistance(200.4, 200), 1, 'a sub-pixel overflow still reaches the last pixel');
  assert.equal(sweepSeconds(0), 6, 'a floor on one sweep');
  assert.ok(sweepSeconds(600) >= 600 / 30, 'no faster than 30px/s');
});

test('scroll CSS: runs only when overflowing, holds at both ends, pauses on hover/focus, OFF under reduced motion', () => {
  const css = STRIP_CSS.replace(/\s+/g, ' ');
  assert.match(css, /\.cap-strip-host\[data-overflow="true"\] \.cap-strip-track \{ animation: cap-strip-scroll /);
  assert.ok(!/^\s*\.cap-strip-track \{[^}]*animation/.test(css), 'the track does not animate unless the host overflows');
  assert.match(css, /0%, 12% \{ transform: translateX\(0\); \} 88%, 100% \{ transform: translateX\(var\(--cap-scroll, 0px\)\); \}/);
  assert.match(css, /infinite alternate/);
  assert.match(css, /\.cap-strip-host:hover \.cap-strip-track, \.cap-strip-host:focus-within \.cap-strip-track \{ animation-play-state: paused; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.cap-strip-host\[data-overflow="true"\] \.cap-strip-track \{ animation: none; \} \.cap-strip-host \{ overflow-x: auto;/);
  assert.match(css, /\.cap-strip-host \{[^}]*height: 36px; overflow: hidden;/, 'one fixed 36px line: overflow never grows the bar');
  assert.match(css, /\.cap-strip-track \{[^}]*white-space: nowrap;/);
  assert.ok(render([HEALTHY()]).includes('<style>'), 'the CSS ships with the strip');
});

test('the connected strip measures its own overflow and hands the travel to the CSS', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CapacityStrip.tsx'), 'CapacityStrip.tsx');
  assert.match(src, /const d = scrollDistance\(track\.scrollWidth, el\.clientWidth\);/);
  assert.match(src, /el\.dataset\.overflow = d > 0 \? 'true' : 'false';/);
  assert.match(src, /el\.style\.setProperty\('--cap-scroll', `\$\{-d\}px`\);/);
  assert.match(src, /new ResizeObserver\(measure\)/);
  assert.match(src, /className="cap-strip-host cth-titlebar-nodrag"/, 'no-drag, so hover can pause it');
});

// ─── Structure ────────────────────────────────────────────────────────────────

test('geometry (§9): one continuous fill per meter, no segments; the mask applied; no IPC in the component', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CapacityStrip.tsx'), 'CapacityStrip.tsx');
  assert.ok(!/segment|repeat\(|Array\.from\(\{ ?length/i.test(src), 'no segmented gauge in the capacity strip');
  assert.ok(src.includes('presentPool('), 'the connected strip applies the one-way mask');
  assert.ok(!/window\.cth/.test(src), 'it reads the one mirror via the hook');
});

test('title bar: the strip is mounted where the display-only "auto mode" label was; the setting itself remains', () => {
  const app = codeOnly(readSource('src/renderer/src/App.tsx'), 'App.tsx');
  const bar = app.indexOf('className="cth-titlebar-drag"');
  const mount = app.indexOf('<CapacityStrip />');
  const settings = app.indexOf('aria-label="Settings"');
  assert.ok(bar > 0 && mount > bar && mount < settings, 'the strip sits in the title bar, before its right-hand controls');
  assert.ok(!/auto mode on|auto mode off/.test(app), 'the title-bar auto-mode label is gone');
  assert.match(readSource('src/renderer/src/components/SettingsModal.tsx'), /autoMode/, 'the autoMode setting is untouched');
});
