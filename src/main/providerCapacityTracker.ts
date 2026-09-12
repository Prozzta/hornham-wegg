/**
 * ProviderCapacityTracker — main-process state for provider allowance, keyed by
 * provider-account/limit identity.
 *
 * WHAT IT IS FOR. Munder already shows an accumulated per-agent token number. That
 * number is not capacity: subscription allowance is shared at account scope, so
 * several agent rows draw on one pool, and a per-agent total says nothing about a
 * provider window. This tracker holds the only thing that does — a normalised
 * remaining figure per window, per pool, with its freshness and its provenance.
 *
 * TWO MUTATORS, BOTH EXPLICIT:
 *   - `ingest(observation)` — a new reading arrived.
 *   - `evaluate(now)`       — time passed, so freshness and reset boundaries move.
 * Reading never mutates. The alternative, a getter that recomputes and bumps a
 * revision, would make revision counts depend on how often something looked, which
 * is precisely what a consumer diffing on revision must be able to trust.
 *
 * REVISIONS ARE CHANGE COUNTERS, NOT EVENT COUNTERS. A re-observation that says
 * exactly what the last one said bumps nothing. Provider snapshots repeat far more
 * often than they change, and a revision that ticks on every repeat would push a
 * no-op update through every consumer above it.
 *
 * RECOVERY IS NEVER INFERRED FROM A CLOCK. A passed reset time moves LIMITED to
 * RECOVERING and no further. Leaving RECOVERING requires observed evidence:
 * `ordinaryUsageAllowed === true`, or a fresh reading with no reached signal and
 * materially restored capacity. A clock passing is not evidence about a provider.
 *
 * THE STATE DERIVATION BELOW IS PROVISIONAL. Thresholds, the freshness budget and
 * the exact transition table are capacity SEMANTICS and are owned by Oscar's
 * L0-SEM. Everything policy-shaped is gathered into `CapacityPolicy` with clearly
 * labelled provisional defaults, so reconciling with L0-SEM is a change to one
 * object and one function rather than a rewrite of the store.
 */
import type {
  CapacityCollectionSnapshot,
  CapacityFreshness,
  CapacityObservation,
  CapacityState,
  ObservationSource,
  PoolCapacitySnapshot
} from '../shared/providerCapacity';

/**
 * PROVISIONAL policy inputs — pending Oscar's L0-SEM.
 *
 * None of these numbers is called safe. The scheduling audit's reserve analysis is
 * explicit that the dependable reserve is unmeasured (one observed Codex account
 * went from 86% used to 100% in about 196 seconds), so a percentage floor here is
 * a placeholder for a learned envelope, not a substitute for one.
 */
export interface CapacityPolicy {
  /** Beyond this age a reading is STALE and the pool is UNKNOWN, not "last known good". */
  freshnessMs: number;
  /** Provisional: remaining at or below this enters RESERVE_ONLY. */
  reservePercent: number;
  /** Provisional: remaining at or below this enters APPROACHING. */
  approachingPercent: number;
  /** Provisional: remaining above this, on a fresh unreached reading, is evidence of recovery. */
  recoveredPercent: number;
}

export const PROVISIONAL_POLICY: CapacityPolicy = {
  freshnessMs: 10 * 60 * 1000,
  reservePercent: 5,
  approachingPercent: 20,
  recoveredPercent: 10
};

/** Provenance authority, used only to break ties between equally-timed readings. */
const SOURCE_AUTHORITY: Record<ObservationSource, number> = {
  'codex-account-read': 3,
  'codex-rollout': 2,
  'claude-status-line': 2
};

