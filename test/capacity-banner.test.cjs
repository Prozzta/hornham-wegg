'use strict';

/**
 * v1.1.45 unit #6 — the LIMITED entry banner (design of record §11, C2.12 rule 3), driven
 * through the REAL tracker, notifier and presenter: it appears on ENTRY to LIMITED only,
 * carries no figure, never repeats for an unchanged state, is dismissible (recorded in
 * main), never replays on a reload, and retires when the pool leaves LIMITED.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityNotifier } = loadTs('src/main/capacityNotify.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { validateCapacityStrip } = loadTs('src/shared/capacityStrip.ts');
const { CapacityStripMirror, selectLimitBanners } = loadTs('src/renderer/src/capacity/capacityStrip.ts');
const { CapacityLimitBannerView } = loadTs('src/renderer/src/components/CapacityLimitBanner.tsx');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct:codex';
const win = (id, kind, remaining) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: 100 - remaining, remainingPercent: remaining,
  resetsAt: kind === 'FIVE_HOUR' ? T0 + 3_600_000 : T0 + 3 * 86_400_000 });

/** tracker -> notifier -> presenter, exactly as the runtime wires them. */
function rig() {
  let now = T0;
  let seq = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const notifier = new CapacityNotifier();
  const presenter = new CapacityStripPresenter({ idKey: Buffer.alloc(32, 5) });
  const publish = () => {
    for (const intent of notifier.observe(tracker.snapshot(), now)) presenter.noteIntent(intent, 'SHOWN');
    const c = presenter.present({ snapshot: tracker.snapshot(), membersOf: () => [], membershipKnown: () => true,
      freshUntil: (k) => tracker.freshUntil(k), now });
    assert.deepEqual(validateCapacityStrip(c), [], 'main only publishes schema-valid objects');
    return c;
  };
  const read = (five, weekly, over = {}) => {
    now += 1000;
    tracker.ingest({ poolKey: POOL, streamId: 's', sourceSequence: ++seq, provider: 'codex', accountScope: 'acct', limitId: 'codex',
      source: 'codex-rollout', observedAt: now, receivedAt: now, windows: [win('five_hour', 'FIVE_HOUR', five), win('seven_day', 'SEVEN_DAY', weekly)],
      providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: null, ...over });
    return publish();
  };
  return { read, publish, presenter };
}
const ATTRIB = { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' };

test('entry to LIMITED (provider-attributed): one banner naming state, cause and consequence — and NO figure', () => {
  const r = rig();
  r.read(80, 60);                                             // baseline: a first sighting is never news
  const c = r.read(63, 0, ATTRIB);
  const [b] = selectLimitBanners(c);
  assert.ok(b, 'the entry raises a banner');
  assert.deepEqual(b.banner, {
    title: 'Codex limited',
    cause: 'Codex reports the Weekly limit reached.',
    consequence: 'Automatic delivery to Codex agents is paused until capacity returns. Queued messages wait; nothing is lost.'
  });
  for (const s of Object.values(b.banner)) assert.ok(!/\d|%/.test(s), `no figure in the banner: "${s}"`);
});

test('crit 16: an UNATTRIBUTED cause is never worded as a named limit reached', () => {
  const r = rig();
  r.read(80, 60);
  const unattributed = selectLimitBanners(r.read(80, 60, { providerReachedType: 'usage' }))[0].banner.cause;
  assert.equal(unattributed, 'Codex reported a usage limit without naming which window.');
  const r2 = rig();
  r2.read(80, 60);
  const denied = selectLimitBanners(r2.read(80, 60, { ordinaryUsageAllowed: false }))[0].banner.cause;
  assert.equal(denied, 'Codex is refusing ordinary use.');
  for (const cause of [unattributed, denied]) assert.ok(!/limit reached|exhausted|Weekly|5h/.test(cause), cause);
});

test('ONLY an entry to LIMITED has a banner — not reserve-only, not recovery', () => {
  const r = rig();
  r.read(80, 60);
  const reserve = r.read(63, 0);                              // RESERVE_ONLY: numeric, unattributed
  assert.equal(reserve.pools[0].state, 'RESERVE_ONLY');
  assert.equal(reserve.pools[0].notice.kind, 'RESERVE_REACHED');
  assert.ok(!('banner' in reserve.pools[0].notice));
  assert.deepEqual(selectLimitBanners(reserve), []);
});

test('never repeats for an unchanged state; a dismissal is recorded in MAIN and survives a renderer reload', () => {
  const r = rig();
  r.read(80, 60);
  const first = r.read(63, 0, ATTRIB);
  const id = selectLimitBanners(first)[0].noticeId;
  const again = r.read(62, 0, ATTRIB);                        // still LIMITED, same episode
  assert.equal(selectLimitBanners(again).length, 1, 'the same banner, not a second one');
  assert.equal(selectLimitBanners(again)[0].noticeId, id, 'not a new notice for an unchanged state');
  assert.equal(r.presenter.dismissNotice(id), true);
  const after = r.publish();
  assert.deepEqual(selectLimitBanners(after), [], 'dismissed');
  assert.deepEqual(selectLimitBanners(r.read(61, 0, ATTRIB)), [], 'and a further reading in the same state does not reopen it');
  const mirror = new CapacityStripMirror();                   // a reloaded window: main is asked again
  assert.equal(mirror.accept(r.presenter.current()), 'ACCEPTED');
  assert.deepEqual(selectLimitBanners(mirror.get()), [], 'a reload shows main\'s record: still dismissed');
});

test('no replay after a restart: a pool first seen LIMITED is a baseline, not an entry', () => {
  const r = rig();
  const c = r.read(63, 0, ATTRIB);
  assert.equal(c.pools[0].state, 'LIMITED');
  assert.deepEqual(selectLimitBanners(c), [], 'a first sighting is never news (the notifier\'s hydrate rule)');
});

test('it retires when the pool leaves LIMITED', () => {
  const r = rig();
  r.read(80, 60);
  assert.equal(selectLimitBanners(r.read(63, 0, ATTRIB)).length, 1);
  const left = r.read(80, 60);
  assert.notEqual(left.pools[0].state, 'LIMITED');
  assert.deepEqual(selectLimitBanners(left), []);
});

test('the schema: a banner only on a LIMIT_REACHED notice, and never with a figure', () => {
  const r = rig();
  r.read(80, 60);
  const good = r.read(63, 0, ATTRIB);
  const bad = (fn) => { const c = JSON.parse(JSON.stringify(good)); fn(c.pools[0].notice); return validateCapacityStrip(c); };
  assert.notDeepEqual(bad((n) => { n.kind = 'RESERVE_REACHED'; }), [], 'a banner on another kind is refused');
  assert.notDeepEqual(bad((n) => { n.banner.cause = 'Weekly is at 0% remaining.'; }), [], 'a figure in the banner is refused');
  assert.notDeepEqual(bad((n) => { n.banner.extra = 'x'; }), [], 'additionalProperties false');
});

test('render: the banner shows main\'s three lines and a dismiss control; nothing when there is nothing to show', () => {
  const item = { poolId: 'pool-0123456789abcdef', noticeId: 'notice-0123456789abcdef',
    banner: { title: 'Codex limited', cause: 'Codex reports the Weekly limit reached.', consequence: 'Automatic delivery is paused.' } };
  const html = renderToStaticMarkup(React.createElement(CapacityLimitBannerView, { items: [item], onDismiss: () => {} }));
  for (const s of ['Codex limited', 'Codex reports the Weekly limit reached.', 'Automatic delivery is paused.', 'data-cap-banner-dismiss', 'role="status"']) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(!/role="meter"/.test(html), 'no meter, no figure');
  assert.equal(renderToStaticMarkup(React.createElement(CapacityLimitBannerView, { items: [], onDismiss: () => {} })), '');
  const src = codeOnly(readSource('src/renderer/src/components/CapacityLimitBanner.tsx'), 'CapacityLimitBanner.tsx');
  assert.match(src, /onDismiss=\{\(id\) => \{ void dismissCapacityNotice\(id\); \}\}/, 'dismissal goes to MAIN, not local state');
  assert.ok(!/useState|localStorage/.test(src), 'no local dismissed-set: a reload must ask main');
  assert.ok(readSource('src/renderer/src/App.tsx').includes('<CapacityLimitBanner />'), 'mounted over the office');
});
