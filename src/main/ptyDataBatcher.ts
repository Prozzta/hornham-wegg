/**
 * Coalesce one pty's output into few IPC messages (LAG-150 F3).
 *
 * node-pty hands main conpty's output in ~170-byte chunks, and every chunk used to become
 * its own `pty:data:<id>` IPC message, and in the renderer its own `term.write`, follow
 * check and parser pass. Measured on 1.1.49: one 3.26 MB burst (a Codex transcript replay)
 * = 20,683 IPC messages and main at 20% of a core for the burst.
 *
 * The rule:
 *   - LEADING EDGE: a chunk that arrives after `windowMs` of quiet is sent AT ONCE, so a
 *     keystroke echo is never delayed.
 *   - Anything arriving inside the window is buffered and sent as ONE string when the
 *     window closes, or earlier once `maxBytes` are buffered.
 *   - `flush()` sends what is buffered NOW. The owner calls it before anything that must
 *     be ordered after the bytes (exit, kill, a screen read), so batching never reorders
 *     output against another message about the same pty.
 * The output is byte-identical: the chunks are concatenated in arrival order, nothing is
 * dropped, split or re-encoded.
 *
 * Pure, with its clock and timers injected, so the rule is tested under node rather than
 * described (the poolTimer.ts pattern).
 */
export interface BatchTimerHost {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
}

/** One 165 Hz display frame is ~6 ms: a window this short is invisible to a reader. */
export const PTY_BATCH_MS = 8;
/** Bound on one message, so a huge burst still streams instead of arriving as one lump. */
export const PTY_BATCH_MAX_BYTES = 64 * 1024;

export interface PtyDataBatcher {
  push(chunk: string): void;
  flush(): void;
  readonly buffered: number;
}

const defaultHost: BatchTimerHost = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now()
};

export function createPtyDataBatcher(
  send: (data: string) => void,
  host: BatchTimerHost = defaultHost,
  windowMs: number = PTY_BATCH_MS,
  maxBytes: number = PTY_BATCH_MAX_BYTES
): PtyDataBatcher {
  let parts: string[] = [];
  let size = 0;
  let handle: unknown = null;
  let lastSend = -Infinity;

  const flush = (): void => {
    if (handle !== null) { host.clear(handle); handle = null; }
    if (parts.length === 0) return;
    const data = parts.length === 1 ? parts[0] : parts.join('');
    parts = []; size = 0;
    lastSend = host.now();
    send(data);
  };

  return {
    push(chunk: string): void {
      if (!chunk) return;
      if (handle === null && parts.length === 0 && host.now() - lastSend >= windowMs) {
        lastSend = host.now();
        send(chunk);
        return;
      }
      parts.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) { flush(); return; }
      if (handle === null) handle = host.set(flush, windowMs);
    },
    flush,
    get buffered(): number { return size; }
  };
}
