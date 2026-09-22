'use strict';

/**
 * v1.1.45 unit #14 PHASE 2 — the PIE-DOT, human-approved, pinned. Each rule kills a census
 * mutant (test/tools/capacity-mutants.cjs, "u14"):
 *   no bar on the strip; the wedge IS the remaining share; the colour ramp (green 100 ->
 *   amber ~50 -> dark red 0); LIMITED = stop sign; never read = spotted; STALE = dimmed and
 *   wedge-less with no figure (S1 = a, and A1's no-figure-on-stale re-pinned); the A2 frame
 *   = an empty pie with a dark-red rim, no stop sign (S3); one lead dot per pool (S2);
 *   PIE_DOT_SIZE 20; contrast in BOTH themes (S4).
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
const pie = loadTs('src/renderer/src/capacity/pieDot.ts');
const { CapacityStripView, StateDot } = loadTs('src/renderer/src/components/CapacityStrip.tsx');

const T0 = 1_800_000_000_000;
const H = 3_600_000;
const win = (id, kind, remaining, resetsAt) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining, resetsAt });
const std = (five, weekly, fiveReset = T0 + H) => [win('five_hour', 'FIVE_HOUR', five, fiveReset), win('seven_day', 'SEVEN_DAY', weekly, T0 + 60 * H)];
const ATTRIB = { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' };

/** One pool through the real tracker + presenter + mask. */
function pool(windows, over = {}, { stale = false, restore = false, mask = false } = {}) {
  let now = T0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const presenter = new CapacityStripPresenter({ formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 9) });
  const obs = { poolKey: 'codex:a:codex', streamId: 's', sourceSequence: 1, provider: 'codex', accountScope: 'a', limitId: 'codex',
    source: 'codex-rollout', observedAt: now, receivedAt: now, windows,
    providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus', ...over };
  if (restore) tracker.restore(obs, null); else tracker.ingest(obs);
  if (stale) { now += L0_SEM_POLICY.liveTtlMs + 10; tracker.evaluate(); }
  const c = presenter.present({ snapshot: tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now });
  const p = c.pools[0];
  // The one-way mask: past main's expiresAt without main's stale push.
  return presentPool(p, mask ? (p.freshness.expiresAt ?? now) + 1 : now);
}
const render = (pools) => renderToStaticMarkup(React.createElement(CapacityStripView, { pools, emptyText: CAPACITY_EMPTY_TEXT }));
const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, '|').split('|').map((s) => s.trim()).filter(Boolean);
const dotOf = (html) => (html.match(/data-cap-dot="([A-Z]+)"/) || [])[1];
/** The lead dot's own markup: from its opening tag to the first </svg> after it. */
const dotHtml = (html) => { const i = html.indexOf('data-cap-dot='); return html.slice(i, html.indexOf('</svg>', i)); };

// ─── The looks ───────────────────────────────────────────────────────────────────────

test('LIMITED is a STOP SIGN, never a pie - live, and still when its reading ages (A1 keeps the state)', () => {
  for (const p of [pool(std(63, 0), ATTRIB), pool(std(80, 60, T0 + 3 * H), { providerReachedType: 'usage' }, { stale: true })]) {
    assert.equal(p.state, 'LIMITED');
    const html = render([p]);
    assert.equal(dotOf(html), 'STOP');
    assert.ok(dotHtml(html).includes('data-cap-stop'), 'the octagon is drawn');
    assert.ok(!/data-cap-pie|data-cap-fill/.test(dotHtml(html)), 'no pie in a stop sign');
  }
});

test('never read is SPOTTED: cold start, and a fresh reading with no usable numbers', () => {
  const cold = renderToStaticMarkup(React.createElement(CapacityStripView, { pools: [], emptyText: CAPACITY_EMPTY_TEXT }));
  assert.equal(dotOf(cold), 'SPOTTED');
  const fresh = pool([win('five_hour', 'FIVE_HOUR', null, null), win('seven_day', 'SEVEN_DAY', 60, null)]);
  assert.equal(fresh.freshness.verdict, 'FRESH');
  const html = render([fresh]);
  assert.equal(dotOf(html), 'SPOTTED');
  assert.ok(dotHtml(html).includes('data-cap-spotted'));
});

test('S1 (a): STALE is DIMMED and wedge-less - aged, restored, or masked - and carries NO figure (A1 re-pinned)', () => {
  const cases = { stale: pool(std(80, 60), {}, { stale: true }), restored: pool(std(80, 60), {}, { restore: true }),
    masked: pool(std(80, 60), {}, { mask: true }) };
  assert.equal(cases.masked.masked, true, 'the mask really fired');
  for (const [name, p] of Object.entries(cases)) {
    const html = render([p]);
    assert.equal(dotOf(html), 'DIMMED', `${name}: dimmed, distinct from the never-read spotted dot`);
    assert.ok(!/data-cap-fill|data-cap-pie|aria-valuenow/.test(html), `${name}: no wedge, no meter anywhere`);
    assert.ok(!visible(html).some((n) => /%/.test(n)), `${name}: no figure on the strip`);
  }
  // The type itself refuses a figure: a dimmed look has nothing to carry one in.
  assert.deepEqual(pie.leadDotOf(cases.stale), { kind: 'DIMMED' });
});

