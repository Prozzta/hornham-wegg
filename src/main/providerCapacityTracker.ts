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
 * SEMANTICS ARE NOT MINE. The state predicates, the transition table, the TTLs and
 * the recovery rules implemented here are Oscar's L0-SEM
 * (`research/notes/oscar-l0-sem.md`, 21,515 bytes, sha256 643D45C0…86CC, frozen at
 * research 8b92e2ea). Where a comment below says why, it is explaining that note,
 * not deciding anything. Section references are to it unless marked C2.
 *
 * FRESHNESS IS MONOTONIC, NOT WALL-CLOCK (L0-SEM §6). When a reading is accepted,
 * its REMAINING TTL is converted to a deadline on a monotonic clock, and staleness
 * is decided against that deadline from then on. A wall-clock move — an NTP
 * correction, a laptop resumed in another timezone, a VM restored — therefore
 * cannot revive an expired reading, which is the one thing this design says must
 * never happen. The wall clock is still used for what it is the only answer to:
 * dating the event at acceptance, the future-skew guard, and comparing a provider's
 * absolute reset time.
 *
 * THREE MUTATORS, ALL EXPLICIT:
 *   - `ingest(observation)`     — a reading arrived.
 *   - `evaluate(now)`           — time passed, so freshness and reset boundaries move.
 *   - `noteSuccessfulTurn(...)` — the caller completed a real turn on this pool.
 * Reading never mutates. A getter that recomputed and bumped a revision would make
 * revision counts depend on how often something looked, which is the one property a
 * consumer diffing on revision has to be able to trust.
 *
 * THE FOUR RULINGS THIS FILE EXISTS TO OBEY (§2, §4, §5):
 *   1. Typed or attributed provider limiting is a STICKY limit epoch.
 *   2. A fresh numeric zero WITHOUT attribution is RESERVE_ONLY, never LIMITED.
 *   3. Positive percentages alone never synthesize APPROACHING or RESERVE_ONLY.
 *      APPROACHING needs an allowlisted provider-native advisory.
 *   4. A reset time passing enters RECOVERING only — never AVAILABLE.
 *
 * WHAT IS DELIBERATELY NOT HERE. No percentage reserve floor, no forecast, no
 * cross-window comparison, no `binding`/`tighter`/`headroom` field, and no reading
 * of the display threshold. The display threshold decides display and nothing else;
 * nothing in this file can see it.
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
 * Operational constants from L0-SEM §6 and §9.2. These are conservative L0
 * constants to be measured in isolated Dev, not provider truth, and changing them
 * is tracker policy — never renderer logic and never a display setting.
 */
export interface CapacityPolicy {
  /** Live status-line / rollout snapshots (§6). */
  liveTtlMs: number;
  /** Provider-owned account read (§6). */
  accountReadTtlMs: number;
  /** A timestamp further ahead than this is invalid rather than very fresh (§6). */
  futureSkewMs: number;
  /** Identical renewals refresh the published anchor at most this often (§7). */
  anchorCoalesceMs: number;
}

export const L0_SEM_POLICY: CapacityPolicy = {
  liveTtlMs: 120_000,
  accountReadTtlMs: 300_000,
  futureSkewMs: 30_000,
  anchorCoalesceMs: 30_000
};

const ttlFor = (source: ObservationSource, policy: CapacityPolicy): number =>
  source === 'codex-account-read' ? policy.accountReadTtlMs : policy.liveTtlMs;

/** Main-owned reason codes. Non-causal unless the provider itself attributed the limit. */
export const REASON = {
  PROVIDER_ATTRIBUTED: 'PROVIDER_ATTRIBUTED_LIMITING',
  PROVIDER_REACHED_UNATTRIBUTED: 'PROVIDER_REACHED_UNATTRIBUTED',
  ORDINARY_USE_DENIED: 'ORDINARY_USE_DENIED',
  NUMERICALLY_EXHAUSTED: 'NUMERICALLY_EXHAUSTED',
  RECOVERY_HINT_UNCONFIRMED: 'RECOVERY_HINT_UNCONFIRMED',
  LIMIT_EPOCH_UNCLEARED: 'LIMIT_EPOCH_UNCLEARED',
  STALE: 'STALE_READING',
  NO_READING: 'NO_READING',
  NO_NUMBERS: 'NO_USABLE_NUMBERS',
  CONFLICT: 'SAME_KEY_CONFLICT',
  PROVIDER_ADVISORY: 'PROVIDER_NATIVE_ADVISORY',
  FRESH: 'FRESH_READING'
} as const;

