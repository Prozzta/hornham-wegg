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
  CapacityWindow,
  ObservationSource,
  PoolCapacitySnapshot
} from '../shared/providerCapacity';
import { applicabilityOf } from '../shared/providerCapacity';

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

/**
 * Retention caps (L0-SEM 162). Exceeding one is not a licence to drop data quietly:
 * 172 requires the affected pool to become UNKNOWN with ONE deduplicated diagnostic,
 * and forbids silently discarding an applicable window while still looking healthy.
 * That is the whole point — truncating to the cap and carrying on would turn a
 * budget breach into a confident answer computed from part of the evidence.
 *
 * The 1 MiB tracker-heap figure from the same line is an isolated-Dev ACCEPTANCE
 * TARGET rather than a runtime cap, per Oscar section 12, so it is measured out of
 * process and not enforced here.
 *
 * THE COLLECTION CAP IS MEASURED ON THE SERIALIZED COLLECTION, WHICH IS THE THING
 * 162 NAMES. Summing retained observations instead made the cap unreachable: 32
 * pools x 8,192 bytes is 262,144 exactly, so a collection of legal pools could never
 * exceed 262,144 and the cap could not fire on any legal input. A published
 * projection is strictly larger than the observation behind it - labels, reason
 * codes, freshness, revision, ages - so measuring what is actually published both
 * matches the words and lets the cap bind.
 */
export const RETENTION_CAPS = {
  maxPools: 32,
  maxWindowsPerPool: 16,
  maxPoolBytes: 8 * 1024,
  maxCollectionBytes: 256 * 1024
} as const;

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
  UNKNOWN_APPLICABILITY: 'UNKNOWN_APPLICABILITY',
  CAP_EXCEEDED: 'RETENTION_CAP_EXCEEDED',
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
  /**
   * Applicable window remainders as they stood at the refusal. A later snapshot that
   * reports MORE than this on some window is the "newer incomplete/non-authoritative
   * snapshot suggests improvement" hint of L0-SEM 95 — which needs a baseline to be
   * an improvement over, and the refusal is that baseline.
   */
  remaindersAtRefusal: Record<string, number>;
  /** Latched once a recovery HINT appears. Hints never confirm; they only de-escalate. */
  hinted: boolean;
}

interface PoolRecord {
  observation: CapacityObservation;
  /** Which retention cap this pool breached, or null. Sticky until a reading fits. */
  capBreach: string | null;
  /** Serialized size of the published projection, for the collection cap. */
  projectionBytes: number;
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

/** What one ingestion did. See `ingestDetailed`. */
export interface IngestResult {
  /** The reading was VALID and is now this pool's current evidence, or was a valid
   *  duplicate of it. False means rejected: future-dated, or out of order. */
  accepted: boolean;
  /** The published projection moved. Always false when `accepted` is false. */
  changed: boolean;
  reason: 'ACCEPTED' | 'DUPLICATE' | 'FUTURE_SKEW' | 'OUT_OF_ORDER' | 'CAP_POOLS';
}

/**
 * Order two readings of one pool by L0-SEM 127's key, `(observedAt, sourceSequence)`.
 * Negative = `a` is older than `b`, 0 = same position, positive = newer.
 *
 * THE SEQUENCE IS ONLY A TIE-BREAK, AND ONLY WITHIN ONE STREAM. Codex restarts
 * `ordinal` at zero in every new rollout file, so comparing ordinals across files
 * would make a brand-new reading look ancient; two readings from different streams
 * are therefore ordered by time alone, which is the only thing they share. Where
 * times are equal and the stream and both sequences agree to be comparable, the
 * sequence decides — and that is the whole point, because Codex stamps whole-second
 * timestamps and two events inside one second are otherwise indistinguishable.
 */
function compareOrderingKey(a: CapacityObservation, b: CapacityObservation): number {
  if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
  const comparable = a.streamId !== null
    && a.streamId === b.streamId
    && a.sourceSequence !== null
    && b.sourceSequence !== null;
  if (!comparable) return 0;
  if (a.sourceSequence! === b.sourceSequence!) return 0;
  return a.sourceSequence! < b.sourceSequence! ? -1 : 1;
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
  // Provenance is a DOMAIN field (L0-SEM 135), not bookkeeping: identical numbers
  // from a live status line and from a replayed rollout are different facts, and a
  // consumer that never sees the change cannot tell one from the other.
  && a.source === b.source
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
   * The highest per-pool revision ever published by ANY pool. A pool that is
   * forgotten and seen again resumes strictly above it.
   *
   * WHY ONE INTEGER AND NOT A MAP PER POOL. The first version kept a high-water mark
   * keyed by pool, which is the obvious shape and grows without bound: pool identity
   * includes an account scope and a limit id, so a machine that authenticates several
   * accounts over its lifetime accumulates an entry per historical identity forever.
   * That preserved A10's monotonicity by violating A16's bounded-state contract -
   * capping current pools at 32 while remembering every pool that ever existed.
   *
   * A SINGLE GLOBAL FLOOR SATISFIES BOTH, because the property required is monotonic
   * per stable poolId, NOT dense per poolId. Resuming above the global maximum is
   * strictly greater than anything that pool ever published, so no consumer can see a
   * revision go backward; the number simply jumps, and L0-SEM 11.2 already says
   * revision distance is not a count and a skip is not a gap. One integer, bounded
   * by construction, and no eviction policy to get wrong.
   */
  private revisionFloor = 0;
  /** How many pools were refused for the cardinality cap. One diagnostic, not one
   *  per refusal — 172 requires the diagnosis to be deduplicated. */
  private poolsRefused = 0;
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
    return this.ingestDetailed(obs).changed;
  }

