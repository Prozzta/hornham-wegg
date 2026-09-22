'use strict';

/**
 * v1.1.45 unit #4 — the provider DETAIL panel (design of record §12, C2.9): a SEPARATE
 * scoped projection on its own channel, every window with reset/freshness/membership/
 * source, no identifiers, dropped on close; opened from the strip and from Settings.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { capacityDetailView } = loadTs('src/main/capacityDetail.ts');
const { validateCapacityDetail, CAPACITY_DETAIL_CHANNEL } = loadTs('src/shared/capacityDetail.ts');
const { CAPACITY_WORDING, capacityStateNote } = loadTs('src/shared/deliveryHold.ts');

const T0 = 1_800_000_000_000;
const ACCOUNT = 'acct-SECRET-44c';
const POOL = `codex:${ACCOUNT}:codex`;
const POOL_ID = 'pool-0123456789abcdef';
const w = (id, kind, remaining, resetsAt, minutes) => ({
  windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : kind === 'SEVEN_DAY' ? 'Weekly' : '24h window',
  windowMinutes: minutes !== undefined ? minutes : kind === 'FIVE_HOUR' ? 300 : kind === 'SEVEN_DAY' ? 10080 : 1440,
  usedPercent: remaining === null ? null : 100 - remaining, remainingPercent: remaining, resetsAt
});
const STD = () => [w('five_hour', 'FIVE_HOUR', 80.6, T0 + 3_600_000), w('seven_day', 'SEVEN_DAY', 60, T0 + 3 * 86_400_000),
  w('model_daily', 'OTHER', 30, T0 + 7_200_000)];

function pool(windows, over = {}, { stale = false, restore = false, at = T0 } = {}) {
  let now = at;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const obs = { poolKey: POOL, streamId: 's', sourceSequence: 1, provider: 'codex', accountScope: ACCOUNT, limitId: 'codex',
    source: 'codex-rollout', observedAt: T0, receivedAt: T0, windows,
    providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus', ...over };
  if (restore) tracker.restore(obs, null); else tracker.ingest(obs);
  if (stale) { now += L0_SEM_POLICY.liveTtlMs + 10; tracker.evaluate(); }
  return { p: tracker.pool(POOL), now };
}
const view = (p, now, over = {}) => capacityDetailView({ pool: p, poolId: POOL_ID, poolLabel: 'Codex', presentation: 'NORMAL',
  members: ['pam', 'dwight'], membershipKnown: true, statusNote: null, now, formatTime: (t) => `@${t - T0}`, ...over });

// ─── The projection ─────────────────────────────────────────────────────────────

test('EVERY window, weekly and model-specific included (even while the strip hides weekly), with figure and reset', () => {
  const { p, now } = pool(STD());
  const v = view(p, now);
  assert.deepEqual(validateCapacityDetail(v), []);
  assert.deepEqual(v.windows.map((x) => x.text), ['5h · 80% remaining', 'Weekly · 60% remaining', '24h window · 30% remaining']);
  assert.deepEqual(v.windows.map((x) => x.resetText), ['reset expected ~@3600000', 'reset expected ~@259200000', 'reset expected ~@7200000']);
  assert.equal(v.windows[0].remainingPercent, 80.6, 'a current figure may feed a meter');
  assert.equal(v.stateText, 'Available');
  assert.deepEqual(v.freshness, { verdict: 'FRESH', text: 'updated @0' });
  assert.deepEqual(v.membership, { known: true, text: 'Shared by 2 agents', agentIds: ['dwight', 'pam'] });
  assert.equal(v.sourceText, 'Codex session log');
  assert.equal(v.domainRevision, p.revision, 'the same domain truth as the strip');
});

test('no secrets: no account scope, no pool key, no raw payload fields in the view', () => {
  const { p, now } = pool(STD());
  const json = JSON.stringify(view(p, now));
  assert.ok(!json.includes(ACCOUNT) && !json.includes(POOL));
  assert.ok(!/accountScope|poolKey|limitId|planType|usedPercent|providerReachedType|streamId/.test(json));
});

test('stale: last-known only, worded "not current", never a meter figure (§10)', () => {
  const { p, now } = pool(STD(), {}, { stale: true });
  const v = view(p, now);
  assert.deepEqual(validateCapacityDetail(v), []);
  assert.equal(v.windows[0].text, '5h · 80% remaining · not current');
  assert.ok(v.windows.every((x) => !('remainingPercent' in x)));
  assert.equal(v.freshness.text, 'last update @0 · not current');
});

test('restored after a restart: said so, and nothing is current', () => {
  const { p, now } = pool(STD(), {}, { restore: true });
  const v = view(p, now);
  assert.match(v.freshness.text, /^restored after restart · last update @0 · not confirmed by a live reading$/);
  assert.ok(v.windows.every((x) => !('remainingPercent' in x) && /not current$/.test(x.text)));
});

test('membership: "Membership unknown" when not every agent of the provider has reported', () => {
  const { p, now } = pool(STD());
  assert.equal(view(p, now, { membershipKnown: false }).membership.text, 'Membership unknown');
  assert.equal(view(p, now, { members: [] }).membership.text, 'No agent has reported on this pool yet');
  assert.equal(view(p, now, { members: ['pam'] }).membership.text, 'Shared by 1 agent');
});

test('C2.7: the details keep the blocked relationship the strip shows (the same table)', () => {
  const attributed = pool(STD().map((x) => (x.kind === 'SEVEN_DAY' ? { ...x, remainingPercent: 0, usedPercent: 100 } : x)),
    { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' });
  const v = view(attributed.p, attributed.now, { presentation: 'BLOCKED_SUBORDINATE' });
  assert.equal(v.state, 'LIMITED');
  assert.equal(v.windows[0].note, 'unavailable while Weekly is exhausted', 'the raw 5h figure keeps its blocker');
  assert.equal(v.windows[1].note, 'the provider reports this limit reached');
  const held = pool(STD().map((x) => (x.kind === 'SEVEN_DAY' ? { ...x, remainingPercent: 0, usedPercent: 100 } : x)));
  assert.equal(view(held.p, held.now, { presentation: 'BLOCKED_SUBORDINATE' }).windows[0].note, 'ordinary work held while Weekly is at 0%');
  assert.ok(!('note' in view(held.p, held.now, { presentation: 'NORMAL' }).windows[0]), 'no blocker when the strip shows none');
});

test('C2.6: an unidentified window reads "Additional limit status unknown"; a known-inapplicable one is not listed', () => {
  const { p, now } = pool([w('five_hour', 'FIVE_HOUR', 80, T0 + 3_600_000), w('mystery', 'OTHER', 40, null, null),
    { ...w('gone', 'OTHER', 50, null, 60), applicability: 'INAPPLICABLE' }], { providerReachedType: 'usage' });
  const v = view(p, now);
  assert.deepEqual(v.windows.map((x) => x.text), ['5h · 80% remaining', 'Additional limit status unknown']);
});

test('a reset time that has passed is worded as a past expectation, never as a recovery', () => {
  const { p } = pool(STD());
  const v = view(p, T0 + 4 * 3_600_000);
  assert.equal(v.windows[0].resetText, 'reset was expected ~@3600000');
});

test('the schema: additionalProperties false, opaque ids only, and no current figure on a stale pool', () => {
  const { p, now } = pool(STD());
  const good = view(p, now);
  const bad = (fn) => { const c = JSON.parse(JSON.stringify(good)); fn(c); return validateCapacityDetail(c); };
  const cases = [
    ['a pool key', (c) => { c.poolKey = POOL; }],
    ['an account scope in a window', (c) => { c.windows[0].accountScope = ACCOUNT; }],
    ['a raw poolId', (c) => { c.poolId = POOL; }],
    ['an extra membership field', (c) => { c.membership.accountScope = ACCOUNT; }],
    ['a stale pool with a meter figure', (c) => { c.freshness.verdict = 'STALE'; c.freshness.ageText = 'Not refreshed in 5 min'; }],
    ['an out-of-range figure', (c) => { c.windows[0].remainingPercent = 120; }]
  ];
  for (const [name, fn] of cases) assert.notDeepEqual(bad(fn), [], `must reject ${name}`);
});

test('the status note is the COMPOSER\'s own wording for the post-reset probe (no contradiction)', () => {
  assert.equal(capacityStateNote('POST_RESET_PROBE'), CAPACITY_WORDING.POST_RESET_PROBE.state);
  assert.equal(capacityStateNote('POST_RESET_PROBE_SPENT'), CAPACITY_WORDING.POST_RESET_PROBE_SPENT.state);
  const { p, now } = pool(STD());
  assert.equal(view(p, now, { statusNote: capacityStateNote('POST_RESET_PROBE_SPENT') }).statusNote,
    'reset passed and the one probe turn has been used; waiting for a new capacity reading');
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const fn = main.slice(main.indexOf('function capacityStatusNote('), main.indexOf('\n}\n', main.indexOf('function capacityStatusNote(')));
  assert.match(fn, /providerCapacity\.admission\.probe\(agentId, 'ORDINARY_TURN'\)/, 'the non-spending probe');
  assert.match(fn, /capacityGateOf\(probed,/, 'the same gate the per-agent snapshot uses');
  assert.match(fn, /return capacityStateNote\(gate\.evidence\);/);
});

// ─── The channel ────────────────────────────────────────────────────────────────

test('its OWN channel: capacity:detail, resolved by opaque poolId, validated; not control:snapshot, not the strip object', () => {
  assert.equal(CAPACITY_DETAIL_CHANNEL, 'capacity:detail');
  assert.match(readSource('src/preload/index.ts'), /ipcRenderer\.invoke\('capacity:detail', poolId\)/);
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  // v1.1.46 A2: the projection moved into capacityDetailViewOf, shared by the ask and the re-push.
  const door = main.indexOf('ipcMain.handle(CAPACITY_DETAIL_CHANNEL');
  assert.ok(door > 0);
  assert.match(main.slice(door, main.indexOf('\n});', door)), /const view = capacityDetailViewOf\(poolId\);/);
  const start = main.indexOf('function capacityDetailViewOf(');
  const handler = main.slice(start, main.indexOf('\n}', start));
  assert.ok(start > 0);
  assert.match(handler, /providerCapacity\.snapshot\(\)\.pools\.find\(\(p\) => capacityStrip\.poolIdOf\(p\.poolKey\) === poolId\)/,
    'built from the tracker snapshot, not from the strip object');
  assert.match(handler, /validateCapacityDetail\(view\)/);
  const snap = main.slice(main.indexOf("ipcMain.handle('control:snapshot'"));
  assert.ok(!/capacityDetail|windows:|sourceText/.test(snap.slice(0, snap.indexOf('});'))), 'C2.9: nothing of it on control:snapshot');
});

// ─── The panel ──────────────────────────────────────────────────────────────────

const panel = loadTs('src/renderer/src/components/CapacityDetailBody.tsx');
const html = (v, names = {}) => renderToStaticMarkup(React.createElement(panel.CapacityDetailBody,
  { view: v, agentName: (id) => names[id] ?? id }));

test('the panel shows every window, reset, freshness, membership (by name) and source; meters only for current figures', () => {
  const { p, now } = pool(STD());
  const out = html(view(p, now, { statusNote: 'a note' }), { pam: 'Pam', dwight: 'Dwight' });
  for (const s of ['5h · 80% remaining', 'Weekly · 60% remaining', '24h window · 30% remaining', 'reset expected ~@259200000',
    'updated @0', 'Shared by 2 agents', 'Dwight, Pam', 'Source: Codex session log', 'a note', 'Available']) {
    assert.ok(out.includes(s), `shows "${s}"`);
  }
  assert.equal((out.match(/role="meter"/g) || []).length, 3, 'one meter per current window');
  const stale = pool(STD(), {}, { stale: true });
  assert.ok(!/role="meter"/.test(html(view(stale.p, stale.now))), 'no meter for a figure that is not current');
  assert.ok(html(view(p, now, { membershipKnown: false })).includes('Membership unknown'));
});

test('lifecycle: asked only while open, re-asked on each collection revision, dropped on close/switch/removal', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CapacityDetailPanel.tsx'), 'CapacityDetailPanel.tsx');
  assert.match(src, /setView\(null\);\s*if \(poolId === null\) return;/, 'a switch or close never shows the previous pool');
  assert.match(src, /\}, \[poolId, revision\]\);/);
  assert.match(src, /const gone = poolId !== null && collection !== null && selectPool\(collection, poolId\) === null;/);
  assert.match(src, /useEffect\(\(\) => \{ if \(gone\) closeCapacityDetail\(\); \}, \[gone\]\);/);
  assert.match(src, /onClick=\{\(\) => \{ setView\(null\); closeCapacityDetail\(\); \}\}/);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src), 'no durable cache');
  assert.match(src, /setView\(v && v\.poolId === poolId \? v : null\)/, 'a late answer for another pool is ignored');
});

test('opening: a strip pool row is clickable and keyboard-operable; the open state holds only an opaque id', () => {
  const strip = codeOnly(readSource('src/renderer/src/components/CapacityStrip.tsx'), 'CapacityStrip.tsx');
  assert.match(strip, /onClick=\{\(\) => openCapacityDetail\(pool\.poolId\)\}/);
  assert.match(strip, /if \(e\.key === 'Enter' \|\| e\.key === ' '\)/);
  const sel = loadTs('src/renderer/src/capacity/detailSelection.ts');
  assert.equal(sel.getOpenCapacityDetail(), null);
  sel.openCapacityDetail('pool-aaaaaaaaaaaaaaaa');
  assert.equal(sel.getOpenCapacityDetail(), 'pool-aaaaaaaaaaaaaaaa');
  sel.closeCapacityDetail();
  assert.equal(sel.getOpenCapacityDetail(), null);
  assert.equal(sel.openFirstCapacityDetail(), false, 'no pool, nothing to open');
});

test('C2.8 (from #8): the setting says all windows are in Provider Details, and links to it', () => {
  const setting = loadTs('src/renderer/src/components/CapacityDisplaySetting.tsx');
  assert.match(setting.CAPACITY_DISPLAY_COPY.help, /All windows remain available in Provider Details\.$/);
  const out = renderToStaticMarkup(React.createElement(setting.CapacityDisplaySetting, { onOpenDetails: () => {} }));
  assert.match(out, /data-capacity-details-link=""[^>]*>open Provider Details<\/button>/);
  const settings = codeOnly(readSource('src/renderer/src/components/SettingsModal.tsx'), 'SettingsModal.tsx');
  assert.match(settings, /<CapacityDisplaySetting onOpenDetails=\{\(\) => \{ if \(openFirstCapacityDetail\(\)\) onClose\(\); \}\} \/>/);
});