/** Main-owned reason codes. Non-causal unless the provider itself attributed the limit. */
export const REASON = {
  PROVIDER_ATTRIBUTED: 'PROVIDER_ATTRIBUTED_LIMITING',
  PROVIDER_REACHED_UNATTRIBUTED: 'PROVIDER_REACHED_UNATTRIBUTED',
  ORDINARY_USE_DENIED: 'ORDINARY_USE_DENIED',
  NUMERICALLY_EXHAUSTED: 'NUMERICALLY_EXHAUSTED',
  RESET_PASSED_UNCONFIRMED: 'RESET_PASSED_UNCONFIRMED',
  STALE: 'STALE_READING',
  NO_READING: 'NO_READING',
  NO_NUMBERS: 'NO_USABLE_NUMBERS',
  RESERVE: 'AT_OR_BELOW_PROVISIONAL_RESERVE',
  APPROACHING: 'AT_OR_BELOW_PROVISIONAL_APPROACHING',
  FRESH: 'FRESH_READING'
} as const;

interface PoolRecord {
  observation: CapacityObservation;
  /** Last published projection, for change detection. */
  projection: PoolCapacitySnapshot;
  /** Sticky until recovery is EVIDENCED, so a later quiet reading cannot erase a refusal. */
  limitedSince: number | null;
}

/**
 * SEMANTIC change detection. Deliberately excludes `observedAt`, `receivedAt` and
 * `ageMs`: those move on every repeat reading and on every tick, and a revision
 * that moved with them would tell a consumer "something changed" once per status
 * line for a pool whose figures are identical. The semantic part of time is
 * `freshness`, and that IS compared.
 */
const sameProjection = (a: PoolCapacitySnapshot, b: PoolCapacitySnapshot): boolean =>
  a.state === b.state
  && a.stateReason === b.stateReason
  && a.freshness === b.freshness
  && a.providerAttributedLimitingWindowId === b.providerAttributedLimitingWindowId
  && a.ordinaryUsageAllowed === b.ordinaryUsageAllowed
  && a.planType === b.planType
  && a.recoveryPending === b.recoveryPending
  && a.numericallyExhaustedWindowIds.join('|') === b.numericallyExhaustedWindowIds.join('|')
  && JSON.stringify(a.windows) === JSON.stringify(b.windows);

export class ProviderCapacityTracker {
  private pools = new Map<string, PoolRecord>();
  private collectionRevision = 0;
  private updatedAt = 0;

  constructor(
    private readonly policy: CapacityPolicy = PROVISIONAL_POLICY,
    private readonly clock: () => number = () => Date.now()
  ) {}

  /**
   * Accept a reading. Returns true when the pool's public projection changed.
   *
   * Older readings are rejected outright. That is what keeps a stale 20%-remaining
   * snapshot from overwriting a newer typed refusal — file order and arrival order
   * are both unreliable here, because a long-running session can emit an event
   * newer than one from a file created later.
   */
  ingest(obs: CapacityObservation): boolean {
    const now = this.clock();
    const prev = this.pools.get(obs.poolKey);
    if (prev) {
      const older = obs.observedAt < prev.observation.observedAt;
      const sameTimeLowerAuthority = obs.observedAt === prev.observation.observedAt
        && SOURCE_AUTHORITY[obs.source] < SOURCE_AUTHORITY[prev.observation.source];
      if (older || sameTimeLowerAuthority) return false;
    }

    const limitedSince = this.nextLimitedSince(prev, obs, now);
    const record: PoolRecord = {
      observation: obs,
      limitedSince,
      projection: prev ? prev.projection : blankProjection(obs)
    };
    this.pools.set(obs.poolKey, record);
    return this.reproject(obs.poolKey, now);
  }

  /**
   * Recompute time-derived facts. Freshness expires and reset boundaries pass
   * without any new reading, and a consumer must see that happen. Returns true when
   * any pool's projection changed.
   */
  evaluate(now: number = this.clock()): boolean {
    let changed = false;
    for (const key of this.pools.keys()) changed = this.reproject(key, now) || changed;
    return changed;
  }

  /** Pure read of the last evaluated projection. */
  snapshot(): CapacityCollectionSnapshot {
    return {
      collectionRevision: this.collectionRevision,
      pools: [...this.pools.values()].map((r) => r.projection),
      updatedAt: this.updatedAt
    };
  }

  pool(poolKey: string): PoolCapacitySnapshot | null {
    return this.pools.get(poolKey)?.projection ?? null;
  }