  /**
   * The same ingestion, reporting WHETHER THE READING WAS ACCEPTED as well as
   * whether the published projection moved. Those are different questions and a
   * caller that conflates them gets one of them wrong: a duplicate and a renewal
   * are both ACCEPTED and change nothing, while a future-dated or out-of-order
   * reading changes nothing because it was REJECTED. Anything deriving state from
   * "a reading arrived from this agent" — learned pool membership, for one — must
   * key on acceptance, and `ingest()`'s boolean cannot express it.
   *
   * Additive on purpose: `ingest()` keeps its exact contract, so no existing caller
   * or fixture has to change to accommodate a question it never asked.
   */
  ingestDetailed(obs: CapacityObservation): IngestResult {
    const now = this.clock();
    // A timestamp far in the future is invalid, not very fresh (§6).
    if (obs.observedAt > now + this.policy.futureSkewMs) {
      return { accepted: false, changed: false, reason: 'FUTURE_SKEW' };
    }

    const prev = this.pools.get(obs.poolKey);
    // The pool cardinality cap. A 33rd pool is NOT created: there is no earlier
    // reading for it, so refusing costs nothing that was previously known, and the
    // seam answers UNKNOWN for an agent with no pool - which is the conservative
    // answer rather than a silent healthy one. This is the one cap whose bounded
    // replacement is a counter rather than a sentinel, because a sentinel would
    // itself be the 33rd record.
    if (!prev && this.pools.size >= RETENTION_CAPS.maxPools) {
      this.poolsRefused += 1;
      if (this.poolsRefused === 1) {
        console.warn(`[capacity] pool cap ${RETENTION_CAPS.maxPools} reached; further pools are not tracked`);
      }
      return { accepted: false, changed: false, reason: 'CAP_POOLS' };
    }
    // The breach is decided on the RAW reading - it is the raw reading that is too
    // big - but everything downstream compares and stores the bounded stand-in. Two
    // identical oversized readings must look identical to the duplicate rules, or
    // the "one deduplicated diagnostic" of 172 becomes one per observation.
    const breach = this.capBreachFor(obs, prev !== undefined);
    const reading = breach ? ProviderCapacityTracker.sentinel(obs) : obs;

    let conflicted = false;
    let pinAnchor = false;
    if (prev) {
      const order = compareOrderingKey(reading, prev.observation);
      if (order < 0) return { accepted: false, changed: false, reason: 'OUT_OF_ORDER' };
      const identical = fingerprint(reading) === fingerprint(prev.observation);
      if (order === 0) {
        // Exact duplicate: same ordering key, same content. A pure no-op (§7) —
        // but an ACCEPTED one: the reading is valid, it simply says nothing new.
        if (identical) return { accepted: true, changed: false, reason: 'DUPLICATE' };
        if (!hasHardEvidence(reading)) conflicted = true;
      } else if (identical) {
        // A live RENEWAL: newer reading, identical values. The freshness deadline
        // moves immediately - the reading really is current again - but the
        // PUBLISHED observation anchor is coalesced, so a pool observed every turn
        // does not emit a revision per turn for a value that never changed (§7).
        pinAnchor = now - prev.anchorAt < this.policy.anchorCoalesceMs;
      }
    }

    const rec: PoolRecord = prev ?? {
      observation: reading,
      capBreach: null,
      projectionBytes: 0,
      projection: blankProjection(reading, this.revisionFloor),
      epoch: null,
      conflicted: false,
      successfulTurnAt: null,
      anchorAt: 0,
      staleAt: 0,
      ageAtAccept: 0,
      acceptedMono: 0
    };
    rec.observation = reading;
    rec.capBreach = breach;
    this.stampDeadline(rec, reading, now);
    rec.conflicted = conflicted;
    rec.epoch = this.nextEpoch(rec, reading, now);
    if (!pinAnchor) rec.anchorAt = now;
    this.pools.set(obs.poolKey, rec);
    return { accepted: true, changed: this.reproject(obs.poolKey, now, pinAnchor), reason: 'ACCEPTED' };
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
      refusedPools: this.poolsRefused,
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
    this.revisionFloor = Math.max(this.revisionFloor, rec.projection.revision);
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
        remaindersAtRefusal: remaindersOf(obs),
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
    // Otherwise: not confirmation, but possibly a HINT. The three hint forms that
    // can be seen at ingestion (L0-SEM 95): a re-anchored reset or limit identity,
    // and a newer snapshot that suggests improvement without being authoritative
    // enough to confirm. The fourth, the reset boundary passing, is time-relative
    // and is resolved in project() instead.
    if (anchorsOf(obs) !== epoch.anchors) return { ...epoch, hinted: true };
    if (suggestsImprovement(obs, epoch)) return { ...epoch, hinted: true };
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

  /**
   * Which retention cap this reading breaches, or null. Checked at ACCEPTANCE rather
   * than at publication, so the breach is a property of the reading that caused it.
   *
   * A breach makes the pool UNKNOWN (172). It deliberately does NOT reject the
   * reading: rejecting would leave the previous, smaller reading in place and being
   * reported as current, which is the silent-discard outcome 172 forbids by another
   * route.
   */
  private capBreachFor(obs: CapacityObservation, poolExists: boolean): string | null {
    if (obs.windows.length > RETENTION_CAPS.maxWindowsPerPool) return 'WINDOWS_PER_POOL';
    if (byteLength(obs) > RETENTION_CAPS.maxPoolBytes) return 'POOL_BYTES';
    // What is ALREADY published, plus room for this pool's own projection. The
    // arriving pool is the one that reports the breach, because it is the one whose
    // arrival caused it.
    let others = 0;
    for (const [key, rec] of this.pools) if (key !== obs.poolKey) others += rec.projectionBytes;
    if (others >= RETENTION_CAPS.maxCollectionBytes) return 'COLLECTION_BYTES';
    void poolExists;
    return null;
  }

  /**
   * A bounded stand-in for a reading that cannot be retained (L0-SEM 172).
   *
   * ACCEPT MUST NOT MEAN RETAIN THE UNBOUNDED OBJECT, and my first version did
   * exactly that: it classified the pool UNKNOWN and then stored all seventeen
   * windows anyway, so the caps announced a bound they did not impose. The pool keeps
   * its IDENTITY and its ordering position — both are small, and discarding them
   * would make the next reading look like a first sighting — and loses every
   * unbounded field. What is retained is constant-size regardless of what arrived.
   */
  private static sentinel(obs: CapacityObservation): CapacityObservation {
    return {
      poolKey: obs.poolKey,
      provider: obs.provider,
      accountScope: obs.accountScope,
      limitId: obs.limitId,
      source: obs.source,
      streamId: obs.streamId,
      sourceSequence: obs.sourceSequence,
      observedAt: obs.observedAt,
      receivedAt: obs.receivedAt,
      windows: [],
      providerAttributedLimitingWindowId: null,
      providerReachedType: null,
      ordinaryUsageAllowed: null,
      planType: null
    };
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
      rec.projectionBytes = byteLength(next);
      return false;
    }
    next.revision = rec.projection.revision + 1;
    this.revisionFloor = Math.max(this.revisionFloor, next.revision);
    rec.projection = publish(next);
    rec.projectionBytes = byteLength(next);
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
      source: obs.source,
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
    // A breached retention cap is UNKNOWN, never a confident answer computed from
    // part of the evidence (L0-SEM 172).
    if (rec.capBreach) return { state: 'UNKNOWN', stateReason: REASON.CAP_EXCEEDED };
    if (ctx.freshness === 'STALE') return { state: 'UNKNOWN', stateReason: REASON.STALE };
    // Applicability is decided BEFORE the numbers, because a window we cannot
    // identify is not a window we can leave out of the arithmetic. Known-inapplicable
    // windows are excluded and are not a gap; unknown applicability is UNKNOWN
    // (L0-SEM 121), and its own reason code, because 89 keeps the reveal reasons
    // exhaustive and separate rather than folding this into "no usable numbers".
    if (obs.windows.some((w) => applicabilityOf(w) === 'UNKNOWN')) {
      return { state: 'UNKNOWN', stateReason: REASON.UNKNOWN_APPLICABILITY };
    }
    const applicable = applicableWindows(obs);
    if (!applicable.length || applicable.some((w) => w.remainingPercent === null)) {
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

/** Serialized size of one retained reading, which is what the byte caps bound. */
const byteLength = (value: unknown): number => JSON.stringify(value).length;

/** Applicable, known remainders, keyed by window. The baseline a later snapshot is
 *  compared against for improvement. */
function remaindersOf(obs: CapacityObservation): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of applicableWindows(obs)) if (w.remainingPercent !== null) out[w.windowId] = w.remainingPercent;
  return out;
}

/**
 * Does this newer, non-confirming snapshot suggest the refusal is easing?
 *
 * L0-SEM 95 makes "a newer incomplete/non-authoritative snapshot suggests
 * improvement" a recovery hint Q. It is reached only after K1 and K3 have already
 * declined, so by construction this snapshot is NOT authoritative — which is exactly
 * why it can only de-escalate to RECOVERING and can never reach AVAILABLE (ruling 4).
 *
 * IMPROVEMENT IS A STRICT INCREASE ON A WINDOW THAT WAS ALREADY KNOWN. A window
 * absent from the refusal is not an improvement: there is nothing it improved on, and
 * treating an unmeasured window as progress is how a missing reading becomes good
 * news. A snapshot carrying hard evidence never reaches here.
 */
function suggestsImprovement(obs: CapacityObservation, epoch: LimitEpoch): boolean {
  for (const w of applicableWindows(obs)) {
    const before = epoch.remaindersAtRefusal[w.windowId];
    if (before === undefined || w.remainingPercent === null) continue;
    if (w.remainingPercent > before) return true;
  }
  return false;
}

/** Windows that actually constrain this pool. Known-inapplicable ones are excluded
 *  and are not treated as missing data (L0-SEM 121). */
const applicableWindows = (obs: CapacityObservation): CapacityWindow[] =>
  obs.windows.filter((w) => applicabilityOf(w) === 'APPLICABLE');

/** Fresh exact zero on an APPLICABLE window. An OBSERVATION; it never implies the
 *  provider said anything. */
function numericallyExhausted(obs: CapacityObservation): string[] {
  return applicableWindows(obs).filter((w) => w.remainingPercent === 0).map((w) => w.windowId);
}

/** K3's "every known-applicable window valid and above zero". A window of unknown
 *  applicability disqualifies the snapshot rather than being skipped: it cannot be
 *  an AUTHORITATIVE all-clear while something in it is unidentified. */
function allWindowsPositive(obs: CapacityObservation): boolean {
  if (obs.windows.some((w) => applicabilityOf(w) === 'UNKNOWN')) return false;
  const applicable = applicableWindows(obs);
  return applicable.length > 0
    && applicable.every((w) => w.remainingPercent !== null && w.remainingPercent > 0);
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
 * is 0 before anything has been published and the collection's revision high-water
 * mark afterwards, so a removed and re-added pool resumes strictly above whatever it
 * last published.
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
    source: obs.source,
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
