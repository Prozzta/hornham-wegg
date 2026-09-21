/**
 * Binds THE capacity mirror (capacityStrip.ts) to main's push channel. One mirror per
 * window, subscribed once; components read it through `useCapacityStrip()` and the
 * selectors in capacityStrip.ts — never through their own IPC listener.
 */
import { useSyncExternalStore } from 'react';
import type { CapacityStripCollection } from '@shared/capacityStrip';
import { CapacityStripMirror } from './capacityStrip';

export const capacityMirror = new CapacityStripMirror();

let bound = false;
/**
 * Subscribe the mirror to main exactly once, then pull the current collection: a
 * window that loads after main's last push must not sit on "nothing" until the next
 * transition. The pull goes through the same `accept`, so it cannot overwrite a newer
 * push that happened to arrive first.
 */
function bind(): void {
  if (bound || typeof window === 'undefined' || !window.cth?.onCapacityStrip) return;
  bound = true;
  window.cth.onCapacityStrip((c) => { capacityMirror.accept(c); });
  void window.cth.capacityStripCurrent()
    .then((c) => { if (c) capacityMirror.accept(c); })
    .catch(() => { /* main unavailable: stay at NONE, which is UNKNOWN */ });
}

const subscribe = (listener: () => void): (() => void) => {
  bind();
  return capacityMirror.subscribe(listener);
};
const read = (): CapacityStripCollection | null => capacityMirror.get();

/** The current pool collection, or null (UNKNOWN) until main has answered. */
export function useCapacityStrip(): CapacityStripCollection | null {
  return useSyncExternalStore(subscribe, read, read);
}

/** Ask main to record a dismissal. The mirror updates from main's push, not locally. */
export function dismissCapacityNotice(noticeId: string): Promise<boolean> {
  return window.cth.capacityDismissNotice(noticeId);
}
