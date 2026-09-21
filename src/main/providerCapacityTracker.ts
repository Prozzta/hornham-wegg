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
import { CAPACITY_STATES, OBSERVATION_SOURCES } from '../shared/providerCapacity';
import type {
  CapacityCollectionSnapshot,
  CapacityFreshness,
  CapacityObservation,
  CapacityState,
  CapacityWindow,
  CapBreachKind,
  CollectionOverflowMarker,
  ObservationSource,
  PoolCapacitySnapshot
} from '../shared/providerCapacity';
import { applicabilityOf } from '../shared/providerCapacity';
import {
  admissionEnvelopeOf, ENVELOPE_TYPED_REACHED, boundedIdentity, boundedPoolKey, boundedStreamId,
  type AdmissionEnvelope
} from './capacityEnvelope';

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
  /**
   * Evidence that survived a process restart and has not yet been confirmed by a
   * live provider reading. It is the pool's EXISTENCE and its last-known detail,
   * never its last-known verdict.
   *
   * WIDTH IS LOAD-BEARING HERE. `TIMER_GROWTH_RESERVE_PER_POOL` is derived from
   * `widthSpread(REASON)`, so a member outside the existing [10, 29] character
   * range would move the reserve, move the collection ceiling, and silently
   * invalidate every budget figure this floor has measured. 20 characters sits
   * inside both ends; a test pins the spread rather than trusting this comment.
   */
  RESTORED: 'RESTORED_UNCONFIRMED',
  FRESH: 'FRESH_READING'
} as const;

/**
 * Bytes held back from the collection budget so that TIMER-ONLY growth can never
 * put a published collection over the section 8 ceiling.
 *
 * WHY A RESERVE AND NOT A TIMER CHECK. The cap applies to EVERY publication
 * (L0-SEM 15), including re-projection on a timer - but a timer must not sentinel a
 * pool that was already admitted, because that destroys a reading with no arrival
 * causing it. Those two hold together only if the room a timer could ever need was
 * already subtracted when the pool was admitted. So arrival is still the only place
 * anything is refused, and the refusal now accounts for what time can add afterwards.
 *
 * WHY THIS IS A PROOF AND NOT A MEASUREMENT. The observed headroom on one fixture is
 * not a bound on growth - that was the residual Oscar rejected, and it is my own
 * "approximately right about a cap" one field over. With the observation fixed, a
 * re-projection can only move fields DERIVED from it, and each one is drawn from a
 * closed set or is a number: `state` and `stateReason` from the enumerations below,
 * `ageMs`/`revision`/`limitEpochAt` as JSON numbers, `freshness` between two equal
 * length words, `recoveryPending` from `false` to the SHORTER `true`. Every other
 * field is copied from the observation and cannot move without a new reading. So the
 * per-pool maximum is the sum of the widths below, and the collection maximum is
 * that times the pool ceiling - arithmetic over constants, not a sample.
 */
/**
 * The widest any finite JSON number can serialize to.
 *
 * THIS WAS 16, JUSTIFIED BY `Number.MAX_SAFE_INTEGER`, AND THE JUSTIFICATION WAS
 * FALSE: the name claims the domain of every JSON number while the derivation
 * covered only safe integers. The runtime publishes finite doubles, not safe
 * integers - `JSON.stringify(Number.MAX_VALUE)` is 23 characters and the negative is
 * 24 - and an injected monotonic clock published a 23-character `ageMs` through the
 * public `evaluate()`. The reserve may have held anyway on accidental slack, but
 * ACCIDENTAL SLACK IS NOT THE PROOF, and a constant whose stated justification is
 * false is not defensible even where it happens to hold.
 *
 * 24 is the measured maximum over the extremes of the finite double domain, pinned
 * by a test that searches them rather than asserting the constant.
 */
const MAX_JSON_NUMBER_CHARS = 24;

/** Widest minus narrowest member of a closed set of strings. */
const widthSpread = (values: readonly string[]): number => {
  const lengths = values.map((v) => v.length);
  return Math.max(...lengths) - Math.min(...lengths);
};

export const TIMER_GROWTH_RESERVE_PER_POOL =
  widthSpread(CAPACITY_STATES)
  + widthSpread(Object.values(REASON))
  // `ageMs` climbs from one digit; `revision` climbs; `limitEpochAt` can go from
  // `null` to a timestamp. Each is charged its full width rather than its realistic
  // one, because a reserve that is too generous costs capacity and a reserve that is
  // too tight costs the guarantee.
  + MAX_JSON_NUMBER_CHARS * 3;

/** The same allowance for the two collection-level fields that move on their own. */
export const TIMER_GROWTH_RESERVE_COLLECTION = MAX_JSON_NUMBER_CHARS * 2;

/** A sticky limit epoch (§5). Begins at accepted hard evidence; staleness never clears it. */
/**
 * A sticky limit epoch (L0-SEM 5).
 *
 * IT DOES NOT CROSS A RESTART, AND AN EARLIER VERSION OF THIS FILE SAID IT DID.
 * Ruling 4 requires the last known epoch IDENTITY to survive, and that identity is
 * `since` - a number. Persisting the whole struct handed unverified `anchors`,
 * `remaindersAtRefusal`, `hinted`, `reachedType` and `permissionDenied` to
 * `nextEpoch` as soon as the restored gate lifted. See `PoolRecord.continuitySince`.
 */