/** A sticky limit epoch (§5). Begins at accepted hard evidence; staleness never clears it. */
interface LimitEpoch {
  since: number;
  /** The observation time of the evidence. A confirmation must be STRICTLY newer. */
  evidenceAt: number;
  attributedWindowId: string | null;
  reachedType: string | null;
  permissionDenied: boolean;
  /** Reset/limit-identity anchors at the moment of the refusal, for re-anchor detection. */
  anchors: string;
  /** Latched once a recovery HINT appears. Hints never confirm; they only de-escalate. */
  hinted: boolean;
}

interface PoolRecord {
  observation: CapacityObservation;
  projection: PoolCapacitySnapshot;
  epoch: LimitEpoch | null;
  /** Same ordering key, different content: facts are invalid until something newer. */
  conflicted: boolean;
  /** K form 2 — a real turn the caller already needed, never a synthetic probe. */
  successfulTurnAt: number | null;
  /** Last time the published observation anchor moved (§7 renewal coalescing). */
  anchorAt: number;
  /** Monotonic instant after which this reading is STALE (§6). */
  staleAt: number;
  /** How old the reading already was when it was accepted, and the monotonic
   *  instant of that acceptance — together these give an age that survives a
   *  wall-clock move as well as the deadline does. */
  ageAtAccept: number;
  acceptedMono: number;
}

/** Hard evidence = typed quota signal or explicit denial. NOT a 429, overload or context error. */
const hasHardEvidence = (obs: CapacityObservation): boolean =>
  obs.ordinaryUsageAllowed === false || obs.providerReachedType !== null;

/** Reset times and limit identity — a change is a re-anchor, which is a recovery HINT (§5). */
const anchorsOf = (obs: CapacityObservation): string =>
  `${obs.limitId}|${obs.windows.map((w) => `${w.windowId}@${w.resetsAt ?? '-'}`).sort().join(',')}`;

/** Semantic fingerprint for duplicate and same-key-conflict detection (§7). */
const fingerprint = (obs: CapacityObservation): string => JSON.stringify([
  obs.windows.map((w) => [w.windowId, w.remainingPercent, w.resetsAt]),
  obs.providerAttributedLimitingWindowId,
  obs.providerReachedType,
  obs.ordinaryUsageAllowed,
  obs.planType
]);

/**
 * SEMANTIC change detection. Deliberately excludes `receivedAt` and `ageMs`, which
 * move on every tick; `observedAt` is included because §7 counts the published
 * observation anchor as a domain field, but renewals that change nothing else are
 * coalesced before they reach here.
 */
const sameProjection = (a: PoolCapacitySnapshot, b: PoolCapacitySnapshot): boolean =>
  a.state === b.state
  && a.stateReason === b.stateReason
  && a.freshness === b.freshness
  && a.observedAt === b.observedAt
  && a.providerAttributedLimitingWindowId === b.providerAttributedLimitingWindowId
  && a.ordinaryUsageAllowed === b.ordinaryUsageAllowed
  && a.planType === b.planType
  && a.recoveryPending === b.recoveryPending
  && a.limitEpochAt === b.limitEpochAt
  && a.numericallyExhaustedWindowIds.join('|') === b.numericallyExhaustedWindowIds.join('|')
  && JSON.stringify(a.windows) === JSON.stringify(b.windows);

export class ProviderCapacityTracker {
  private pools = new Map<string, PoolRecord>();
  /**
   * poolKey → the highest per-pool revision ever published for it, RETAINED ACROSS
   * REMOVAL. A pool that is forgotten and seen again is the same pool - same
   * provider, same account, same limit id - so its revision must keep counting.
   * Without this the re-added pool restarted at 1 and a consumer holding revision 6
   * discarded every update until the new count caught up, which is a silent stall
   * rather than a visible error. Revisions are a monotonic identity, not a
   * population count, and nothing here expires this map: it costs one small integer
   * per pool key ever seen, against a 32-pool cap.
   */
  private revisionFloor = new Map<string, number>();
  private collectionRevision = 0;
  private updatedAt = 0;

