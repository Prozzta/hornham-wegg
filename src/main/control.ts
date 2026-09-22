/**
 * ControlRegistry — operator control over running agents (#7C.1–7C.3).
 *
 * Holds per-agent control state that the HookServer reads when deciding what to
 * return from a hook. This is how the floor exerts control WITHOUT typing into
 * the PTY: the decision rides Claude Code's own hook-return protocol.
 *
 *   - pause / gateTool (#7C.1) → PreToolUse returns permissionDecision:'deny'
 *     (race-free, immediate — no renderer round-trip, so it can't hit the shim
 *     timeout). Slow human APPROVAL deliberately rides Claude's native prompt
 *     instead, per the spec's latency mitigation.
 *   - steer (#7C.2) → the next UserPromptSubmit/PostToolUse returns
 *     additionalContext, injecting guidance into the agent's context once.
 *   - halt (#7C.3) → the next hook boundary returns { continue:false } so the
 *     agent stops CLEANLY (vs killing the PTY). Overrides the inbox-drain.
 *
 * Runs in the Electron main process; no electron import (unit-testable).
 */

/** Max steer notes queued per agent before the OLDEST is dropped. Each note
 *  rides the next hook's additionalContext; a stalled/halted agent never drains
 *  the queue, so without a cap a burst of steers (closing-time loop, a stuck
 *  caller) would grow memory forever. The latest instruction wins: when full we
 *  drop from the front (FIFO) so a busy agent still hears the most recent note. */
const MAX_PENDING_STEERS = 20;

import type { AgentImpact } from '../shared/deliveryHold';

export interface AgentControlSnapshot {
  /**
   * Provider capacity refuses an ORDINARY automatic turn for this agent's pool.
   *
   * MAIN COMPUTES THIS; NOTHING ELSE DERIVES IT. It is filled in at the IPC boundary
   * from the admission seam, never stored on the control record and never set by a
   * caller — a consumer that computed its own would be a second capacity
   * implementation with no evidence behind it.
   *
   * It is deliberately SEPARATE from `autoDeliveryPaused`: that flag means a person
   * paused this agent and is shown as such, so folding capacity into it would tell a
   * user they paused something they did not. This one gates automatic delivery and
   * is shown as what it is - a capacity hold, in the words of `capacityEvidence`.
   */
  capacityHold?: boolean;
  /**
   * L0-FUSION stage 5.4b - an unresolved INTERFERED on this agent's terminal, or null. A
   * human typed onto automation's staged text: main sent no Enter, cleared nothing, and
   * refuses every programmatic delivery to that terminal until a HUMAN resolves it
   * (`autoSubmit:resolveInterference`). Read from the one owner; it has no timer.
   */
  interfered?: { requestId: string; reason: string; at: number } | null;
  /**
   * WHY capacity answers as it does, kept distinct (L0-UNKNOWN ruling, state invariant):
   * 'NO_POOL' is OUTSIDE capacity gating and never "available"; 'STALE_AFTER_HEALTHY'
   * proceeds but is NOT healthy; 'RECOVERING' is a post-reset re-probe and is NOT healthy;
   * the rest are held. See `CapacityEvidence` in automaticSubmit.ts.
   */
  capacityEvidence?: 'NO_POOL' | 'FRESH_HEALTHY' | 'STALE_AFTER_HEALTHY' | 'FRESH_NOT_HEALTHY' | 'STALE_AFTER_LIMITED' | 'STALE_AFTER_UNHEALTHY' | 'RECOVERING' | 'NO_STATE' | 'INDETERMINATE' | 'UNCLASSIFIED' | 'POST_RESET_PROBE' | 'POST_RESET_PROBE_SPENT' | 'LIMITED_NO_KNOWN_RESET';
  /**
   * v1.1.45 unit #5 - what this agent's card says while a hold is real, or null when
   * nothing is held. MAIN-produced from the fields above (`agentImpactOf`); AGENT-scoped,
   * so it belongs here - it carries a pool LABEL, never pool data (that is capacity:strip).
   */
  impact?: AgentImpact | null;
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

interface AgentControl {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: Set<string>;
  steerQueue: string[];
}

/**
 * A real change of one blocking flag (pre-M1 event-wake bridge). Main-only notification:
 * the `*_RELEASED` / `RESUMED` kinds are retry edges for a pending inbox wake. Applying
 * a block is reported too, but is never a retry edge. Nothing here changes a snapshot.
 */
export type ControlTransition =
  | 'PAUSED' | 'UNPAUSED' | 'HALTED' | 'RESUMED'
  | 'AUTO_DELIVERY_PAUSED' | 'AUTO_DELIVERY_RELEASED';

export class ControlRegistry {
  private readonly map = new Map<string, AgentControl>();
  private transitionObserver: ((agentId: string, transition: ControlTransition, snapshot: AgentControlSnapshot) => void) | null = null;