interface CapacityLimitEpoch {
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

/** The internal spelling, unchanged, so exporting the type moved no call site. */
type LimitEpoch = CapacityLimitEpoch;

interface PoolRecord {
  observation: CapacityObservation;
  /** Which retention cap this pool breached, or null. Sticky until a reading fits. */
  capBreach: CapBreachKind | null;
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
  /**
   * This pool's current evidence came from the durable store and no live provider
   * reading has arrived since. It is cleared by the first accepted LIVE ingestion
   * and by nothing else - not by time, not by a clock move, not by a re-read of the
   * same historical line.
   */
  restoredUnconfirmed: boolean;
  /**
   * The `since` of a limit epoch that was open when a previous process exited.
   *
   * A NUMBER, AND DELIBERATELY ONLY A NUMBER. The first version of this crossed the
   * whole derived epoch and said it was carried "as identity, forbidden from
   * classifying" - but that was a property of the GATE, not of the payload, and the
   * gate is temporary: the first accepted live reading clears `restoredUnconfirmed`
   * and `nextEpoch` then consumes the restored `anchors`, `remaindersAtRefusal`,
   * `hinted`, `reachedType` and `permissionDenied` as though this process had
   * observed them. A structurally-accepted epoch could publish RECOVERING off a
   * later incomplete reading that carried no limiting fact at all.
   *
   * So nothing classifying crosses. `rec.epoch` is null after a restore, and this
   * number does exactly two things: it keeps `limitEpochAt` continuous for a
   * consumer, and it becomes the `since` of the next REAL epoch built from live
   * hard evidence - so a refusal that never ended keeps its identity without any
   * unverified fact being able to decide a state. A principle is not a payload.
   */
  continuitySince: number | null;
}

/** What one ingestion did. See `ingestDetailed`. */
export interface IngestResult {
  /** The reading was VALID and is now this pool's current evidence, or was a valid
   *  duplicate of it. False means rejected: future-dated, or out of order. */
  accepted: boolean;
  /** The published projection moved. Always false when `accepted` is false. */
  changed: boolean;
  reason: 'ACCEPTED' | 'DUPLICATE' | 'FUTURE_SKEW' | 'OUT_OF_ORDER' | 'CAP_POOLS' | 'UNBOUNDED_IDENTITY';
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

/**
 * Does this reading AFFIRMATIVELY say a limitation is over?
 *
 * The same two K forms `nextEpoch` uses to close an epoch it is holding - explicit
 * provider permission, and a fresh authoritative snapshot with every known window
 * above zero. Factored out because a restored pool has no epoch object for
 * `nextEpoch` to close, so the question has to be asked directly of the reading.
 *
 * Deliberately NOT "anything that is not a refusal". An incomplete or stale reading
 * says nothing about whether a limitation ended, and treating silence as clearance
 * is how a carried identity would quietly disappear on the first empty payload.
 */
const clearsLimitation = (obs: CapacityObservation, fresh: boolean): boolean => {
  if (hasHardEvidence(obs)) return false;
  if (obs.ordinaryUsageAllowed === true) return true;
  return fresh && obs.windows.length > 0 && allWindowsPositive(obs);
};

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
  && a.capBreach === b.capBreach
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
  /** Latched once the pool-count cap is breached (L0-SEM 13). Not a pool, not a
   *  count, and cleared only by proof — never by arrivals merely stopping. */
  private overflow: CollectionOverflowMarker | null = null;
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
  /**
   * Re-admit one observation that outlived the process that collected it.
   *
   * WHY THIS IS A SEPARATE ENTRY POINT RATHER THAN A FLAG ON THE OBSERVATION.
   * "Restored" is a property of the INGESTION EVENT, not of the reading: the bytes
   * that were persisted are the same bytes that were collected, and the provider
   * said nothing different. Putting a marker on the payload would also have spent
   * the 8 KiB per-pool INPUT budget on a field that appears nowhere in the output -
   * the input-only-fields hazard this floor has now met four times - so a maximal
   * observation that fitted when it was collected could fail to fit when restored,
   * and be replaced by its bounded stand-in for no reason a provider caused.
   *
   * Everything else is the normal boundary, deliberately: identity bounding, future
   * skew, the pool cap, the retention caps, ordering and the collection budget all
   * apply exactly as they do to a live reading (L0-TAIL ruling 6).
   */
  restore(observation: CapacityObservation, continuitySince: number | null = null): IngestResult {
    return this.ingestDetailed(observation, { continuitySince });
  }