test('a live figure is a PIE whose wedge IS the remaining share, drawn as the pool\'s ONE lead dot (S2)', () => {
  const p = pool(std(80.6, 60));
  const html = render([p]);
  assert.equal(dotOf(html), 'PIE');
  assert.equal((html.match(/data-cap-dot=/g) || []).length, 1, 'one lead dot per pool');
  const d = pie.PIE_DOT_SIZE;
  const expected = pie.wedgePath(80.6, d / 2 - 1.5, d / 2);
  assert.ok(dotHtml(html).includes(`d="${expected}"`), 'the drawn wedge is exactly the remaining share');
  assert.match(html, /role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80.6"/, 'the 5h meter semantics sit on the pie');
  // A revealed weekly figure gets its own pie beside its text.
  const rev = render([pool(std(80, 14.9))]);
  assert.equal((rev.match(/data-cap-meter="weekly"[^>]*data-cap-pie=""/g) || []).length, 1);
});

test('wedgePath: the sweep is the remaining share (clockwise from 12 o\'clock); 0 = nothing, 100 = the whole disc', () => {
  const r = 10;
  const c = 10;
  assert.equal(pie.wedgePath(0, r, c), null);
  assert.equal(pie.wedgePath(100, r, c), 'FULL');
  const end = (p) => pie.wedgePath(p, r, c).match(/A [\d.]+ [\d.]+ 0 (\d) 1 ([\d.-]+) ([\d.-]+) Z$/);
  let m = end(25);
  assert.deepEqual([m[1], +m[2], +m[3]], ['0', 20, 10], '25% ends at 3 o\'clock, small arc');
  m = end(50);
  assert.deepEqual([m[1], +m[2], +m[3]], ['0', 10, 20], '50% ends at 6 o\'clock');
  m = end(75);
  assert.deepEqual([m[1], +m[2], +m[3]], ['1', 0, 10], '75% ends at 9 o\'clock, LARGE arc');
});

test('the colour ramp: green at 100, amber around 50, dark red at 0, and the hue never rises as the figure falls', () => {
  const hsl = (p) => pie.remainingColor(p).match(/hsl\(([\d.]+), ([\d.]+)%, ([\d.]+)%\)/).slice(1).map(Number);
  const [h100] = hsl(100);
  const [h50] = hsl(50);
  const [h0, , l0] = hsl(0);
  assert.ok(h100 >= 110 && h100 <= 140, `100% is green (hue ${h100})`);
  assert.ok(h50 >= 25 && h50 <= 50, `50% is amber/orange (hue ${h50})`);
  assert.ok(h0 <= 5 && l0 <= 30, `0% is DARK red (hue ${h0}, lightness ${l0})`);
  let prev = Infinity;
  for (let p = 100; p >= 0; p -= 5) { const [h] = hsl(p); assert.ok(h <= prev, `hue at ${p}% does not rise`); prev = h; }
  assert.equal(pie.remainingColor(150), pie.remainingColor(100), 'clamped');
  // The drawn wedge takes the colour of ITS figure.
  assert.ok(dotHtml(render([pool(std(10, 60))])).includes(`fill="${pie.remainingColor(10)}"`));
});

test('S3: the A2 frame (reserve only, weekly at 0%) is an EMPTY pie with a dark-red rim - no stop sign', () => {
  const p = pool(std(63, 0));
  assert.equal(p.state, 'RESERVE_ONLY');
  const html = render([p]);
  assert.equal(dotOf(html), 'PIE');
  assert.ok(!dotHtml(html).includes('data-cap-fill'), 'nothing filled at 0%');
  assert.ok(dotHtml(html).includes(`stroke="${pie.remainingColor(0)}"`), 'the rim takes the dark red');
  assert.ok(!html.includes('data-cap-stop'));
});

test('no BAR anywhere on the strip: every meter is a pie-dot, and the bar primitive is not used by the strip', () => {
  for (const p of [pool(std(80.6, 60)), pool(std(10, 60)), pool(std(80, 14.9)), pool(std(63, 0), ATTRIB), pool(std(63, 0))]) {
    const html = render([p]);
    const meters = html.match(/<span role="meter"[^>]*>/g) || [];
    for (const m of meters) assert.ok(m.includes('data-cap-pie'), `a strip meter is a pie: ${m.slice(0, 80)}`);
    assert.ok(!/width:\d+(\.\d+)?%/.test(html), 'no bar fill');
  }
  const src = codeOnly(readSource('src/renderer/src/components/CapacityStrip.tsx'), 'CapacityStrip.tsx');
  const strip = src.slice(src.indexOf('function Meter('), src.indexOf('export function CapacityStrip('));
  assert.ok(!strip.includes('<CapacityMeter'), 'the strip path never draws the bar primitive');
  assert.ok(!/StateShape|STATE_TOKEN/.test(src), 'the retired glyph path is gone');
});

test('PIE_DOT_SIZE is 20 and every dot is drawn at it (the old glyph was 14)', () => {
  assert.equal(pie.PIE_DOT_SIZE, 20);
  for (const look of [{ kind: 'STOP' }, { kind: 'SPOTTED' }, { kind: 'DIMMED' }, { kind: 'RING' }, { kind: 'PIE', percent: 40 }]) {
    const html = renderToStaticMarkup(React.createElement(StateDot, { look, state: 'AVAILABLE', name: 'x' }));
    assert.match(html, /<svg width="20" height="20"/, look.kind);
  }
});

// ─── S4: contrast in BOTH themes (non-text graphics: WCAG 1.4.11, >= 3:1) ─────────────

const rgbOf = (c) => {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  const [h, s, l] = c.match(/hsl\(([\d.]+), ([\d.]+)%, ([\d.]+)%\)/).slice(1).map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => { const k = (n + h / 30) % 12; return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
};
const lum = (c) => { const [r, g, b] = rgbOf(c).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
/** The title bar's backgrounds, from src/renderer/src/design/tokens.css (light, then dark). */
const BARS = { lightCream100: '#FFF8E7', lightCream200: '#F4E9C7', darkCream100: '#1D1D22', darkCream200: '#26262C' };

test('S4: every ramp colour keeps >= 3:1 on its disc, and the disc, the rim, the stop sign and the spotted dot hold on both themes', () => {
  for (let p = 0; p <= 100; p += 5) {
    const k = contrast(pie.remainingColor(p), pie.PIE_TRACK);
    assert.ok(k >= 3, `${p}%: ${k.toFixed(2)}:1 against the disc`);
  }
  for (const [bar, bg] of Object.entries(BARS)) {
    const dark = bar.startsWith('dark');
    // The disc's edge: the rim on a light bar, the light disc itself on a dark bar.
    assert.ok(contrast(dark ? pie.PIE_TRACK : pie.PIE_RIM, bg) >= 3, `${bar}: the pie's edge`);
    // The stop sign: its red on a light bar, its white edge on a dark bar.
    assert.ok(contrast(dark ? '#FFFFFF' : pie.STOP_RED, bg) >= 3, `${bar}: the stop sign's edge`);
    // Spotted: black stroke on a light bar, white disc on a dark bar.
    assert.ok(contrast(dark ? '#FFFFFF' : '#111111', bg) >= 3, `${bar}: the spotted dot's edge`);
  }
  assert.ok(contrast('#FFFFFF', pie.STOP_RED) >= 3, 'the white rim reads on the red');
});

test('the stop sign keeps its white edge (it is what reads on the dark bar)', () => {
  const html = renderToStaticMarkup(React.createElement(StateDot, { look: { kind: 'STOP' }, state: 'LIMITED', name: 'x' }));
  assert.match(html, new RegExp(`data-cap-stop=""[^>]*fill="${pie.STOP_RED}" stroke="#FFFFFF"`));
});

test('one mark for a pool everywhere: the limit banner draws the stop sign; the details header follows the same rules', () => {
  const { CapacityLimitBannerView } = loadTs('src/renderer/src/components/CapacityLimitBanner.tsx');
  const banner = renderToStaticMarkup(React.createElement(CapacityLimitBannerView,
    { items: [{ poolId: 'p', noticeId: 'n', banner: { title: 'Codex limited', cause: 'c', consequence: 'q' } }], onDismiss: () => {} }));
  assert.equal(dotOf(banner), 'STOP');
  const v = (over) => ({ state: 'AVAILABLE', freshness: { verdict: 'FRESH', text: 't' }, windows: [{ kind: 'FIVE_HOUR', remainingPercent: 42 }], ...over });
  assert.deepEqual(pie.detailDotOf(v({})), { kind: 'PIE', percent: 42 });
  assert.deepEqual(pie.detailDotOf(v({ state: 'LIMITED' })), { kind: 'STOP' });
  assert.deepEqual(pie.detailDotOf(v({ freshness: { verdict: 'STALE', text: 't' } })), { kind: 'DIMMED' });
  assert.deepEqual(pie.detailDotOf(v({ state: 'UNKNOWN', windows: [] })), { kind: 'SPOTTED' });
  const body = codeOnly(readSource('src/renderer/src/components/CapacityDetailBody.tsx'), 'CapacityDetailBody.tsx');
  assert.match(body, /<StateDot look=\{detailDotOf\(view\)\} state=\{view\.state\} name=\{view\.stateText\} \/>/);
});
