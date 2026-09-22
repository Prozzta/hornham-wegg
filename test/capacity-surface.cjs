'use strict';

/**
 * v1.1.45 unit #12 — THE CAPACITY SURFACE, as one scan source for the vocabulary and
 * geometry guards (C2.2, §8-9, C2.11 crit 11-12).
 *
 * Two corpora, both built BY CONSTRUCTION rather than listed by hand:
 *  - SOURCE: every file under src/ that imports a capacity-surface module, plus those
 *    modules. A new component that shows capacity has to import the surface to get at it,
 *    so it is scanned without anyone remembering to add it.
 *  - RUNTIME: every string main actually produces for a person across the fixture matrix -
 *    the strip, the detail panel, the Monitor usage line, the banner, the toasts, the agent
 *    impact, the composer notes and the hold hints - collected as leaves of the real
 *    objects, so copy composed at run time is scanned too.
 */
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const ROOT = path.resolve(__dirname, '..');

/** C2.2: raw five-hour/weekly comparisons may not be worded as an ordering of headroom. */
const CROSS_FAMILY = /\bbinding\b|\btighter\b|\bnear[- ]tight\b|\bheadroom\b|\bsafer window\b|\blikely to exhaust first\b/i;
/** The existing delivery-hold ban (delivery-hold.test.cjs): attention copy never claims health. */
const CLAIMS_HEALTH = /\bavailable\b|\bhealthy\b|\ballowed\b|\bok\b|\bfine\b/i;
/** A figure of any kind. The banner, toasts, impact and composer carry none (§6, §11, §13). */
const ANY_FIGURE = /\d|%/;
const PERCENT = /\d+(?:\.\d+)?\s?%/;

/** The modules that ARE the capacity surface. Importing one puts a file in the corpus. */
const SURFACE_MODULES = [
  'src/shared/capacityStrip.ts', 'src/shared/capacityDetail.ts', 'src/shared/deliveryHold.ts',
  'src/shared/agentUsage.ts', 'src/shared/capacityThreshold.ts',
  'src/main/capacityStrip.ts', 'src/main/capacityDetail.ts', 'src/main/capacityToast.ts',
  'src/main/capacityAgentUsage.ts',
  'src/renderer/src/capacity/capacityStrip.ts', 'src/renderer/src/capacity/stripLayout.ts',
  'src/renderer/src/capacity/useCapacityStrip.ts', 'src/renderer/src/capacity/detailSelection.ts',
  'src/renderer/src/components/composerStatus.ts', 'src/renderer/src/components/agentImpactView.ts'
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}

/** Does `file`'s import list reach one of the surface modules? */
function importsSurface(file, src) {
  const dir = path.posix.dirname(file);
  for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    let target = null;
    if (spec.startsWith('@shared/')) target = 'src/shared/' + spec.slice('@shared/'.length);
    else if (spec.startsWith('@/')) target = 'src/renderer/src/' + spec.slice(2);
    else if (spec.startsWith('.')) target = path.posix.normalize(path.posix.join(dir, spec));
    if (!target) continue;
    if (SURFACE_MODULES.some((s) => s === target || s === target + '.ts' || s === target + '.tsx')) return true;
  }
  return false;
}

/** The source corpus: { file, code } with comments stripped (codeOnly). */
function sourceCorpus() {
  const out = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const raw = readSource(file);
    if (SURFACE_MODULES.includes(file) || importsSurface(file, raw)) out.push({ file, code: codeOnly(raw, path.basename(file)) });
  }
  return out;
}

