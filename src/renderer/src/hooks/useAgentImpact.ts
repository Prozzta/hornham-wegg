/**
 * v1.1.45 unit #5 — each agent's main-produced impact string, from control:snapshot.
 *
 * CRIT-15-PRE: PUSHED, never polled. Each agent's snapshot is read ONCE when something
 * first shows it (the mount-time initial state, which also tells main to serve it); after
 * that main pushes every change on its own channel (`window.cth.onAgentImpact`). There is
 * no timer. One subscription serves every card and row while anything is shown. A push
 * row outranks a mount answer that lands after it. The string is main's; nothing here
 * decides or words a hold.
 */
import { useSyncExternalStore } from 'react';
import type { AgentImpact, AgentImpactPush } from '@shared/deliveryHold';

const values = new Map<string, AgentImpact | null>();
const listeners = new Map<string, Set<() => void>>();
/** Agents whose row a push has carried: a later mount answer is older than it. */
const pushed = new Set<string>();
let unsubscribePush: (() => void) | null = null;

const sameImpact = (a: AgentImpact | null | undefined, b: AgentImpact | null): boolean =>
  (a ?? null) === b || (!!a && !!b && a.kind === b.kind && a.text === b.text && a.verb === b.verb);

function store(agentId: string, next: AgentImpact | null): void {
  if (sameImpact(values.get(agentId), next) && values.has(agentId)) return;
  values.set(agentId, next);
  for (const l of listeners.get(agentId) ?? []) l();
}

function read(agentId: string): void {
  if (typeof window === 'undefined' || !window.cth?.controlSnapshot) return;
  window.cth.controlSnapshot(agentId)
    .then((s) => {
      if (pushed.has(agentId) || !listeners.has(agentId)) return;
      store(agentId, s?.impact ?? null);
    })
    // Main not ready: say nothing rather than guess. Absence is "no impact known".
    .catch(() => {});
}

function onPush(push: AgentImpactPush): void {
  for (const row of push?.rows ?? []) {
    if (!listeners.has(row.agentId)) continue;
    pushed.add(row.agentId);
    store(row.agentId, row.impact ?? null);
  }
}

function subscribe(agentId: string, listener: () => void): () => void {
  let set = listeners.get(agentId);
  const first = !set;
  if (!set) { set = new Set(); listeners.set(agentId, set); }
  set.add(listener);
  if (!unsubscribePush && typeof window !== 'undefined' && window.cth?.onAgentImpact) {
    unsubscribePush = window.cth.onAgentImpact(onPush);
  }
  if (first) read(agentId);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) { listeners.delete(agentId); values.delete(agentId); pushed.delete(agentId); }
    if (listeners.size === 0 && unsubscribePush) { unsubscribePush(); unsubscribePush = null; }
  };
}

const NONE = (): null => null;
const noSubscribe = (): (() => void) => () => {};

/** The agent's impact, or null when nothing is held (or it is not known yet). */
export function useAgentImpact(agentId: string | undefined): AgentImpact | null {
  return useSyncExternalStore(
    agentId ? (l) => subscribe(agentId, l) : noSubscribe,
    agentId ? () => values.get(agentId) ?? null : NONE,
    NONE
  );
}
