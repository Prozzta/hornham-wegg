/**
 * L0-SEAM — the conservative admission seam.
 *
 * WHAT THIS IS AND IS NOT. It CONSUMES main-owned capacity state and decides
 * whether a unit of work may start. It does not compute capacity, does not observe
 * a provider, does not hold a percentage and does not own a threshold. Every fact
 * it uses arrives from `ProviderCapacityTracker`; if it needed a number the tracker
 * does not publish, the right fix is in the tracker, not here.
 *
 * CAPACITY IS NOT CONTEXT. Provider/account allowance and per-agent context or
 * session state are different quantities with different scopes, and they do not
 * share a type, a field or a code path anywhere in this file. Nothing here imports
 * the context map, and a decision carries no token count, no session id and no
 * context figure. Conflating them is how four agent rows come to look like four
 * quotas, or how one full session comes to look like a spent subscription.
 *
 * SHARED AGENTS ARE ONE POOL. An agent is resolved to a pool key and then plays no
 * further part: the verdict is a property of the POOL. Three agents on one
 * subscription therefore get one answer, and refusing them is one refusal rather
 * than three. There is no per-agent quota anywhere in this module, and no code path
 * where an agent id can influence a capacity fact.
 *
 * NO CROSS-PROVIDER MIGRATION. This seam admits or refuses. It never moves work to
 * another provider, never picks a provider, and never returns an alternative.
 *
 * A DECISION IS NOT A LAUNCH. The single RECOVERING turn per epoch is the evidence
 * that a refusal has ended, so it must be spent by a turn that actually happened.
 * Recording the grant inside `admit()` spent it on the DECISION, and a caller that
 * asked and then did not start - a cancelled queue item, a guard further down, a
 * worker that drained its mail before delivery - burned the one chance the epoch
 * had. So a grant is taken in two steps: `admit()` RESERVES it, and
 * `confirmLaunch()` commits it once the turn really started. `cancelGrant()`
 * returns it if the launch never happens.
 *
 * The reservation still blocks a second concurrent asker, because two callers each
 * seeing ALLOW before either starts is the retry storm this exists to prevent. A
 * reservation nobody ever resolves expires, so a caller that dies between deciding
 * and launching cannot strand the pool in a state where recovery can never be
 * attempted again.
 */
import type { CapacityState, PoolCapacitySnapshot } from '../shared/providerCapacity';

/**
 * What is being asked for. Only work that costs a PROVIDER TURN is gated here:
 * local work — checkpointing, writing a report, committing, closing down — is not a
 * capacity question and is never refused by this seam.
 */
export type WorkClass =
  /** A new ordinary model turn, or an automatic retry of one. */
  | 'ORDINARY_TURN'
  /** A turn whose only purpose is to finish safely: checkpoint, hand off, report, stop. */
  | 'CLOSURE_TURN';

export type AdmissionVerdict =
  | 'ALLOW'
  | 'REFUSE'
  /**
   * Capacity is not known. This is NOT a refusal and NOT permission: the seam
   * declines to infer safety and hands the fact back, so the caller applies its own
   * configured conservative behaviour. Inventing an answer here would either stall
   * the hive on every stale reading or claim a safety nobody observed.
   */
  | 'UNKNOWN_NOT_INFERRED_SAFE';

/**
 * How long a RESERVED but unconfirmed recovery grant is honoured before it is
 * treated as abandoned. It bounds one failure only - a caller that decides and then
 * neither launches nor cancels - and the cost of it being wrong in either direction
 * is small: too short risks two attempts at one recovery, too long delays a retry
 * that a stuck caller already lost. It is not a provider constant and nothing about
 * capacity is derived from it.
 */
export const RECOVERY_RESERVATION_TTL_MS = 60_000;

