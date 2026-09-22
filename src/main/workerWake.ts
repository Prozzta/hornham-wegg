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
const ACTIVE_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact']);

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
}

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
      r = { pending: new Set(), announced: new Set(), inFlight: null, held: null, lifecycle: 'unknown', lastHumanNeedsAt: 0, lastReconcileAttemptAt: 0 };
      this.agents.set(agentId, r);
    }
    return r;
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
    r.lifecycle = 'unknown';
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

  /** Feed a hook event. Returns true when it is a RETRY EDGE for pending work. */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now()): boolean {
    if (!agentId || !event) return false;
    const r = this.rec(agentId);
    if (event === 'Stop') { r.lifecycle = 'idle'; return true; }
    if (event === 'SubagentStop') return r.lifecycle === 'idle';   // never turns active into idle
    if (event === 'Notification') {
      if (classifyHook(event, message) === 'needsHuman') { r.lastHumanNeedsAt = at; return false; }
      r.lifecycle = 'idle';
      return true;
    }
    if (ACTIVE_EVENTS.has(event)) { r.lifecycle = 'active'; return false; }
    // A session boundary moots whatever the previous session was doing, in both directions:
    // it never asserts a turn is running (the cold-boot deadlock above), and it must not
    // let a stale `active` from the old session survive into the new one either — a
    // --resume'd agent would inherit exactly the same deadlock. Not a retry edge: nothing
    // is known to be idle yet, so the reconciliation beat decides, behind boot grace.
    if (event === 'SessionStart' || event === 'SessionEnd') { r.lifecycle = 'unknown'; return false; }
    return false;
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
    for (const id of [...r.announced]) if (!current.has(id)) r.announced.delete(id);
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
    const claim: WakeClaim = Object.freeze({ agentId: f.agentId, requestId: inboxWakeRequestId(f.agentId, ids), ids: Object.freeze(ids), cause });
    r.inFlight = claim;
    return claim;
  }

  /** The owner's outcome for a claim. Only the CURRENT in-flight claim is settled. */
  settle(claim: WakeClaim, outcomeKind: string): void {
    const r = this.agents.get(claim.agentId);
    if (!r || r.inFlight?.requestId !== claim.requestId) return;
    r.inFlight = null;
    if (outcomeKind === 'COMMITTED') {
      for (const id of claim.ids) r.announced.add(id);
      r.lifecycle = 'active';          // a turn just started; new mail waits for its Stop
    } else if (outcomeKind === 'HUMAN_HANDLED') {
      for (const id of claim.ids) r.announced.add(id);
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
      for (const id of held.ids) r.announced.add(id);
    }
    return true;
  }

  /** Agents with pending ids (bounded retries after a capacity change or at startup). */
  pendingAgents(): string[] {
    return [...this.agents].filter(([, r]) => r.pending.size > 0).map(([id]) => id).sort();
  }

  /** Read-only view for diagnostics and tests. */
  state(agentId: string): { pending: string[]; announced: string[]; inFlight: WakeClaim | null; held: WakeClaim | null; lifecycle: WakeLifecycle } {
    const r = this.agents.get(agentId);
    return {
      pending: r ? [...r.pending].sort() : [],
      announced: r ? [...r.announced].sort() : [],
      inFlight: r?.inFlight ?? null,
      held: r?.held ?? null,
      lifecycle: r?.lifecycle ?? 'unknown'
    };
  }

  /** Forget per-agent state (the agent's PTY was closed). */
  forget(agentId: string, ptyId?: string): void {
    this.agents.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }
}

/** The plan's name for the same class. */
export { WorkerWakeWatchdog as InboxWakeCoordinator };
