'use strict';

/**
 * STALE-RETAIN (human ruling 2026-09-22; SUPERSEDES A1). A pool whose reading has merely
 * aged KEEPS its last-known figure on the strip and is drawn as its ordinary pie-dot; the
 * age moves to the provider details as "Not refreshed in X min". Unchanged: a never-read
 * pool is SPOTTED, an aged open limit keeps its STOP sign, and evidence restored across a
 * restart (nothing this run has seen) stays DIMMED and figure-free. Each rule kills a
 * census mutant (test/tools/capacity-mutants.cjs, "sr").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { capacityDetailView, notRefreshedText } = loadTs('src/main/capacityDetail.ts');
const { validateCapacityDetail } = loadTs('src/shared/capacityDetail.ts');
const { validateCapacityStrip, CAPACITY_EMPTY_TEXT } = loadTs('src/shared/capacityStrip.ts');
const { presentPool } = loadTs('src/renderer/src/capacity/capacityStrip.ts');
const pie = loadTs('src/renderer/src/capacity/pieDot.ts');
const { CapacityStripView } = loadTs('src/renderer/src/components/CapacityStrip.tsx');
const { CapacityDetailBody } = loadTs('src/renderer/src/components/CapacityDetailBody.tsx');
const S = require('./capacity-surface.cjs');

const T0 = 1_800_000_000_000;
const H = 3_600_000;
const POOL = 'codex:a:codex';
const win = (id, kind, remaining, resetsAt) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: remaining === null ? null : 100 - remaining,
  remainingPercent: remaining, resetsAt });
const std = (five, weekly) => [win('five_hour', 'FIVE_HOUR', five, T0 + H), win('seven_day', 'SEVEN_DAY', weekly, T0 + 60 * H)];

/** One pool through the real tracker; `age` ms after the reading, stale or not. */
function rig(windows, { over = {}, restore = false, age = 0 } = {}) {
  let now = T0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const obs = { poolKey: POOL, streamId: 's', sourceSequence: 1, provider: 'codex', accountScope: 'a', limitId: 'codex',
    source: 'codex-rollout', observedAt: T0, receivedAt: T0, windows,
    providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus', ...over };
  if (restore) tracker.restore(obs, null); else tracker.ingest(obs);
  now += age;
  tracker.evaluate();
  const presenter = new CapacityStripPresenter({ formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 5) });
  const c = presenter.present({ snapshot: tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now });
  assert.deepEqual(validateCapacityStrip(c), [], 'the strip object passes its own schema');
  const detail = capacityDetailView({ pool: tracker.pool(POOL), poolId: c.pools[0].poolId, poolLabel: 'Codex',
    presentation: c.pools[0].presentation, members: [], membershipKnown: true, statusNote: null, now,
    formatTime: (t) => `@${t - T0}` });
  return { strip: c.pools[0], detail, now };
}
const STALE_AGE = L0_SEM_POLICY.liveTtlMs + 10;
const render = (pools) => renderToStaticMarkup(React.createElement(CapacityStripView, { pools, emptyText: CAPACITY_EMPTY_TEXT }));
const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, '|').split('|').map((s) => s.trim()).filter(Boolean);
const dotOf = (html) => (html.match(/data-cap-dot="([A-Z]+)"/) || [])[1];

// ─── The strip ──────────────────────────────────────────────────────────────────────

test('a stale reading KEEPS its last-known figures: the ordinary pie, its wedge, its meter and its text; the tracker state stays UNKNOWN', () => {
  const { strip } = rig(std(42, 10), { age: STALE_AGE });
  assert.equal(strip.freshness.verdict, 'STALE');
  assert.equal(strip.state, 'UNKNOWN', 'domain truth is not touched: the tracker\'s own state, verbatim');
  assert.equal(strip.presentation, 'NORMAL');
  assert.equal(strip.fiveHour.text, '5h · 42% remaining');
  assert.equal(strip.fiveHour.meter.remainingPercent, 42);
  assert.equal(strip.weekly.meter.remainingPercent, 10, 'a revealed weekly keeps its figure too');
  const html = render([strip]);
  assert.equal(dotOf(html), 'PIE', 'the normal pie-dot, not dimmed, not spotted');
  const d = pie.PIE_DOT_SIZE;
  assert.ok(html.includes(`d="${pie.wedgePath(42, d / 2 - 1.5, d / 2)}"`), 'the wedge is the last-known figure');
  assert.ok(visible(html).includes('5h · 42% remaining'));
  assert.ok(html.includes(`role="img" aria-label="${strip.stateText}" data-cap-state-token="UNKNOWN"`),
    'the state word screen readers hear is still the tracker\'s (the figure is not a health claim)');
  assert.deepEqual(pie.leadDotOf(strip), { kind: 'PIE', percent: 42 });
});