  constructor(
    private readonly policy: CapacityPolicy = L0_SEM_POLICY,
    private readonly clock: () => number = () => Date.now(),
    /** Monotonic milliseconds. Never goes backwards, and is unaffected by the
     *  system clock — which is exactly why freshness is decided against it. */
    private readonly monotonic: () => number = () => performance.now()
  ) {}

  /**
   * Accept a reading. Returns true when the pool's published projection changed.
   *
   * ORDERING (§7). A lower ordering key than the last accepted one is out of order
   * and ignored — which is what stops a late-arriving stale snapshot from
   * overwriting a newer typed refusal. An equal key with equal content is a
   * duplicate no-op. An equal key with DIFFERENT content is a schema/order
   * conflict: hard evidence is accepted because risk dominates, and anything else
   * invalidates the pool's facts to UNKNOWN rather than merging two stories.
   */
  ingest(obs: CapacityObservation): boolean {
    const now = this.clock();
    // A timestamp far in the future is invalid, not very fresh (§6).
    if (obs.observedAt > now + this.policy.futureSkewMs) return false;

    const prev = this.pools.get(obs.poolKey);
    let conflicted = false;
    let pinAnchor = false;
    if (prev) {
      if (obs.observedAt < prev.observation.observedAt) return false;
      const identical = fingerprint(obs) === fingerprint(prev.observation);
      if (obs.observedAt === prev.observation.observedAt) {
        // Exact duplicate: same ordering key, same content. A pure no-op (§7).
        if (identical) return false;
        if (!hasHardEvidence(obs)) conflicted = true;
      } else if (identical) {
        // A live RENEWAL: newer reading, identical values. The freshness deadline
        // moves immediately - the reading really is current again - but the
        // PUBLISHED observation anchor is coalesced, so a pool observed every turn
        // does not emit a revision per turn for a value that never changed (§7).
        pinAnchor = now - prev.anchorAt < this.policy.anchorCoalesceMs;
      }
    }

    const rec: PoolRecord = prev ?? {
      observation: obs,
      projection: blankProjection(obs, this.revisionFloor.get(obs.poolKey) ?? 0),
      epoch: null,
      conflicted: false,
      successfulTurnAt: null,
      anchorAt: 0,
      staleAt: 0,
      ageAtAccept: 0,
      acceptedMono: 0
    };
    rec.observation = obs;
    this.stampDeadline(rec, obs, now);
    rec.conflicted = conflicted;
    rec.epoch = this.nextEpoch(rec, obs, now);
    if (!pinAnchor) rec.anchorAt = now;
    this.pools.set(obs.poolKey, rec);
    return this.reproject(obs.poolKey, now, pinAnchor);
  }

  /**
   * Recompute time-derived facts: freshness expires and reset boundaries pass with
   * no new reading at all, and a consumer must see that happen.
   */
  evaluate(now: number = this.clock(), monoNow: number = this.monotonic()): boolean {
    let changed = false;
    for (const key of this.pools.keys()) changed = this.reproject(key, now, false, monoNow) || changed;
    return changed;
  }

  /**
   * K form 2 (§5) — a successful REAL ordinary turn the caller already needed. It
   * confirms recovery from the old refusal and nothing else: with no fresh capacity
   * snapshot the pool lands in UNKNOWN, because proving the refusal ended is not
   * proving there is headroom now. Never call this for a synthetic probe; L0 has no
   * such thing.
   */
  noteSuccessfulTurn(poolKey: string, at: number = this.clock()): boolean {
    const rec = this.pools.get(poolKey);
    if (!rec) return false;
    rec.successfulTurnAt = at;
    return this.reproject(poolKey, this.clock());
  }

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

