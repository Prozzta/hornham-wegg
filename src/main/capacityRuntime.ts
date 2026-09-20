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
import { CapacityAdmission, ADMISSION_REASON, type AdmissionDecision, type WorkClass } from './capacityAdmission';
import { CapacityNotifier, type CapacityNotifyIntent } from './capacityNotify';
import { ProviderCapacityTracker, staleLastKnown } from './providerCapacityTracker';
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

/** Why a claim is structurally dead at revalidation — see `CapacityRuntime.revalidate`. */
export const CLAIM_REASON = {
  TARGET: 'CLAIM_TARGET_MISMATCH',
  POOL: 'CLAIM_POOL_MOVED',
  EPOCH: 'CLAIM_EPOCH_CHANGED',
  GRANT: 'CLAIM_GRANT_LOST'
} as const;

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

/**
 * What an automatic submit presents when it asks to type: the decision it was
 * admitted under, who it is for, and the terminal it was taken for.
 *
 * BOTH AUTOMATIC SUBMIT PATHS PRESENT ONE OF THESE. The renderer delivery holds a
 * ticket and the main-process worker wake does not, but the question they ask at the
 * keystroke is identical - so it is asked in one place. A second copy of this check
 * would drift, and the two copies would disagree exactly when it mattered.
 */
export interface DeliveryClaim {
  decision: AdmissionDecision;
  agentId: string;
  workClass: WorkClass;
  /** The PTY the decision was taken for. A grant is not transferable. */
  target: string | null;
}

/**
 * A claim that was also given a TICKET, because its deliverer is out of process and
 * cannot be trusted to return the reservation - see `beginAutomaticDelivery`.
 */
interface PendingDelivery extends DeliveryClaim {
  timer: unknown;
  writeBegan: boolean;
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
  /**
   * Reservations handed out to an out-of-process deliverer, keyed by ticket.
   *
   * `writeBegan` IS THE FACT A15 FOUND MISSING, and it is the only new state here:
   * without it a ticket that dies AFTER the submit keystroke is byte-for-byte the
   * same object as one that dies BEFORE it. See `markAutomaticDeliveryWriting`.
   */
  private readonly pending = new Map<string, PendingDelivery>();
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

