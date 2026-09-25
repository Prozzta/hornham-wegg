/**
 * v1.1.45 CRIT-15-PRE - the agent-card impact string is PUSHED, never polled.
 *
 * It used to be refreshed by a 2s renderer poll of control:snapshot (useAgentImpact), the
 * last renderer poll of the class crit 15 forbids. Main already words the string
 * (`agentImpactOf`, unit #5); now main also decides WHEN it is sent: on every event that
 * can move it (a capacity publication, an admission-ledger move, a floor pause, an
 * automatic-submit outcome, a resolved interference, an agent spawn or leave), to every
 * window, on its OWN channel, and only when a row changed.
 *
 * The rows are the agents a renderer has asked about through control:snapshot, so every
 * card that used to be polled is still served - including one whose terminal has gone.
 * Each row is the SAME string the snapshot answers: one computation, two doors.
 */
import type { AgentImpact, AgentImpactPush } from '../shared/deliveryHold';

/** One row per agent, in id order: the impact main would answer for it right now. */
export function agentImpactPushOf(
  agentIds: Iterable<string>,
  impactOf: (agentId: string) => AgentImpact | null
): AgentImpactPush {
  return { rows: [...new Set(agentIds)].sort().map((agentId) => ({ agentId, impact: impactOf(agentId) })) };
}

/** Sends a push only when its rows changed. The key includes the agent ids. */
export class AgentImpactPushGate {
  private last: string | null = null;
  next(push: AgentImpactPush): AgentImpactPush | null {
    const key = JSON.stringify(push.rows);
    if (key === this.last) return null;
    this.last = key;
    return push;
  }
}
