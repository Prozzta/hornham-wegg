/**
 * L0-WIRE — the main-process owner of provider capacity.
 *
 * WHAT WAS MISSING AND WHY IT MATTERED. The tracker, the admission seam and the
 * notifier were each correct in isolation and none of them ran. Production built a
 * tracker and called `ingest()`; nothing called `evaluate()`, so a reading never
 * expired and a reset boundary never passed unless a new reading happened to arrive.
 * Nothing consumed a verdict, so a LIMITED pool suppressed nothing. Nothing observed
 * the collection, so no transition was ever delivered. This object is the one place
 * those three are joined, and joining them is what the scopes already asked for:
 * the scheduler CONSUMES the state, main owns the DELIVERY LIFECYCLE, and freshness
 * is inert if nothing evaluates.
 *
 * NO POLLING, HERE OR ANYWHERE. There is exactly one timer and it is armed at the
 * next instant a projection could change on its own - the soonest of every pool's
 * staleness deadline and every open epoch's reset boundary, which the tracker
 * computes because only it holds the state those instants derive from. When nothing
 * is pending there is no timer at all. A fixed interval would have been simpler and
 * would have spent a wakeup every tick for a floor that is usually idle.
 *
 * AN AGENT BELONGS TO THE POOL ITS OWN READINGS LANDED IN. The mapping is recorded
 * from observations that actually arrived, never derived from a guessed limit id: a
 * pool key is `provider:accountScope:limitId`, and the limit id is a provider fact
 * this process cannot predict. An agent that has produced no reading maps to no
 * pool, and the seam answers UNKNOWN rather than inventing permission.
 *
 * NOTHING RENDERER. No IPC, no window, no web contents. Delivery is a callback the
 * owner supplies, so the decision to notify is testable without a display and a
 * renderer can never become the thing that dedupes.
 */
import { CapacityAdmission, ADMISSION_REASON, RECOVERY_RESERVATION_TTL_MS, type AdmissionDecision, type WorkClass } from './capacityAdmission';
import { CapacityNotifier, type CapacityNotifyIntent } from './capacityNotify';
import { ProviderCapacityTracker, staleLastKnown } from './providerCapacityTracker';
import { poolKeyOf as poolKeyFor, type CapacityCollectionSnapshot, type CapacityObservation }
  from '../shared/providerCapacity';
import type { AgyFamily } from './capacityNormalize';

/**
 * Never schedule a boundary closer than this. A reading whose deadline is already
 * upon us would otherwise re-arm in a tight loop while the clock caught up.
 */
const MIN_DELAY_MS = 250;

/**
 * Never wait longer than this for a single boundary, even when the next real one is
 * days away. A machine that suspends stops its timers; capping the wait means a
 * resumed process re-evaluates within a bounded period instead of honouring a
 * deadline the suspension already invalidated. It shortens sleep; it never
 * lengthens it, so it cannot delay a real boundary.
 */
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;

/** Why a claim is structurally dead at revalidation — see `CapacityRuntime.revalidate`. */
export const CLAIM_REASON = {
  TARGET: 'CLAIM_TARGET_MISMATCH',
  POOL: 'CLAIM_POOL_MOVED',
  EPOCH: 'CLAIM_EPOCH_CHANGED',
  GRANT: 'CLAIM_GRANT_LOST'
} as const;

export interface CapacityRuntimeDeps {
  /** Deliver decided transitions. Called only with a non-empty list. */
  deliver: (intents: CapacityNotifyIntent[]) => void;
  now?: () => number;
  /** Injected so a test can drive the boundary without waiting for a real timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Something a DISPLAY could show changed: a collection was published or an agent's
   * pool mapping moved. Called after `deliver`, so a notice decided in the same
   * publication is already recorded when the display re-projects. Optional, and it
   * feeds nothing back: display is downstream of every decision made here.
   */
  onChange?: () => void;
  /**
   * v1.1.45 CRIT-15-PRE: the admission ledger moved (a grant reserved, confirmed, held for
   * a person or returned), or a reservation nobody resolved has just lapsed on its TTL. An
   * agent's impact string reads that ledger, so main re-pushes impacts on this instead of
   * a renderer polling for it. Optional, and it feeds nothing back.
   */
  onAdmission?: () => void;
}

/**
 * What an automatic submit presents when it asks to type: the decision it was
 * admitted under, who it is for, and the terminal it was taken for.
 *
 * EVERY AUTOMATIC SUBMIT PRESENTS ONE OF THESE, to `revalidate`. The question asked at
 * the keystroke is identical whatever the delivery is - so it is asked in one place. A
 * second copy of this check would drift, and the two copies would disagree exactly when
 * it mattered.
 */