  /** The work MAY have started and only a person can say — see `holdGrantForHuman`. */
  holdGrant(decision: AdmissionDecision): void {
    this.admission.holdGrantForHuman(decision);
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
   * no pool, no capacity state. THE EXPIRY IS OWNED HERE. An unsettled ticket that
   * never reported a write returns its grant on a main-process timer, so the worst a
   * vanished caller can cost is one delivery window. An unsettled ticket that DID
   * report one keeps its turn spent, because the write may have landed — see
   * `markAutomaticDeliveryWriting`, where that asymmetry is argued. In neither case
   * is a reservation swallowed by a caller that never used it. That report is a
   * PRECONDITION the deliverer waits on, so "may have landed" is a statement about
   * causation here and not about message ordering.
   *
   * STATUS (L0-FUSION stage 5.5a): THE RENDERER NO LONGER HOLDS A TICKET AT ALL. Since
   * stage 5.3 the ticket door - `beginAutomaticDelivery`, `markAutomaticDeliveryWriting`,
   * `settleAutomaticDelivery` - and the boolean `maySubmitNow` / `holds` have NO
   * production caller: main's one submit owner admits, revalidates (`revalidate`, below)
   * and confirms in-process. Everything above describes a path that no longer runs. The
   * methods remain ONLY because their tests remain, and those are removed together, in
   * their own commit, once a validator has signed the test-by-test successor mapping
   * (test/l0-fusion-stage5-successor-mapping.md). Do not add a caller.
   */
  beginAutomaticDelivery(
    agentId: string,
    workClass: WorkClass = 'ORDINARY_TURN',
    /**
     * The PTY this delivery is for. A GRANT IS NOT TRANSFERABLE: bound here, at the
     * moment the ticket is minted, so a later keystroke naming a different terminal
     * cannot spend one agent's reservation on another agent's prompt. Null only for
     * a caller that has no terminal to name.
     */
    target: string | null = null
  ): AutomaticDeliveryGrant {
    const decision = this.admission.admit(agentId, workClass);
    if (decision.verdict === 'REFUSE') {
      return { ok: false, reason: decision.reason, poolKey: decision.poolKey ?? null };
    }
    const ticket = `cap-${(this.ticketSeq += 1)}`;
    const timer = this.setTimer(() => this.expireAutomaticDelivery(ticket), AUTO_DELIVERY_TTL_MS);
    if (timer && typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();
    this.pending.set(ticket, { decision, timer, writeBegan: false, agentId, workClass, target });
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

  /**
   * MAY the deliverer write the submit keystroke this ticket authorised?
   *
   * L0-FIX9 — THIS USED TO BE AN ANNOUNCEMENT AND IT IS NOW A PRECONDITION, because an
   * announcement nobody waits for is not an ordering. The first version was sent and
   * discarded, so the Enter could reach main first and a renderer that then died looked
   * exactly like one that never wrote — the very case A15 exists to separate. Whether
   * that actually happened was a property of the transport: measured at 7,060 trials on
   * Electron 32.3.3 with zero counterexamples, and documented nowhere, so the code was
   * entitled to nothing. THE REPAIR IS NOT BETTER EVIDENCE FOR THE ORDERING, IT IS NOT
   * NEEDING ONE: the deliverer waits for this answer and writes only on `true`, so the
   * mark HAPPENED-BEFORE the keystroke by causation rather than by luck.
   *
   * A15 — WHAT WAS MISSING WAS A FACT, NOT A CHECK. A deliverer that dies after the
   * Enter lands but before it settles leaves a ticket in EXACTLY the state a death
   * BEFORE the write leaves it in: minted, unsettled, silent. The expiry then
   * returned the grant as if nothing had started, permitting a SECOND recovery turn
   * in an epoch whose single turn a write that really did land had already spent.
   * Nothing distinguished the two, and no amount of waiting could: A TIMEOUT CANNOT
   * MANUFACTURE A FACT THAT WAS NEVER RECORDED. So the repair is to record it, and
   * that is the whole of the fix — the expiry and the TTL are untouched.
   *
   * WHY IT IS RECORDED BEFORE THE WRITE AND NOT AFTER IT. Either ordering leaves a
   * gap of one IPC round trip, and they fail in OPPOSITE directions. Marked BEFORE,
   * a death in the gap makes main believe a write that never happened: ONE MISSED
   * TURN, which is visible — the instruction sits unsent in the agent's prompt — and
   * a human can retry it. Marked AFTER, a death in the gap makes main believe no
   * write happened: a SECOND SEND of an instruction that already landed, which
   * nobody sees and nobody can undo. The gap does not close; it is pointed at the
   * recoverable failure.
   *
   * THE MARK GOVERNS ONLY THE SILENT CASE, NEVER AN ANSWER. If the deliverer is
   * still alive and reports a failed write, `settleAutomaticDelivery(ticket, false)`
   * returns the grant exactly as before: a live report is better evidence than an
   * inference drawn from silence, and a mark that overrode it would turn every
   * failed PTY write into a permanently swallowed turn.
   *
   * IT CARRIES NO CAPACITY MEANING. The deliverer says "I am about to type", just as
   * it already says "it started" or "it did not". It derives nothing, is told
   * nothing, and still holds only an opaque ticket; main keeps every decision,
   * including what an unmarked expiry is taken to mean.
   *
   * FALSE IS A REFUSAL, NOT AN ERROR, AND IT IS THE HALF THAT DOES REAL WORK. An
   * unknown ticket is one main has already reclaimed — expired, settled, or never
   * issued — so its reservation belongs to somebody else now and writing against it
   * would be an unauthorised send that no reservation covers. The old fire-and-forget
   * version permitted exactly that and could not have reported it.
   *
   * AND A REFUSAL MUST NEVER BE READ AS A MARK. Treating a failed or rejected answer as
   * though the ticket were marked converts a transport failure into a swallowed turn —
   * the opposite defect, and the one the live-settle carve-out below exists to prevent.
   * No answer means no keystroke.
   *
   * Idempotent: marking a live ticket twice answers `true` twice and spends nothing. A
   * mark can neither resurrect a reclaimed reservation nor attach itself to the next.
   */
  markAutomaticDeliveryWriting(ticket: string, target: string | null = null): boolean {
    const held = this.pending.get(ticket);
    if (!held) return false;
    if (!this.maySubmitNow(held, target)) return false;
    held.writeBegan = true;
    return true;
  }

  /**
   * Would this submission be admitted RIGHT NOW, as the holder of its own grant?
   *
   * PUBLIC, AND SHARED BY BOTH AUTOMATIC SUBMIT PATHS. The renderer delivery reaches
   * it through a ticket; the main-process worker wake calls it directly with the
   * decision it already holds. One check, so the two paths cannot drift apart - and so
   * that a future single submit transaction INHERITS it rather than reimplementing it.
   *
   * L0-TOCTOU. The old check was "is the ticket still in `pending`", which answers a
   * question nobody asked. A ticket is minted before the terminal is waited for,
   * before the payload is typed and before the TUI pause - AN INTERVAL IN WHICH THE
   * POOL CAN GO LIMITED OR RESERVE_ONLY, OR ENTER A NEW EPOCH - and none of that
   * removes the ticket from `pending`, so the delivery submitted anyway. That is not a
   * hypothetical ordering: it is the schedule this code already runs.
   *
   * IT RE-ASKS ADMISSION'S OWN QUESTION AGAINST THE CURRENT PROJECTION. Not a second
   * state table - this module cannot afford one, and the seam says so itself - and NOT
   * the decision that was taken at admission time, which cannot have changed and would
   * read as revalidation while checking nothing. The same rule, asked again, now.
   *
   * THE FOUR THINGS THE PROBE ALONE DOES NOT COVER, EACH WITH ITS OWN FAILURE:
   *  - THE TARGET. A grant is not transferable; a keystroke naming a different PTY
   *    than the ticket was minted for would spend one agent's turn on another's prompt.
   *  - THE MAPPING. An agent whose readings have since landed in a DIFFERENT pool is
   *    not the agent this decision was about, even if both pools happen to allow.
   *  - THE EPOCH. A new limit epoch has its own single recovery turn. Spending it
   *    through a ticket admitted under the previous one would consume a turn that
   *    `confirmLaunch` then refuses to record, because the grant ids do not match.
   *  - THE GRANT. A reservation abandoned on its TTL and re-taken by another caller
   *    lives in the same epoch under a different id.
   *
   * AND THE CARVE-OUT THAT MAKES THE PROBE USABLE AT ALL: a RECOVERING pool whose one
   * turn THIS ticket reserved answers REFUSE / RECOVERING_SPENT. Read naively that
   * aborts every recovery delivery ever granted - the guard mistaking its own
   * reservation for someone else's - so that single refusal is permitted, and only
   * when `holdsGrant` proves the reservation is still ours.
   *
   * TWO OF THESE CLAUSES CANNOT FIRE UNDER THE CURRENT CONSTANTS, AND I AM SAYING SO
   * RATHER THAN LETTING THE TESTS IMPLY OTHERWISE. Deleting the EPOCH clause, and
   * deleting the GRANT clause, each leaves every test in the suite green: no fixture
   * distinguishes them from the probe, because reaching either case needs the clock to
   * move further than a ticket lives. `AUTO_DELIVERY_TTL_MS` is 30 s, while a
   * reservation is abandoned at `RECOVERY_RESERVATION_TTL_MS` = 60 s and a second limit
   * epoch needs a recovery and a fresh hard reading — so a ticket is always gone first.
   *
   * THEY STAY, AND NOT OUT OF CAUTION. Each guards a case where the PROBE ALONE SAYS
   * YES and the answer is wrong: a grant abandoned on its TTL and re-taken leaves the
   * pool ALLOWING, and this ticket would type a turn `confirmLaunch` then refuses to
   * record, because the grant ids no longer match — a turn spent and not counted. The
   * relationship that makes that unreachable is between two tunable constants, so it is
   * one edit away from being reachable, and the clause is what stays correct across
   * that edit. A guard whose unreachability depends on a constant is not dead code; it
   * is a guard whose test is owed the day the constant moves.
   */
  maySubmitNow(held: DeliveryClaim, target: string | null): boolean {
    // The renderer ticket path's boolean. It is the collapse `revalidate` exists to
    // replace, kept only until that path is removed; the main-owned submit transaction
    // never reads it.
    return this.revalidate(held, target).verdict !== 'REFUSE';
  }

  /**
   * `maySubmitNow`'s question with its answer LEFT INTACT: the tri-state verdict and the
   * reason, for the main-owned submit transaction (`automaticSubmit.ts`).
   *
   * L0-FUSION section 3. The boolean above collapses three verdicts against `REFUSE`, so
   * UNKNOWN proceeded by an inequality nobody chose. The owner applies ONE named,
   * exhaustive resolver to what this returns — at ADMIT, before STAGE and at the final
   * revalidation — and that is only possible if the verdict reaches it uncollapsed.
   *
   * The four structural clauses are the same four, each now answering REFUSE under its
   * own reason rather than a bare `false`, and the carve-out is the same carve-out: a
   * RECOVERING pool whose single turn THIS claim reserved is ALLOW, not a refusal of the
   * claim by its own reservation.
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

  /**
   * The TTL ran out with this ticket still unsettled: the deliverer went away.
   *
   * The grant resolves to WHAT WAS RECORDED rather than to a constant `false`.
   * Unmarked, the write had not begun, nothing was spent, and the turn goes back —
   * the abandoned-before-launch case this expiry was built for, unchanged. Marked,
   * the write MAY have landed, so the turn is treated as SPENT: where the evidence
   * genuinely runs out we fail toward ALREADY LAUNCHED, because a missed turn is
   * visible and recoverable and a duplicate send is neither.
   */
  private expireAutomaticDelivery(ticket: string): void {
    const held = this.pending.get(ticket);
    if (!held) return;
    this.settleAutomaticDelivery(ticket, held.writeBegan);
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
    // Outstanding delivery tickets are resolved rather than abandoned: a grant that
    // outlived the runtime holding it would be spent on a turn that cannot now start
    // — UNLESS its write had already begun, in which case the turn started before we
    // stopped and returning the grant would authorise a second one. Same fact and the
    // same reading of it as the expiry, deliberately: A SHUTDOWN IS NOT NEW EVIDENCE
    // about which side of the write a delivery got to.
    for (const ticket of [...this.pending.keys()]) this.expireAutomaticDelivery(ticket);
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
