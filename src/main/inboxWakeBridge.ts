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
import type { InterferenceHow, ProviderStatus, WakeCause, WakeClaim, WakeMode, WorkerWakeFacts, WorkerWakeWatchdog } from './workerWake';

export interface InboxWakeSubmit {
  requestId: string;
  agentId: string;
  admissionClass: 'CAPACITY_GATED';
  text: string;
  /** The text of an earlier nudge that was never confirmed as a turn (WakeClaim.recheck):
   *  the owner must see it absent from the prompt before typing this one. */
  priorText?: string;
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
  /** DIAGNOSIS ONLY (diag-1.1.46-wake): one durable breadcrumb per stage of the wake path.
   *  `log` above is console.log, which a PACKAGED Windows Electron app throws away — which
   *  is precisely why the 1.1.46 canary could not say where the path died. This one writes
   *  to the hive event log instead, so the evidence survives the run. */
  diag?: (stage: string, fields: Record<string, unknown>) => void;
  /** FALSEACTIVE-STALL-2 (B1): Codex's own record of its newest turn boundary for this agent,
   *  read from a bounded rollout tail. Undefined = not a Codex agent (no probe). Optional so
   *  every existing deployment and test runs unchanged. */
  codexTurnProbe?: (agentId: string) => import('./codexRolloutLifecycle').CodexLifecycleProbe | undefined;
  /** CODEX-FALSEACTIVE-153: does this agent's provider report its own turn starts? Then
   *  our COMMITTED epoch is provisional until it does. Absent = no (the plain reading). */
  confirmsTurnStart?: (agentId: string) => boolean;
}

export class InboxWakeBridge {
  /** Agents with a wake already scheduled this turn (event coalescing). */
  private readonly scheduled = new Map<string, WakeCause>();

  constructor(private readonly deps: InboxWakeBridgeDeps) {}

  /** Coalesce every event for this agent in this turn into one attempt, after the turn. */
  scheduleWake(agentId: string, cause: WakeCause): void {
    if (!agentId) { this.deps.diag?.('schedule', { agentId, cause, took: 'no-agent-id' }); return; }
    if (this.scheduled.has(agentId)) { this.deps.diag?.('schedule', { agentId, cause, took: 'coalesced' }); return; }
    this.scheduled.set(agentId, cause);
    this.deps.diag?.('schedule', { agentId, cause, took: 'armed' });
    this.deps.setImmediate(() => {
      const c = this.scheduled.get(agentId) ?? cause;
      this.scheduled.delete(agentId);
      // A throw here would otherwise be an uncaught exception in main with nothing said.
      // Reported, then rethrown: the diagnosis branch must not change what happens.
      try {
        this.requestInboxWake(agentId, c, 'event');
      } catch (e) {
        this.deps.diag?.('throw', { agentId, cause: c, mode: 'event', error: String(e) });
        throw e;
      }
    });
  }

