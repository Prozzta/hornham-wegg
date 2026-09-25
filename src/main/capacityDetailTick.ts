/**
 * v1.1.46 A2 (CAPUI-STALE-AGE-TICK) - the "Not refreshed in X min" note in the provider
 * details keeps counting while the panel stays open on a stale pool.
 *
 * Main words the age (`notRefreshedText`), and the panel re-asks only when the strip's
 * collection revision moves (crit 17). A stale pool is one nothing is reporting on, so the
 * revision stood still and the note froze at the minute the panel was opened. The fix is a
 * TIME EDGE IN MAIN, never a renderer clock (crit 15): while a window has the panel open on
 * a STALE pool, main re-pushes that pool's detail view at each minute boundary of its age.
 * A close, a switch to another pool, the window going away, or the pool no longer being
 * stale (fresh again, never read, or gone) stops it. Electron-free so the tests drive it
 * with fake timers.
 */
export const DETAIL_TICK_MS = 60_000;
/** Lands a re-push just past the minute boundary, so the floor has moved when it is worded. */
const BOUNDARY_MARGIN_MS = 250;

export interface DetailTickDeps {
  /** The pool's last observation time while it is STALE; null when fresh, never read or gone. */
  staleSince(poolId: string): number | null;
  /** Re-push the pool's current detail view to one window. */
  push(windowId: number, poolId: string): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

interface OpenPanel { poolId: string; timer: unknown | null }

export class CapacityDetailTicker {
  private readonly open = new Map<number, OpenPanel>();
  constructor(private readonly deps: DetailTickDeps) {}

  /** The panel in `windowId` asked for `poolId`: an open, or a crit-17 re-ask. */
  opened(windowId: number, poolId: string): void {
    const cur = this.open.get(windowId);
    if (cur && cur.poolId === poolId && cur.timer !== null) return;   // already ticking
    this.closed(windowId);
    const entry: OpenPanel = { poolId, timer: null };
    this.open.set(windowId, entry);
    this.arm(windowId, entry);
  }

  /** The panel closed (or the window went). With `poolId`, only a panel on that pool. */
  closed(windowId: number, poolId?: string): void {
    const cur = this.open.get(windowId);
    if (!cur || (poolId !== undefined && cur.poolId !== poolId)) return;
    if (cur.timer !== null) this.deps.clearTimer(cur.timer);
    this.open.delete(windowId);
  }

  stopAll(): void {
    for (const id of [...this.open.keys()]) this.closed(id);
  }

  /** For tests and diagnostics: the pool a window is ticking, or null. */
  ticking(windowId: number): string | null {
    const cur = this.open.get(windowId);
    return cur && cur.timer !== null ? cur.poolId : null;
  }

  private arm(windowId: number, entry: OpenPanel): void {
    const since = this.deps.staleSince(entry.poolId);
    if (since === null) { entry.timer = null; return; }
    const age = Math.max(0, this.deps.now() - since);
    const ms = DETAIL_TICK_MS - (age % DETAIL_TICK_MS) + BOUNDARY_MARGIN_MS;
    entry.timer = this.deps.setTimer(() => this.fire(windowId, entry), ms);
  }

  private fire(windowId: number, entry: OpenPanel): void {
    if (this.open.get(windowId) !== entry) return;                   // closed or switched
    entry.timer = null;
    if (this.deps.staleSince(entry.poolId) === null) return;          // no longer stale: stop
    this.deps.push(windowId, entry.poolId);
    this.arm(windowId, entry);
  }
}
