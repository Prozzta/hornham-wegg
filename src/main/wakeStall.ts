/**
 * THE INBOX-WAKE STALL WATCHDOG.
 *
 * The 1.1.46 packaged failure was not that a wake went wrong. It was that it went wrong
 * SILENTLY, for fifteen minutes, on a floor whose whole job is to keep moving. Every guard
 * in `claim()` is fail-closed, and every individual refusal is ordinary and expected — an
 * agent mid-turn, inside boot grace, on cooldown. No single refusal means anything.
 *
 * What DOES mean something is the same refusal, with the same reason, for an agent that has
 * undrained mail, for minutes on end. That is not a hold, it is a deadlock.
 *
 * This decides when to say so. It cannot fix a bad guard — nothing here can — but it turns
 * the entire class of "main refuses forever and the floor quietly dies" from invisible into
 * a named, durable row that points at the guard responsible. For this bug, and the next one.
 *
 * Pure: no clock, no log, no Electron. The caller supplies `now` and does the announcing.
 */

/** How long one unchanging refusal, with mail waiting, has to hold before it is a stall. */
export const WAKE_STALL_AFTER_MS = 5 * 60_000;

/**
 * Refusal reasons that are a DELIBERATE state rather than a stall. A paused, halted or
 * auto-delivery-paused agent is refusing because a human said so; an INTERFERED hold and a
 * HITL prompt are both waiting on a human answer. Announcing those would train everyone to
 * ignore the watchdog, which is the only failure mode that would make it worse than nothing.
 */
const DELIBERATE = new Set([
  'no-pending-ids', 'paused', 'halted', 'auto-delivery-paused', 'held-interfered', 'hitl-hold'
]);

/** What the caller should do about this refusal. */
export interface WakeStall {
  agentId: string;
  why: string;
  inboxIds: number;
  stalledMs: number;
}

export class WakeStallWatch {
  private readonly watching = new Map<string, { why: string; since: number; announced: boolean }>();

  /**
   * Fold one refusal in. Returns a stall to announce EXACTLY ONCE per unbroken run of the
   * same reason — a stalled floor must not also flood its own log.
   */
  note(agentId: string, why: string, inboxIds: number, now: number): WakeStall | null {
    if (!agentId) return null;
    // Nothing pending means nothing is stuck: that is the floor at rest.
    if (inboxIds <= 0 || DELIBERATE.has(why)) { this.watching.delete(agentId); return null; }
    const cur = this.watching.get(agentId);
    // A DIFFERENT reason is progress of a kind — the state machine is moving. Restart the
    // clock rather than blaming the new guard for the old one's wait.
    if (!cur || cur.why !== why) { this.watching.set(agentId, { why, since: now, announced: false }); return null; }
    if (cur.announced) return null;
    const stalledMs = now - cur.since;
    if (stalledMs < WAKE_STALL_AFTER_MS) return null;
    cur.announced = true;
    return { agentId, why, inboxIds, stalledMs };
  }

  /** The agent took a wake: whatever it was waiting on, it is not stuck. */
  clear(agentId: string): void {
    this.watching.delete(agentId);
  }

  /** Read-only view for diagnostics and tests. */
  watchingFor(agentId: string): { why: string; since: number; announced: boolean } | null {
    return this.watching.get(agentId) ?? null;
  }
}