  /**
   * How long until the SOONEST moment a projection could change with no new
   * reading at all, or null when nothing is pending.
   *
   * WHY THE TRACKER ANSWERS THIS AND NOT THE SCHEDULER. Two things move on their
   * own: a reading expires, and a reset boundary passes. Both instants are derived
   * from state only this class holds - the monotonic staleness deadline and the
   * epoch-scoped reset arithmetic - and a scheduler that recomputed them from the
   * published projection would be a second implementation of the same rules, free
   * to drift from this one. So the tracker names the instant and the scheduler does
   * nothing but wait for it.
   *
   * A DELAY, NOT A TIMESTAMP, DELIBERATELY. The staleness deadline lives on the
   * monotonic clock and the reset boundary on the wall clock; they cannot be
   * compared as instants without picking one basis and corrupting the other. As
   * durations from now they compare honestly.
   */
  nextBoundaryDelayMs(now: number = this.clock(), monoNow: number = this.monotonic()): number | null {
    let soonest: number | null = null;
    const consider = (delay: number): void => {
      if (delay < 0) return;
      soonest = soonest === null ? delay : Math.min(soonest, delay);
    };
    for (const rec of this.pools.values()) {
      // A fresh reading will expire. A stale one has already published that fact.
      // The deadline is the LAST fresh instant - freshness is `monoNow <= staleAt` -
      // so the predicate flips one tick after it. Waking exactly ON the deadline
      // finds the reading still fresh and re-arms for zero, which is a busy loop
      // rather than a boundary.
      if (monoNow <= rec.staleAt) consider(rec.staleAt - monoNow + 1);
      // A refusal whose boundary has not yet been treated as a hint. Once hinted,
      // the pool is already RECOVERING and only new evidence moves it.
      const epoch = rec.epoch;
      if (!epoch || epoch.hinted) continue;
      const at = nextResetBoundary(rec.observation, epoch);
      if (at !== null && at > now) consider(at - now);
    }
    return soonest;
  }

  /**
   * Removal is explicit. Nothing here expires a pool on its own at L0.
   *
   * The record goes; the revision high-water mark stays. See `revisionFloor`.
   */
  forget(poolKey: string): boolean {
    const rec = this.pools.get(poolKey);
    if (!rec) return false;
    this.revisionFloor.set(poolKey, rec.projection.revision);
    this.pools.delete(poolKey);
    this.collectionRevision += 1;
    this.updatedAt = this.clock();
    return true;
  }

  /**
   * The limit epoch (§5). Begins at accepted hard evidence and is sticky; it is
   * cleared only by a STRICTLY NEWER confirmation. A numeric zero never opens one —
   * that is ruling 2, and it is the whole reason attribution and exhaustion are
   * separate facts rather than one flag.
   */
  private nextEpoch(rec: PoolRecord, obs: CapacityObservation, now: number): LimitEpoch | null {
    if (hasHardEvidence(obs)) {
      // Contradictory same-payload permission cannot confirm recovery (§4): the
      // risk-dominant fact wins and the epoch is (re)opened at this evidence.
      return {
        since: rec.epoch?.since ?? now,
        evidenceAt: obs.observedAt,
        attributedWindowId: obs.providerAttributedLimitingWindowId,
        reachedType: obs.providerReachedType,
        permissionDenied: obs.ordinaryUsageAllowed === false,
        anchors: anchorsOf(obs),
        hinted: false
      };
    }
    const epoch = rec.epoch;
    if (!epoch) return null;
    if (obs.observedAt <= epoch.evidenceAt) return epoch; // same-time or older cannot confirm

    // K1 — explicit provider permission.
    if (obs.ordinaryUsageAllowed === true) return null;
    // K3 — a fresh authoritative snapshot after the event, no reached fact, every
    // known-applicable window valid and above zero.
    if (this.isFresh(obs, now) && obs.windows.length > 0 && allWindowsPositive(obs)) return null;
    // Otherwise: not confirmation. A re-anchored reset or limit identity is a HINT.
    if (anchorsOf(obs) !== epoch.anchors) return { ...epoch, hinted: true };
    return epoch;
  }

  /**
   * Convert the REMAINING wall TTL into a monotonic deadline at the moment of
   * acceptance (§6). After this, staleness is a monotonic comparison and the system
   * clock cannot move it. A reading that was ALREADY past its TTL when it arrived
   * gets a deadline in the past and is stale immediately, which is correct.
   */
  private stampDeadline(rec: PoolRecord, obs: CapacityObservation, now: number): void {
    const mono = this.monotonic();
    const age = Math.max(0, now - obs.observedAt);
    rec.ageAtAccept = age;
    rec.acceptedMono = mono;
    rec.staleAt = mono + (ttlFor(obs.source, this.policy) - age);
  }

