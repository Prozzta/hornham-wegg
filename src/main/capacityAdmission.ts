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
 * NOTHING IS ENFORCED YET. This module is a pure decision function plus one small
 * per-epoch grant record. No caller is wired to it in this commit: turning it on is
 * a separate, visible change, because a seam that silently starts refusing work is
 * exactly the kind of behaviour change that should never arrive as a side effect.
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

export const ADMISSION_REASON = {
  NO_POOL: 'NO_CAPACITY_POOL_FOR_AGENT',
  NO_STATE: 'NO_CAPACITY_STATE_FOR_POOL',
  LIMITED: 'POOL_LIMITED',
  RESERVE_ORDINARY: 'POOL_RESERVE_ONLY_ORDINARY_WORK_SUPPRESSED',
  RESERVE_CLOSURE: 'POOL_RESERVE_ONLY_CLOSURE_PERMITTED',
  RECOVERING_GRANT: 'RECOVERING_SINGLE_TURN_GRANTED',
  RECOVERING_SPENT: 'RECOVERING_SINGLE_TURN_ALREADY_GRANTED',
  UNKNOWN: 'CAPACITY_UNKNOWN',
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
}

/** What the seam needs from the world. Injected, so the decision stays testable. */
export interface AdmissionDeps {
  /** Agent → pool key. Several agents returning the SAME key is the normal case. */
  poolKeyForAgent: (agentId: string) => string | null;
  /** Pool key → the tracker's published projection. */
  poolState: (poolKey: string) => PoolCapacitySnapshot | null;
}

export class CapacityAdmission {
  /**
   * poolKey → the limit epoch under which a recovery turn was already granted.
   * One grant per epoch: RECOVERING means the old refusal MAY have ended, so the
   * single permitted turn is the evidence, and a second attempt before that turn
   * reports back would be a retry storm against a provider that just refused.
   */
  private recoveryGrants = new Map<string, number>();

  constructor(private readonly deps: AdmissionDeps) {}

  admit(agentId: string, workClass: WorkClass = 'ORDINARY_TURN'): AdmissionDecision {
    const poolKey = this.deps.poolKeyForAgent(agentId);
    if (!poolKey) {
      // No pool means no capacity FACT, not a free pass and not a refusal.
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
        if (this.recoveryGrants.get(poolKey) === epoch) {
          return at('REFUSE', ADMISSION_REASON.RECOVERING_SPENT);
        }
        this.recoveryGrants.set(poolKey, epoch);
        return at('ALLOW', ADMISSION_REASON.RECOVERING_GRANT);
      }

      case 'RESERVE_ONLY':
        // A window is spent. Ordinary work is suppressed; finishing safely is not.
        return workClass === 'CLOSURE_TURN'
          ? at('ALLOW', ADMISSION_REASON.RESERVE_CLOSURE)
          : at('REFUSE', ADMISSION_REASON.RESERVE_ORDINARY);

      case 'UNKNOWN':
        return at('UNKNOWN_NOT_INFERRED_SAFE', ADMISSION_REASON.UNKNOWN);

      case 'APPROACHING':
        // Caution, not suppression: the state exists only behind a provider-native
        // advisory, and L0 attaches no throttling to it.
        return at('ALLOW', ADMISSION_REASON.APPROACHING);

      case 'AVAILABLE':
      default:
        return at('ALLOW', ADMISSION_REASON.AVAILABLE);
    }
  }

  /** Forget a pool's grant record — used when a pool is removed. */
  forget(poolKey: string): void {
    this.recoveryGrants.delete(poolKey);
  }
}

function decision(
  verdict: AdmissionVerdict,
  reason: string,
  poolKey: string | null,
  state: CapacityState | null,
  workClass: WorkClass,
  limitEpochAt: number | null
): AdmissionDecision {
  return { verdict, reason, poolKey, state, workClass, limitEpochAt };
}