test('the renderer\'s expiry mask keeps the figure too, and says exactly what main\'s stale push will say', () => {
  const fresh = rig(std(42, 60)).strip;
  const masked = presentPool(fresh, fresh.freshness.expiresAt + 1);
  assert.equal(masked.masked, true);
  assert.equal(masked.presentation, 'NORMAL');
  assert.deepEqual(pie.leadDotOf(masked), { kind: 'PIE', percent: 42 });
  const stale = rig(std(42, 60), { age: STALE_AGE }).strip;
  assert.equal(stale.fiveHour.text, masked.fiveHour.text);
  assert.equal(stale.state, masked.state);
});

test('unchanged: never read is SPOTTED, an aged open limit keeps its STOP sign, and restored evidence stays DIMMED with no figure', () => {
  const never = render([rig([win('five_hour', 'FIVE_HOUR', null, null), win('seven_day', 'SEVEN_DAY', 60, null)]).strip]);
  assert.equal(dotOf(never), 'SPOTTED');
  const cold = render([]);
  assert.equal(dotOf(cold), 'SPOTTED');
  const limit = rig(std(80, 60), { over: { providerReachedType: 'usage' }, age: STALE_AGE }).strip;
  assert.equal(limit.state, 'LIMITED');
  assert.equal(dotOf(render([limit])), 'STOP');
  assert.ok(!/\d+%/.test(visible(render([limit])).join(' ')), 'an aged limit shows no figure (unchanged)');
  const restored = rig(std(42, 60), { restore: true }).strip;
  assert.equal(restored.presentation, 'UNKNOWN');
  const rh = render([restored]);
  assert.equal(dotOf(rh), 'DIMMED', 'not a reading this run has seen: not retained');
  assert.ok(!/data-cap-pie|aria-valuenow/.test(rh) && !visible(rh).some((n) => /%/.test(n)));
});

// ─── The provider details ───────────────────────────────────────────────────────────

test('the details say "Not refreshed in X min" for a stale reading, X = whole minutes since the last observed reading', () => {
  const age = STALE_AGE + 7 * 60_000 + 59_000;
  const { detail, now } = rig(std(42, 60), { age });
  assert.deepEqual(validateCapacityDetail(detail), []);
  assert.equal(detail.freshness.ageText, `Not refreshed in ${Math.floor((now - T0) / 60_000)} min`);
  assert.equal(notRefreshedText(T0, T0 + 7 * 60_000 + 59_999), 'Not refreshed in 7 min', 'whole minutes, rounded down');
  assert.equal(notRefreshedText(T0, T0 + 60_000), 'Not refreshed in 1 min');
  assert.equal(notRefreshedText(T0, T0 - 5_000), 'Not refreshed in 0 min', 'never negative');
  const html = renderToStaticMarkup(React.createElement(CapacityDetailBody, { view: detail, agentName: (id) => id }));
  assert.match(html, /data-cap-detail-age="[^"]*"[^>]*>Not refreshed in \d+ min</, 'drawn in the panel');
  assert.ok(!S.CLAIMS_HEALTH.test(detail.freshness.ageText), 'the note claims no health');
  // The header dot matches the strip: the last-known pie.
  assert.deepEqual(pie.detailDotOf(detail), { kind: 'PIE', percent: 42 });
  // The rows stay honest: no current figure is offered to a bar.
  assert.ok(detail.windows.every((w) => !('remainingPercent' in w)));
});

test('a fresh reading has no age note; restored evidence has one and keeps its dimmed header', () => {
  const fresh = rig(std(42, 60)).detail;
  assert.ok(!('ageText' in fresh.freshness));
  const html = renderToStaticMarkup(React.createElement(CapacityDetailBody, { view: fresh, agentName: (id) => id }));
  assert.ok(!html.includes('data-cap-detail-age'));
  const restored = rig(std(42, 60), { restore: true, age: 3 * 60_000 }).detail;
  assert.equal(restored.freshness.ageText, 'Not refreshed in 3 min');
  assert.deepEqual(pie.detailDotOf(restored), { kind: 'DIMMED' });
});

test('the detail schema: ageText exactly when STALE and worded exactly; a last-known figure only on a stale five-hour row', () => {
  const stale = rig(std(42, 60), { age: STALE_AGE }).detail;
  const { ageText: _a, ...noAge } = stale.freshness;
  assert.ok(validateCapacityDetail({ ...stale, freshness: noAge }).length > 0, 'a stale view must carry its age');
  assert.ok(validateCapacityDetail({ ...stale, freshness: { ...stale.freshness, ageText: 'a while' } }).length > 0);
  const fresh = rig(std(42, 60)).detail;
  assert.ok(validateCapacityDetail({ ...fresh, freshness: { ...fresh.freshness, ageText: 'Not refreshed in 1 min' } }).length > 0);
  const five = fresh.windows.findIndex((w) => w.kind === 'FIVE_HOUR');
  const { remainingPercent: _r, ...row } = fresh.windows[five];
  const windows = fresh.windows.map((w, i) => (i === five ? { ...row, lastKnownPercent: 42 } : w));
  assert.ok(validateCapacityDetail({ ...fresh, windows }).length > 0, 'a fresh pool has no last-known figure');
});