  /** Removal is explicit. Nothing here expires a pool on its own at L0. */
  forget(poolKey: string): boolean {
    if (!this.pools.delete(poolKey)) return false;
    this.collectionRevision += 1;
    this.updatedAt = this.clock();
    return true;
  }

  /**
   * LIMITED is sticky until recovery is evidenced. Without this, a rollout event
   * that merely lacks a reached signal would clear a real refusal, and the tracker
   * would oscillate between LIMITED and AVAILABLE on ordinary traffic.
   */
  private nextLimitedSince(prev: PoolRecord | undefined, obs: CapacityObservation, now: number): number | null {
    if (obs.ordinaryUsageAllowed === false || obs.providerReachedType) return prev?.limitedSince ?? now;
    if (numericallyExhausted(obs).length) return prev?.limitedSince ?? now;
    if (!prev?.limitedSince) return null;
    // Evidence-based exits only.
    if (obs.ordinaryUsageAllowed === true) return null;
    const best = maxRemaining(obs);
    if (best !== null && best > this.policy.recoveredPercent) return null;
    return prev.limitedSince;
  }

  private reproject(poolKey: string, now: number): boolean {
    const rec = this.pools.get(poolKey);
    if (!rec) return false;
    const next = this.project(rec, now);
    if (sameProjection(rec.projection, next)) {
      // Nothing semantic moved, but the timestamps did. Store them - otherwise a
      // fresh reading identical to the last one would keep the OLD observedAt and
      // the pool would expire into STALE while it was in fact being observed - and
      // leave the revision exactly where it was.
      next.revision = rec.projection.revision;
      rec.projection = next;
      return false;
    }
    // Carry the revision forward and increment ONLY on a real change.
    next.revision = rec.projection.revision + 1;
    rec.projection = next;
    this.collectionRevision += 1;
    this.updatedAt = now;
    return true;
  }

  private project(rec: PoolRecord, now: number): PoolCapacitySnapshot {
    const obs = rec.observation;
    const ageMs = Math.max(0, now - obs.observedAt);
    const freshness: CapacityFreshness = ageMs <= this.policy.freshnessMs ? 'FRESH' : 'STALE';
    const exhausted = numericallyExhausted(obs);
    const resetPassed = earliestRelevantReset(obs, exhausted) !== null
      && (earliestRelevantReset(obs, exhausted) as number) <= now;
    const recoveryPending = rec.limitedSince !== null && resetPassed;
    const { state, stateReason } = this.deriveState(obs, rec, { freshness, exhausted, recoveryPending });
    return {
      poolKey: obs.poolKey,
      provider: obs.provider,
      accountScope: obs.accountScope,
      limitId: obs.limitId,
      revision: rec.projection.revision,
      state,
      stateReason,
      windows: obs.windows,
      freshness,
      observedAt: obs.observedAt,
      receivedAt: obs.receivedAt,
      ageMs,
      providerAttributedLimitingWindowId: obs.providerAttributedLimitingWindowId,
      numericallyExhaustedWindowIds: exhausted,
      ordinaryUsageAllowed: obs.ordinaryUsageAllowed,
      planType: obs.planType,
      recoveryPending
    };
  }