  ingestDetailed(obs: CapacityObservation, restore?: { continuitySince: number | null }): IngestResult {
    const now = this.clock();
    // IDENTITY IS RETAINED STATE AND MUST BE BOUNDED BEFORE ANYTHING IS RETAINED.
    //
    // The bounded stand-in bounds the PAYLOAD and copied identity through raw, so a
    // 300,000-character limitId was published inside the very object whose job is to
    // bound what a breach retains - the same defect as the first sentinel, which
    // classified the pool UNKNOWN and then stored all seventeen windows anyway, one
    // field-class over. The pool key is checked too, not just its parts: it is the
    // Map key this record is retained under, and bounding only the parts would leave
    // the key free to be anything the provider sent.
    //
    // REFUSED RATHER THAN TRUNCATED, and that is forced rather than chosen. A
    // shortened identity is a DIFFERENT identity - the rule that keeps the envelope
    // from relabelling - so truncating a poolKey could silently merge two real pools
    // into one. Nothing can be retained for a reading whose identity cannot be
    // believed, so nothing is: no record is created, no previous reading is
    // disturbed, and an agent with no resolvable pool already gets the seam's
    // UNKNOWN, which declines to infer safety.
    if (!ProviderCapacityTracker.identityIsBounded(obs)) {
      return { accepted: false, changed: false, reason: 'UNBOUNDED_IDENTITY' };
    }
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
      // Retain NOTHING about the excess pool - not the entity, not its identity, not
      // its payload (L0-SEM 13). The breach is recorded as one fixed marker, and a
      // later excess arrival is a semantic no-op rather than a second anything:
      // telling a 34th NEW pool from a repeat of the 33rd would require keeping the
      // identities this cap exists to refuse.
      // The envelope is validated even here, where no pool entity may be kept: the
      // fact that SOMETHING omitted is refusing has to survive, or a turn we cannot
      // map to a known pool proceeds against a provider that just said no.
      const envelope = admissionEnvelopeOf(obs);
      const limited = envelope !== null;
      const known = this.overflow;
      if (!known || (limited && !known.hardLimitObserved)) {
        // FROZEN AT PUBLICATION, for the same reason every pool projection is, and
        // more urgently. `snapshot()` hands out this exact object and
        // `collectionAdmission()` reads the same one, so an unfrozen marker let a
        // consumer delete `admission` and neutralize the section 14 safety fact -
        // with no tracker operation, no evidence, and no revision to notice it by.
        // Freezing at PUBLICATION rather than copying at each accessor is what
        // closes BOTH readers at once; a copy on one accessor still leaves the
        // other handing out the live object.
        this.overflow = Object.freeze({
          kind: 'POOL_COUNT_EXCEEDED' as const,
          completeness: 'UNKNOWN' as const,
          excess: 'ONE_OR_MORE' as const,
          ...(limited || known?.hardLimitObserved
            ? { hardLimitObserved: true, admission: 'LIMITED' as const }
            : {})
        });
        // Its own publication, and exclusive with the reproject path below by the
        // unconditional return at the end of this branch.
        this.commitPublication(true, now);
        if (!known) {
          console.warn(`[capacity] pool cap ${RETENTION_CAPS.maxPools} exceeded; the collection is incomplete`);
        }
      }
      return { accepted: false, changed: false, reason: 'CAP_POOLS' };
    }
    // The breach is decided on the RAW reading - it is the raw reading that is too
    // big - but everything downstream compares and stores the bounded stand-in. Two
    // identical oversized readings must look identical to the duplicate rules, or
    // the "one deduplicated diagnostic" of 172 becomes one per observation.
    const breach = this.capBreachFor(obs);
    // Captured BEFORE anything is mutated: once the arriving reading is committed,
    // `prev` and the record being written are the same object, and the admitted
    // identities this validates against would be the ones that just arrived.
    const admittedWindowIds = prev?.observation.windows.map((w) => w.windowId) ?? [];
    // Parsed from the raw reading, independently of the bulk path and before any of
    // it is retained. Constant-size by construction, so honouring it cannot
    // reintroduce the unbounded retention the breach just refused.
    const boundedStandIn = (): CapacityObservation =>
      ProviderCapacityTracker.sentinel(obs, admissionEnvelopeOf(obs, admittedWindowIds));
    const reading = breach ? boundedStandIn() : obs;

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
      acceptedMono: 0,
      restoredUnconfirmed: false,
      continuitySince: null
    };
    const commit = (stored: CapacityObservation, kind: CapBreachKind | null): void => {
      rec.observation = stored;
      rec.capBreach = kind;
      this.stampDeadline(rec, stored, now, restore !== undefined);
      rec.conflicted = conflicted;
      // A RESTORE CARRIES NO EPOCH AT ALL - only the `since` that identifies one.
      // Re-deriving an epoch here would mint a fresh `since` for a refusal that
      // never ended, and carrying the whole struct would hand unverified classifying
      // fields to `nextEpoch` the moment the restored gate lifts. A number does
      // neither. A LIVE reading takes the normal path, which is what lets fresh
      // telemetry either re-establish this epoch under its old identity or clear it.
      if (restore) {
        rec.epoch = null;
        rec.continuitySince = restore.continuitySince;
      } else {
        rec.epoch = this.nextEpoch(rec, stored, now);
        // Live evidence settles the carried identity one way or the other: a real
        // epoch ABSORBS it as its own `since`, and an affirmative clearance ends it.
        // An incomplete reading does neither, so the identity survives unconfirmed -
        // the same asymmetry the rest of this file uses, because "says nothing" is
        // not "says it is over".
        if (rec.epoch || clearsLimitation(stored, this.isFresh(stored, now))) {
          rec.continuitySince = null;
        }
      }
      // Set on every commit rather than only on restore: the first accepted LIVE
      // reading is what clears it, and routing both through one assignment means a
      // future caller cannot forget the clearing half.
      rec.restoredUnconfirmed = restore !== undefined;
      if (!pinAnchor) rec.anchorAt = now;
    };
    commit(reading, breach);
    this.pools.set(obs.poolKey, rec);

