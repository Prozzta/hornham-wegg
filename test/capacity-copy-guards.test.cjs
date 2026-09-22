'use strict';

/**
 * v1.1.45 unit #12 — VOCABULARY AND GEOMETRY GUARDS for the whole capacity display
 * (inventory row 12; C2.2, §8-9, C2.11 crit 11-12). Tests only: nothing here changes
 * behaviour. Each guard fails if the copy or the geometry drifts, over ONE scan source
 * (test/capacity-surface.cjs) that finds the surface by construction.
 *
 *  1. Cross-family vocabulary: no binding / tighter / near-tight / headroom / safer window /
 *     likely to exhaust first - in the surface source, or in anything main produces.
 *  2. No bare percentage: a figure stands beside its window everywhere it appears (§8);
 *     the banner, the toasts, the agent impact, the hold hints and the composer notes
 *     carry no figure at all, and attention copy never claims health.
 *  3. No visible state word on the strip: the shape carries it, as its accessible name.
 *  4. Geometry: nothing on the capacity surface draws a segmented gauge (segmented means
 *     context, §9); each capacity meter is one continuous fill.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const S = require('./capacity-surface.cjs');

const { STATE_TEXT } = loadTs('src/main/capacityStrip.ts');
const { CAPACITY_EMPTY_TEXT } = loadTs('src/shared/capacityStrip.ts');
const { CapacityStripView, STATE_TOKEN } = loadTs('src/renderer/src/components/CapacityStrip.tsx');

const FIX = S.FIXTURES();
const SOURCE = S.sourceCorpus();
const renderStrip = (pools) => renderToStaticMarkup(React.createElement(CapacityStripView, { pools, emptyText: CAPACITY_EMPTY_TEXT }));
const visibleNodes = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, '|')
  .split('|').map((s) => s.trim()).filter(Boolean);
/** Every string main produces for the capacity display, across the fixture matrix. */
const RUNTIME = FIX.flatMap((f) => ['strip', 'shown', 'detail', 'usage', 'banners', 'toasts']
  .flatMap((part) => S.leaves(f[part], `${f.name}:${part}`)));
const ATTENTION = S.attentionCopy();

// ─── The scan source itself ─────────────────────────────────────────────────────────

test('the surface is found BY CONSTRUCTION: every capacity component imports its way in', () => {
  const files = SOURCE.map((s) => s.file);
  for (const m of S.SURFACE_MODULES) assert.ok(files.includes(m), `${m} is scanned`);
  for (const c of ['CapacityStrip.tsx', 'CapacityDetailBody.tsx', 'CapacityDetailPanel.tsx', 'CapacityLimitBanner.tsx',
    'CapacityDisplaySetting.tsx', 'AgentUsageLine.tsx', 'AgentImpactBadge.tsx', 'MessageQueueComposer.tsx']) {
    assert.ok(files.includes(`src/renderer/src/components/${c}`), `${c} is reached through its imports`);
  }
  assert.ok(S.importsSurface('src/renderer/src/components/NewThing.tsx', "import { x } from '../capacity/stripLayout';"));
  assert.ok(S.importsSurface('src/renderer/src/components/NewThing.tsx', "import type { X } from '@shared/capacityStrip';"));
  assert.ok(!S.importsSurface('src/renderer/src/components/NewThing.tsx', "import { x } from './PixelButton';"));
  assert.ok(RUNTIME.length > 50 && ATTENTION.length > 50, 'the runtime corpus is not empty');
  assert.equal(FIX.find((f) => f.name === 'attributed LIMITED').banners.length, 1, 'the banner is in the corpus');
  assert.equal(FIX.find((f) => f.name === 'attributed LIMITED').toasts.length, 1, 'the LIMITED toast is in the corpus');
});

// ─── 1. Cross-family vocabulary (C2.2, crit 11) ─────────────────────────────────────

test('crit 11: no cross-family ordering word anywhere in the capacity surface SOURCE', () => {
  for (const { file, code } of SOURCE) {
    const m = code.match(S.CROSS_FAMILY);
    assert.equal(m, null, `${file} says "${m && m[0]}"`);
  }
});