  private isFresh(obs: CapacityObservation, now: number): boolean {
    return Math.max(0, now - obs.observedAt) <= ttlFor(obs.source, this.policy);
  }

  /**
   * `pinAnchor` holds the PUBLISHED observation time at its last value while the
   * internal reading moves on. It is the coalescing half of §7, and it is why an
   * identical renewal can refresh freshness without publishing anything.
   */
  private reproject(poolKey: string, now: number, pinAnchor = false, monoNow: number = this.monotonic()): boolean {
    const rec = this.pools.get(poolKey);
    if (!rec) return false;
    const next = this.project(rec, now, monoNow);
    if (pinAnchor && rec.projection.observedAt > 0) {
      next.observedAt = rec.projection.observedAt;
      next.ageMs = Math.max(0, now - rec.projection.observedAt);
    }
    if (sameProjection(rec.projection, next)) {
      // Nothing semantic moved; keep the revision and store the refreshed clock
      // fields so a pool being actively observed cannot expire on an old timestamp.
      next.revision = rec.projection.revision;
      rec.projection = publish(next);
      return false;
    }
    next.revision = rec.projection.revision + 1;
    rec.projection = publish(next);
    this.collectionRevision += 1;
    this.updatedAt = now;
    return true;
  }

  private project(rec: PoolRecord, now: number, monoNow: number): PoolCapacitySnapshot {
    const obs = rec.observation;
    // Age is measured the same way the deadline is: how old the reading was when it
    // was accepted, plus monotonic time since. A wall-clock move cannot shrink it.
    const ageMs = Math.max(0, rec.ageAtAccept + (monoNow - rec.acceptedMono));
    const freshness: CapacityFreshness = monoNow <= rec.staleAt ? 'FRESH' : 'STALE';
    const exhausted = numericallyExhausted(obs);

    // K form 2 and the reset-passage HINT are both time-relative, so they are
    // resolved here rather than at ingest: a reset can pass with no reading at all.
    let epoch = rec.epoch;
    if (epoch && rec.successfulTurnAt !== null && rec.successfulTurnAt > epoch.evidenceAt) {
      epoch = null;
      rec.epoch = null;
    }
    if (epoch && !epoch.hinted && resetPassed(obs, epoch, now)) {
      epoch = { ...epoch, hinted: true };
      rec.epoch = epoch;
    }

    const { state, stateReason } = this.deriveState(rec, obs, { freshness, exhausted, epoch });
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
      recoveryPending: epoch?.hinted === true,
      limitEpochAt: epoch?.since ?? null
    };
  }

  /**
   * The state predicates of L0-SEM §2, in risk order.
   *
   * The epoch is settled first because it outranks every numeric fact: a sticky
   * refusal is not a reading and staleness cannot clear it. Then freshness, then
   * completeness, then exhaustion. AVAILABLE is last and is the only state that
   * requires everything to be present, fresh and positive.
   *
   * APPROACHING has no branch that any current payload can reach. It requires an
   * allowlisted provider-native advisory, and neither adapter emits one — which is
   * a fact about the payloads, not a gap here. Synthesizing it from a percentage is
   * exactly what ruling 3 forbids, so the state stays unreachable until an
   * allowlisted provider fact exists with a fixture behind it.
   */
  private deriveState(
    rec: PoolRecord,
    obs: CapacityObservation,
    ctx: { freshness: CapacityFreshness; exhausted: string[]; epoch: LimitEpoch | null }
  ): { state: CapacityState; stateReason: string } {
    if (ctx.epoch) {
      if (ctx.epoch.hinted) return { state: 'RECOVERING', stateReason: REASON.RECOVERY_HINT_UNCONFIRMED };
      if (ctx.epoch.permissionDenied) return { state: 'LIMITED', stateReason: REASON.ORDINARY_USE_DENIED };
      if (ctx.epoch.attributedWindowId) return { state: 'LIMITED', stateReason: REASON.PROVIDER_ATTRIBUTED };
      if (ctx.epoch.reachedType) return { state: 'LIMITED', stateReason: REASON.PROVIDER_REACHED_UNATTRIBUTED };
      return { state: 'LIMITED', stateReason: REASON.LIMIT_EPOCH_UNCLEARED };
    }
    // A same-key contradiction leaves facts unusable rather than merged (§7).
    if (rec.conflicted) return { state: 'UNKNOWN', stateReason: REASON.CONFLICT };
    if (ctx.freshness === 'STALE') return { state: 'UNKNOWN', stateReason: REASON.STALE };
    if (!obs.windows.length || obs.windows.some((w) => w.remainingPercent === null)) {
      // Incomplete is UNKNOWN, never "healthy on the windows we happen to have".
      return { state: 'UNKNOWN', stateReason: REASON.NO_NUMBERS };
    }
    if (ctx.exhausted.length) return { state: 'RESERVE_ONLY', stateReason: REASON.NUMERICALLY_EXHAUSTED };
    return { state: 'AVAILABLE', stateReason: REASON.FRESH };
  }
}

