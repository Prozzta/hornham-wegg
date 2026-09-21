'use strict';

/**
 * v1.1.45 unit #2 — the title-bar capacity strip.
 *
 * Every fixture is a REAL pool object: real tracker -> real presenter -> the renderer's
 * presentPool, then rendered with react-dom/server. So what is asserted about the DOM is
 * what main can actually make the strip draw.
 *
 * Order follows the spec's own (§20): UNKNOWN / stale FIRST, then the healthy path, then
 * the weekly and exhausted frames, then the layout (C2.10) and the structural rules.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { presentPool } = loadTs('src/renderer/src/capacity/capacityStrip.ts');
const { chooseCollapseLevel, poolTokens, poolWidth, COLLAPSE_LEVELS } = loadTs('src/renderer/src/capacity/stripLayout.ts');
const { CapacityStripView, STATE_TOKEN, STATE_COLOR } = loadTs('src/renderer/src/components/CapacityStrip.tsx');

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

const render = (pools, level) => renderToStaticMarkup(React.createElement(CapacityStripView, { pools, level }));
/** The visible text, tags stripped (aria-hidden state tokens stripped too). */
const visibleText = (html) => html.replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '|');
const count = (s, re) => (s.match(re) || []).length;

const HEALTHY = () => pool(std(80.6, 60));
const REVEALED = () => pool(std(80, 14.9));
const BLOCKED = () => pool(std(63, 0), { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' });
const STALE = () => pool(std(80, 60), {}, { stale: true });

// ─── UNKNOWN / stale FIRST (§20) ─────────────────────────────────────────────

test('stale pool: NO meter primitive at any width — no track, no fill, no aria value — only main\'s text', () => {
  const p = STALE();
  assert.equal(p.presentation, 'UNKNOWN');
  for (const level of COLLAPSE_LEVELS) {
    const html = render([p], level);
    assert.ok(!/role="(meter|progressbar)"|aria-valuenow|data-cap-meter/.test(html), `level ${level}: an empty bar is a drawn claim of zero`);
    assert.ok(!/\d+%/.test(html), `level ${level}: stale removes the number`);
    assert.match(visibleText(html), /5h · Capacity unknown/, `level ${level}: the 5h status is stated, not silent`);
    assert.ok(html.includes(`data-cap-state-token="UNKNOWN"`));
  }
  assert.match(visibleText(render([p], 0)), /5h · Capacity unknown · last update @/, 'absolute last-update time (A3)');
});

test('C2.6 split: applicable-but-unknown weekly says "Weekly capacity unknown", text only', () => {
  const p = pool(std(80, 60), { providerReachedType: 'usage' }, { stale: true });
  assert.equal(p.state, 'LIMITED', 'A1: the tracker state is kept verbatim');
  assert.equal(p.presentation, 'UNKNOWN', 'A1: but the figures are removed');
  assert.equal(p.weekly.reason, 'UNKNOWN_CAPACITY');
  for (const level of COLLAPSE_LEVELS) {
    const html = render([p], level);
    assert.ok(visibleText(html).includes('|Weekly capacity unknown|'), `level ${level}`);
    assert.ok(!/role="meter"|\d+%/.test(html), `level ${level}: no figure, no meter`);
  }
});

test('C2.6 split: unknown applicability says "Additional limit status unknown", text only', () => {
  const p = pool([win('five_hour', 'FIVE_HOUR', 80, T0 + 3_600_000), win('mystery', 'OTHER', 40, null)],
    { providerReachedType: 'usage' });
  assert.equal(p.weekly.reason, 'UNKNOWN_APPLICABILITY');
  for (const level of COLLAPSE_LEVELS) {
    const html = render([p], level);
    assert.ok(visibleText(html).includes('|Additional limit status unknown|'), `level ${level}`);
    assert.equal(count(html, /data-cap-meter="weekly"/g), 0);
  }
});

test('the expiry mask degrades a healthy row to UNKNOWN with no meter', () => {
  const p = HEALTHY();
  const now = p.freshness.expiresAt + 1;
  const masked = presentPool(p, now);
  const html = render([masked], 0);
  assert.ok(!/role="meter"|\d+%/.test(html));
  assert.ok(html.includes('data-cap-state-token="UNKNOWN"'));
});

test('UNKNOWN is never drawn as healthy: its token and colour differ from AVAILABLE', () => {
  assert.notEqual(STATE_TOKEN.UNKNOWN, STATE_TOKEN.AVAILABLE);
  assert.notEqual(STATE_COLOR.UNKNOWN, STATE_COLOR.AVAILABLE);
  assert.equal(new Set(Object.values(STATE_TOKEN)).size, 6, 'every state has its own non-colour token');
});

// ─── Healthy path ─────────────────────────────────────────────────────────────

test('healthy: mark, label, state word + token, ONE continuous meter, 5h figure, reset expectation', () => {
  const html = render([HEALTHY()], 0);
  const text = visibleText(html);
  assert.ok(text.includes('|Codex|'));
  assert.ok(text.includes('Available'));
  assert.ok(html.includes('data-cap-state-token="AVAILABLE"'));
  assert.equal(count(html, /role="meter"/g), 1);
  assert.match(html, /role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80.6" aria-valuetext="5h · 80% remaining"/);
  assert.ok(text.includes('|5h · 80% remaining|'));
  assert.ok(text.includes('|reset expected ~@3600000|'));
  assert.ok(!text.includes('Weekly'), 'weekly is hidden and therefore absent');
  assert.ok(html.includes('<svg'), 'the provider mark is drawn');
});

test('C2.10 collapse order: meters first, then reset hints, then compact figures — 5h never dropped', () => {
  const p = HEALTHY();
  const at = (level) => render([p], level);
  assert.ok(/role="meter"/.test(at(0)) && /data-cap-reset/.test(at(0)));
  assert.ok(!/role="meter"/.test(at(1)) && /data-cap-reset/.test(at(1)), 'level 1 drops meters only');
  assert.ok(!/role="meter"/.test(at(2)) && !/data-cap-reset/.test(at(2)), 'level 2 also drops reset hints');
  assert.ok(visibleText(at(2)).includes('|5h · 80% remaining|'));
  assert.ok(visibleText(at(3)).includes('|5h 80%|'), 'level 3 compacts the labelled figure');
});

test('weekly revealed: its own continuous meter and main\'s text, compacting to main\'s compact text', () => {
  const p = REVEALED();
  assert.equal(p.weekly.reason, 'BELOW_DISPLAY_THRESHOLD');
  const full = render([p], 0);
  assert.equal(count(full, /role="meter"/g), 2);
  assert.ok(visibleText(full).includes('|Weekly · 14% remaining|'));
  assert.ok(visibleText(render([p], 3)).includes('|Weekly 14%|'));
  assert.ok(visibleText(render([p], 3)).includes('|5h 80%|'), 'a revealed weekly never displaces the 5h value');
});

test('crit 1: every fixture at every width shows a 5h value or status, and no bare percentage exists', () => {
  for (const make of [HEALTHY, REVEALED, BLOCKED, STALE]) {
    const p = make();
    for (const level of COLLAPSE_LEVELS) {
      const text = visibleText(render([p], level));
      assert.match(text, /\|5h[ ·]/, `${p.presentation} level ${level}`);
      for (const piece of text.split('|')) {
        if (/\d+%/.test(piece)) assert.match(piece, /^(5h|Weekly)\b/, `a percentage must carry its window: "${piece}"`);
      }
    }
  }
});

// ─── The exhausted frame (C2.7, crit 14-15) ──────────────────────────────────

test('crit 14: blocked frame — exactly ONE subordinate 5h token, no meter/progress semantics, no positive colour', () => {
  const p = BLOCKED();
  assert.equal(p.presentation, 'BLOCKED_SUBORDINATE');
  for (const level of COLLAPSE_LEVELS) {
    const html = render([p], level);
    assert.equal(count(html, /data-cap-figure="five-hour"/g), 1, `level ${level}`);
    assert.equal(count(html, /data-cap-subordinate="true"/g), 1);
    assert.equal(count(html, /63%/g), 1, `level ${level}: the 5h figure appears exactly once`);
    assert.ok(!/role="(meter|progressbar)"|aria-value|data-cap-meter|data-cap-reset/.test(html), `level ${level}`);
    assert.ok(!html.includes('--cth-status-success'), `level ${level}: no positive-capacity colour anywhere`);
    assert.ok(!/animation|transition/.test(html), 'no animation channel');
    const five = html.match(/data-cap-figure="five-hour"[^>]*>([^<]*)</)[1];
    assert.match(five, /63%.*(unavailable while Weekly is exhausted|blocked by Weekly)/, 'the blocker is in the SAME atomic string');
  }
  assert.ok(visibleText(render([p], 3)).includes('|5h 63% · blocked by Weekly|'), 'the compact invariant (C2.7)');
});

test('crit 15: overall LIMITED, weekly primary, then the subordinate 5h token — in DOM and reading order', () => {
  for (const level of COLLAPSE_LEVELS) {
    const html = render([BLOCKED()], level);
    const iState = html.indexOf('Limited');
    const iWeekly = html.indexOf('data-cap-figure="weekly"');
    const iFive = html.indexOf('data-cap-figure="five-hour"');
    assert.ok(iState >= 0 && iState < iWeekly && iWeekly < iFive, `level ${level}: LIMITED, weekly, then 5h`);
  }
});

test('A2: the RESERVE_ONLY held frame renders like crit 14/15 — one subordinate token, weekly first, no meter', () => {
  const p = pool(std(63, 0));
  assert.equal(p.state, 'RESERVE_ONLY');
  assert.equal(p.presentation, 'BLOCKED_SUBORDINATE');
  for (const level of COLLAPSE_LEVELS) {
    const html = render([p], level);
    assert.equal(count(html, /data-cap-subordinate="true"/g), 1, `level ${level}`);
    assert.equal(count(html, /63%/g), 1, `level ${level}: the 5h figure appears exactly once`);
    assert.ok(!/role="(meter|progressbar)"|aria-value|data-cap-meter|data-cap-reset/.test(html), `level ${level}`);
    assert.ok(!html.includes('--cth-status-success'), `level ${level}: no positive-capacity colour`);
    const iState = html.indexOf('Reserve only');
    const iWeekly = html.indexOf('data-cap-figure="weekly"');
    const iFive = html.indexOf('data-cap-figure="five-hour"');
    assert.ok(iState >= 0 && iState < iWeekly && iWeekly < iFive, `level ${level}: state, weekly, then 5h`);
  }
  assert.ok(visibleText(render([p], 3)).includes('|5h 63% · held by Weekly 0%|'));
  assert.ok(visibleText(render([p], 0)).includes('|5h · 63% remaining · ordinary work held while Weekly is at 0%|'));
});

// ─── Layout (C2.10) ───────────────────────────────────────────────────────────

test('chooseCollapseLevel picks the LEAST collapsed level that fits, and never goes past 3', () => {
  const measure = (s) => s.length * 6;
  const pools = [REVEALED(), HEALTHY()];
  const widths = COLLAPSE_LEVELS.map((l) => pools.reduce((s, p, i) => s + poolWidth(p, l, measure) + (i ? 16 : 0), 0));
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] < widths[i - 1], `level ${i} must be narrower than ${i - 1}`);
  assert.equal(chooseCollapseLevel(pools, widths[0], measure), 0);
  assert.equal(chooseCollapseLevel(pools, widths[0] - 1, measure), 1);
  assert.equal(chooseCollapseLevel(pools, widths[1] - 1, measure), 2);
  assert.equal(chooseCollapseLevel(pools, widths[2] - 1, measure), 3);
  assert.equal(chooseCollapseLevel(pools, 10, measure), 3, 'below the compact form the layout is unsupported, not smaller');
  assert.equal(chooseCollapseLevel(pools, 0, measure), 0, 'unmeasured renders full until measured');
});

test('the layout copies main\'s strings — it composes no wording of its own', () => {
  for (const make of [HEALTHY, REVEALED, BLOCKED, STALE]) {
    const p = make();
    const allowed = new Set([p.fiveHour.text, p.fiveHour.compactText, p.fiveHour.resetText,
      p.weekly?.text, p.weekly?.compactText, p.weekly?.resetText].filter(Boolean));
    for (const level of COLLAPSE_LEVELS) {
      for (const t of poolTokens(p, level)) {
        const s = t.kind === 'meter' ? t.valueText : t.text;
        assert.ok(allowed.has(s), `"${s}" is not a string main supplied`);
      }
    }
  }
});

test('nothing renders before main answers (NONE is not drawn as a healthy empty strip)', () => {
  assert.equal(render([], 0), '');
});

// ─── Structure ────────────────────────────────────────────────────────────────

test('geometry (§9): the strip draws ONE continuous fill per meter and no segments', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CapacityStrip.tsx'), 'CapacityStrip.tsx');
  assert.ok(!/segment|repeat\(|\.map\(\(_?, ?i\)|Array\.from\(\{ ?length/i.test(src), 'no segmented gauge in the capacity strip');
  assert.ok(src.includes('presentPool('), 'the connected strip applies the one-way mask');
  assert.ok(!/window\.cth/.test(src), 'no IPC in the component: it reads the one mirror via the hook');
});

test('C2.10: mounted in the 36px title bar, fixed height, clipped — a capacity change cannot reflow the chrome', () => {
  const app = readSource('src/renderer/src/App.tsx');
  const bar = app.indexOf('{/* Title bar */}');
  const mount = app.indexOf('<CapacityStrip />');
  const settings = app.indexOf('aria-label="Settings"');
  assert.ok(bar > 0 && mount > bar && mount < settings, 'the strip sits in the title bar, before its right-hand controls');
  const src = codeOnly(readSource('src/renderer/src/components/CapacityStrip.tsx'), 'CapacityStrip.tsx');
  const host = src.slice(src.indexOf('data-cap-strip'));
  assert.match(host, /height: 36/);
  assert.match(host, /overflow: 'hidden'/);
  assert.match(host, /flexWrap: 'wrap'/);
});