test('crit 11: no cross-family ordering word in anything main PRODUCES (strip, detail, usage, banner, toasts, holds, impact, composer)', () => {
  for (const l of [...RUNTIME, ...ATTENTION]) assert.ok(!S.CROSS_FAMILY.test(l.text), `${l.at}: "${l.text}"`);
  for (const f of FIX) {
    for (const n of visibleNodes(renderStrip([f.shown]))) assert.ok(!S.CROSS_FAMILY.test(n), `${f.name} strip shows "${n}"`);
  }
});

// ─── 2. No bare percentage (§8, crit 12) ─────────────────────────────────────────────

test('§8: every percentage main produces stands right beside its window, never alone', () => {
  let seen = 0;
  for (const l of RUNTIME) {
    for (const m of l.text.matchAll(new RegExp(S.PERCENT.source, 'g'))) {
      seen++;
      const before = l.text.slice(0, m.index);
      assert.match(before, /\b(5h|Weekly|24h window)(?: ·| is at)? $/, `${l.at}: "${m[0]}" is bare in "${l.text}"`);
    }
  }
  assert.ok(seen > 20, 'the figures were actually checked');
});

test('the banner, the toasts, the agent impact, the hold hints and the composer notes carry NO figure', () => {
  for (const f of FIX) {
    for (const l of [...S.leaves(f.banners, `${f.name}:banner`), ...S.leaves(f.toasts, `${f.name}:toast`)]) {
      assert.ok(!S.ANY_FIGURE.test(l.text), `${l.at}: "${l.text}"`);
    }
  }
  for (const l of ATTENTION) assert.ok(!S.ANY_FIGURE.test(l.text), `${l.at}: "${l.text}"`);
});

test('attention copy never claims health: banner, LIMITED toast, and every hold / note / impact for a non-healthy state', () => {
  const lim = FIX.find((f) => f.name === 'attributed LIMITED');
  for (const l of [...S.leaves(lim.banners, 'banner'), ...S.leaves(lim.toasts, 'toast')]) {
    assert.ok(!S.CLAIMS_HEALTH.test(l.text), `${l.at}: "${l.text}"`);
  }
  for (const l of ATTENTION) if (!l.healthy) assert.ok(!S.CLAIMS_HEALTH.test(l.text), `${l.at}: "${l.text}"`);
});

// ─── 3. No visible state word on the strip (human override) ─────────────────────────

test('the strip shows NO state word in any fixture; each state word survives only as the shape\'s aria-label', () => {
  const words = Object.values(STATE_TEXT);
  assert.ok(words.length >= 6, 'every state word main owns');
  for (const f of FIX) {
    const html = renderStrip([f.shown]);
    const nodes = visibleNodes(html);
    for (const w of words) assert.ok(!nodes.includes(w), `${f.name}: "${w}" is visible text`);
    assert.ok(html.includes(`role="img" aria-label="${f.shown.stateText}"`), `${f.name}: the shape is named "${f.shown.stateText}"`);
    assert.match(html, /data-cap-dot="[A-Z]+"[^>]*>(<span[^>]*>)?<svg/, `${f.name}: the dot itself is drawn (unit #14)`);
  }
});

// ─── 4. Geometry (§9) ────────────────────────────────────────────────────────────────

test('§9: nothing on the capacity surface draws a segmented gauge; each capacity meter is ONE continuous fill', () => {
  const SEGMENTED = /\bsegment|\.repeat\(|Array\.from\(\{ ?length/i;
  for (const { file, code } of SOURCE) {
    if (!file.startsWith('src/renderer/')) continue;
    const m = code.match(SEGMENTED);
    assert.equal(m, null, `${file} draws segments ("${m && m[0]}") - segmented means CONTEXT`);
  }
  for (const f of FIX) {
    const html = renderStrip([f.shown]);
    let meters = 0;
    // Unit #14: a meter is a pie-dot. Up to its own <svg> close it holds at most ONE fill
    // (none at 0%), a single wedge or disc, never segments.
    for (const m of html.matchAll(/data-cap-meter="[^"]*"[^>]*>([\s\S]*?)<\/svg>/g)) {
      meters++;
      assert.ok((m[1].match(/data-cap-fill=/g) || []).length <= 1, `${f.name}: a meter holds exactly ONE fill`);
    }
    assert.equal(meters, (html.match(/data-cap-meter=/g) || []).length, `${f.name}: every meter was checked`);
  }
});