    // THE COLLECTION CAP IS ENFORCED ON THE CANDIDATE PUBLISHED COLLECTION - the
    // retained representation, which is the only thing that can be measured rather
    // than estimated. If it will not fit, the ARRIVING pool is the one replaced by
    // its bounded stand-in, because it is the one whose arrival caused the breach;
    // the pools already published keep the readings they were admitted with. The
    // substitution happens BEFORE publication, so this whole ingest is one revision.
    const moved = this.reproject(
      obs.poolKey,
      now,
      pinAnchor,
      this.monotonic(),
      breach ? undefined : () => commit(boundedStandIn(), 'COLLECTION_BYTES_EXCEEDED')
    );
    return { accepted: true, changed: this.commitPublication(moved, now), reason: 'ACCEPTED' };
  }

  /**
   * Recompute time-derived facts: freshness expires and reset boundaries pass with
   * no new reading at all, and a consumer must see that happen.
   */
  evaluate(now: number = this.clock(), monoNow: number = this.monotonic()): boolean {
    // ONE SWEEP IS ONE PUBLICATION (L0-SEM 16). Every pool is re-projected to its
    // FINAL state for this instant - so a pool crossing two boundaries in the same
    // sweep collapses into one advance, and an intermediate difference the sweep
    // overwrites was never a difference - and the collection moves once for the
    // whole sweep, or not at all. Each pool's OWN revision still moves only if its
    // own projection differs, so pools this sweep did not affect advance by zero.
    let moved = false;
    for (const key of this.pools.keys()) moved = this.reproject(key, now, false, monoNow) || moved;
    return this.commitPublication(moved, now);
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
    const publishedAt = this.clock();
    return this.commitPublication(this.reproject(poolKey, publishedAt), publishedAt);
  }

  snapshot(): CapacityCollectionSnapshot {
    return {
      collectionRevision: this.collectionRevision,
      overflow: this.overflow,
      pools: [...this.pools.values()].map((r) => r.projection),
      updatedAt: this.updatedAt
    };
  }

  /**
   * The admission verdict that applies to a binding this collection cannot resolve —
   * an agent whose pool was omitted by the cardinality cap. Null when the collection
   * is complete, or incomplete without any omitted pool having stated a refusal.
   */
  collectionAdmission(): 'LIMITED' | null {
    return this.overflow?.admission ?? null;
  }

  pool(poolKey: string): PoolCapacitySnapshot | null {
    return this.pools.get(poolKey)?.projection ?? null;
  }

  /**
   * The WALL-CLOCK instant this pool's reading stops being fresh, or null once it has
   * (or for an unknown pool). Read-only and display-only: it exists so the renderer's
   * one permitted local-time fallback — a mask that may only DEGRADE a row after main's
   * own deadline (design §17) — is armed from THIS deadline rather than from a second
   * TTL rule that could disagree with it. It decides nothing here.
   */
  freshUntil(poolKey: string, now: number = this.clock(), monoNow: number = this.monotonic()): number | null {
    const rec = this.pools.get(poolKey);
    if (!rec || monoNow > rec.staleAt) return null;
    return now + (rec.staleAt - monoNow);
  }

  /**
   * CAN THIS POOL'S HOLD END ON ITS OWN? A LABEL for whoever shows the state - it decides
   * nothing, changes no state and no verdict.
   *
   * It exists because two holds never end without a human, and a person looking at a
   * waiting message deserves to see that rather than wonder (L0-UNKNOWN, unnamed cases
   * c1 and c2 - reported to the human; c1 was then given ONE post-reset probe, c2 none):
   *
   *   'NO_KNOWN_RESET'      a provider REFUSAL is open and no reset boundary is known that
   *                         could ever become its recovery hint. LIMITED until a newer
   *                         reading arrives.
   *   'SPENT_RESET_PASSED'  the reading went stale with a window at exactly zero and NO
   *                         refusal, so no limit epoch exists to hint - and that window's
   *                         known reset has now PASSED. The admission seam allows ONE
   *                         post-reset probe for it (`postResetProbeKey`, ruling "1a").
   *   'RESET_KNOWN'         a boundary is known and still ahead: the hold can end by itself.
   *   null                  not a held pool of either kind.
   *
   * Asked of the tracker's OWN record with the tracker's OWN boundary rule
   * (`nextResetBoundary`), not re-derived from a snapshot by a caller.
   */
  resetOutlook(poolKey: string): 'NO_KNOWN_RESET' | 'SPENT_RESET_PASSED' | 'RESET_KNOWN' | null {
    const rec = this.pools.get(poolKey);
    if (!rec || rec.restoredUnconfirmed) return null;
    const p = rec.projection;
    if (rec.epoch) {
      if (p.state !== 'LIMITED') return null; // RECOVERING has already been hinted
      return nextResetBoundary(rec.observation, rec.epoch) === null ? 'NO_KNOWN_RESET' : 'RESET_KNOWN';
    }
    if (staleLastKnown(p) !== 'NOT_HEALTHY') return null;
    const spent = rec.observation.windows.filter((w) => p.numericallyExhaustedWindowIds.includes(w.windowId));
    if (!spent.length) return null;
    if (spent.some((w) => w.resetsAt === null)) return 'NO_KNOWN_RESET';
    return spent.every((w) => (w.resetsAt as number) <= this.clock()) ? 'SPENT_RESET_PASSED' : 'RESET_KNOWN';
  }

  /**
   * L0-UNKNOWN, the human's ruling "1a": WHICH passed reset is this? Non-null exactly when
   * `resetOutlook` is 'SPENT_RESET_PASSED' - the reading went stale with a window at zero
   * and NO provider refusal, and every spent window's known reset has now passed.
   *
   * The admission seam allows ONE re-probe per value of this key and no more. The key names
   * the READING (its time and sequence) and the RESET (the latest spent boundary), so a
   * second ask on the same evidence finds the same key and is refused, and ANY newer
   * accepted reading - limited, healthy or spent again - makes a different key or leaves
   * this case altogether. Read from what the tracker already holds. Nothing is inferred,
   * nothing is polled, no state changes, and the projection stays UNKNOWN: a passed reset
   * never manufactures AVAILABLE here, and it does not manufacture RECOVERING either -
   * RECOVERING's single turn is keyed to a limit EPOCH, and this case has none.
   */
  postResetProbeKey(poolKey: string): string | null {
    if (this.resetOutlook(poolKey) !== 'SPENT_RESET_PASSED') return null;
    const rec = this.pools.get(poolKey)!;
    const spent = rec.observation.windows.filter((w) => rec.projection.numericallyExhaustedWindowIds.includes(w.windowId));
    const latest = Math.max(...spent.map((w) => w.resetsAt as number));
    return `${rec.observation.observedAt}#${rec.observation.sourceSequence}#${latest}`;
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
   * An authoritative COMPLETE inventory of the pools that exist. Clears the
   * pool-count overflow marker if it proves the collection fits (L0-SEM 13).
   *
   * WHY THIS EXISTS AS AN EXPLICIT CALL RATHER THAN A CONSEQUENCE. The marker says
   * "pools are missing from this collection", and nothing that happens inside this
   * tracker can disprove that: excess arrivals stopping is not proof, time passing
   * is not proof, and a pool being forgotten frees a SLOT without showing that the
   * omitted pool is gone. Only an enumeration from outside — something that can see
   * every pool that exists, not only the ones that happened to be offered — can
   * establish it. That is the same discipline as recovery never being inferred from
   * a reset time passing: absence of evidence must not clear a fact, and evidence
   * must.
   *
   * Returns true if the marker was cleared.
   */
  /**
   * Everything that may cross a restart: the OBSERVATIONS this collection currently
   * holds, each with its epoch continuity identity.
   *
   * OBSERVATIONS, NOT PROJECTIONS (L0-TAIL ruling 1). The projection is a derived
   * verdict and persisting it would make the restore a replay of a conclusion; the
   * observation is what the provider actually said, and re-admitting it lets the
   * current rules decide afresh. Nothing here is fabricated or adjusted: the
   * timestamps are the provider's own.
   *
   * EVERY RETAINED POOL IS EXPORTED, INCLUDING ONE WHOSE EVIDENCE IS ITSELF
   * RESTORED. An earlier version skipped those, meaning to stop a single
   * observation surviving an unbounded chain of restarts while never being
   * confirmed. THAT GUARD RECREATED THE DEFECT THIS WHOLE FEATURE EXISTS TO FIX:
   * the store is written by whole-file replacement, so a clean quit with no live
   * telemetry in between rewrote it as an empty list and the NEXT restart had no
   * pool at all - known pool becomes absent, exactly as before.
   *
   * And the hazard it guarded against was already discharged by a mechanism in this
   * same file: restored evidence is permanently stale and permanently unconfirmed,
   * so it can never become current truth however many restarts it survives. The
   * guard bought nothing and cost the card's purpose. The question an unrequested
   * guard has to answer first is what is ALREADY discharging this.
   */
  persistable(): { observation: CapacityObservation; continuitySince: number | null }[] {
    const out: { observation: CapacityObservation; continuitySince: number | null }[] = [];
    for (const rec of this.pools.values()) {
      out.push({
        observation: rec.observation,
        // The live epoch's identity, or the one already being carried.
        continuitySince: rec.epoch?.since ?? rec.continuitySince ?? null
      });
    }
    return out;
  }

  noteCompleteInventory(poolKeys: readonly string[]): boolean {
    if (!this.overflow) return false;
    if (poolKeys.length > RETENTION_CAPS.maxPools) return false;
    this.overflow = null;
    this.commitPublication(true, this.clock());
    return true;
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
    this.commitPublication(true, this.clock());
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
        since: rec.epoch?.since ?? rec.continuitySince ?? now,
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
  private stampDeadline(
    rec: PoolRecord,
    obs: CapacityObservation,
    now: number,
    restored = false
  ): void {
    const mono = this.monotonic();
    const age = Math.max(0, now - obs.observedAt);
    rec.ageAtAccept = age;
    rec.acceptedMono = mono;
    // A RESTORED READING IS NEVER FRESH, AT ANY AGE (L0-TAIL ruling 3).
    //
    // The monotonic clock this deadline is measured against did not survive the
    // restart, so there is no deadline to restore and none may be reconstructed.
    // The tempting alternative - compute the remaining TTL from wall-clock age - is
    // ruled out in terms: "do not use wall-clock age alone to promote a restored
    // observation to a current/healthy verdict". A reading persisted one second
    // before the restart is therefore stale on arrival, which is not pessimism: we
    // genuinely do not know what happened while the process was down, and the only
    // thing that can tell us is a live provider reading.
    //
    // This is also what makes the backwards-clock case uninteresting for restored
    // evidence: nothing about a restored pool is derived from wall-clock age, so
    // moving the clock in either direction cannot promote it.
    rec.staleAt = restored ? mono - 1 : mono + (ttlFor(obs.source, this.policy) - age);
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
  private capBreachFor(obs: CapacityObservation): CapBreachKind | null {
    if (obs.windows.length > RETENTION_CAPS.maxWindowsPerPool) return 'WINDOW_COUNT_EXCEEDED';
    if (byteLength(obs) > RETENTION_CAPS.maxPoolBytes) return 'POOL_BYTES_EXCEEDED';
    // The COLLECTION cap is not decided here. See `overCollectionBudget`: it is a
    // property of the collection, not of the reading, so it cannot be answered
    // before the reading has been projected into the collection.
    return null;
  }

  /**
   * Is the PUBLISHED collection over its byte budget?
   *
   * MEASURED, NOT SUMMED, AND THAT IS THE WHOLE POINT. The previous version added up
   * `projectionBytes` for every pool EXCEPT the arriving one and compared that. Both
   * halves were wrong and each one alone was enough to let the cap be exceeded:
   * omitting the arriving pool checks the collection that existed a moment ago
   * rather than the one about to be published, and a sum of per-pool sizes is not
   * the size of the collection - the wrapper fields and the array punctuation
   * between 32 elements are real retained bytes that no per-pool figure contains.
   * Thirty-two individually legal 8,192-byte readings summed to exactly the cap and
   * serialized to 267,460 bytes; the 5,316-byte difference is precisely the part a
   * sum cannot see.
   *
   * So this serializes the thing the cap actually bounds - the published collection,
   * as a consumer receives it - and there is nothing left to be approximately right
   * about.
   */
  private wouldOverflowCollection(
    poolKey: string,
    candidate: PoolCapacitySnapshot,
    now: number,
    candidateRevision: number
  ): boolean {
    const projected = { ...candidate, revision: candidateRevision };
    const pools: PoolCapacitySnapshot[] = [];
    let substituted = false;
    for (const [key, rec] of this.pools) {
      if (key === poolKey) { pools.push(projected); substituted = true; } else pools.push(rec.projection);
    }
    if (!substituted) pools.push(projected);
    // Built in the exact shape `snapshot()` publishes, with the values a changed
    // re-projection is about to assign, so this is the retained representation and
    // not a model of it.
    const bytes = byteLength({
      collectionRevision: this.collectionRevision + 1,
      overflow: this.overflow,
      pools,
      updatedAt: now
    });
    return bytes > RETENTION_CAPS.maxCollectionBytes
      - TIMER_GROWTH_RESERVE_COLLECTION
      - TIMER_GROWTH_RESERVE_PER_POOL * pools.length;
  }

  /**
   * A bounded stand-in for a reading that cannot be retained (L0-SEM 172).
   *
   * ACCEPT MUST NOT MEAN RETAIN THE UNBOUNDED OBJECT, and my first version did
   * exactly that: it classified the pool UNKNOWN and then stored all seventeen
   * windows anyway, so the caps announced a bound they did not impose. The REAL pool
   * stays — it keeps its identity and its ordering position, both small, and
   * discarding them would make the next reading look like a first sighting.
   *
   * THE OFFENDING WINDOW SET IS REJECTED WHOLE, AND THAT IS NOT THE SAME AS
   * TRUNCATING. Keeping sixteen of seventeen windows would be bounded and would be
   * WORSE than the breach: a selected subset is a COMPLETE-LOOKING SET that nobody
   * observed, so the pool could classify on evidence the provider never sent.
   * Neither the 17th window nor any chosen 16 survives (L0-SEM 13).
   */
  /**
   * Is every identity this reading would have us RETAIN within its bound?
   *
   * These are the fields the stand-in copies through, so they are exactly the ones a
   * breach cannot shrink. `sourceSequence` and the timestamps are numbers and bounded
   * by their own serialization; `source` is checked against the closed set because an
   * unknown source is not a source.
   */
  private static identityIsBounded(obs: CapacityObservation): boolean {
    return boundedPoolKey(obs.poolKey) !== null
      && boundedIdentity(obs.provider) !== null
      && boundedIdentity(obs.accountScope) !== null
      && boundedIdentity(obs.limitId) !== null
      && (OBSERVATION_SOURCES as readonly string[]).includes(obs.source)
      && (obs.streamId === null || obs.streamId === undefined || boundedStreamId(obs.streamId) !== null);
  }

  private static sentinel(obs: CapacityObservation, envelope: AdmissionEnvelope | null): CapacityObservation {
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
      // The one fact that survives a bulk rejection (L0-SEM 14), and only in its
      // validated, constant-size form: a FIXED discriminator rather than the
      // provider's own string, and a window id only if it was already an admitted
      // identity. Without a valid envelope these stay null and section 13's UNKNOWN
      // stands untouched.
      providerAttributedLimitingWindowId: envelope?.windowId ?? null,
      providerReachedType: envelope?.hardLimit === 'TYPED_REACHED' ? ENVELOPE_TYPED_REACHED : null,
      ordinaryUsageAllowed: envelope?.hardLimit === 'ORDINARY_USE_DENIED' ? false : null,
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
  private reproject(
    poolKey: string,
    now: number,
    pinAnchor = false,
    monoNow: number = this.monotonic(),
    onOverBudget?: () => void
  ): boolean {
    const rec = this.pools.get(poolKey);
    if (!rec) return false;
    const build = (): PoolCapacitySnapshot => {
      const p = this.project(rec, now, monoNow);
      if (pinAnchor && rec.projection.observedAt > 0) {
        p.observedAt = rec.projection.observedAt;
        p.ageMs = Math.max(0, now - rec.projection.observedAt);
      }
      return p;
    };
    let next = build();

    // ONE ACCEPTED INGEST IS ONE PUBLICATION (L0-SEM 15). The budget is decided on
    // the CANDIDATE, before any revision moves, so a reading that has to be replaced
    // by its bounded stand-in still advances `collectionRevision` and this pool's
    // revision exactly once. The previous shape published the full projection, found
    // the collection over budget, and published again - two increments for one
    // ingest, and a phantom intermediate revision that no consumer asked for.
    if (onOverBudget && this.wouldOverflowCollection(poolKey, next, now, rec.projection.revision + 1)) {
      onOverBudget();
      next = build();
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
    // THE COLLECTION REVISION IS NOT THIS METHOD'S TO ADVANCE (L0-SEM 16). One pool
    // moving is not one publication: a timer SWEEP re-projects every pool and is ONE
    // atomic publication, so a per-pool increment here made five expiring pools move
    // the collection 5 -> 10 where the correct answer is 5 -> 6. The caller owns the
    // transaction boundary because only the caller knows where it is; this method
    // owns the POOL's own revision, which is per-pool by definition.
    return true;
  }

  /**
   * Close one atomic publication. Advances the collection revision AT MOST ONCE, and
   * not at all when nothing moved - a repeated no-change sweep is a no-op, not an
   * increment carrying identical content.
   *
   * THE SOLE WRITER OF `collectionRevision`, DELIBERATELY. The at-most-once rule was
   * enforced here while three other sites advanced the same counter directly: the
   * excess-pool marker, `noteCompleteInventory` and `forget`. Each of those really is
   * a distinct publication, so the behaviour was right - but an invariant that lives
   * in one function while four places can break it is a convention, not a boundary,
   * and nothing structural stopped a fifth writer appearing. Routing every one of
   * them through here makes the rule true by construction instead of by inspection,
   * and leaves exactly one line to review when it is next questioned.
   */
  private commitPublication(changed: boolean, now: number): boolean {
    if (!changed) return false;
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
    // NOT WHILE RESTORED-UNCONFIRMED. The reset-passage hint is computed from the
    // observation's own reset boundary and the wall clock, so on restored evidence
    // it would manufacture "recovery is likely" out of nothing but elapsed downtime
    // - wall-clock age promoting a restored reading toward a healthier verdict,
    // which ruling 3 forbids by name. The hint is not lost: it is re-evaluated the
    // moment live evidence confirms the pool, against a reading we can believe.
    if (epoch && !epoch.hinted && !rec.restoredUnconfirmed && resetPassed(obs, epoch, now)) {
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
      capBreach: rec.capBreach,
      limitEpochAt: epoch?.since ?? rec.continuitySince ?? null
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
    // RESTORED EVIDENCE IS NOT CURRENT TRUTH, AND THIS GATE SITS ABOVE THE EPOCH
    // BRANCH BECAUSE THE EPOCH BRANCH OUTRANKS EVERYTHING ELSE.
    //
    // That ordering is the whole defect the ruling exists to prevent. A pool that
    // was LIMITED before the restart carries its epoch across, and the epoch branch
    // below would republish LIMITED - the pre-restart verdict reinstated as current
    // truth, with no provider having said anything since. The human's own example
    // is the test: pre-restart epoch 42 / LIMITED, post-restart epoch 42 / UNKNOWN.
    // The epoch still reaches the projection as `limitEpochAt`, so continuity is
    // preserved and published; what it may not do is decide the state.
    //
    // It is equally the other half of the two-sided rule: UNKNOWN is not AVAILABLE,
    // so a restart cannot clear a real provider limitation either. The pool is
    // honestly unknown until something live says otherwise, which is the only
    // answer the evidence supports.
    if (rec.restoredUnconfirmed) {
      return { state: 'UNKNOWN', stateReason: REASON.RESTORED };
    }
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

/**
 * Serialized size of one retained reading, in UTF-8 BYTES, which is what the byte
 * caps bound.
 *
 * `JSON.stringify(value).length` counts UTF-16 CODE UNITS and that is a different
 * quantity. Oscar section 12 states the ceilings on UTF-8 serialization, and the
 * normalizers retain provider strings, so the gap is reachable rather than
 * theoretical: a character above U+07FF is one code unit and three bytes, and a
 * supplementary character is two code units and four bytes, so the undercount
 * reaches 3x. A plan type of 3,500 supplementary characters measured 7,508 and was
 * 14,508; thirty-two such pools published 468,572 bytes while the code read 244,572
 * and sentinelled none of them.
 *
 * Pure ASCII is arithmetically unchanged - one code unit is one byte - so every
 * ASCII fixture keeps its existing numbers.
 */
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

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
const applicableWindows = (obs: { windows: CapacityWindow[] }): CapacityWindow[] =>
  obs.windows.filter((w) => applicabilityOf(w) === 'APPLICABLE');

/** Fresh exact zero on an APPLICABLE window. An OBSERVATION; it never implies the
 *  provider said anything. */
function numericallyExhausted(obs: CapacityObservation): string[] {
  return applicableWindows(obs).filter((w) => w.remainingPercent === 0).map((w) => w.windowId);
}

/** K3's "every known-applicable window valid and above zero". A window of unknown
 *  applicability disqualifies the snapshot rather than being skipped: it cannot be
 *  an AUTHORITATIVE all-clear while something in it is unidentified. */
function allWindowsPositive(obs: { windows: CapacityWindow[] }): boolean {
  if (obs.windows.some((w) => applicabilityOf(w) === 'UNKNOWN')) return false;
  const applicable = applicableWindows(obs);
  return applicable.length > 0
    && applicable.every((w) => w.remainingPercent !== null && w.remainingPercent > 0);
}

/**
 * L0-UNKNOWN (human ruling, option ii) - WHAT A STALE POOL WAS, THE LAST TIME IT WAS KNOWN.
 *
 * Answers for ONE case only: a pool whose state is UNKNOWN *because its reading went
 * stale* (`REASON.STALE`). Returns null for every other pool, including every other kind
 * of UNKNOWN - so a conflict, a breached cap, a restored-unconfirmed pool or an
 * unidentifiable window can never be mistaken for "merely quiet".
 *
 * NOTHING IS INFERRED AND NOTHING NEW IS STORED. `deriveState` reaches the STALE branch
 * only AFTER the restored gate, the limit epoch, the conflict and the cap breach have all
 * declined - so reason STALE already means: no open limit epoch, no conflict, no breach,
 * live evidence. What is left to ask is what the reading's own numbers said, and that is
 * asked with the predicate this module ALREADY uses to call a snapshot an all-clear
 * (`allWindowsPositive`, K3) rather than a second copy of it: every window identified,
 * every applicable window present and above zero. The published projection keeps the
 * reading's windows while stale, so this reads the tracker's own published facts.
 *
 *   'HEALTHY'      quiet after an all-clear. Silence after a healthy reading is weak
 *                  evidence of exhaustion: provider activity both consumes allowance and
 *                  produces the next observation.
 *   'NOT_HEALTHY'  quiet after a reading that was NOT an all-clear - a window at zero, a
 *                  missing number, an unidentified window.
 *
 * A pool that went quiet after a provider REFUSAL never reaches here at all: its limit
 * epoch outranks staleness, so it stays LIMITED until its reset boundary passes and then
 * becomes RECOVERING. That is the tracker's existing behaviour and is not changed.
 */
export function staleLastKnown(pool: PoolCapacitySnapshot): 'HEALTHY' | 'NOT_HEALTHY' | null {
  if (pool.state !== 'UNKNOWN' || pool.stateReason !== REASON.STALE) return null;
  return allWindowsPositive(pool) ? 'HEALTHY' : 'NOT_HEALTHY';
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
    capBreach: null,
    limitEpochAt: null
  };
}