export interface DeliveryClaim {
  decision: AdmissionDecision;
  agentId: string;
  workClass: WorkClass;
  /** The PTY the decision was taken for. A grant is not transferable. */
  target: string | null;
}

export class CapacityRuntime {
  readonly tracker: ProviderCapacityTracker;
  readonly admission: CapacityAdmission;
  private readonly notifier = new CapacityNotifier();
  private readonly poolForAgent = new Map<string, string>();
  /** agentId → the Antigravity ACCOUNT scope its accepted ticks came from. Lets Monitor
   *  name the sibling family an agent is not gated by, without making it a member of it. */
  private readonly agyScopeByAgent = new Map<string, string>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  private readonly lapseTimers = new Set<unknown>();
  private stopped = false;

  constructor(private readonly deps: CapacityRuntimeDeps, tracker = new ProviderCapacityTracker()) {
    this.tracker = tracker;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.admission = new CapacityAdmission({
      poolKeyForAgent: (agentId) => this.poolForAgent.get(agentId) ?? null,
      poolState: (poolKey) => this.tracker.pool(poolKey),
      collectionAdmission: () => this.tracker.collectionAdmission(),
      staleLastKnown,
      postResetProbeKey: (poolKey) => this.tracker.postResetProbeKey(poolKey),
      now: this.now
    });
  }

  /**
   * A reading arrived from a collector, attributed to the agent whose session
   * produced it.
   *
   * THE MAPPING COMMITS WITH THE READING, NOT BEFORE IT. It used to be recorded
   * first, on the reasoning that even a duplicate proves which pool an agent draws
   * on. That is true of a DUPLICATE and false of a REJECTED reading, and the two
   * were not distinguished: a future-dated observation — invalid, discarded, and
   * exactly the shape a clock skew or a forged timestamp produces — still retargeted
   * the agent, moving it off an accepted LIMITED pool and onto whatever the rejected
   * reading named. Evidence that was not good enough to change the pool must not be
   * good enough to change who belongs to it.
   *
   * An accepted duplicate or renewal still commits the mapping: it is a valid
   * reading that happens to say nothing new, which is why acceptance and change are
   * separate answers here.
   */
  ingest(agentId: string | null, obs: CapacityObservation): void {
    const result = this.tracker.ingestDetailed(obs);
    const moved = !!agentId && result.accepted && this.poolForAgent.get(agentId) !== obs.poolKey;
    if (agentId && result.accepted) this.poolForAgent.set(agentId, obs.poolKey);
    if (result.changed) this.publish();
    else if (moved) this.deps.onChange?.();
    this.rearm();
  }

/**
   * ONE Antigravity statusline tick: two observations, ingested as a COHERENT PAIR.
   *
   * WHY THIS EXISTS AND `ingest` COULD NOT BE REUSED (design 1.3). A tick describes TWO
   * pools - the account's 3P allowance and its Gemini allowance - and `ingest` records
   * `poolForAgent` per call, so calling it twice would leave the agent mapped to whichever
   * observation went in LAST. The agent draws on exactly one of the two, chosen by the
   * model in that same tick, so the mapping has to be decided for the pair rather than by
   * arrival order.
   *
   * ALL OR NOTHING FOR THE BINDING. Both observations are offered to the tracker, but the
   * agent is re-mapped only if BOTH were accepted and the pair is coherent (same provider,
   * same account scope, exactly the 3p and gemini pool keys of that scope). A tick we
   * could not accept whole must not move an agent off a pool it is currently gated by -
   * the same rule `ingest` applies to a single rejected reading, one level up.
   *
   * `agentId` is null for the user's OWN interactive AGY session: both pools are still
   * ingested and displayed, because capacity is account-wide, but no hive member and no
   * wake lifecycle is invented for a session nobody spawned.
   *
   * At most one publish, one onChange and one rearm for the pair, so a tick that moves
   * both pools is still a single push.
   */
  ingestAgyTick(agentId: string | null, tick: {
    accountScope: string;
    activeLimitId: AgyFamily;
    observations: readonly [CapacityObservation, CapacityObservation];
  }): void {
    const [a, b] = tick.observations;
    const coherent = a.provider === 'antigravity' && b.provider === 'antigravity'
      && a.accountScope === tick.accountScope && b.accountScope === tick.accountScope
      && a.poolKey === poolKeyFor('antigravity', tick.accountScope, '3p')
      && b.poolKey === poolKeyFor('antigravity', tick.accountScope, 'gemini');

    const ra = this.tracker.ingestDetailed(a);
    const rb = this.tracker.ingestDetailed(b);

    let moved = false;
    if (agentId && coherent && ra.accepted && rb.accepted) {
      const active = tick.activeLimitId === 'gemini' ? b : a;
      moved = this.poolForAgent.get(agentId) !== active.poolKey;
      this.poolForAgent.set(agentId, active.poolKey);
      // Which ACCOUNT this agent draws on, so Monitor can name the sibling family it is
      // not gated by. Committed with the mapping, for the same reason.
      this.agyScopeByAgent.set(agentId, tick.accountScope);
    }

    if (ra.changed || rb.changed) this.publish();
    else if (moved) this.deps.onChange?.();
    this.rearm();
  }

