/**
 * v1.1.45 unit #4 — the provider DETAIL view (design of record §12, C2.9).
 *
 * "Provider details is not fed by the strip object." This is a SEPARATE, surface-scoped
 * projection built in main from the same normalised tracker snapshot at the same domain
 * revision, returned on its OWN invoke channel only while the panel is open, and dropped
 * by the renderer on close, pool switch, reload or disconnect. It carries what the strip
 * deliberately does not: EVERY window the pool has (the weekly and any model-specific
 * window, even while the strip hides them), each with its remaining figure and reset
 * expectation, plus the freshness verdict, the membership and the source.
 *
 * What it never carries: credentials, account identifiers, pool keys, raw provider
 * payloads (§12). Pool identity is the strip's opaque poolId plus its label.
 *
 * Every word is main's. A stale figure survives here ONLY as last-known, subordinate and
 * worded "not current" (§10), and never with a meter.
 */
import { CAPACITY_STATES, PROVIDER_IDS, type CapacityState, type ProviderId } from './providerCapacity';

/** Invoke: the detail view for one poolId, or null when that pool is not in the collection. */
export const CAPACITY_DETAIL_CHANNEL = 'capacity:detail';
/** v1.1.46 A2 - push: main's re-push of the open STALE pool's detail view, once a minute. */
export const CAPACITY_DETAIL_PUSH = 'capacity:detailPush';
/** v1.1.46 A2 - send: the panel on this poolId closed or switched; main stops re-pushing it. */
export const CAPACITY_DETAIL_CLOSED = 'capacity:detailClosed';

export interface DetailWindow {
  /** Main's label: `5h`, `Weekly`, or a model-specific / other window's own label. */
  label: string;
  kind: 'FIVE_HOUR' | 'SEVEN_DAY' | 'OTHER';
  /** The whole line, label inseparable from figure or status. */
  text: string;
  /** Present ONLY for a current (fresh, valid) figure: the one thing a meter may draw. */
  remainingPercent?: number;
  /** STALE-RETAIN: the five-hour row's last-known figure for a plain stale reading - the
   *  figure the strip still draws, so the header dot matches it. Never offered to a meter. */
  lastKnownPercent?: number;
  /** `reset expected ~14:30`, or `reset was expected ~14:30` once that time has passed. */
  resetText?: string;
  /** A relationship main knows about this window (provider attribution, a blocked 5h). */
  note?: string;
}

export interface ProviderCapacityDetailView {
  poolId: string;
  poolLabel: string;
  provider: ProviderId;
  /** The tracker revision this was built from (the same domain truth as the strip). */
  domainRevision: number;
  state: CapacityState;
  stateText: string;
  /** The composer's own words for what admission is doing on this pool (e.g. the post-reset probe). */
  statusNote?: string;
  /** `ageText` ("Not refreshed in X min") is present exactly when the reading is STALE. */
  freshness: { verdict: 'FRESH' | 'STALE'; text: string; ageText?: string };
  windows: DetailWindow[];
  membership: { known: boolean; text: string; agentIds: string[] };
  sourceText: string;
}

// ─── Runtime schema (additionalProperties:false) ───────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 300;

