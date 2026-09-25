/**
 * v1.1.45 unit #4 — which pool's provider details are open, if any. Part of the ONE
 * capacity family (§17): the strip opens it, the panel reads it, the Settings link opens
 * it. It holds only an opaque poolId, never pool data: the panel asks main for the detail
 * view itself, and drops it on close.
 */
import { useSyncExternalStore } from 'react';
import { capacityMirror } from './useCapacityStrip';
import { selectPools } from './capacityStrip';

let openPoolId: string | null = null;
const listeners = new Set<() => void>();
const emit = (): void => { for (const l of [...listeners]) l(); };

export function openCapacityDetail(poolId: string): void {
  if (openPoolId === poolId) return;
  openPoolId = poolId;
  emit();
}

export function closeCapacityDetail(): void {
  if (openPoolId === null) return;
  openPoolId = null;
  emit();
}

/** Open the first pool's details (the Settings link). False when there is no pool to show. */
export function openFirstCapacityDetail(): boolean {
  const first = selectPools(capacityMirror.get())[0];
  if (!first) return false;
  openCapacityDetail(first.poolId);
  return true;
}

export function getOpenCapacityDetail(): string | null {
  return openPoolId;
}

const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The open poolId, or null when the panel is closed. */
export function useOpenCapacityDetail(): string | null {
  return useSyncExternalStore(subscribe, getOpenCapacityDetail, () => null);
}