export const ADMISSION_REASON = {
  NO_POOL: 'NO_CAPACITY_POOL_FOR_AGENT',
  OMITTED_POOL_LIMITED: 'UNRESOLVED_BINDING_UNDER_OBSERVED_LIMIT',
  NO_STATE: 'NO_CAPACITY_STATE_FOR_POOL',
  LIMITED: 'POOL_LIMITED',
  RESERVE_ORDINARY: 'POOL_RESERVE_ONLY_ORDINARY_WORK_SUPPRESSED',
  RESERVE_CLOSURE: 'POOL_RESERVE_ONLY_CLOSURE_PERMITTED',
  RECOVERING_GRANT: 'RECOVERING_SINGLE_TURN_GRANTED',
  RECOVERING_SPENT: 'RECOVERING_SINGLE_TURN_ALREADY_GRANTED',
  UNKNOWN: 'CAPACITY_UNKNOWN',
  /** L0-UNKNOWN option (ii): UNKNOWN because the reading went stale, and the reading was
   *  an all-clear. Still UNKNOWN - the seam does not infer safety - but DIFFERENT EVIDENCE
   *  from every other unknown, and the caller's one named mapping treats it differently. */
  STALE_AFTER_HEALTHY: 'CAPACITY_STALE_LAST_KNOWN_HEALTHY',
  /** ...and the reading was NOT an all-clear (a window at zero, a gap, an unidentified window). */
  STALE_AFTER_UNHEALTHY: 'CAPACITY_STALE_LAST_KNOWN_NOT_HEALTHY',
  AVAILABLE: 'POOL_AVAILABLE',
  APPROACHING: 'POOL_APPROACHING_PROVIDER_ADVISORY'
} as const;

export interface AdmissionDecision {
  verdict: AdmissionVerdict;
  reason: string;
  /** The pool the decision is about. Null when the agent maps to no pool at all. */
  poolKey: string | null;
  /** The state the decision was taken from, for audit. Never recomputed by a caller. */
  state: CapacityState | null;
  workClass: WorkClass;
  /** The epoch this decision was taken under, so a later refusal is distinguishable. */
  limitEpochAt: number | null;
  /**
   * Present only on the ALLOW that reserved the one recovery turn for an epoch.
   * Hand it back to `confirmLaunch()` when the turn really starts, or to
   * `cancelGrant()` when it does not. Every other decision carries null, so a
   * caller cannot confirm a launch it was never granted.
   */
  grantId: string | null;
}

/** What the seam needs from the world. Injected, so the decision stays testable. */
export interface AdmissionDeps {
  /** Agent → pool key. Several agents returning the SAME key is the normal case. */
  poolKeyForAgent: (agentId: string) => string | null;
  /** Pool key → the tracker's published projection. */
  poolState: (poolKey: string) => PoolCapacitySnapshot | null;
  /**
   * The verdict for a binding this collection cannot resolve (L0-SEM 14). Returns
   * 'LIMITED' when a pool omitted by the cardinality cap was seen stating a hard
   * limit. Optional: a caller with no collection-level facts supplies nothing and
   * an unresolved binding stays UNKNOWN, exactly as before.
   */
  collectionAdmission?: () => 'LIMITED' | null;
  /**
   * What a STALE pool was when last known, as the TRACKER answers it
   * (`staleLastKnown`): 'HEALTHY', 'NOT_HEALTHY', or null when the pool is not UNKNOWN
   * for staleness at all. Injected for the reason everything here is: this module may
   * not grow a second state table, so the predicate stays the tracker's. Optional, and
   * ABSENT MEANS NO SPLIT - every unknown stays plain UNKNOWN, which holds.
   */
  staleLastKnown?: (pool: PoolCapacitySnapshot) => 'HEALTHY' | 'NOT_HEALTHY' | null;
  /**
   * Wall-clock milliseconds, for the reservation TTL below and nothing else.
   *
   * REQUIRED RATHER THAN DEFAULTED, on purpose. This module must contain no clock
   * of its own - a seam that can read the time is a seam that can start deriving
   * facts from it, and the one fact it is allowed is the one the tracker publishes.
   * A registered test asserts that this file names no ambient clock at all, and it
   * caught exactly that drift when a defaulted one arrived with the TTL.
   */
  now: () => number;
}

export class CapacityAdmission {
  /**
   * poolKey → the limit epoch under which a recovery turn was already granted.
   * One grant per epoch: RECOVERING means the old refusal MAY have ended, so the
   * single permitted turn is the evidence, and a second attempt before that turn
   * reports back would be a retry storm against a provider that just refused.
   */
  private recoveryGrants = new Map<string, RecoveryGrant>();
  private grantSeq = 0;

  constructor(
    private readonly deps: AdmissionDeps,
    private readonly reservationTtlMs: number = RECOVERY_RESERVATION_TTL_MS
  ) {}

  /**
   * The verdict WITHOUT taking anything. Use this to ASK - to render a gate, to
   * answer a snapshot, to decide whether to offer work - and `admit()` only when
   * something is about to start.
   *
   * IT EXISTS BECAUSE ASKING MUST NOT COST THE ANSWER. `admit()` reserves the
   * epoch's single recovery turn when it returns one, so a caller that polled it to
   * find out whether work WOULD be allowed would spend the one attempt on the
   * question - and a snapshot that is read on every queue tick would spend it
   * immediately and permanently.
   */
  probe(agentId: string, workClass: WorkClass = 'ORDINARY_TURN'): AdmissionDecision {
    return this.decide(agentId, workClass);
  }

