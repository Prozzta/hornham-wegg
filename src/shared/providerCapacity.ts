/**
 * L0 provider-capacity vocabulary and DTOs.
 *
 * One pool = one provider-account/limit identity. NOT one provider and NOT one
 * agent: a subscription allowance is shared at account/plan/limit scope, so four
 * agent rows can draw on one pool, and two accounts of the same provider are two
 * pools that must never merge. Everything here is keyed that way.
 *
 * VOCABULARY RULE (design of record C2.2). There is deliberately no `bindingWindow`,
 * `tighterWindow`, `moreHeadroom` or `likelyToExhaustFirst` field anywhere in this
 * module. Five-hour and weekly percentages have different denominators and different
 * replenishment horizons, so raw percentage order is not an order of headroom or of
 * time to exhaustion. Only these survive, and they are separate facts:
 *   - `providerAttributedLimitingWindowId` — the provider NAMES the window. Causal.
 *   - `numericallyExhaustedWindowIds`      — a fresh zero remainder. Observational.
 * They are never collapsed into one field, because a generic 429, an overload, a
 * context exhaustion or a refusal without attribution would then be silently
 * relabelled as a named window limiting the account.
 *
 * NULL IS NOT ZERO. A missing, unparsed or stale value stays null and the state
 * stays UNKNOWN. Converting an absent reading to 0, or to "available", is the one
 * error that turns this module into a source of false claims.
 */

/** Provider families L0 collects from. */
export type ProviderId = 'claude' | 'codex';

/**
 * Tracker states (scheduling audit section 8). HANDOFF_REQUIRED is deliberately
 * absent at L0: it is a property of in-flight work, not of provider capacity, and
 * the admission seam that owns it is a separate card.
 */
export type CapacityState =
  | 'UNKNOWN'
  | 'AVAILABLE'
  | 'APPROACHING'
  | 'RESERVE_ONLY'
  | 'LIMITED'
  | 'RECOVERING';

/**
 * Window identity is derived from DURATION, never from the provider's positional
 * naming: Codex reports `primary`/`secondary`, which are slots rather than windows,
 * and a plan change can move which slot holds which duration.
 */
export type WindowKind = 'FIVE_HOUR' | 'SEVEN_DAY' | 'OTHER';

/** Whether the snapshot is still inside its freshness budget. */
export type CapacityFreshness = 'FRESH' | 'STALE';

/**
 * Provenance, because the levels are not interchangeable: a direct account read is
 * authoritative for current capacity, a rollout copy is authoritative at its event
 * time, and nothing else is authoritative at all.
 */
export type ObservationSource =
  | 'claude-status-line'
  | 'codex-rollout'
  | 'codex-account-read';

/** One normalised allowance window. Every numeric field is nullable on purpose. */
export interface CapacityWindow {
  /** Stable within a pool. Derived from duration where known, so it survives re-anchoring. */
  windowId: string;
  kind: WindowKind;
  /** User-safe label, main-owned. The renderer never composes window wording. */
  label: string;
  windowMinutes: number | null;
  usedPercent: number | null;
  /** Remaining, not used — the conversion happens once, here. null is UNKNOWN, never 0. */
  remainingPercent: number | null;
  /** Epoch ms. An expectation, never a recovery claim. */
  resetsAt: number | null;
}

/**
 * One normalised reading from one source at one instant. Pure data: the normalisers
 * that produce it do no I/O and hold no state, so every shape question is testable
 * without a provider, a clock or a filesystem.
 */
export interface CapacityObservation {
  poolKey: string;
  provider: ProviderId;
  /**
   * Account discriminator. Two accounts of one provider MUST produce different
   * values or their pools merge and the UI understates consumption. Supplied by the
   * collection site from the credential location it used — a path or a hash of one,
   * never credential bytes.
   */
  accountScope: string;
  limitId: string;
  source: ObservationSource;
  /** Provider event time where the source supplies one, else receipt time. */
  observedAt: number;
  receivedAt: number;
  windows: CapacityWindow[];
  /** Set ONLY when the provider names the window. Causal evidence. */
  providerAttributedLimitingWindowId: string | null;
  /** The provider's own typed reached signal, retained verbatim for auditability. */
  providerReachedType: string | null;
  /** Tri-state. null stays unknown and must never be read as true. */
  ordinaryUsageAllowed: boolean | null;
  planType: string | null;
}

/** The tracker's public projection of one pool. */
export interface PoolCapacitySnapshot {
  poolKey: string;
  provider: ProviderId;
  accountScope: string;
  limitId: string;
  /** Per-pool revision: increments only when this projection actually changes. */
  revision: number;
  state: CapacityState;
  /** Main-owned, non-causal unless the provider attributed the limit. */
  stateReason: string;
  windows: CapacityWindow[];
  freshness: CapacityFreshness;
  observedAt: number;
  receivedAt: number;
  ageMs: number;
  providerAttributedLimitingWindowId: string | null;
  numericallyExhaustedWindowIds: string[];
  ordinaryUsageAllowed: boolean | null;
  planType: string | null;
  /** A reset boundary has passed but recovery is NOT yet evidenced. Never implies AVAILABLE. */
  recoveryPending: boolean;
  /**
   * Identity of the current limit epoch — the moment hard evidence opened it — or
   * null when none is open. It exists because two consumers need to tell ONE refusal
   * from a later one: the admission seam grants at most one recovery turn per epoch,
   * and the notifier emits at most one intent per epoch. A state name alone cannot
   * distinguish "still the same refusal" from "refused again", and a revision number
   * moves for reasons that have nothing to do with refusals.
   */
  limitEpochAt: number | null;
}

/** The whole collection, with its own revision so a consumer can diff cheaply. */
export interface CapacityCollectionSnapshot {
  /** Increments when any pool projection changes or a pool is added or removed. */
  collectionRevision: number;
  pools: PoolCapacitySnapshot[];
  updatedAt: number;
}

/** Claude's documented five-hour window, and Codex's 300-minute primary. */
export const FIVE_HOUR_MINUTES = 300;
/** Claude's documented seven-day window, and Codex's 10080-minute secondary. */
export const SEVEN_DAY_MINUTES = 10_080;

/**
 * Duration → kind. Tolerant by design: a provider that re-anchors or adds a
 * model-family window must land in OTHER rather than be forced into a known slot,
 * because a mislabelled window is worse than an unlabelled one.
 */
export function windowKindFromMinutes(minutes: number | null | undefined): WindowKind {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return 'OTHER';
  if (minutes === FIVE_HOUR_MINUTES) return 'FIVE_HOUR';
  if (minutes === SEVEN_DAY_MINUTES) return 'SEVEN_DAY';
  return 'OTHER';
}

/** User-safe label, main-owned. */
export function windowLabel(kind: WindowKind, minutes: number | null): string {
  if (kind === 'FIVE_HOUR') return '5h';
  if (kind === 'SEVEN_DAY') return 'Weekly';
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
    return minutes % 60 === 0 ? `${minutes / 60}h window` : `${minutes}m window`;
  }
  return 'Other limit';
}

/** Pool identity. Assembled in one place so no caller invents a second key format. */
export function poolKeyOf(provider: ProviderId, accountScope: string, limitId: string): string {
  return `${provider}:${accountScope}:${limitId}`;
}
