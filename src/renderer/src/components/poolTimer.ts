/**
 * A timer that exists only while the thing it serves is non-empty.
 *
 * Oscar's L0 efficiency assessment (2026-09-20) found the prompt mirror's 500 ms interval
 * started with the first terminal and NEVER stopped: with the pool empty it still fired
 * 7,200 callbacks an hour over nothing. `sync(size)` is called wherever the pool's size can
 * change: ABSENT at 0, PRESENT at 1, and EXACTLY ONE however large the pool grows.
 *
 * Pure, with its timers injected, so the rule is tested under node rather than described.
 */
export interface PoolTimerHost {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface PoolTimer {
  /** Tell the timer how many things it serves NOW. Idempotent. */
  sync(size: number): void;
  readonly running: boolean;
}

export function createPoolTimer(
  tick: () => void,
  ms: number,
  host: PoolTimerHost = { set: (fn, t) => setInterval(fn, t), clear: (h) => clearInterval(h as ReturnType<typeof setInterval>) }
): PoolTimer {
  let handle: unknown = null;
  return {
    sync(size: number): void {
      if (size > 0 && handle === null) handle = host.set(tick, ms);
      else if (size <= 0 && handle !== null) { host.clear(handle); handle = null; }
    },
    get running(): boolean { return handle !== null; }
  };
}