  admit(agentId: string, workClass: WorkClass = 'ORDINARY_TURN'): AdmissionDecision {
    const decision = this.decide(agentId, workClass);
    // The one verdict that costs something to give. Reserving here, rather than
    // inside the decision, is what lets `probe()` share this logic instead of
    // duplicating it - a second copy of the state table is exactly the drift this
    // module cannot afford.
    if (decision.reason === ADMISSION_REASON.RECOVERING_GRANT && decision.poolKey) {
      const grantId = `${decision.poolKey}#${decision.limitEpochAt ?? 0}#${++this.grantSeq}`;
      this.recoveryGrants.set(decision.poolKey, {
        epoch: decision.limitEpochAt ?? 0,
        grantId,
        confirmed: false,
        reservedAt: this.deps.now()
      });
      return { ...decision, grantId };
    }
    return decision;
  }

  private decide(agentId: string, workClass: WorkClass): AdmissionDecision {
    const poolKey = this.deps.poolKeyForAgent(agentId);
    if (!poolKey) {
      // An unresolvable binding while an OMITTED pool has been seen refusing. The
      // pool that refused is one the cardinality cap forbids remembering, so the
      // fact rides on the collection marker - and it applies here, to a turn that
      // cannot be proved to belong to one of the retained pools, and nowhere else.
      // The retained pools keep their own verdicts and are not relabelled by it.
      if (this.deps.collectionAdmission?.() === 'LIMITED') {
        return decision('REFUSE', ADMISSION_REASON.OMITTED_POOL_LIMITED, null, null, workClass, null);
      }
      // Otherwise: no pool means no capacity FACT, not a free pass and not a refusal.
      return decision('UNKNOWN_NOT_INFERRED_SAFE', ADMISSION_REASON.NO_POOL, null, null, workClass, null);
    }
    const pool = this.deps.poolState(poolKey);
    if (!pool) {
      return decision('UNKNOWN_NOT_INFERRED_SAFE', ADMISSION_REASON.NO_STATE, poolKey, null, workClass, null);
    }
    const at = (verdict: AdmissionVerdict, reason: string): AdmissionDecision =>
      decision(verdict, reason, poolKey, pool.state, workClass, pool.limitEpochAt);

    switch (pool.state) {
      case 'LIMITED':
        // New turns AND automatic retries, both classes. Local work is not gated here.
        return at('REFUSE', ADMISSION_REASON.LIMITED);

      case 'RECOVERING': {
        // At most one real queued turn per epoch, and never a synthetic probe: the
        // turn must be work the caller already needed.
        const epoch = pool.limitEpochAt ?? 0;
        const held = this.recoveryGrants.get(poolKey);
        if (held && held.epoch === epoch && !this.abandoned(held)) {
          return at('REFUSE', ADMISSION_REASON.RECOVERING_SPENT);
        }
        return at('ALLOW', ADMISSION_REASON.RECOVERING_GRANT);
      }

      case 'RESERVE_ONLY':
        // A window is spent. Ordinary work is suppressed; finishing safely is not.
        return workClass === 'CLOSURE_TURN'
          ? at('ALLOW', ADMISSION_REASON.RESERVE_CLOSURE)
          : at('REFUSE', ADMISSION_REASON.RESERVE_ORDINARY);

      case 'UNKNOWN': {
        // STILL "NOT A REFUSAL AND NOT PERMISSION" in every branch: the verdict does not
        // change, only the evidence it carries. Which unknowns may proceed is the
        // caller's ONE named mapping (L0-UNKNOWN), never decided here.
        const was = this.deps.staleLastKnown?.(pool) ?? null;
        if (was === 'HEALTHY') return at('UNKNOWN_NOT_INFERRED_SAFE', ADMISSION_REASON.STALE_AFTER_HEALTHY);
        if (was === 'NOT_HEALTHY') return at('UNKNOWN_NOT_INFERRED_SAFE', ADMISSION_REASON.STALE_AFTER_UNHEALTHY);
        return at('UNKNOWN_NOT_INFERRED_SAFE', ADMISSION_REASON.UNKNOWN);
      }

      case 'APPROACHING':
        // Caution, not suppression: the state exists only behind a provider-native
        // advisory, and L0 attaches no throttling to it.
        return at('ALLOW', ADMISSION_REASON.APPROACHING);

      case 'AVAILABLE':
      default:
        return at('ALLOW', ADMISSION_REASON.AVAILABLE);
    }
  }

