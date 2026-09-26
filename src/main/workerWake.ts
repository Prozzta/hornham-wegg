/**
 * The inbox-wake COORDINATOR (pre-M1 event-wake bridge; was the #151 worker watchdog).
 *
 * WHAT IT DECIDES. Which agent - any agent, god included - gets ONE guarded inbox-wake
 * turn, for which inbox message ids, and what happened to those ids afterwards. It types
 * nothing: every wake goes through the one main-owned submit transaction
 * (`AutomaticSubmitOwner.submit`, CAPACITY_GATED), which owns admission, the prompt and
 * human-input guards, the final revalidation and the Enter.
 *
 * WHO FEEDS IT. Events first: a durable inbox write (`HiveManager.setDeliveryObserver`),
 * hook lifecycle edges (Stop, idle Notification, eligible SubagentStop), control releases
 * and capacity changes. The 15s main beat is RECONCILIATION over the same state - it
 * finds ids a lost callback or a restart missed. Both paths claim through `claim()`; there
 * is no second decision path and no god special case.
 *
 * PER AGENT: one pending set, one in-flight claim, one held (INTERFERED) claim, and
 * per-message-id dedup. Duplicate delivery / hook / control / scan signals coalesce; they
 * can never produce a second turn.
 *
 *  - pendingIds    observed in the inbox, not yet in a committed wake;
 *  - announcedIds  in a COMMITTED wake, while still on disk (never re-announced);
 *  - inFlight      the sole claimed submission (immutable: new mail waits for the next edge);
 *  - held          an INTERFERED claim, until a human says SEND_AGAIN or ALREADY_HANDLED.
 *
 * Ids are ANNOUNCED ONLY AFTER COMMITTED. REFUSED / ABORTED / FAILED / REJECTED release
 * them back to pending; INTERFERED holds them; HUMAN_HANDLED is terminal.
 *
 * No electron import, clock injected - every race is driven synchronously in tests.
 */
import { createHash } from 'node:crypto';

/** The #151 nudge text, kept for reference; the wake itself uses `inboxNudgeText(ids)`. */
export const WORKER_WAKE_NUDGE =
  'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.';

/** Reconciliation fallback: no PTY output for this long = quiescent (renderer QUIESCE_IDLE_MS). */
export const WORKER_WAKE_IDLE_MS = 12_000;
/** Never wake inside the boot sequence (renderer BOOT_GRACE_MS). */
export const WORKER_WAKE_BOOT_GRACE_MS = 35_000;
/** Reconciliation only: minimum gap between two scan-driven attempts for one agent. */
export const WORKER_WAKE_COOLDOWN_MS = 60_000;
/** A permission/HITL notification blocks wakes for this long after it fires. */
export const WORKER_WAKE_HITL_REARM_MS = 5 * 60_000;

/**
 * How long a freshly opened active epoch refuses native IDLE readings (Jim, c4 audit).
 *
 * A statusline tick is dated by GENERATION, not by arrival. Several are in flight at once
 * (one short-lived shim process per render), and agy keeps truthfully rendering `idle`
 * until it has actually processed the prompt we just typed - the typed nudge itself
 * causes renders. So right after a COMMITTED wake there is a systematically populated
 * window of idle readings that describe the turn BEFORE this one. Believing one closes
 * the epoch we just opened, and because event-mode `claim()` tests only the lifecycle -
 * no quiescence - the next pending message is typed straight into the live turn.
 *
 * Five seconds is several times the render period, so a genuinely idle agent is accepted
 * on the next tick after the grace (the statusline goes on rendering while idle - that is
 * the premise of the duplicate-tick test). Stall recovery is measured in minutes and is
 * untouched. It deliberately does NOT require a running tick first: a turn that finishes
 * inside the grace without ever rendering `working` would otherwise be stuck active,
 * which is the very stall c4 exists to remove.
 */
export const PROVIDER_IDLE_CONFIRM_MS = 5_000;

/**
 * AGY-FALSEACTIVE-STALL (Jim, WAKE-BUGS-152 (1)). How long after a terminal Stop a provider
 * `running` reading is presumed to describe the turn that Stop just ended. On the live floor
 * AGY went on rendering `running` for up to 2.6 s after its own Stop hook, and that stale
 * tick opened a new active epoch nothing would ever close. A reading inside this window
 * opens nothing unless a turn start (our COMMITTED submit, UserPromptSubmit, PreInvocation)
 * came after the Stop.
 */
export const STOP_SETTLE_MS = 5_000;

/**
 * CODEX-FALSEACTIVE-153 (Jim). Our own `COMMITTED` is evidence that the Enter went out, not
 * that the provider started a turn: Dwight's typed nudge never became a Codex turn, and with
 * no turn nothing could ever close the epoch. For a provider that reports turn starts, the
 * epoch our submit opens is PROVISIONAL until the provider confirms one; unconfirmed this
 * long, the lifecycle goes back to `unknown` and the claim's ids are re-pended ONCE.
 */
