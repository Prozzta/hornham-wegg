/**
 * v1.1.45 unit #5 — each agent's main-produced impact string, READ from control:snapshot.
 *
 * ONE poller for every card and row: an agent shown both as a card and as a Command
 * Center row costs one snapshot read per tick, not two. It runs only while something is
 * subscribed, on the composer's 2s cadence (holds flip on human timescales). The string is
 * main's; nothing here decides or words a hold.
 */
import { useSyncExternalStore } from 'react';
import type { AgentImpact } from '@shared/deliveryHold';

const POLL_MS = 2000;
const values = new Map<string, AgentImpact | null>();
const listeners = new Map<string, Set<() => void>>();
let timer: ReturnType<typeof setInterval> | null = null;

const sameImpact = (a: AgentImpact | null | undefined, b: AgentImpact | null): boolean =>
  (a ?? null) === b || (!!a && !!b && a.kind === b.kind && a.text === b.text && a.verb === b.verb);

function read(agentId: string): void {
  if (typeof window === 'undefined' || !window.cth?.controlSnapshot) return;
  window.cth.controlSnapshot(agentId)
    .then((s) => {
      const next = s?.impact ?? null;
      if (sameImpact(values.get(agentId), next) && values.has(agentId)) return;
      values.set(agentId, next);
      for (const l of listeners.get(agentId) ?? []) l();
    })
    // Main not ready: say nothing rather than guess. Absence is "no impact known".
    .catch(() => {});
}

function subscribe(agentId: string, listener: () => void): () => void {
  let set = listeners.get(agentId);
  if (!set) { set = new Set(); listeners.set(agentId, set); }
  set.add(listener);
  read(agentId);
  if (!timer) timer = setInterval(() => { for (const id of listeners.keys()) read(id); }, POLL_MS);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) { listeners.delete(agentId); values.delete(agentId); }
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
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