  /**
   * The turn really started. Commit the reservation, so it is spent by a launch
   * rather than by a question.
   */
  confirmLaunch(decision: AdmissionDecision): void {
    const held = decision.poolKey ? this.recoveryGrants.get(decision.poolKey) : undefined;
    if (!held || !decision.grantId || held.grantId !== decision.grantId) return;
    held.confirmed = true;
  }

  /**
   * The turn did not start after all. Return the reservation so the epoch keeps its
   * one attempt — but only a reservation, never a CONFIRMED grant: a turn that ran
   * cannot be un-run by cancelling the permission it ran under.
   */
  cancelGrant(decision: AdmissionDecision): void {
    const held = decision.poolKey ? this.recoveryGrants.get(decision.poolKey) : undefined;
    if (!held || !decision.grantId || held.grantId !== decision.grantId || held.confirmed) return;
    this.recoveryGrants.delete(decision.poolKey!);
  }

  /**
   * The turn MAY have started, and only a person can say (L0-FUSION stage 5.6, god's
   * ruling on G1b). The submit owner calls this at INTERFERED: our payload is on a live
   * prompt and a human may press Enter on it at any moment, so the evidence has run out
   * and - as A15 ruled for the ticket before it - we fail toward ALREADY LAUNCHED.
   *
   * It exists as its own state because neither existing one is right. `confirmLaunch`
   * cannot be undone, and the human may yet say "it was NOT sent - send it again", which
   * must give the turn back. Leaving the reservation merely unconfirmed is worse: it is
   * ABANDONED after `RECOVERY_RESERVATION_TTL_MS` (60 s), so the epoch's one turn would be
   * handed to someone else while a person is still reading the prompt. A grant held for a
   * human never expires on a timer; it ends by `confirmLaunch` (handled) or `cancelGrant`
   * (send again), or with its epoch. Idempotent; a no-op for a decision that holds nothing.
   */
  holdGrantForHuman(decision: AdmissionDecision): void {
    const held = decision.poolKey ? this.recoveryGrants.get(decision.poolKey) : undefined;
    if (!held || !decision.grantId || held.grantId !== decision.grantId || held.confirmed) return;
    held.heldForHuman = true;
  }

  /** Forget a pool's grant record — used when a pool is removed. */
  forget(poolKey: string): void {
    this.recoveryGrants.delete(poolKey);
  }

  /** A reservation nobody confirmed or cancelled within the TTL. Confirmed grants
   *  never expire: they record something that actually happened. */
  /**
   * Does this decision STILL OWN the reservation it was granted?
   *
   * For a revalidation at the moment of the keystroke, and it exists because the
   * obvious check is wrong: re-probing a RECOVERING pool whose turn this very
   * decision reserved answers REFUSE / RECOVERING_SPENT. A caller that read that as a
   * refusal would abort every recovery delivery it had legitimately been granted -
   * MISTAKING ITS OWN RESERVATION FOR SOMEBODY ELSE'S. Epoch equality alone will not
   * separate them either: a grant abandoned on its TTL and re-taken by another caller
   * sits in the same epoch under a different id.
   *
   * False once the grant has been reclaimed, re-issued, or abandoned on its TTL.
   */
  holdsGrant(decision: AdmissionDecision): boolean {
    const held = decision.poolKey ? this.recoveryGrants.get(decision.poolKey) : undefined;
    if (!held || !decision.grantId) return false;
    return held.grantId === decision.grantId && !this.abandoned(held);
  }

  private abandoned(grant: RecoveryGrant): boolean {
    return !grant.confirmed && !grant.heldForHuman && this.deps.now() - grant.reservedAt >= this.reservationTtlMs;
  }
}

interface RecoveryGrant {
  epoch: number;
  grantId: string;
  confirmed: boolean;
  reservedAt: number;
  /** Set by `holdGrantForHuman`: possibly launched, awaiting a person. No TTL applies. */
  heldForHuman?: boolean;
}

function decision(
  verdict: AdmissionVerdict,
  reason: string,
  poolKey: string | null,
  state: CapacityState | null,
  workClass: WorkClass,
  limitEpochAt: number | null
): AdmissionDecision {
  return { verdict, reason, poolKey, state, workClass, limitEpochAt, grantId: null };
}
