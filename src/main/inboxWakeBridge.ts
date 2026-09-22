/**
 * The pre-M1 event-wake bridge: ONE path from "something that could let an agent take a
 * turn" to one guarded inbox-wake submit (plan: floor-self-advance-PLAN.md, section 3).
 *
 *   durable inbox write ─┐
 *   Stop / idle hook ────┤
 *   control release ─────┼─ scheduleWake (setImmediate, coalesced per agent) ─┐
 *   capacity change ─────┤                                                     ├─ requestInboxWake
 *   SEND_AGAIN ──────────┘                        15s reconciliation beat ─────┘
 *
 * `requestInboxWake` re-reads the inbox (the files are authoritative), reconciles the
 * coordinator, gathers the live facts, takes the coordinator's one in-flight claim and
 * submits it through the owner as CAPACITY_GATED work with the claim's stable request id.
 * Every outcome is settled; nothing retries recursively. There is no god branch and no
 * direct PTY write: god wakes exactly as a worker does.
 *
 * The primary path uses `setImmediate` (never a delay or an interval), which also lets the
 * HookServer finish its synchronous Stop response before any submit is attempted.
 * Electron-free; every effect is injected.
 */
import type { InterferenceHow, WakeCause, WakeClaim, WakeMode, WorkerWakeFacts, WorkerWakeWatchdog } from './workerWake';

export interface InboxWakeSubmit {
  requestId: string;
  agentId: string;
  admissionClass: 'CAPACITY_GATED';
  text: string;
}

export interface InboxWakeBridgeDeps {
  coordinator: WorkerWakeWatchdog;
  /** The agent's undrained inbox ids, read from disk NOW. */
  inboxIds: (agentId: string) => string[];
  /** Live facts (PTY, last output, control flags, owner inhibition), or null for no terminal. */
  facts: (agentId: string) => Omit<WorkerWakeFacts, 'agentId'> | null;
  /** AutomaticSubmitOwner.submit - the ONLY way a wake reaches a terminal. */
  submit: (req: InboxWakeSubmit) => Promise<{ kind: string }>;
  /** The payload for a batch of ids (inboxNudgeText). */
  text: (ids: readonly string[]) => string;
  setImmediate: (fn: () => void) => void;
  now: () => number;
  log?: (line: string) => void;
}

export class InboxWakeBridge {
  /** Agents with a wake already scheduled this turn (event coalescing). */
  private readonly scheduled = new Map<string, WakeCause>();

  constructor(private readonly deps: InboxWakeBridgeDeps) {}

  /** Coalesce every event for this agent in this turn into one attempt, after the turn. */
  scheduleWake(agentId: string, cause: WakeCause): void {
    if (!agentId || this.scheduled.has(agentId)) return;
    this.scheduled.set(agentId, cause);
    this.deps.setImmediate(() => {
      const c = this.scheduled.get(agentId) ?? cause;
      this.scheduled.delete(agentId);
      this.requestInboxWake(agentId, c, 'event');
    });
  }

  /** THE one wake path, for events and reconciliation alike. Returns the claim it submitted. */
  requestInboxWake(agentId: string, cause: WakeCause, mode: WakeMode): WakeClaim | null {
    const { coordinator } = this.deps;
    coordinator.reconcile(agentId, this.deps.inboxIds(agentId));
    const f = this.deps.facts(agentId);
    const claim = coordinator.claim(
      f ? { agentId, ...f } : { agentId, lastOutputAt: 0, autoDeliveryPaused: false, paused: false, halted: false },
      cause, mode, this.deps.now());
    if (!claim) return null;
    this.deps.log?.(`[inbox-wake] claim ${agentId} cause=${cause} mode=${mode} ids=${claim.ids.length}`);
    let submitted: Promise<{ kind: string }>;
    try {
      submitted = this.deps.submit({
        requestId: claim.requestId,
        agentId,
        admissionClass: 'CAPACITY_GATED',
        text: this.deps.text(claim.ids)
      });
    } catch {
      submitted = Promise.resolve({ kind: 'FAILED' });
    }
    void submitted
      .then((outcome) => outcome?.kind ?? 'FAILED', () => 'FAILED')
      .then((kind) => {
        coordinator.settle(claim, kind);
        this.deps.log?.(`[inbox-wake] ${kind === 'COMMITTED' ? 'commit' : 'release'} ${agentId} cause=${cause} outcome=${kind}`);
      });
    return claim;
  }

  /** Hive delivery observer: a durable inbox write landed. */
  onDelivery(agentId: string, messageId: string): void {
    this.deps.coordinator.noteDelivery(agentId, messageId);
    this.scheduleWake(agentId, 'delivery');
  }

  /** HookServer observation (before its response): record lifecycle, retry after the turn. */
  onHook(agentId: string | undefined, event: string | undefined, message: string | undefined): void {
    if (this.deps.coordinator.noteHook(agentId, event, message, this.deps.now()) && agentId) {
      this.scheduleWake(agentId, 'hook');
    }
  }

  /** A blocking control state cleared (unpause, resume, auto-delivery release). */
  onControlRelease(agentId: string): void {
    this.scheduleWake(agentId, 'control');
  }

  /** Capacity changed: retry every agent that still has pending ids (admission decides). */
  onCapacityChange(): void {
    for (const agentId of this.deps.coordinator.pendingAgents()) this.scheduleWake(agentId, 'capacity');
  }

  /** A human resolved an INTERFERED hold. SEND_AGAIN goes back through every guard;
   *  ALREADY_HANDLED resolves the ids with no further submit. */
  onInterferenceResolved(agentId: string, how: InterferenceHow): void {
    if (this.deps.coordinator.resolveInterference(agentId, how) && how === 'SEND_AGAIN') {
      this.scheduleWake(agentId, 'interference');
    }
  }

  /** The reconciliation beat: the same path, in reconcile mode, over every live agent. */
  reconcileAll(agentIds: readonly string[]): void {
    for (const agentId of agentIds) this.requestInboxWake(agentId, 'reconcile', 'reconcile');
  }
}
