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
 * `poolKey + transition + the episode that transition is ABOUT`. A pool that
 * re-observes LIMITED fifty times inside one refusal produces one intent, and a
 * SECOND, genuinely separate refusal produces a second.
 *
 * AND THE EPISODE IS NOT ALWAYS THE DESTINATION'S EPOCH. This is where the first
 * version of this file was wrong, and the error is worth stating because it is not
 * visible from the transition table. A confirmed recovery CLEARS `limitEpochAt`, so
 * keying a RECOVERED intent on the destination snapshot keyed every recovery in the
 * process's life to the same string - and the second genuine recovery was suppressed
 * forever. A transition is about the epoch it OPENS or the epoch it CLOSES, so
 * RECOVERED is scoped by the epoch it ended, which lives in the PRIOR state.
 * RESERVE_ONLY has no epoch at all by ruling 2, so its episodes are counted here
 * instead: a per-pool ordinal that advances on every state entry, which makes two
 * genuine reserve episodes distinct without inventing a provider fact.
 *
 * ORDERING IS THE COLLECTION'S, NOT THIS MODULE'S. A complete-replace snapshot with
 * an equal or lower `collectionRevision` is ignored wholesale (L0-SEM 11.2) - not
 * merged, not partially applied. Without that, an older snapshot replayed after a
 * newer one reads as a transition backwards, emits a false RECOVERED, and burns the
 * identity the real recovery would have needed.
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
  /**
   * The epoch this intent is ABOUT - the one it opened or the one it closed - which
   * for a RECOVERED is the epoch that has just been cleared and is therefore no
   * longer on the pool. Null only for a transition that genuinely has no epoch on
   * either side, which today means RESERVE_REACHED.
   */
  limitEpochAt: number | null;
  /** Identity: one intent per this string, ever, in this process. */
  identity: string;
  at: number;
}

interface PoolMemory {
  state: CapacityState;
  limitEpochAt: number | null;
  /**
   * How many state ENTRIES this pool has made in this process. It is the identity
   * scope for transitions that have no epoch to be scoped by - today only
   * RESERVE_REACHED, which by ruling 2 is numeric exhaustion with nothing attributed
   * and therefore no epoch anywhere to key on.
   */
  episode: number;
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

/**
 * The identity scope of a transition: the epoch it is ABOUT, or - when the
 * transition has no epoch by construction - the pool's episode ordinal.
 *
 * LIMIT_REACHED opens an epoch, so it is scoped by the destination's.
 * RECOVERED ends one, so it is scoped by the PRIOR state's: the destination has
 * already had the field cleared, which is precisely the bug this replaces.
 * RECOVERY_POSSIBLE happens inside an epoch that is still open, so either side
 * carries it; the destination is preferred and the prior is the fallback.
 * RESERVE_REACHED has no epoch on either side and falls through to the ordinal.
 */
function identityScope(kind: NotifyKind, prev: PoolMemory, pool: PoolCapacitySnapshot, episode: number): string {
  const epoch =
    kind === 'LIMIT_REACHED' ? pool.limitEpochAt
      : kind === 'RECOVERED' ? prev.limitEpochAt
        : kind === 'RECOVERY_POSSIBLE' ? (pool.limitEpochAt ?? prev.limitEpochAt)
          : null;
  // The ordinal is the fallback for every epochless case, not only the expected
  // one. If a state that should carry an epoch ever arrives without one, two
  // genuine events stay distinguishable instead of collapsing into each other.
  return epoch !== null ? `e${epoch}` : `n${episode}`;
}

export class CapacityNotifier {
  private memory = new Map<string, PoolMemory>();
  /** Every intent identity already emitted in this process. */
  private emitted = new Set<string>();
  /**
   * The highest collection revision this notifier has acted on. Complete-replace
   * semantics (L0-SEM 11.2): any STRICTLY higher revision is accepted wholesale and
   * needs no adjacency; equal or lower is ignored wholesale. Starts below zero so a
   * genuinely empty first collection at revision 0 is still a real observation.
   */
  private lastCollectionRevision = -1;

  /**
   * Establish where pools already are WITHOUT emitting anything. Call this on
   * startup, on reload, on reconnect and on resubscribe — every path that rebuilds
   * state that already existed. This is the difference between a user being told
   * once and being told every time the window is reopened.
   */
  hydrate(snapshot: CapacityCollectionSnapshot): void {
    for (const pool of snapshot.pools) this.memory.set(pool.poolKey, memoryOf(pool, 0));
    // A baseline also sets the ordering floor. Otherwise the collection that was
    // hydrated from could be replayed afterwards and be treated as news.
    this.lastCollectionRevision = snapshot.collectionRevision;
  }

  /**
   * Compare a snapshot against what this process last saw and return the intents.
   * A pool seen for the FIRST time only records a baseline: with no prior state
   * there is no transition, and a first sighting after a reload is indistinguishable
   * from a first sighting at startup — so neither may notify.
   */
  observe(snapshot: CapacityCollectionSnapshot, now: number = Date.now()): CapacityNotifyIntent[] {
    // An out-of-order or repeated collection is not news about anything. Rejecting
    // it WHOLESALE - before a single pool is inspected - is the only version of this
    // check that is safe, because a partial application would leave this module's
    // memory describing a collection that never existed.
    if (snapshot.collectionRevision <= this.lastCollectionRevision) return [];
    this.lastCollectionRevision = snapshot.collectionRevision;

    const intents: CapacityNotifyIntent[] = [];
    const seen = new Set<string>();
    for (const pool of snapshot.pools) {
      seen.add(pool.poolKey);
      const prev = this.memory.get(pool.poolKey);
      if (!prev) {                               // baseline only
        this.memory.set(pool.poolKey, memoryOf(pool, 0));
        continue;
      }
      const entered = prev.state !== pool.state;
      const episode = prev.episode + (entered ? 1 : 0);
      this.memory.set(pool.poolKey, memoryOf(pool, episode));
      if (!entered && prev.limitEpochAt === pool.limitEpochAt) continue;
      const kind = kindFor(prev.state, pool.state);
      if (!kind) continue;
      // Identity is keyed on the EPISODE THE TRANSITION IS ABOUT - never on a
      // timestamp or a revision. Repeated observations of one refusal share it; a
      // genuinely separate refusal does not. A reload cannot manufacture a new
      // epoch, because the epoch comes from the provider evidence rather than from
      // this process's lifetime.
      const scope = identityScope(kind, prev, pool, episode);
      const identity = `${pool.poolKey}|${kind}|${scope}`;
      if (this.emitted.has(identity)) continue;
      this.emitted.add(identity);
      intents.push({
        kind,
        poolKey: pool.poolKey,
        provider: pool.provider,
        from: prev.state,
        to: pool.state,
        stateReason: pool.stateReason,
        // The epoch the identity was scoped by, so a consumer reading the intent and
        // a consumer reading the identity string can never disagree about which
        // refusal is being reported.
        limitEpochAt: scope.startsWith('e') ? Number(scope.slice(1)) : null,
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

const memoryOf = (pool: PoolCapacitySnapshot, episode: number): PoolMemory => ({
  state: pool.state,
  limitEpochAt: pool.limitEpochAt,
  episode
});
