/**
 * The bridge the composer scenario runs against. IMPORTED FIRST, so `window.cth` exists
 * before any renderer module that touches it at load is evaluated.
 *
 * `controlSnapshot` answers from `bridge.snapshot`, which the scenario changes between
 * steps exactly as main's state would change. `resolveInterference` RECORDS the call and
 * clears the hold, as the owner does. Everything else is inert: an `on*` subscription
 * returns an unsubscribe, any other call resolves undefined.
 */
export const bridge = {
  snapshot: {} as Record<string, unknown>,
  resolveCalls: [] as Array<{ agentId: string; at: number }>,
  snapshotReads: 0
};

const known: Record<string, unknown> = {
  controlSnapshot: (_agentId: string) => { bridge.snapshotReads += 1; return Promise.resolve({ ...bridge.snapshot }); },
  resolveInterference: (agentId: string) => {
    bridge.resolveCalls.push({ agentId, at: Date.now() });
    bridge.snapshot = { ...bridge.snapshot, interfered: null };
    return Promise.resolve(true);
  }
};

(window as unknown as { cth: unknown }).cth = new Proxy(known, {
  get: (target, name: string) => target[name]
    ?? (name.startsWith('on') ? () => () => { /* nothing subscribed */ }
      // A `*Sync` read answers a VALUE (the store reads `rosterReadSync()` at load): null.
      : name.endsWith('Sync') ? () => null
      : () => Promise.resolve(undefined))
});
