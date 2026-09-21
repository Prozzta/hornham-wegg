/**
 * v1.1.45 unit #5 — how an agent's badge reads while a hold is real. Pure.
 *
 * MAIN decides whether a hold exists and words it (`agentImpactOf`, shared/deliveryHold.ts).
 * This only decides WHERE that string goes: an agent that would otherwise read as having
 * nothing going on (`idle`, or `done`) shows the impact instead, because "idle" on a held
 * agent tells a person there is nothing to do (C2.11 crit 13). An agent that is actually
 * working keeps its working badge and context: it is mid-turn, and the hold applies to the
 * NEXT automatic delivery, which the composer already explains.
 */
import type { AgentImpact } from '@shared/deliveryHold';
import type { StatusKind } from './PixelBadge';

/** Statuses that say "nothing is happening here" — exactly what a hold must never read as. */
export const RESTING_STATUSES: readonly StatusKind[] = ['idle', 'success'];

export interface ImpactBadge {
  status: StatusKind;
  /** Main's leading word (`paused` / `waiting` / `held`), or undefined for the normal label. */
  label?: string;
  /** Main's full impact string for the context line, or null when nothing replaces it. */
  impactText: string | null;
}

export function impactBadge(status: StatusKind, impact: AgentImpact | null | undefined): ImpactBadge {
  if (!impact || !RESTING_STATUSES.includes(status)) return { status, impactText: null };
  return {
    status: impact.verb === 'waiting' ? 'waiting' : 'blocked',
    label: impact.verb,
    impactText: impact.text
  };
}
