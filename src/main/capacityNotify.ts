/**
 * L0-NOTIF — transition-based capacity notifications, main-owned.
 *
 * A NOTIFICATION IS A TRANSITION, AND A TRANSITION NEEDS A PRIOR STATE. That single
 * sentence is the whole design, and it is what makes replay impossible rather than
 * merely unlikely.
 *
 * THE REPLAY TRAP, STATED PLAINLY. After a reload, a reconnect or a resubscribe,
 * the tracker starts empty and the first observation lands the pool in - say -
 * LIMITED. Anything that decides by *looking at a snapshot* sees "this pool is
 * LIMITED" and fires. It fires again on the next reconnect, and again, for a
 * refusal the user was told about an hour ago. The guard is not deduplication by
 * content, because content is exactly what a reload reconstructs faithfully. The
 * guard is that a FIRST SIGHTING IS A BASELINE, NEVER A TRANSITION: `hydrate()`
 * records where each pool already was and emits nothing, and `observe()` can only
 * emit where it has a prior state of its own to compare against.
 *
 * THE SECOND GUARD, for the case the first one cannot see: at most ONE intent per
 * `poolKey + transition + limit epoch`. A pool that re-observes LIMITED fifty times
 * inside one refusal produces one intent, and a SECOND, genuinely separate refusal
 * produces a second - which is why `limitEpochAt` exists rather than a boolean.
 *
 * DELIVERY IS MAIN-OWNED. This module decides WHETHER and WHAT; it does not deliver.
 * Nothing here touches Electron's Notification, the renderer or IPC, so the decision
 * is testable without a window and a renderer can never be the thing that dedupes.
 */
import type { CapacityCollectionSnapshot, CapacityState, PoolCapacitySnapshot } from '../shared/providerCapacity';

/** The transitions L0 tells a user about. Everything else is a state change, not news. */
export type NotifyKind =
  /** Ordinary use is blocked: typed provider evidence or explicit denial. */
  | 'LIMIT_REACHED'
  /** A window is spent, without the provider attributing a limit. Observational. */
  | 'RESERVE_REACHED'
  /** The old refusal may have ended; capacity is NOT yet confirmed. */
  | 'RECOVERY_POSSIBLE'
  /** Confirmed back to ordinary use after a refusal. */
  | 'RECOVERED';

export interface CapacityNotifyIntent {
  kind: NotifyKind;
  poolKey: string;
  provider: string;
  from: CapacityState;
  to: CapacityState;
  /** Main-owned reason code carried through from the tracker. Never renderer wording. */
  stateReason: string;
  /** The epoch this intent belongs to. Null for transitions outside a refusal. */
  limitEpochAt: number | null;
  /** Identity: one intent per this string, ever, in this process. */
  identity: string;
  at: number;
}

interface PoolMemory {
  state: CapacityState;
  limitEpochAt: number | null;
}

/**
 * Which transitions are worth telling someone about, and under which name.
 * Returning null means "a state change, but not news" — for example UNKNOWN in
 * either direction, which happens whenever a reading simply ages out and would
 * otherwise notify a user about the weather.
 */
function kindFor(from: CapacityState, to: CapacityState): NotifyKind | null {
  if (to === 'LIMITED' && from !== 'LIMITED') return 'LIMIT_REACHED';
  if (to === 'RESERVE_ONLY' && from !== 'RESERVE_ONLY' && from !== 'LIMITED') return 'RESERVE_REACHED';
  if (to === 'RECOVERING' && from === 'LIMITED') return 'RECOVERY_POSSIBLE';
  if ((to === 'AVAILABLE' || to === 'APPROACHING') && (from === 'LIMITED' || from === 'RECOVERING')) return 'RECOVERED';
  return null;
}

export class CapacityNotifier {
  private memory = new Map<string, PoolMemory>();
  /** Every intent identity already emitted in this process. */
  private emitted = new Set<string>();

  /**
   * Establish where pools already are WITHOUT emitting anything. Call this on
   * startup, on reload, on reconnect and on resubscribe — every path that rebuilds
   * state that already existed. This is the difference between a user being told
   * once and being told every time the window is reopened.
   */
  hydrate(snapshot: CapacityCollectionSnapshot): void {
    for (const pool of snapshot.pools) this.memory.set(pool.poolKey, memoryOf(pool));
  }

  /**
   * Compare a snapshot against what this process last saw and return the intents.
   * A pool seen for the FIRST time only records a baseline: with no prior state
   * there is no transition, and a first sighting after a reload is indistinguishable
   * from a first sighting at startup — so neither may notify.
   */
  observe(snapshot: CapacityCollectionSnapshot, now: number = Date.now()): CapacityNotifyIntent[] {
    const intents: CapacityNotifyIntent[] = [];
    const seen = new Set<string>();
    for (const pool of snapshot.pools) {
      seen.add(pool.poolKey);
      const prev = this.memory.get(pool.poolKey);
      this.memory.set(pool.poolKey, memoryOf(pool));
      if (!prev) continue;                       // baseline only
      if (prev.state === pool.state && prev.limitEpochAt === pool.limitEpochAt) continue;
      const kind = kindFor(prev.state, pool.state);
      if (!kind) continue;
      // Identity is keyed on the EPOCH, not on a timestamp or a revision: repeated
      // observations of one refusal share it, and a genuinely separate refusal does
      // not. A reload cannot manufacture a new epoch, because the epoch comes from
      // the provider evidence rather than from this process's lifetime.
      const identity = `${pool.poolKey}|${kind}|${pool.limitEpochAt ?? 'none'}`;
      if (this.emitted.has(identity)) continue;
      this.emitted.add(identity);
      intents.push({
        kind,
        poolKey: pool.poolKey,
        provider: pool.provider,
        from: prev.state,
        to: pool.state,
        stateReason: pool.stateReason,
        limitEpochAt: pool.limitEpochAt,
        identity,
        at: now
      });
    }
    // A pool that disappeared from a complete-replace snapshot is gone. Forget its
    // baseline; keep its emitted identities, so a pool that comes back does not
    // re-announce a refusal that was already announced.
    for (const key of [...this.memory.keys()]) if (!seen.has(key)) this.memory.delete(key);
    return intents;
  }
}

const memoryOf = (pool: PoolCapacitySnapshot): PoolMemory => ({
  state: pool.state,
  limitEpochAt: pool.limitEpochAt
});
