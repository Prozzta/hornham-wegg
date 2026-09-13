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
/**
 * Whether a window constrains THIS pool, as a tri-state rather than a presence test.
 *
 * L0-SEM 121 needs all three and they behave differently: a known-APPLICABLE window
 * is classified, a known-INAPPLICABLE one is EXCLUDED and is not a gap, and one whose
 * applicability is UNKNOWN forces the pool to UNKNOWN. Collapsing the last two into
 * "absent" is what let an unidentified window be silently skipped while the pool went
 * on reporting AVAILABLE on the windows that happened to parse.
 *
 * INAPPLICABLE is representable and is not produced by either adapter today: neither
 * provider states that a window does not apply to an account. It exists so a future
 * provider fact has somewhere true to land, and NOT as a place to put a guess.
 */
export type WindowApplicability = 'APPLICABLE' | 'INAPPLICABLE' | 'UNKNOWN';

/**
 * Applicability of a window, STATED if the payload said so and DERIVED otherwise.
 *
 * There is one rule and this is it, so a caller that builds a window by hand and a
 * normaliser that builds one from a payload cannot disagree. The derivation is the
 * same question the normalisers ask: COULD WE IDENTIFY THIS WINDOW? A window with a
 * known kind or a real duration is one we can name, and a named window applies. One
 * with neither is a window we fell back to a slot name for — a slot a plan change can
 * move — so we do not know what it constrains, and 121 makes that UNKNOWN rather
 * than something to leave quietly out of the arithmetic.
 */
export const applicabilityOf = (w: CapacityWindow): WindowApplicability =>
  w.applicability ?? (w.kind === 'OTHER' && w.windowMinutes === null ? 'UNKNOWN' : 'APPLICABLE');

export interface CapacityWindow {
  /** Stable within a pool. Derived from duration where known, so it survives re-anchoring. */
  windowId: string;
  kind: WindowKind;
  /**
   * Does this window constrain this pool? Optional because the provider states it
   * only when it has something to say; absent means "derive it", via
   * `applicabilityOf`. Never read this field directly — read that function, so the
   * stated and derived cases cannot drift apart.
   */
  applicability?: WindowApplicability;
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
  /**
   * Stable identity of the STREAM this reading came from, and its position in that
   * stream (L0-SEM 127). The ordering key is `(observedAt, sourceSequence)`.
   *
   * WHY A SEQUENCE AND NOT JUST A TIME. A Codex rollout stamps whole-second
   * timestamps, so two events written inside the same second are indistinguishable
   * by time alone and the later one looks like a duplicate or an out-of-order
   * replay. The rollout already numbers its own lines with `ordinal`, which is
   * exactly the sequence this needs — it was there all along and nothing read it.
   *
   * THE STREAM ID MATTERS BECAUSE SEQUENCES ARE ONLY COMPARABLE WITHIN A STREAM.
   * Codex starts a new rollout file per session and restarts `ordinal` at zero, so
   * comparing an ordinal from one file against another would make a brand-new
   * reading look ancient. Both are null for a source that numbers nothing, and a
   * null sequence simply falls back to ordering by time.
   */
  streamId: string | null;
  sourceSequence: number | null;
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
  /**
   * Which collector produced the reading behind this projection. PROVENANCE IS A
   * DOMAIN FIELD (L0-SEM 135): the same numbers arriving from a live status line and
   * from a replayed rollout are not the same fact, and a consumer that cannot see
   * the difference cannot tell a current reading from a re-read of an old one.
   */
  source: ObservationSource;
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
  /** Fixed metadata for a retention-cap breach, or null. See `CapBreachKind`. */
  capBreach: CapBreachKind | null;
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

/** Fixed-size evidence that the collection is missing pools. See `overflow`. */
export interface CollectionOverflowMarker {
  kind: 'POOL_COUNT_EXCEEDED';
  completeness: 'UNKNOWN';
  excess: 'ONE_OR_MORE';
}

/**
 * Which retention cap a pool breached. Fixed metadata (L0-SEM 13) — it records the
 * SHAPE of the breach and never any part of what breached it.
 */
export type CapBreachKind =
  | 'WINDOW_COUNT_EXCEEDED'
  | 'POOL_BYTES_EXCEEDED'
  | 'COLLECTION_BYTES_EXCEEDED';

/** The whole collection, with its own revision so a consumer can diff cheaply. */
export interface CapacityCollectionSnapshot {
  /**
   * Present once the pool-count cap has been breached, and latched (L0-SEM 13).
   *
   * NOT A POOL AND NOT A COUNT. It carries no identity, no windows, no percentages
   * and no reset data, because retaining any of those about the excess pools is the
   * very thing the cap forbids. And it says ONE_OR_MORE rather than a number: under
   * a one-pool ingest API you cannot tell a 34th NEW pool from a repeat of the 33rd
   * without retaining the identities you are specifically refusing to retain, so
   * counting would itself be unbounded. `ONE_OR_MORE` is the honest bounded fact.
   *
   * Its presence means the COLLECTION is incomplete. The retained pools keep their
   * own valid states; what a consumer may not do is treat the collection as whole,
   * and any reference to an omitted pool resolves UNKNOWN rather than AVAILABLE.
   */
  overflow: CollectionOverflowMarker | null;
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