  /** Observe real state changes only (a setter given its current value emits nothing). */
  setTransitionObserver(cb: ((agentId: string, transition: ControlTransition, snapshot: AgentControlSnapshot) => void) | null): void {
    this.transitionObserver = cb;
  }

  private emit(id: string, transition: ControlTransition): void {
    try { this.transitionObserver?.(id, transition, this.snapshot(id)); } catch { /* notification only */ }
  }

  private ensure(id: string): AgentControl {
    let c = this.map.get(id);
    if (!c) {
      c = {
        paused: false,
        halted: false,
        autoDeliveryPaused: false,
        gatedTools: new Set(),
        steerQueue: []
      };
      this.map.set(id, c);
    }
    return c;
  }

  // ─── Operator actions (wired to IPC) ───────────────────────────────────────

  pause(id: string, on: boolean): void {
    const c = this.ensure(id);
    if (c.paused === on) return;
    c.paused = on;
    this.emit(id, on ? 'PAUSED' : 'UNPAUSED');
  }
  pauseAutoDelivery(id: string, on: boolean): void {
    const c = this.ensure(id);
    if (c.autoDeliveryPaused === on) return;
    c.autoDeliveryPaused = on;
    this.emit(id, on ? 'AUTO_DELIVERY_PAUSED' : 'AUTO_DELIVERY_RELEASED');
  }
  replaceAutoDeliveryPauses(ids: Iterable<string>): void {
    const paused = new Set(ids);
    const changed: string[] = [];
    for (const [id, control] of this.map) {
      const on = paused.has(id);
      if (control.autoDeliveryPaused !== on) { control.autoDeliveryPaused = on; changed.push(id); }
    }
    for (const id of paused) {
      const c = this.ensure(id);
      if (!c.autoDeliveryPaused) { c.autoDeliveryPaused = true; changed.push(id); }
    }
    // Reported only for the ids that actually changed.
    for (const id of changed) this.emit(id, this.map.get(id)!.autoDeliveryPaused ? 'AUTO_DELIVERY_PAUSED' : 'AUTO_DELIVERY_RELEASED');
  }
  gateTool(id: string, tool: string, on: boolean): void {
    const c = this.ensure(id);
    if (on) c.gatedTools.add(tool); else c.gatedTools.delete(tool);
  }
  steer(id: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    const q = this.ensure(id).steerQueue;
    if (q.length >= MAX_PENDING_STEERS) {
      // Drop the oldest so the newest instruction still reaches the next hook
      // boundary. Log a breadcrumb so a note silently falling off the front is
      // diagnosable — a full queue means the agent has been unreachable for a long time.
      console.warn(`[control] ${id}: steer queue full (${MAX_PENDING_STEERS}) — dropping oldest note`);
      q.shift(); // keep the newest note, drop the oldest
    }
    q.push(t.slice(0, 10000)); // hook additionalContext cap
  }
  /** Request a graceful stop at the next hook boundary. */
  halt(id: string): void {
    const c = this.ensure(id);
    if (c.halted) return;
    c.halted = true;
    this.emit(id, 'HALTED');
  }
  /** Drop all queued-but-undelivered steer notes (e.g. closing time cancelled
   *  before a busy agent's next hook boundary consumed the instruction). */
  clearSteers(id: string): void { const c = this.map.get(id); if (c) c.steerQueue.length = 0; }
  /** Clear pause + halt (lets a paused/halted agent run again). Keeps gates. */
  resume(id: string): void {
    const c = this.ensure(id);
    if (!c.paused && !c.halted) return;
    c.paused = false;
    c.halted = false;
    this.emit(id, 'RESUMED');
  }

  // ─── Reads (used by HookServer) ────────────────────────────────────────────

  shouldHalt(id: string): boolean { return this.map.get(id)?.halted ?? false; }
  isAutoDeliveryPaused(id: string): boolean {
    return this.map.get(id)?.autoDeliveryPaused ?? false;
  }

  /** Whether a tool call should be denied (paused agent, or this tool gated). */
  toolDecision(id: string, tool: string): { deny: boolean; reason?: string } {
    const c = this.map.get(id);
    if (!c) return { deny: false };
    if (c.paused) return { deny: true, reason: 'Paused by operator — resume from the floor to continue.' };
    if (tool && c.gatedTools.has(tool)) return { deny: true, reason: `Tool ${tool} is gated by the operator.` };
    return { deny: false };
  }

  /** Dequeue one pending steer note for delivery, or undefined. */
  takeSteer(id: string): string | undefined { return this.map.get(id)?.steerQueue.shift(); }

  snapshot(id: string): AgentControlSnapshot {
    const c = this.map.get(id);
    return {
      paused: c?.paused ?? false,
      halted: c?.halted ?? false,
      autoDeliveryPaused: c?.autoDeliveryPaused ?? false,
      gatedTools: c ? Array.from(c.gatedTools) : [],
      pendingSteers: c?.steerQueue.length ?? 0
    };
  }
}