export const SUBMIT_CONFIRM_MS = 60_000;

/**
 * WAKE-NO-PENDING-IDS hardening (Jim, WAKE-BUGS-152 (2)). An id announced this long ago and
 * still on disk when the agent is idle again was overlooked (or its turn failed); it is
 * re-pended ONCE, so it is announced one more time and never looped.
 */
export const REANNOUNCE_AFTER_MS = 3 * 60_000;

/** A hook event message that means "the agent needs the human" — permission /
 *  approve / confirm prompts (mirrors the renderer's needsHuman detection in
 *  useHive.ts). Anything matching the idle-waiting shape is NOT a HITL hold. */
export type HookClass = 'needsHuman' | 'idle' | null;

export function classifyHook(event: string | undefined, message: string | undefined): HookClass {
  if (event === 'Notification') {
    const msg = (message ?? '').toLowerCase();
    const idleWaiting = !msg
      || msg.includes('waiting for your input')
      || msg.includes('is idle')
      || msg.includes('waiting for input');
    const needsHuman = msg.includes('permission')
      || msg.includes('approve')
      || msg.includes('confirm')
      || msg.includes('needs your');
    if (needsHuman && !idleWaiting) return 'needsHuman';
    return 'idle';
  }
  return null;
}

/**
 * Hook events that prove the main agent is working (a stale idle assertion is cleared).
 *
 * `SessionStart` is deliberately NOT one of them, and this is the 1.1.46 floor-stall in one
 * line. Every CLI fires it while it BOOTS, before anything has been submitted to it, so
 * counting it as an active turn labelled every freshly spawned agent active while it sat
 * parked at its prompt. The only way back to `idle` is a `Stop`, which a turn that never
 * started cannot emit, so event wakes (which need recorded idle) and the reconciliation
 * beat (which under D3 lets PTY silence stand in only for an UNKNOWN lifecycle) both
 * refused every wake for the life of the process. In 1.1.45 the renderer's 4s inbox poll
 * had covered it regardless of lifecycle; C3 deleted that, and no producer was left.
 *
 * A session boundary means the PREVIOUS turn is moot, not that a new one is running, so it
 * is handled as `unknown` below — which routes it into the already-ratified
 * `unknown && quiescent` recovery, behind boot grace. D3 is untouched: a turn that really
 * starts supplies `UserPromptSubmit` (and then `PreToolUse`) immediately, and stays
 * unclaimable through any length of silent tool until it says `Stop`.
 */