  /**
   * The pool key for ONE of this agent's two Antigravity families, or null.
   *
   * For Monitor, which shows both families of the account an agent draws on. It reads the
   * account scope committed with an ACCEPTED tick, so it can never invent a pool for an
   * agent whose readings were refused. It does NOT make the agent a member of the
   * inactive family: admission, recovery grants and final revalidation all continue to
   * use the one active `poolForAgent` mapping, so a 3P zero cannot block a Gemini turn.
   */
  poolKeyForAgyFamily(agentId: string, family: AgyFamily): string | null {
    const scope = this.agyScopeByAgent.get(agentId);
    return scope ? poolKeyFor('antigravity', scope, family) : null;
  }

  /** Agents whose own accepted readings landed in this pool. A copy: never a handle. */
  membersOf(poolKey: string): string[] {
    const out: string[] = [];
    for (const [agentId, key] of this.poolForAgent) if (key === poolKey) out.push(agentId);
    return out;
  }

  /** The pool this agent's own accepted readings landed in, or null. */
  poolKeyOf(agentId: string): string | null {
    return this.poolForAgent.get(agentId) ?? null;
  }

  /** Whether this agent has produced any accepted reading, i.e. has a known pool. */
  hasPool(agentId: string): boolean {
    return this.poolForAgent.has(agentId);
  }

  /** May this agent start this unit of work? See `CapacityAdmission`. */
  admit(agentId: string, workClass: WorkClass = 'ORDINARY_TURN'): AdmissionDecision {
    const decision = this.admission.admit(agentId, workClass);
    if (decision.grantId) this.armReservationLapse();
    this.admissionMoved();
    return decision;
  }

  /** The work really started — commit any recovery grant the decision reserved. */
  confirmLaunch(decision: AdmissionDecision): void {
    this.admission.confirmLaunch(decision);
    this.admissionMoved();
  }

  /** The work MAY have started and only a person can say — see `holdGrantForHuman`. */
  holdGrant(decision: AdmissionDecision): void {
    this.admission.holdGrantForHuman(decision);
    this.admissionMoved();
  }

  /** The work did not start after all — return any reservation it held. */
  cancelGrant(decision: AdmissionDecision): void {
    this.admission.cancelGrant(decision);
    this.admissionMoved();
  }

  private admissionMoved(): void {
    try { this.deps.onAdmission?.(); } catch { /* display never decides */ }
  }

  /** An unresolved reservation lapses on its TTL with no event; one one-shot marks the lapse. */
  private armReservationLapse(): void {
    if (!this.deps.onAdmission || this.stopped) return;
    const handle = this.setTimer(() => {
      this.lapseTimers.delete(handle);
      if (!this.stopped) this.admissionMoved();
    }, RECOVERY_RESERVATION_TTL_MS + 1);
    this.lapseTimers.add(handle);
  }