  /** THE one wake path, for events and reconciliation alike. Returns the claim it submitted. */
  requestInboxWake(agentId: string, cause: WakeCause, mode: WakeMode, readIds?: string[]): WakeClaim | null {
    const { coordinator } = this.deps;
    this.deps.diag?.('enter', { agentId, cause, mode });
    // The beat passes the ids it has just read and reconciled: one inbox read per beat.
    const ids = readIds ?? this.deps.inboxIds(agentId);
    if (!readIds) coordinator.reconcile(agentId, ids);
    const f = this.deps.facts(agentId);
    const now = this.deps.now();
    this.deps.diag?.('facts', {
      agentId, cause, mode,
      inboxIds: ids.length,
      pty: f?.ptyId ?? null,
      idleMs: f && f.lastOutputAt > 0 ? now - f.lastOutputAt : null,
      paused: f?.paused ?? null, halted: f?.halted ?? null,
      autoDeliveryPaused: f?.autoDeliveryPaused ?? null, inhibited: f?.inhibited ?? null
    });
    const claim = coordinator.claim(
      f ? { agentId, ...f } : { agentId, lastOutputAt: 0, autoDeliveryPaused: false, paused: false, halted: false },
      cause, mode, now);
    if (!claim) {
      this.deps.diag?.('no-claim', { agentId, cause, mode, why: coordinator.whyNoClaim(agentId), inboxIds: ids.length });
      return null;
    }
    this.deps.diag?.('claim', { agentId, cause, mode, ids: claim.ids.length, requestId: claim.requestId });
    this.deps.log?.(`[inbox-wake] claim ${agentId} cause=${cause} mode=${mode} ids=${claim.ids.length}`);
    let submitted: Promise<{ kind: string }>;
    try {
      submitted = this.deps.submit({
        requestId: claim.requestId,
        agentId,
        admissionClass: 'CAPACITY_GATED',
        text: this.deps.text(claim.ids),
        ...(claim.recheck ? { priorText: this.deps.text(claim.recheck) } : {})
      });
      this.deps.diag?.('submit', { agentId, cause, mode, requestId: claim.requestId });
    } catch (e) {
      this.deps.diag?.('submit-threw', { agentId, cause, mode, error: String(e) });
      submitted = Promise.resolve({ kind: 'FAILED' });
    }
    void submitted
      .then((outcome) => outcome ?? { kind: 'FAILED' }, () => ({ kind: 'FAILED' }))
      .then((outcome: { kind: string; reason?: unknown }) => {
        const kind = outcome.kind;
        this.deps.diag?.('settle', { agentId, cause, mode, outcome: kind, ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}), requestId: claim.requestId });
        coordinator.settle(claim, kind, this.deps.now(), kind === 'COMMITTED' && (this.deps.confirmsTurnStart?.(agentId) ?? false));
        this.deps.log?.(`[inbox-wake] ${kind === 'COMMITTED' ? 'commit' : 'release'} ${agentId} cause=${cause} outcome=${kind}`);
      });
    return claim;
  }

  /** Hive delivery observer: a durable inbox write landed. */
  onDelivery(agentId: string, messageId: string): void {
    const fresh = this.deps.coordinator.noteDelivery(agentId, messageId);
    this.deps.diag?.('delivery', { agentId, messageId, fresh });
    this.scheduleWake(agentId, 'delivery');
  }

  /** HookServer observation (before its response): record lifecycle, retry after the turn. */
  onHook(agentId: string | undefined, event: string | undefined, message: string | undefined, fullyIdle?: boolean, turnId?: string): void {
    const edge = this.deps.coordinator.noteHook(agentId, event, message, this.deps.now(), fullyIdle, turnId);
    // The lifecycle is sourced ONLY here, from the live hook stream - the one input no
    // in-harness test ever drove. Every hook boundary is recorded so a packaged run shows
    // whether Stop/Notification ever arrive at all, and what the lifecycle became.
    this.deps.diag?.('hook', { agentId: agentId ?? null, event: event ?? null, edge, ...(turnId ? { turn: turnId } : {}) });
    if (edge && agentId) {
      this.scheduleWake(agentId, 'hook');
    }
  }

  /**
   * A provider-native status reading (today: one validated Antigravity statusline tick).
   *
   * It rides the SAME scheduling path as a hook edge, deliberately: a native idle is one
   * more observation that an agent may be able to take a turn, not a new authority. It
   * coalesces with hook and delivery edges for the turn, goes through `requestInboxWake`,
   * and is refused by every guard a hook-driven wake is refused by. No second request id,
   * no second submit owner, no direct PTY write — the 1.1.46 lesson is that a second
   * producer is a second turn, and there is still exactly one.
   */
  onProviderStatus(agentId: string | undefined, status: ProviderStatus, sessionId: string | null = null, readAt?: number): void {
    // `readAt` is when the shim READ the status. It is passed through in preference to the
    // delivery clock because delivery order says nothing about reading order - the whole
    // point of the coordinator's ordering guard. Absent one, the delivery clock stands in.
    const at = typeof readAt === 'number' && Number.isFinite(readAt) ? readAt : this.deps.now();
    const edge = this.deps.coordinator.noteProviderStatus(agentId, status, at, sessionId);
    // The session is a breadcrumb, not a secret: it is the provider's own conversation id
    // and is exactly what a packaged run needs to explain a discarded tick.
    this.deps.diag?.('provider-status', { agentId: agentId ?? null, status, session: sessionId, at, edge });
    if (edge && agentId) this.scheduleWake(agentId, 'hook');
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

  /** Agents a missing/unreadable rollout was already reported for (log once per agent). */
  private readonly rolloutReported = new Set<string>();

  /**
   * FALSEACTIVE-STALL-2 (B1): before the beat's claim, an agent that is ACTIVE with mail
   * waiting may have lost its Stop. Ask Codex's rollout (bounded tail) whether the open turn
   * completed, and close it only with that proof. Everything else fails closed.
   */
  private closeLostCodexTurn(agentId: string, inboxIds: readonly string[]): void {
    const probeFn = this.deps.codexTurnProbe;
    if (!probeFn) return;
    const st = this.deps.coordinator.state(agentId);
    if (st.lifecycle !== 'active') return;
    // A provisional epoch is probed with or without mail: its confirmation is a turn START.
    if (inboxIds.length === 0 && !st.provisional) return;   // nothing waiting: nothing is stuck
    const probe = probeFn(agentId);
    if (!probe) return;                                      // not a Codex agent
    if (!probe.ok) {
      if (!this.rolloutReported.has(agentId)) {
        this.rolloutReported.add(agentId);
        this.deps.diag?.('codex-rollout', { agentId, closed: false, why: probe.why });
      }
      return;
    }
    this.rolloutReported.delete(agentId);
    const latest = probe.latest;
    // CODEX-FALSEACTIVE-153: any boundary after our claim is Codex confirming the turn our
    // submit asked for (a completion too: that turn ran). Recorded before the close below.
    if (latest && st.provisional && this.deps.coordinator.noteProviderTurnStarted(agentId, latest.at)) {
      this.deps.diag?.('codex-rollout', { agentId, confirmed: true, turn: latest.turnId, at: latest.at });
    }
    if (!latest || latest.kind !== 'complete') return;       // no boundary, or a turn is running
    const closed = this.deps.coordinator.noteProviderTurnEnded(agentId, latest.turnId, latest.at);
    if (closed) this.deps.diag?.('codex-rollout', { agentId, closed: true, turn: latest.turnId, at: latest.at });
  }

  /** The reconciliation beat: the same path, in reconcile mode, over every live agent. */
  reconcileAll(agentIds: readonly string[]): void {
    for (const agentId of agentIds) {
      // Per agent, so one throwing agent cannot silently take the whole beat down with it
      // (today it does: runWorkerWakeBeat catches at the top and the rest of the fleet is
      // skipped every tick, forever). Reported, then rethrown - unchanged behaviour.
      try {
        const ids = this.deps.inboxIds(agentId);
        this.deps.coordinator.reconcile(agentId, ids);
        try { this.closeLostCodexTurn(agentId, ids); }
        catch (e) { this.deps.diag?.('codex-rollout', { agentId, closed: false, why: 'probe-threw', error: String(e) }); }
        // The beat's own lifecycle edges (deferred idle, unconfirmed submit, re-announce),
        // after the reconcile so ids that left the disk are not re-pended.
        const edge = this.deps.coordinator.beat(agentId, this.deps.now());
        if (edge) this.deps.diag?.(edge.kind, { agentId, ...('ids' in edge ? { ids: edge.ids.length } : {}) });
        this.requestInboxWake(agentId, 'reconcile', 'reconcile', ids);
      } catch (e) {
        this.deps.diag?.('throw', { agentId, cause: 'reconcile', mode: 'reconcile', error: String(e) });
        throw e;
      }
    }
  }
}