  /**
   * PROVISIONAL state derivation — to be reconciled against Oscar's L0-SEM before
   * anything downstream depends on the exact boundaries.
   *
   * The ordering is risk-monotonic on purpose: refusal evidence outranks numbers,
   * numbers outrank staleness, and nothing reaches AVAILABLE without a fresh
   * reading that actually carries a figure.
   *
   * One deliberate choice worth naming, because it is the one place the design of
   * record admits two readings: C2.7 defines the overall state as LIMITED when an
   * applicable window is exhausted AND blocking ordinary use. Fresh numeric
   * exhaustion establishes the first and not the second. It is treated as LIMITED
   * here — understating it would let a scheduler spend against a spent window —
   * but it carries the OBSERVATIONAL reason code, never the attributed one, so no
   * surface above can turn it into a causal claim.
   */
  private deriveState(
    obs: CapacityObservation,
    rec: PoolRecord,
    ctx: { freshness: CapacityFreshness; exhausted: string[]; recoveryPending: boolean }
  ): { state: CapacityState; stateReason: string } {
    if (obs.ordinaryUsageAllowed === false) {
      return { state: 'LIMITED', stateReason: REASON.ORDINARY_USE_DENIED };
    }
    if (rec.limitedSince !== null) {
      // A passed reset moves LIMITED to RECOVERING and no further. Never AVAILABLE.
      if (ctx.recoveryPending) return { state: 'RECOVERING', stateReason: REASON.RESET_PASSED_UNCONFIRMED };
      if (obs.providerAttributedLimitingWindowId) {
        return { state: 'LIMITED', stateReason: REASON.PROVIDER_ATTRIBUTED };
      }
      if (obs.providerReachedType) {
        return { state: 'LIMITED', stateReason: REASON.PROVIDER_REACHED_UNATTRIBUTED };
      }
      return { state: 'LIMITED', stateReason: REASON.NUMERICALLY_EXHAUSTED };
    }
    if (ctx.freshness === 'STALE') return { state: 'UNKNOWN', stateReason: REASON.STALE };
    const remaining = minRemaining(obs);
    if (remaining === null) return { state: 'UNKNOWN', stateReason: REASON.NO_NUMBERS };
    if (remaining <= this.policy.reservePercent) return { state: 'RESERVE_ONLY', stateReason: REASON.RESERVE };
    if (remaining <= this.policy.approachingPercent) return { state: 'APPROACHING', stateReason: REASON.APPROACHING };
    return { state: 'AVAILABLE', stateReason: REASON.FRESH };
  }
}

/**
 * The least remaining figure across windows that HAVE one.
 *
 * This is a minimum over same-kind quantities, not a claim that the lowest window
 * binds. There is deliberately no accompanying "which window binds" field: the
 * denominators differ, so ordering these percentages orders nothing real (C2.2).
 */
function minRemaining(obs: CapacityObservation): number | null {
  let min: number | null = null;
  for (const w of obs.windows) {
    if (w.remainingPercent === null) continue;
    min = min === null ? w.remainingPercent : Math.min(min, w.remainingPercent);
  }
  return min;
}

function maxRemaining(obs: CapacityObservation): number | null {
  let max: number | null = null;
  for (const w of obs.windows) {
    if (w.remainingPercent === null) continue;
    max = max === null ? w.remainingPercent : Math.max(max, w.remainingPercent);
  }
  return max;
}

/** Fresh zero remainder. An OBSERVATION; it never implies the provider said anything. */
function numericallyExhausted(obs: CapacityObservation): string[] {
  return obs.windows.filter((w) => w.remainingPercent === 0).map((w) => w.windowId);
}

/**
 * The reset time that matters for recovery: the earliest reset among the windows
 * that are actually spent, falling back to the earliest known reset when nothing is
 * numerically spent (a typed refusal with no zeroed window still has a boundary).
 */
function earliestRelevantReset(obs: CapacityObservation, exhausted: string[]): number | null {
  const pool = exhausted.length
    ? obs.windows.filter((w) => exhausted.includes(w.windowId))
    : obs.windows;
  let earliest: number | null = null;
  for (const w of pool) {
    if (w.resetsAt === null) continue;
    earliest = earliest === null ? w.resetsAt : Math.min(earliest, w.resetsAt);
  }
  return earliest;
}

/** Revision 0 placeholder; the first reproject replaces it and moves to revision 1. */
function blankProjection(obs: CapacityObservation): PoolCapacitySnapshot {
  return {
    poolKey: obs.poolKey,
    provider: obs.provider,
    accountScope: obs.accountScope,
    limitId: obs.limitId,
    revision: 0,
    state: 'UNKNOWN',
    stateReason: REASON.NO_READING,
    windows: [],
    freshness: 'STALE',
    observedAt: 0,
    receivedAt: 0,
    ageMs: 0,
    providerAttributedLimitingWindowId: null,
    numericallyExhaustedWindowIds: [],
    ordinaryUsageAllowed: null,
    planType: null,
    recoveryPending: false
  };
}