/**
 * Seal a projection before it becomes the pool's published state.
 *
 * WHY SEALING RATHER THAN COPYING. `snapshot()` and `pool()` hand out the tracker's
 * OWN objects, so a consumer that wrote to one was editing authoritative state
 * directly - changing a state or a percentage with no revision, no evidence and no
 * way for anything downstream to notice. Copying on every read would cost an
 * allocation per pool per read and still leave the first reader's copy writable;
 * freezing costs one pass at publication and makes the mutation itself fail. The
 * windows array and its members are frozen too: freezing only the outer object
 * leaves `snapshot.pools[0].windows[0].remainingPercent = 100` working, which is
 * precisely the edit that would matter.
 */
function publish(p: PoolCapacitySnapshot): PoolCapacitySnapshot {
  for (const w of p.windows) Object.freeze(w);
  Object.freeze(p.windows);
  Object.freeze(p.numericallyExhaustedWindowIds);
  return Object.freeze(p);
}

/** Fresh exact zero. An OBSERVATION; it never implies the provider said anything. */
function numericallyExhausted(obs: CapacityObservation): string[] {
  return obs.windows.filter((w) => w.remainingPercent === 0).map((w) => w.windowId);
}

function allWindowsPositive(obs: CapacityObservation): boolean {
  return obs.windows.every((w) => w.remainingPercent !== null && w.remainingPercent > 0);
}

/** Has the reset boundary relevant to the refusal passed? A passed boundary is a
 *  HINT and never a confirmation (ruling 4). */
function resetPassed(obs: CapacityObservation, epoch: LimitEpoch, now: number): boolean {
  const at = nextResetBoundary(obs, epoch);
  return at !== null && at <= now;
}

/**
 * The earliest reset boundary that could become a recovery hint for this epoch, or
 * null if there is none. Attributed window first, then exhausted windows, then the
 * earliest known reset - the narrowest evidence available.
 *
 * A boundary that had ALREADY passed when the refusal was recorded is excluded: the
 * provider refused knowing it, so it is not news about that refusal (L0-SEM 11.1).
 * That exclusion is also what makes a fresh refusal during RECOVERING land back on
 * LIMITED rather than bouncing straight off the old, already-expired reset time.
 */
function nextResetBoundary(obs: CapacityObservation, epoch: LimitEpoch): number | null {
  const scoped = epoch.attributedWindowId
    ? obs.windows.filter((w) => w.windowId === epoch.attributedWindowId)
    : obs.windows.filter((w) => w.remainingPercent === 0);
  const pool = scoped.length ? scoped : obs.windows;
  let earliest: number | null = null;
  for (const w of pool) {
    if (w.resetsAt === null || w.resetsAt <= epoch.evidenceAt) continue;
    earliest = earliest === null ? w.resetsAt : Math.min(earliest, w.resetsAt);
  }
  return earliest;
}

/**
 * Placeholder; the first reproject replaces it and moves to `floor + 1`. The floor
 * is 0 for a pool never seen before and the pool's last published revision for one
 * that was removed and has come back.
 */
function blankProjection(obs: CapacityObservation, floor = 0): PoolCapacitySnapshot {
  return {
    poolKey: obs.poolKey,
    provider: obs.provider,
    accountScope: obs.accountScope,
    limitId: obs.limitId,
    revision: floor,
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
    recoveryPending: false,
    limitEpochAt: null
  };
}