/** Every string leaf of a value, with its path. */
function leaves(value, at = '$', out = []) {
  if (typeof value === 'string') out.push({ at, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) leaves(v, `${at}.${k}`, out);
  return out;
}

// ─── The runtime corpus ─────────────────────────────────────────────────────────────

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityNotifier } = loadTs('src/main/capacityNotify.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { capacityDetailView } = loadTs('src/main/capacityDetail.ts');
const { agentUsageView } = loadTs('src/main/capacityAgentUsage.ts');
const { presentPool } = loadTs('src/renderer/src/capacity/capacityStrip.ts');
const hold = loadTs('src/shared/deliveryHold.ts');
const { composerStatus } = loadTs('src/renderer/src/components/composerStatus.ts');

const T0 = 1_800_000_000_000;
const POOL = 'codex:acct:codex';
const win = (id, kind, remaining, resetsAt) => ({ windowId: id, kind,
  label: kind === 'FIVE_HOUR' ? '5h' : kind === 'SEVEN_DAY' ? 'Weekly' : '24h window',
  windowMinutes: kind === 'FIVE_HOUR' ? 300 : kind === 'SEVEN_DAY' ? 10080 : 1440,
  usedPercent: remaining === null ? null : 100 - remaining, remainingPercent: remaining, resetsAt });
const std = (five, weekly) => [win('five_hour', 'FIVE_HOUR', five, T0 + 3_600_000),
  win('seven_day', 'SEVEN_DAY', weekly, T0 + 3 * 86_400_000), win('model_daily', 'OTHER', 30, T0 + 7_200_000)];
const ATTRIB = { providerReachedType: 'usage', providerAttributedLimitingWindowId: 'seven_day' };
/** The window labels a percentage may stand beside (§8: never without its window). */
const WINDOW_LABELS = /\b(5h|Weekly|24h window)\b/;

/** One fixture: a baseline reading, then `windows`/`over` (so a transition is real), optionally aged. */
function fixture(name, windows, over = {}, { stale = false } = {}) {
  let now = T0;
  let seq = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now);
  const notifier = new CapacityNotifier();
  const presenter = new CapacityStripPresenter({ formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 7) });
  const read = (w, o = {}) => {
    now += 1000;
    tracker.ingest({ poolKey: POOL, streamId: 's', sourceSequence: ++seq, provider: 'codex', accountScope: 'acct', limitId: 'codex',
      source: 'codex-rollout', observedAt: now, receivedAt: now, windows: w,
      providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus', ...o });
    return notifier.observe(tracker.snapshot(), now);
  };
  read(std(80, 60));
  const intents = read(windows, over);
  const toasts = intents.map((i) => { presenter.noteIntent(i, 'SHOWN'); return presenter.toastFor(i, tracker.pool(POOL)); });
  if (stale) { now += L0_SEM_POLICY.liveTtlMs + 10; tracker.evaluate(); }
  const strip = presenter.present({ snapshot: tracker.snapshot(), membersOf: () => ['pam'], membershipKnown: () => true,
    freshUntil: (k) => tracker.freshUntil(k), now });
  const p = strip.pools[0];
  const detail = capacityDetailView({ pool: tracker.pool(POOL), poolId: p.poolId, poolLabel: p.label, presentation: p.presentation,
    members: ['pam'], membershipKnown: true, statusNote: null, now, formatTime: (t) => `@${t - T0}` });
  return { name, strip, shown: presentPool(p, now), detail, usage: agentUsageView(tracker.pool(POOL), now, (t) => `@${t - T0}`),
    banners: strip.pools.map((q) => q.notice?.banner).filter(Boolean), toasts: toasts.filter(Boolean) };
}

const FIXTURES = () => [
  fixture('healthy', std(80.6, 60)),
  fixture('low 5h', std(10, 60)),
  fixture('weekly revealed', std(80, 14.9)),
  fixture('attributed LIMITED', std(63, 0), ATTRIB),
  fixture('A2 RESERVE_ONLY', std(63, 0)),
  fixture('stale', std(80, 60), {}, { stale: true })
];

/** The strings that are ABOUT a hold or an attention state, never a figure and never "healthy". */
function attentionCopy() {
  const out = [];
  const names = Object.keys(hold.CAPACITY_WORDING);
  for (const e of names) {
    for (const capacityHold of [true, false]) {
      const v = hold.deliveryHoldView({ agentName: 'Alice', interfered: null, paused: false, headManual: false, capacityHold, capacityEvidence: e });
      if (v) out.push(...leaves(v, `hold(${e})`).map((l) => ({ ...l, healthy: e === 'FRESH_HEALTHY' })));
    }
    const note = hold.capacityStateNote(e);
    if (note) out.push({ at: `note(${e})`, text: note, healthy: e === 'FRESH_HEALTHY' });
    const s = composerStatus({ agentName: 'Alice', queueLength: 0, idle: true, hold: null, block: null, capacityNote: note, capacityEvidence: e });
    if (s) out.push(...leaves(s, `composer(${e})`));
  }
  for (const poolState of ['UNKNOWN', 'AVAILABLE', 'APPROACHING', 'RESERVE_ONLY', 'LIMITED', 'RECOVERING', null]) {
    for (const e of [null, ...names]) {
      for (const poolLabel of ['Codex', null]) {
        const v = hold.agentImpactOf({ interfered: false, autoDeliveryPaused: false, capacityHold: true, capacityEvidence: e, poolState, poolLabel });
        if (v) out.push({ at: `impact(${poolState},${e})`, text: v.text });
      }
    }
  }
  return out;
}

module.exports = {
  CROSS_FAMILY, CLAIMS_HEALTH, ANY_FIGURE, PERCENT, WINDOW_LABELS, SURFACE_MODULES, importsSurface,
  sourceCorpus, leaves, FIXTURES, attentionCopy
};
