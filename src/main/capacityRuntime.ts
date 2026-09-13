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
import { CapacityAdmission, type AdmissionDecision, type WorkClass } from './capacityAdmission';
import { CapacityNotifier, type CapacityNotifyIntent } from './capacityNotify';
import { ProviderCapacityTracker } from './providerCapacityTracker';
import type { CapacityCollectionSnapshot, CapacityObservation } from '../shared/providerCapacity';

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

/**
 * How long a delivery ticket may stay unsettled before its reservation is returned.
 *
 * Generous against the real path it covers - a renderer write chain waits for the
 * terminal, types, waits 140ms, submits, then settles - and short against the thing
 * it protects, which is a recovery turn reserved forever by a caller that went away.
 * Expiring EARLY only ever releases a grant that can be taken again; expiring never
 * loses it permanently, so the failure directions are not symmetric.
 */
const AUTO_DELIVERY_TTL_MS = 30_000;

/** What a deliverer receives. On refusal, no ticket exists to settle. */
export type AutomaticDeliveryGrant =
  | { ok: true; ticket: string }
  | { ok: false; reason: string; poolKey: string | null };

export interface CapacityRuntimeDeps {
  /** Deliver decided transitions. Called only with a non-empty list. */
  deliver: (intents: CapacityNotifyIntent[]) => void;
  now?: () => number;
  /** Injected so a test can drive the boundary without waiting for a real timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class CapacityRuntime {
  readonly tracker: ProviderCapacityTracker;
  readonly admission: CapacityAdmission;
  private readonly notifier = new CapacityNotifier();
  private readonly poolForAgent = new Map<string, string>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  private stopped = false;
  /** Reservations handed out to an out-of-process deliverer, keyed by ticket. */
  private readonly pending = new Map<string, { decision: AdmissionDecision; timer: unknown }>();
  private ticketSeq = 0;

  constructor(private readonly deps: CapacityRuntimeDeps, tracker = new ProviderCapacityTracker()) {
    this.tracker = tracker;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.admission = new CapacityAdmission({
      poolKeyForAgent: (agentId) => this.poolForAgent.get(agentId) ?? null,
      poolState: (poolKey) => this.tracker.pool(poolKey),
      collectionAdmission: () => this.tracker.collectionAdmission(),
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
    if (agentId && result.accepted) this.poolForAgent.set(agentId, obs.poolKey);
    if (result.changed) this.publish();
    this.rearm();
  }

  /**
   * Would this agent be refused right now? Asks WITHOUT taking the epoch's recovery
   * turn, so it is safe to call on every queue tick. See `CapacityAdmission.probe`.
   */
  holds(agentId: string, workClass: WorkClass = 'ORDINARY_TURN'): boolean {
    return this.admission.probe(agentId, workClass).verdict === 'REFUSE';
  }

  /** May this agent start this unit of work? See `CapacityAdmission`. */
  admit(agentId: string, workClass: WorkClass = 'ORDINARY_TURN'): AdmissionDecision {
    return this.admission.admit(agentId, workClass);
  }

  /** The work really started — commit any recovery grant the decision reserved. */
  confirmLaunch(decision: AdmissionDecision): void {
    this.admission.confirmLaunch(decision);
  }

  /** The work did not start after all — return any reservation it held. */
  cancelGrant(decision: AdmissionDecision): void {
    this.admission.cancelGrant(decision);
  }

  /**
   * Begin an AUTOMATIC delivery that another process will perform.
   *
   * WHY THIS EXISTS AND WHY `holds()` WAS NOT ENOUGH. `holds()` probes: it answers
   * without reserving, which is right for a snapshot read that happens on every
   * queue tick and wrong for the dispatch that snapshot authorises. A gate's job is
   * not only to avoid spending the epoch's single recovery turn on a question - it
   * is to make the dispatch it authorises BE THE THING THAT SPENDS IT. With only a
   * probe in front of it, two agents on one RECOVERING pool both read "not held" and
   * both launch, and so do two deliveries to one agent before either is confirmed:
   * nothing reserved, so there was nothing for the second to find taken.
   *
   * THE RENDERER MUST NOT HOLD HALF A TRANSACTION. It cannot be trusted to return a
   * reservation - it can be reloaded, occluded, throttled or closed between the two
   * calls - so what it receives is an opaque ticket and nothing else: no decision,
   * no pool, no capacity state. THE EXPIRY IS OWNED HERE. An unsettled ticket
   * returns its grant on a main-process timer, so the worst a vanished caller can
   * cost is one delivery window, never a permanently swallowed recovery turn.
   */
  beginAutomaticDelivery(
    agentId: string,
    workClass: WorkClass = 'ORDINARY_TURN'
  ): AutomaticDeliveryGrant {
    const decision = this.admission.admit(agentId, workClass);
    if (decision.verdict === 'REFUSE') {
      return { ok: false, reason: decision.reason, poolKey: decision.poolKey ?? null };
    }
    const ticket = `cap-${(this.ticketSeq += 1)}`;
    const timer = this.setTimer(() => this.settleAutomaticDelivery(ticket, false), AUTO_DELIVERY_TTL_MS);
    if (timer && typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();
    this.pending.set(ticket, { decision, timer });
    return { ok: true, ticket };
  }

  /**
   * The delivery this ticket authorised either happened or did not.
   *
   * Idempotent, and deliberately silent about an unknown ticket: the expiry above
   * and a late renderer answer race by construction, and the settled-first winner is
   * always correct because both say the same thing about a grant that is already
   * back. `launched` confirms; anything else returns the reservation.
   */
  settleAutomaticDelivery(ticket: string, launched: boolean): void {
    const held = this.pending.get(ticket);
    if (!held) return;
    this.pending.delete(ticket);
    this.clearTimer(held.timer);
    if (launched) this.admission.confirmLaunch(held.decision);
    else this.admission.cancelGrant(held.decision);
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
    // Outstanding delivery tickets are returned rather than abandoned: a grant that
    // outlived the runtime holding it would be spent on a turn that cannot now start.
    for (const ticket of [...this.pending.keys()]) this.settleAutomaticDelivery(ticket, false);
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