function extra(o: Record<string, unknown>, allowed: string[], at: string): string[] {
  return Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${at}.${k}: property not allowed`);
}

function windowErrors(w: unknown, at: string): string[] {
  if (!isObj(w)) return [`${at}: not an object`];
  const errors = extra(w, ['label', 'kind', 'text', 'remainingPercent', 'lastKnownPercent', 'resetText', 'note'], at);
  if (!isText(w.label)) errors.push(`${at}.label: not text`);
  if (!['FIVE_HOUR', 'SEVEN_DAY', 'OTHER'].includes(w.kind as string)) errors.push(`${at}.kind: not a window kind`);
  if (!isText(w.text)) errors.push(`${at}.text: not text`);
  if ('remainingPercent' in w) {
    const r = w.remainingPercent;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 100) errors.push(`${at}.remainingPercent: not 0..100`);
  }
  if ('lastKnownPercent' in w) {
    const r = w.lastKnownPercent;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 100) errors.push(`${at}.lastKnownPercent: not 0..100`);
    if (w.kind !== 'FIVE_HOUR') errors.push(`${at}.lastKnownPercent: five-hour row only`);
    if ('remainingPercent' in w) errors.push(`${at}.lastKnownPercent: never beside a current figure`);
  }
  if ('resetText' in w && !isText(w.resetText)) errors.push(`${at}.resetText: not text`);
  if ('note' in w && !isText(w.note)) errors.push(`${at}.note: not text`);
  return errors;
}

/** Validate a detail view. Empty = valid; anything else is refused whole. */
export function validateCapacityDetail(v: unknown): string[] {
  if (!isObj(v)) return ['$: not an object'];
  const errors = extra(v, ['poolId', 'poolLabel', 'provider', 'domainRevision', 'state', 'stateText', 'statusNote',
    'freshness', 'windows', 'membership', 'sourceText'], '$');
  if (!isText(v.poolId) || !/^pool-[0-9a-f]{16}$/.test(v.poolId as string)) errors.push('$.poolId: not an opaque pool id');
  if (!isText(v.poolLabel)) errors.push('$.poolLabel: not text');
  if (!(PROVIDER_IDS as readonly string[]).includes(v.provider as string)) errors.push('$.provider: not a provider');
  if (!Number.isSafeInteger(v.domainRevision) || (v.domainRevision as number) < 0) errors.push('$.domainRevision: not a revision');
  if (!(CAPACITY_STATES as readonly string[]).includes(v.state as string)) errors.push('$.state: not a state');
  if (!isText(v.stateText)) errors.push('$.stateText: not text');
  if ('statusNote' in v && !isText(v.statusNote)) errors.push('$.statusNote: not text');
  if (!isObj(v.freshness)) errors.push('$.freshness: not an object');
  else {
    errors.push(...extra(v.freshness, ['verdict', 'text', 'ageText'], '$.freshness'));
    if (v.freshness.verdict !== 'FRESH' && v.freshness.verdict !== 'STALE') errors.push('$.freshness.verdict: not FRESH|STALE');
    if (!isText(v.freshness.text)) errors.push('$.freshness.text: not text');
    if ((v.freshness.verdict === 'STALE') !== ('ageText' in v.freshness)) errors.push('$.freshness.ageText: present exactly when STALE');
    if ('ageText' in v.freshness && !(isText(v.freshness.ageText) && /^Not refreshed in \d+ min$/.test(v.freshness.ageText as string))) {
      errors.push('$.freshness.ageText: not "Not refreshed in X min"');
    }
  }
  if (!Array.isArray(v.windows)) errors.push('$.windows: not an array');
  else v.windows.forEach((w, i) => errors.push(...windowErrors(w, `$.windows[${i}]`)));
  if (!isObj(v.membership)) errors.push('$.membership: not an object');
  else {
    errors.push(...extra(v.membership, ['known', 'text', 'agentIds'], '$.membership'));
    if (typeof v.membership.known !== 'boolean') errors.push('$.membership.known: not a boolean');
    if (!isText(v.membership.text)) errors.push('$.membership.text: not text');
    if (!Array.isArray(v.membership.agentIds) || !v.membership.agentIds.every(isText)) errors.push('$.membership.agentIds: not ids');
  }
  if (!isText(v.sourceText)) errors.push('$.sourceText: not text');
  // A figure that is not current must never be offered for a meter.
  if (isObj(v.freshness) && v.freshness.verdict === 'STALE' && Array.isArray(v.windows)
    && v.windows.some((w) => isObj(w) && 'remainingPercent' in w)) {
    errors.push('$.windows: a stale pool offers no current figure');
  }
  if (isObj(v.freshness) && v.freshness.verdict !== 'STALE' && Array.isArray(v.windows)
    && v.windows.some((w) => isObj(w) && 'lastKnownPercent' in w)) {
    errors.push('$.windows: a last-known figure belongs to a stale pool only');
  }
  return errors;
}
