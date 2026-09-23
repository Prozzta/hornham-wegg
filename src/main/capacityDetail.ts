/**
 * v1.1.45 unit #4 — the provider DETAIL projection (design of record §12, C2.9). Pure.
 *
 * Built from the same normalised tracker snapshot as the strip, at the same domain
 * revision, but NOT from the strip object: the strip hides what the panel must show. So
 * this enumerates EVERY window the pool has (except one the provider states does not
 * apply), weekly and any model-specific window included, each with its figure and its
 * reset expectation.
 *
 * It borrows three things from the strip on purpose, so the two surfaces cannot disagree:
 * the state words (STATE_TEXT), the blocked relationship (blockedFrameNote: C2.7 says the
 * details may show the raw 5h figure but must keep the blocked relation), and the strip's
 * own presentation of this pool (to know whether that relation holds right now).
 *
 * A figure that is not current (a stale reading, or evidence restored across a restart)
 * survives here only as last-known, worded "not current", and is never offered to a meter
 * (§10). An unidentified window says "Additional limit status unknown" (C2.6).
 */
import { applicabilityOf, type CapacityWindow, type PoolCapacitySnapshot } from '../shared/providerCapacity';
import type { DetailWindow, ProviderCapacityDetailView } from '../shared/capacityDetail';
import type { StripPresentation } from '../shared/capacityStrip';
import { STATE_TEXT, blockedFrameNote, formatLocalTime } from './capacityStrip';

export interface CapacityDetailInputs {
  pool: PoolCapacitySnapshot;
  poolId: string;
  poolLabel: string;
  /** The strip's presentation of this pool at the same revision, or null if it has none. */
  presentation: StripPresentation | null;
  members: readonly string[];
  membershipKnown: boolean;
  /** The composer's own words for this pool's admission state, or null. */
  statusNote: string | null;
  now: number;
  formatTime?: (t: number, now: number) => string;
}

const SOURCE_TEXT: Record<PoolCapacitySnapshot['source'], string> = {
  'claude-status-line': 'Claude status line',
  'codex-rollout': 'Codex session log',
  'codex-account-read': 'Codex account read',
  'antigravity-status-line': 'Antigravity status line'
};

const KIND_ORDER: Record<CapacityWindow['kind'], number> = { FIVE_HOUR: 0, SEVEN_DAY: 1, OTHER: 2 };

const validRemaining = (v: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;

/**
 * STALE-RETAIN: the strip keeps a stale reading's figure, so the provider details carry the
 * honesty - how long since the last observed reading, in whole minutes (never negative).
 */
export function notRefreshedText(observedAt: number, now: number): string {
  return `Not refreshed in ${Math.max(0, Math.floor((now - observedAt) / 60_000))} min`;
}

export function capacityDetailView(i: CapacityDetailInputs): ProviderCapacityDetailView {
  const { pool, now } = i;
  const fmt = i.formatTime ?? formatLocalTime;
  const restored = pool.stateReason === 'RESTORED_UNCONFIRMED';
  const current = pool.freshness === 'FRESH' && !restored;
  // STALE-RETAIN: the same test the strip uses to keep a plain stale reading's figures.
  const retained = pool.freshness === 'STALE' && pool.state === 'UNKNOWN' && pool.stateReason === 'STALE_READING';
  const blocked = i.presentation === 'BLOCKED_SUBORDINATE' ? blockedFrameNote(pool.state) : null;

  const windows: DetailWindow[] = [...pool.windows]
    .filter((w) => applicabilityOf(w) !== 'INAPPLICABLE')
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .map((w) => {
      const out: DetailWindow = { label: w.label, kind: w.kind, text: '' };
      const r = validRemaining(w.remainingPercent);
      if (applicabilityOf(w) === 'UNKNOWN') out.text = 'Additional limit status unknown';
      else if (r === null) out.text = `${w.label} · capacity unknown`;
      else if (current) { out.text = `${w.label} · ${Math.floor(r)}% remaining`; out.remainingPercent = r; }
      else {
        out.text = `${w.label} · ${Math.floor(r)}% remaining · not current`;
        if (retained && w.kind === 'FIVE_HOUR' && applicabilityOf(w) === 'APPLICABLE') out.lastKnownPercent = r;
      }
      if (w.resetsAt !== null) {
        out.resetText = w.resetsAt > now ? `reset expected ~${fmt(w.resetsAt, now)}` : `reset was expected ~${fmt(w.resetsAt, now)}`;
      }
      if (pool.providerAttributedLimitingWindowId === w.windowId) out.note = 'the provider reports this limit reached';
      else if (w.kind === 'FIVE_HOUR' && blocked) out.note = blocked;
      return out;
    });

  const last = fmt(pool.observedAt, now);
  const freshnessText = restored
    ? `restored after restart · last update ${last} · not confirmed by a live reading`
    : current ? `updated ${last}` : `last update ${last} · not current`;

  const members = [...i.members].sort();
  const membershipText = !i.membershipKnown
    ? 'Membership unknown'
    : members.length ? `Shared by ${members.length} agent${members.length === 1 ? '' : 's'}` : 'No agent has reported on this pool yet';

  const view: ProviderCapacityDetailView = {
    poolId: i.poolId,
    poolLabel: i.poolLabel,
    provider: pool.provider,
    domainRevision: pool.revision,
    state: pool.state,
    stateText: STATE_TEXT[pool.state],
    freshness: pool.freshness === 'STALE'
      ? { verdict: pool.freshness, text: freshnessText, ageText: notRefreshedText(pool.observedAt, now) }
      : { verdict: pool.freshness, text: freshnessText },
    windows,
    membership: { known: i.membershipKnown, text: membershipText, agentIds: members },
    sourceText: SOURCE_TEXT[pool.source]
  };
  if (i.statusNote) view.statusNote = i.statusNote;
  return view;
}