const ACTIVE_EVENTS = new Set(['UserPromptSubmit', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact']);

/**
 * The canonical provider-native lifecycle, as the AGY statusline normaliser states it.
 * It is NOT derived here and never inferred from silence, from the renderer, from inbox
 * age or from the stall watchdog — it is read off a version-validated tick and nothing
 * else. This is the authoritative recovery input the 1.1.47 false-active stall lacked:
 * a `COMMITTED` wake opens an active epoch, and before this there was no observation in
 * the main process capable of closing one once its terminal hook was lost.
 */
export type ProviderStatus = 'idle' | 'running' | 'waiting_for_confirmation';

export type WakeLifecycle = 'active' | 'idle' | 'unknown';
/** Why a wake was attempted (breadcrumbs only; never a decision input). */
export type WakeCause = 'delivery' | 'hook' | 'control' | 'capacity' | 'interference' | 'reconcile' | 'renderer';
/** `event`: needs recorded lifecycle-idle evidence. `reconcile`: may also use PTY quiescence. */
export type WakeMode = 'event' | 'reconcile';

/** One agent's live facts, gathered by the caller immediately before a claim. */
export interface WorkerWakeFacts {
  agentId: string;
  /** Live PTY id, or undefined when the agent has no terminal. */
  ptyId?: string;
  /** Timestamp of the PTY's last output (0 = never output). */
  lastOutputAt: number;
  /** ControlRegistry snapshot flags. */
  autoDeliveryPaused: boolean;
  paused: boolean;
  halted: boolean;
  /** The submit owner holds an unresolved INTERFERED inhibition on this PTY. */
  inhibited?: boolean;
}

/** One immutable claimed batch. */
export interface WakeClaim {
  agentId: string;
  requestId: string;
  /** Sorted, unique. Never enlarged after the claim. */
  ids: readonly string[];
  cause: WakeCause;
  /** The ids of an earlier nudge that was typed but never confirmed as a provider turn.
   *  That nudge may still sit UNSENT in the composer, so the owner must see it absent from
   *  the prompt before typing this one (never double-typed). Absent = no such check. */
  recheck?: readonly string[];
}

export type InterferenceHow = 'SEND_AGAIN' | 'ALREADY_HANDLED';

interface AgentWake {
  pending: Set<string>;
  announced: Set<string>;
  inFlight: WakeClaim | null;
  held: WakeClaim | null;
  lifecycle: WakeLifecycle;
  lastHumanNeedsAt: number;
  lastReconcileAttemptAt: number;
  /** The provider session this agent's native status ticks speak for, once one has
   *  been learned. Null = nothing learned yet (accept and learn from the next tick). */
  providerSession: string | null;
  /** When the most recent active epoch opened (0 = none ever). Terminal proof must be
   *  newer than this, so a reading that predates the turn cannot close it. It is only
   *  ever read while the lifecycle IS active, so the hook path deliberately leaves a
   *  spent value in place rather than spending a write clearing it. */
  activeSince: number;
  /** Turns whose Stop has been recorded, newest last, bounded (FALSEACTIVE-STALL-2). A
   *  tool event that names one of these arrived after its own turn ended. */
  closedTurns: string[];
  /** The Codex turn the lifecycle is active FOR, when a hook named it (null otherwise).
   *  B1 closes a lost Stop only with a completion of exactly this turn. */
  openTurnId: string | null;
  /** When the last terminal Stop was recorded (0 = none). */
  stoppedAt: number;
  /** When the provider last said a turn STARTED (an active hook, a confirming reading). */
  turnStartAt: number;
  /** The active epoch was opened by our COMMITTED and the provider has not confirmed a
   *  turn yet (only for a provider that reports turn starts). */
  provisional: boolean;
  /** When the current in-flight claim was taken (a turn start after it confirms it). */
  claimedAt: number;
  /** The ids of the commit that opened the provisional epoch. */
  commitIds: readonly string[];
  /** An idle reading refused only by the confirm grace, applied on a later beat unless
   *  something newer said active (0 = none). */
  pendingIdleAt: number;
  /** id -> when it was announced (COMMITTED). */
  announcedAt: Map<string, number>;
  /** Ids already re-pended once (unconfirmed submit or stale announcement). Never again. */
  reannounced: Set<string>;
  /** See WakeClaim.recheck; carried until a claim that checked it COMMITS. */
  recheck: readonly string[] | null;
  /** AGY's last invocation hook was PreInvocation (a model call is running): a deferred
   *  idle is not applied until PostInvocation or a Stop says it ended. */
  invoking: boolean;
}

/** What a reconcile beat changed for one agent (null = nothing). */
export type WakeBeatEdge =
  | { kind: 'deferred-idle' }
  | { kind: 'submit-unconfirmed'; ids: readonly string[] }
  | { kind: 'reannounce'; ids: readonly string[] };

/** How many closed turn ids are remembered per agent. Only a straggler of a RECENT turn
 *  can still be in flight, so a short window is enough. */
const CLOSED_TURN_MEMORY = 16;
/** Events that can only happen INSIDE a turn. A late one from a closed turn is stale. A
 *  UserPromptSubmit is not in here: a new prompt is never a straggler of an old turn. */
const IN_TURN_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/** `inbox-wake:<agent>:<sha256 of the sorted ids>` - the same batch always has the same id. */
export function inboxWakeRequestId(agentId: string, ids: readonly string[]): string {
  const digest = createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
  return `inbox-wake:${agentId}:${digest}`;
}

export class WorkerWakeWatchdog {
  /** ptyId → spawn timestamp (boot grace). */
  private spawnedAt = new Map<string, number>();
  private agents = new Map<string, AgentWake>();
  /** DIAGNOSIS ONLY (diag-1.1.46-wake): the guard that refused this agent's last claim. */
  private lastWhy = new Map<string, string>();

  /** DIAGNOSIS ONLY: why `claim()` last returned null for this agent ('' = it claimed). */
  whyNoClaim(agentId: string): string {
    return this.lastWhy.get(agentId) ?? '';
  }

  private rec(agentId: string): AgentWake {
    let r = this.agents.get(agentId);
    if (!r) {
      r = {
        pending: new Set(), announced: new Set(), inFlight: null, held: null, lifecycle: 'unknown', lastHumanNeedsAt: 0, lastReconcileAttemptAt: 0, providerSession: null, activeSince: 0, closedTurns: [], openTurnId: null,
        stoppedAt: 0, turnStartAt: 0, provisional: false, claimedAt: 0, commitIds: [], pendingIdleAt: 0, announcedAt: new Map(), reannounced: new Set(), recheck: null, invoking: false
      };
      this.agents.set(agentId, r);
    }
    return r;
  }

  /** The provider said a turn started: a provisional epoch is confirmed, and an idle
   *  reading deferred before this is overtaken. */
  private turnStarted(r: AgentWake, at: number): void {
    r.turnStartAt = Math.max(r.turnStartAt, at);
    r.provisional = false;
    if (r.pendingIdleAt > 0 && at > r.pendingIdleAt) r.pendingIdleAt = 0;
  }

  /** The lifecycle leaves `active`: every epoch-scoped fact goes with it. */
  private endEpoch(r: AgentWake, to: WakeLifecycle): void {
    r.lifecycle = to;
    r.provisional = false;
    r.pendingIdleAt = 0;
  }

  /** Ids announced more than REANNOUNCE_AFTER_MS ago, still on disk, never re-pended:
   *  back to pending, once each. */
  private requeueStale(r: AgentWake, now: number): string[] {
    const ids: string[] = [];
    for (const id of [...r.announced]) {
      const at = r.announcedAt.get(id) ?? 0;
      if (r.reannounced.has(id) || !(at > 0 && now - at >= REANNOUNCE_AFTER_MS)) continue;
      r.announced.delete(id);
      r.announcedAt.delete(id);
      r.reannounced.add(id);
      r.pending.add(id);
      ids.push(id);
    }
    return ids.sort();
  }

  private known(r: AgentWake, id: string): boolean {
    return r.pending.has(id) || r.announced.has(id) || !!r.inFlight?.ids.includes(id) || !!r.held?.ids.includes(id);
  }

  /** Record a PTY spawn: its boot sequence is left alone, its lifecycle starts unknown, and a
   *  held INTERFERED claim from the previous incarnation goes back to pending (the owner
   *  retires that inhibition with the process). */
  noteSpawn(ptyId: string, at = Date.now(), agentId?: string): void {
    this.spawnedAt.set(ptyId, at);
    if (!agentId) return;
    const r = this.rec(agentId);
    this.endEpoch(r, 'unknown');
    r.recheck = null;   // the new incarnation's composer is empty; the old one died with it
    r.invoking = false;
    // A new PTY incarnation is a new provider session. Forget the old one BEFORE any
    // tick of the new one arrives: keeping it would make the first tick of the fresh
    // session look like a mismatch and be discarded, and the agent would then have no
    // native lifecycle at all — the exact blindness this commit exists to remove.
    r.providerSession = null;
    if (r.held) {
      for (const id of r.held.ids) if (!r.announced.has(id)) r.pending.add(id);
      r.held = null;
    }
  }

  /** A durable inbox write landed. True when the id is new to this agent. */
  noteDelivery(agentId: string, messageId: string): boolean {
    if (!agentId || typeof messageId !== 'string' || !messageId) return false;
    const r = this.rec(agentId);
    if (this.known(r, messageId)) return false;
    r.pending.add(messageId);
    return true;
  }

  /**
   * Feed a hook event. Returns true when it is a RETRY EDGE for pending work.
   *
   * `fullyIdle` is Antigravity's own terminal qualifier, preserved through the agy hook
   * shim. It is read ONLY to REFUSE a Stop that says it is not terminal: Claude has no
   * such field, so an absent one keeps the long-standing "any Stop means idle" reading
   * and nothing about Claude moves. `false` is a provider statement that the turn is
   * still running, and believing it over the event name is what stops a mid-chain Stop
   * from opening a window for a second prompt.
   */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now(), fullyIdle?: boolean, turnId?: string): boolean {
    if (!agentId || !event) return false;
    const r = this.rec(agentId);
    if (event === 'Stop') {
      if (fullyIdle === false) return false;   // the provider says the turn is not over
      this.endEpoch(r, 'idle');
      r.openTurnId = null;
      r.stoppedAt = at;
      r.invoking = false;
      // The turn is over and the agent is idle: an id it was told about minutes ago and
      // left on disk gets one more announcement (bounded: once per id).
      this.requeueStale(r, at);
      if (turnId && !r.closedTurns.includes(turnId)) {
        r.closedTurns.push(turnId);
        if (r.closedTurns.length > CLOSED_TURN_MEMORY) r.closedTurns.shift();
      }
      return true;
    }
    // FALSEACTIVE-STALL-2. Each hook is its own short-lived shim process on the pipe, so
    // arrival order is not event order: on the live floor a Codex PostToolUse arrived 5 s
    // AFTER its turn's end (and a PreToolUse 8 s after its tool finished). Read as a fresh
    // edge, that straggler re-opened a turn that was already over, and nothing would ever
    // close it again, because the turn's Stop had already come and gone: every wake was
    // then refused as lifecycle-active, for good. Codex stamps turn_id on its hooks, so a
    // tool event naming a turn we have already seen END is recognised for what it is and
    // ignored. Scoped to in-turn events on purpose: a UserPromptSubmit always opens.
    if (turnId && IN_TURN_EVENTS.has(event) && r.closedTurns.includes(turnId)) return false;
    if (event === 'SubagentStop') return r.lifecycle === 'idle';   // never turns active into idle
    if (event === 'Notification') {
      if (classifyHook(event, message) === 'needsHuman') { r.lastHumanNeedsAt = at; return false; }
      this.endEpoch(r, 'idle');
      return true;
    }
    // Jim (WAKE-CONFIRM-AUDIT-153 note 1): AGY brackets every model call with Pre/PostInvocation,
    // and its running ticks can pause >5 s inside one. A deferred idle must not land there.
    if (event === 'PostInvocation') { r.invoking = false; return false; }
    if (ACTIVE_EVENTS.has(event)) {
      if (event === 'PreInvocation') r.invoking = true;
      this.turnStarted(r, at);   // the provider's own turn start: confirms our submit
      r.lifecycle = 'active'; r.activeSince = at;
      r.openTurnId = turnId ?? null;   // no id (Claude, our own submit): the turn is unnamed
      return false;
    }
    // A session boundary moots whatever the previous session was doing, in both directions:
    // it never asserts a turn is running (the cold-boot deadlock above), and it must not
    // let a stale `active` from the old session survive into the new one either — a
    // --resume'd agent would inherit exactly the same deadlock. Not a retry edge: nothing
    // is known to be idle yet, so the reconciliation beat decides, behind boot grace.
    if (event === 'SessionStart' || event === 'SessionEnd') { this.endEpoch(r, 'unknown'); r.invoking = false; return false; }
    return false;
  }

  /**
   * Feed one PROVIDER-NATIVE status reading. Returns true when it is a RETRY EDGE.
   *
   * THE FIX FOR THE FALSE-ACTIVE STALL. `settle(COMMITTED)` opens an active epoch, and
   * until now only a terminal HOOK could close one. When that hook was never delivered —
   * as in the 1.1.47 incident, where no AGY lifecycle event reached main at all — the
   * agent was known-active forever: event mode refuses anything but idle, and D3
   * deliberately refuses to let PTY silence stand in for a positively active lifecycle.
   * The watchdog could see the contradiction and say so, but had nothing authoritative
   * to say it WITH. This is that input.
   *
   * THE MAPPING (design 4.1), and it is the whole of it:
   *
   *   idle                     -> lifecycle idle,   RETRY EDGE
   *   running                  -> lifecycle active, no edge
   *   waiting_for_confirmation -> lifecycle active + HITL hold, no edge
   *
   * Confirmation is BOTH: the turn is alive (so silence still cannot claim it) and a
   * human is being asked something (so the existing HITL rearm blocks the claim for its
   * full window). Mail can never be typed through a permission prompt.
   *
   * THE INCARNATION GUARD. A tick naming a session other than the learned one is
   * discarded entirely — it cannot set idle, cannot set active, cannot arm HITL. A late
   * tick from a session the PTY has already replaced is the one way a native reading
   * could make a genuinely busy new turn look finished, and `noteSpawn` clears the
   * learned session so the new incarnation starts by learning its own. A tick that names
   * no session at all is accepted: it is one stream per PTY and receive order settles it.
   *
   * Nothing here claims, submits or types. It records what the provider said; the
   * ordinary guarded path decides what, if anything, follows.
   */
  noteProviderStatus(agentId: string | undefined, status: ProviderStatus, at = Date.now(), sessionId: string | null = null): boolean {
    if (!agentId) return false;
    const r = this.rec(agentId);
    if (sessionId) {
      if (r.providerSession !== null && r.providerSession !== sessionId) return false;
      r.providerSession = sessionId;
    }
    // TERMINAL PROOF MUST BE NEWER THAN THE EDGE IT CLOSES, and it must be old enough to
    // be ABOUT this turn.
    //
    // HONEST BOOKKEEPING (Jim, c4 re-audit P6): these two are NOT independent. While the
    // lifecycle is active the grace SUBSUMES the ordering check, because `at < activeSince`
    // implies `at - activeSince < 0 < PROVIDER_IDLE_CONFIRM_MS` - so deleting the ordering
    // line alone changes nothing any test can see, exactly as c3's safety override is
    // subsumed by the ratified gating rule. Its only behavioural residue is in the
    // NOT-active case, where a pre-epoch reading yields a spurious (and harmless) retry
    // edge instead of silence. It is kept as NARROWING INSURANCE: the grace is a tuning
    // constant and someone will shorten it one day, and the ordering rule must not leave
    // with it. Two rules, one guarantee - said plainly rather than implied.
    //
    // (1) ORDERING. Each tick is its own short-lived shim process on the named pipe, so
    //     two in flight can be received out of order. `at` is the shim's READING time, not
    //     the arrival time - arrival through one process is monotone and would make this
    //     unreachable, which is exactly how the first version of this guard was decoration
    //     (Jim, c4 audit). Stamped by the shim on the same clock as `activeSince`.
    //
    // (2) CONFIRM GRACE. Ordering alone cannot help when the reading is HONESTLY newer:
    //     agy goes on rendering `idle` until it has processed the prompt we just typed, so
    //     a tick generated after the Enter but before the state flips is both truthful and
    //     about the previous turn. Refuse - never defer - for the grace; the next tick
    //     after it decides. See PROVIDER_IDLE_CONFIRM_MS.
    //
    // (3) DEFER, NEVER DROP (AGY-FALSEACTIVE-STALL (b)). "The next tick after the grace
    //     decides" assumed ticks keep coming; AGY goes silent while idle, so a refused
    //     idle was the last word and the epoch never closed. A grace-refused reading is
    //     remembered and applied by the next beat after the grace (`beat`), unless
    //     something newer said active first. The beat already runs: no new timer.
    if (status === 'idle') {
      if (r.activeSince > 0 && at < r.activeSince) return false;
      if (r.lifecycle === 'active' && r.activeSince > 0 && at - r.activeSince < PROVIDER_IDLE_CONFIRM_MS) {
        r.pendingIdleAt = Math.max(r.pendingIdleAt, at);
        return false;
      }
      this.closeUnconfirmed(r);
      this.endEpoch(r, 'idle');
      r.activeSince = 0;
      return true;
    }
    // (4) STOP IS TERMINAL PROOF (AGY-FALSEACTIVE-STALL (a)). AGY goes on rendering
    //     `running` for seconds after its own Stop; that reading is about the turn the Stop
    //     ended. Inside STOP_SETTLE_MS of a Stop it opens nothing, unless a turn start came
    //     after the Stop (which, being active, is not re-opened here anyway), and it is
    //     never taken as confirmation of our submit.
    const afterStop = r.stoppedAt > 0 && at < r.stoppedAt + STOP_SETTLE_MS;
    if (r.lifecycle !== 'active') {
      if (afterStop && r.turnStartAt <= r.stoppedAt) return false;
      r.activeSince = at;   // a new epoch, not a repeat of one
    }
    r.lifecycle = 'active';
    if (!afterStop && at >= r.activeSince && at >= r.claimedAt) this.turnStarted(r, at);
    if (status === 'waiting_for_confirmation') r.lastHumanNeedsAt = at;
    return false;
  }

  /**
   * FALSEACTIVE-STALL-2 (B1): Codex's own rollout says a turn COMPLETED. Returns true when
   * that closed the open turn (a retry edge), false when it proves nothing.
   *
   * The companion of noteProviderStatus for a provider whose lifecycle is recorded per
   * turn rather than ticked. It closes ONLY an active lifecycle, and only with proof about
   * THAT turn: the same turn id when the app knows which turn is open, otherwise a
   * completion newer than the active epoch (codexTurnEnded). It never opens anything and
   * never touches an idle or unknown agent. D3 is untouched: this is the provider saying
   * the turn ended, not silence standing in for it.
   */
  noteProviderTurnEnded(agentId: string | undefined, turnId: string, at: number): boolean {
    if (!agentId || !turnId) return false;
    const r = this.agents.get(agentId);
    if (!r || r.lifecycle !== 'active') return false;
    if (r.openTurnId ? r.openTurnId !== turnId : !(r.activeSince > 0 && at > r.activeSince)) return false;
    this.endEpoch(r, 'idle');
    r.activeSince = 0;
    r.openTurnId = null;
    if (!r.closedTurns.includes(turnId)) {
      r.closedTurns.push(turnId);
      if (r.closedTurns.length > CLOSED_TURN_MEMORY) r.closedTurns.shift();
    }
    return true;
  }

  /**
   * CODEX-FALSEACTIVE-153: Codex's rollout says a turn STARTED at `at` (task_started). A start
   * after the claim confirms the provisional epoch our submit opened. Returns true when it
   * confirmed one. Never opens, closes or re-pends anything.
   */
  noteProviderTurnStarted(agentId: string | undefined, at: number): boolean {
    if (!agentId || !Number.isFinite(at)) return false;
    const r = this.agents.get(agentId);
    if (!r || r.lifecycle !== 'active' || !r.provisional || !(r.claimedAt > 0 && at >= r.claimedAt)) return false;
    this.turnStarted(r, at);
    return true;
  }

  /**
   * One reconcile beat for one agent (call after `reconcile`, so ids that left the disk are
   * gone). At most one edge, in this order:
   *
   *  - deferred-idle       an idle reading refused by the confirm grace, with nothing newer
   *                        saying active, is applied now that the grace is over;
   *  - submit-unconfirmed  our COMMITTED epoch was never confirmed by the provider within
   *                        SUBMIT_CONFIRM_MS: lifecycle unknown (quiescence rules apply
   *                        again), the claim's ids back to pending ONCE, and the next claim
   *                        must first see the unsent nudge absent from the prompt;
   *  - reannounce          idle, and ids announced REANNOUNCE_AFTER_MS ago are still on
   *                        disk: back to pending, once each.
   */
  beat(agentId: string, now = Date.now()): WakeBeatEdge | null {
    const r = this.agents.get(agentId);
    if (!r) return null;
    if (r.lifecycle === 'active' && r.pendingIdleAt > 0 && !r.invoking && now - r.activeSince >= PROVIDER_IDLE_CONFIRM_MS) {
      this.closeUnconfirmed(r);
      this.endEpoch(r, 'idle');
      r.activeSince = 0;
      return { kind: 'deferred-idle' };
    }
    if (r.lifecycle === 'active' && r.provisional && now - r.activeSince >= SUBMIT_CONFIRM_MS) {
      const ids: string[] = [];
      for (const id of r.commitIds) {
        if (!r.announced.has(id) || r.reannounced.has(id)) continue;
        r.announced.delete(id);
        r.announcedAt.delete(id);
        r.reannounced.add(id);
        r.pending.add(id);
        ids.push(id);
      }
      this.closeUnconfirmed(r);
      this.endEpoch(r, 'unknown');
      return { kind: 'submit-unconfirmed', ids };
    }
    if (r.lifecycle === 'idle' && !r.inFlight && !r.held) {
      const ids = this.requeueStale(r, now);
      if (ids.length) return { kind: 'reannounce', ids };
    }
    return null;
  }

  /** A provisional epoch ends without the provider ever confirming a turn: the nudge that
   *  opened it may still be unsent in the composer, so the next claim checks first. */
  private closeUnconfirmed(r: AgentWake): void {
    if (r.provisional && r.commitIds.length) r.recheck = r.commitIds;
  }

  /**
   * Align with the files, which are authoritative: ids no longer on disk leave every set,
   * ids on disk that nothing knows about become pending (a lost callback, a restart). No
   * ordering is inferred from the id strings.
   */
  reconcile(agentId: string, currentInboxIds: readonly string[]): void {
    const current = new Set(currentInboxIds.filter((id) => typeof id === 'string' && id.length > 0));
    const r = this.rec(agentId);
    for (const id of [...r.pending]) if (!current.has(id)) r.pending.delete(id);
    for (const id of [...r.announced]) if (!current.has(id)) { r.announced.delete(id); r.announcedAt.delete(id); }
    for (const id of [...r.reannounced]) if (!current.has(id)) r.reannounced.delete(id);
    if (r.held && !r.held.ids.some((id) => current.has(id))) r.held = null;
    for (const id of current) if (!this.known(r, id)) r.pending.add(id);
  }

  /**
   * At most ONE immutable batch, or null. Both modes fail closed on: no PTY, pause, halt,
   * auto-delivery pause, an owner inhibition, a recent HITL prompt, boot grace, an existing
   * in-flight or held claim. `event` mode needs recorded lifecycle-idle evidence;
   * `reconcile` may also accept PTY quiescence, but ONLY for an agent whose lifecycle is
   * unknown (never one known to be active), rate-limited per agent.
   */
  claim(f: WorkerWakeFacts, cause: WakeCause, mode: WakeMode, now = Date.now()): WakeClaim | null {
    const r = this.rec(f.agentId);
    // DIAGNOSIS ONLY (diag-1.1.46-wake): every `return null` below names itself, so a
    // packaged run can say WHICH guard is holding instead of just "no wake". `no()` is
    // pure bookkeeping — it returns null and changes nothing the guards decide.
    const no = (why: string): null => { this.lastWhy.set(f.agentId, why); return null; };
    if (r.inFlight) return no('in-flight');
    if (r.held) return no('held-interfered');
    if (r.pending.size === 0) return no('no-pending-ids');
    if (!f.ptyId) return no('no-pty');
    if (f.paused) return no('paused');
    if (f.halted) return no('halted');
    if (f.autoDeliveryPaused) return no('auto-delivery-paused');
    if (f.inhibited) return no('owner-inhibited');
    if (r.lastHumanNeedsAt > 0 && now - r.lastHumanNeedsAt < WORKER_WAKE_HITL_REARM_MS) return no('hitl-hold');
    const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
    if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) return no('boot-grace');
    if (mode === 'event') {
      if (r.lifecycle !== 'idle') return no(`lifecycle-${r.lifecycle}`);
    } else {
      const quiescent = f.lastOutputAt > 0 && now - f.lastOutputAt >= WORKER_WAKE_IDLE_MS;
      // D3 (god ruling, Dwight's tightening): PTY silence stands in ONLY when the lifecycle is
      // UNKNOWN (start-up, lost history, a lost Stop). A positively ACTIVE agent is never claimed
      // on quiescence: a silent tool, build or network wait can outlast 12s, and the owner
      // proves the prompt and the human, not that the model's turn ended.
      if (!(r.lifecycle === 'idle' || (r.lifecycle === 'unknown' && quiescent))) {
        return no(`lifecycle-${r.lifecycle}${quiescent ? '' : '-not-quiescent'}`);
      }
      if (r.lastReconcileAttemptAt > 0 && now - r.lastReconcileAttemptAt < WORKER_WAKE_COOLDOWN_MS) return no('reconcile-cooldown');
      r.lastReconcileAttemptAt = now;
    }
    this.lastWhy.delete(f.agentId);
    const ids = [...r.pending].sort();
    r.pending.clear();
    r.claimedAt = now;
    // A re-announced id was COMMITTED once under the plain request id, and the owner replays
    // a remembered COMMITTED for that id without typing: the second announcement is a new
    // request. Once per id, so one suffix is enough.
    const again = ids.some((id) => r.reannounced.has(id));
    const requestId = inboxWakeRequestId(f.agentId, ids) + (again ? ':again' : '');
    const claim: WakeClaim = Object.freeze({
      agentId: f.agentId, requestId, ids: Object.freeze(ids), cause,
      ...(r.recheck ? { recheck: r.recheck } : {})
    });
    r.inFlight = claim;
    return claim;
  }

  /**
   * The owner's outcome for a claim. Only the CURRENT in-flight claim is settled.
   *
   * `confirms`: this agent's provider reports its own turn starts (a UserPromptSubmit or
   * PreInvocation hook, Codex's task_started). Then a COMMITTED epoch is PROVISIONAL until
   * one arrives (see SUBMIT_CONFIRM_MS). A provider with no such signal keeps the plain
   * reading - COMMITTED is active until its Stop - since waiting for a confirmation that can
   * never come would re-announce every turn.
   */
  settle(claim: WakeClaim, outcomeKind: string, at = Date.now(), confirms = false): void {
    const r = this.agents.get(claim.agentId);
    if (!r || r.inFlight?.requestId !== claim.requestId) return;
    r.inFlight = null;
    if (outcomeKind === 'COMMITTED') {
      for (const id of claim.ids) { r.announced.add(id); r.announcedAt.set(id, at); }
      r.lifecycle = 'active';          // a turn just started; new mail waits for its Stop
      r.activeSince = at;              // and THIS is the edge terminal proof must be newer than
      r.pendingIdleAt = 0;
      // Already confirmed if the provider's turn start beat our settle here.
      r.provisional = confirms && !(r.claimedAt > 0 && r.turnStartAt >= r.claimedAt);
      r.commitIds = claim.ids;
      if (claim.recheck) r.recheck = null;   // the prompt was seen clear, and this went out
    } else if (outcomeKind === 'HUMAN_HANDLED') {
      for (const id of claim.ids) { r.announced.add(id); r.announcedAt.set(id, at); }
      r.recheck = null;
    } else if (outcomeKind === 'INTERFERED') {
      r.held = claim;                  // no automatic retry until a human rules
    } else {
      for (const id of claim.ids) if (!r.announced.has(id)) r.pending.add(id);
    }
  }

  /** A human resolved the owner's INTERFERED hold. Returns true when a held claim moved. */
  resolveInterference(agentId: string, how: InterferenceHow): boolean {
    const r = this.agents.get(agentId);
    if (!r?.held) return false;
    const held = r.held;
    r.held = null;
    if (how === 'SEND_AGAIN') {
      for (const id of held.ids) if (!r.announced.has(id)) r.pending.add(id);
    } else {
      for (const id of held.ids) { r.announced.add(id); r.announcedAt.set(id, Date.now()); }
      r.recheck = null;                // a person dealt with the prompt
    }
    return true;
  }

  /** Agents with pending ids (bounded retries after a capacity change or at startup). */
  pendingAgents(): string[] {
    return [...this.agents].filter(([, r]) => r.pending.size > 0).map(([id]) => id).sort();
  }

  /** Read-only view for diagnostics and tests. */
  state(agentId: string): { pending: string[]; announced: string[]; inFlight: WakeClaim | null; held: WakeClaim | null; lifecycle: WakeLifecycle; providerSession: string | null; provisional: boolean } {
    const r = this.agents.get(agentId);
    return {
      pending: r ? [...r.pending].sort() : [],
      announced: r ? [...r.announced].sort() : [],
      inFlight: r?.inFlight ?? null,
      held: r?.held ?? null,
      lifecycle: r?.lifecycle ?? 'unknown',
      providerSession: r?.providerSession ?? null,
      provisional: r?.provisional ?? false
    };
  }

  /** Read-only: the open turn as the hooks named it, and the active epoch (FALSEACTIVE-STALL-2). */
  turnFacts(agentId: string): { openTurnId: string | null; activeSince: number } {
    const r = this.agents.get(agentId);
    return { openTurnId: r?.openTurnId ?? null, activeSince: r?.activeSince ?? 0 };
  }

  /** Forget per-agent state (the agent's PTY was closed). */
  forget(agentId: string, ptyId?: string): void {
    this.agents.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }
}

/** The plan's name for the same class. */
export { WorkerWakeWatchdog as InboxWakeCoordinator };