  /**
   * Would this submission be admitted RIGHT NOW, as the holder of its own grant? The
   * tri-state verdict and the reason, for the main-owned submit transaction
   * (`automaticSubmit.ts`).
   *
   * L0-TOCTOU. A claim is admitted before the terminal is waited for, before the payload
   * is typed and before the TUI pause - AN INTERVAL IN WHICH THE POOL CAN GO LIMITED OR
   * RESERVE_ONLY, OR ENTER A NEW EPOCH. So this RE-ASKS ADMISSION'S OWN QUESTION AGAINST
   * THE CURRENT PROJECTION: not a second state table, and NOT the decision that was taken
   * at admission time, which cannot have changed and would read as revalidation while
   * checking nothing. The same rule, asked again, now.
   *
   * L0-FUSION section 3. THE VERDICT IS RETURNED UNCOLLAPSED. A boolean collapses three
   * verdicts against `REFUSE`, so UNKNOWN proceeds by an inequality nobody chose. The
   * owner applies ONE named, exhaustive resolver to what this returns — at ADMIT, before
   * STAGE and at the final revalidation — and that is only possible if the verdict
   * reaches it intact.
   *
   * THE FOUR THINGS THE PROBE ALONE DOES NOT COVER, each answering REFUSE under its own
   * reason:
   *  - THE TARGET. A grant is not transferable; a keystroke naming a different PTY than
   *    the claim was taken for would spend one agent's turn on another's prompt.
   *  - THE MAPPING. An agent whose readings have since landed in a DIFFERENT pool is
   *    not the agent this decision was about, even if both pools happen to allow.
   *  - THE EPOCH. A new limit epoch has its own single recovery turn. Spending it under
   *    a claim admitted in the previous one would consume a turn that `confirmLaunch`
   *    then refuses to record, because the grant ids do not match.
   *  - THE GRANT. A reservation abandoned on its TTL and re-taken by another caller
   *    lives in the same epoch under a different id.
   *
   * AND THE CARVE-OUT THAT MAKES THE PROBE USABLE AT ALL: a RECOVERING pool whose one
   * turn THIS claim reserved answers REFUSE / RECOVERING_SPENT. Read naively that aborts
   * every recovery delivery ever granted - the guard mistaking its own reservation for
   * someone else's - so that single refusal is ALLOW, and only when `holdsGrant` proves
   * the reservation is still ours.
   */
  revalidate(held: DeliveryClaim, target: string | null): { verdict: AdmissionDecision['verdict']; reason: string } {
    if (held.target !== target) return { verdict: 'REFUSE', reason: CLAIM_REASON.TARGET };
    if ((this.poolForAgent.get(held.agentId) ?? null) !== held.decision.poolKey) {
      return { verdict: 'REFUSE', reason: CLAIM_REASON.POOL };
    }
    const pool = held.decision.poolKey ? this.tracker.pool(held.decision.poolKey) : null;
    if ((pool?.limitEpochAt ?? null) !== held.decision.limitEpochAt) {
      return { verdict: 'REFUSE', reason: CLAIM_REASON.EPOCH };
    }
    if (held.decision.grantId && !this.admission.holdsGrant(held.decision)) {
      return { verdict: 'REFUSE', reason: CLAIM_REASON.GRANT };
    }
    const now = this.admission.probe(held.agentId, held.workClass);
    if (now.verdict === 'REFUSE' && now.reason === ADMISSION_REASON.RECOVERING_SPENT
      && this.admission.holdsGrant(held.decision)) {
      return { verdict: 'ALLOW', reason: ADMISSION_REASON.RECOVERING_GRANT };
    }
    // The same carve-out for the post-reset probe ("1a"): the pool refuses everyone ELSE
    // because THIS claim holds the one probe. That is not a refusal of it.
    if (now.verdict === 'REFUSE' && now.reason === ADMISSION_REASON.POST_RESET_PROBE_SPENT
      && this.admission.holdsGrant(held.decision)) {
      return { verdict: 'ALLOW', reason: ADMISSION_REASON.POST_RESET_PROBE_GRANT };
    }
    return { verdict: now.verdict, reason: now.reason };
  }

  snapshot(): CapacityCollectionSnapshot {
    return this.tracker.snapshot();
  }

  /**
   * Adopt the current collection as the baseline WITHOUT notifying. For a restart
   * or a re-subscribe: a first sighting is not a transition, and telling a user
   * about a refusal they were told about an hour ago is the failure this prevents.
   */
  hydrate(): void {
    this.notifier.hydrate(this.tracker.snapshot());
  }

  /** Release the timer. After this the runtime observes nothing further. */
  stop(): void {
    this.stopped = true;
    this.disarm();
    for (const handle of this.lapseTimers) this.clearTimer(handle);
    this.lapseTimers.clear();
  }

  /**
   * The boundary fired: time has passed and something may have changed with no new
   * reading at all. This is the callback the audit correctly observed was never
   * scheduled — the reset tests simulated it by calling `evaluate()` directly.
   */
  private tick(): void {
    this.timer = null;
    if (this.stopped) return;
    if (this.tracker.evaluate()) this.publish();
    this.rearm();
  }

  private publish(): void {
    const intents = this.notifier.observe(this.tracker.snapshot(), this.now());
    if (intents.length) this.deps.deliver(intents);
    this.deps.onChange?.();
  }

  /**
   * Arm the single timer for the next instant anything can change. Re-arming from
   * scratch each time — rather than keeping a timer and checking whether it is still
   * right — means the schedule is always derived from current state, so a new
   * reading that brings a boundary forward cannot be missed.
   */
  private rearm(): void {
    this.disarm();
    if (this.stopped) return;
    const delay = this.tracker.nextBoundaryDelayMs();
    if (delay === null) return;
    const wait = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, delay));
    const handle = this.setTimer(() => this.tick(), wait);
    // A capacity boundary must never be the reason this process stays alive.
    if (handle && typeof (handle as NodeJS.Timeout).unref === 'function') (handle as NodeJS.Timeout).unref();
    this.timer = handle;
  }

  private disarm(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
