/**
 * Input provenance for every byte the app writes to a PTY.
 *
 * L0-FUSION (research `notes/andy-l0-fusion-design.md`, rev 13, section 13): the fused
 * automatic-submit transaction needs ONE fact from the input path — whether a HUMAN
 * wrote to this PTY after automatic text was staged. Today `pty:write` carries only
 * `(id, data)` and merges four provenances under one signature, so main cannot know.
 * This type is the wire fact that fixes that. Every writer DECLARES it; nothing infers it.
 *
 * THREE VALUES, AND THE THIRD IS NOT A CONVENIENCE:
 *   HUMAN        a person acted — typing, paste, IME, user clear/dismiss, drag-drop.
 *                The ONLY value that advances a PTY's human-input generation.
 *   CONTROL      terminal plumbing with no human behind the bytes: theme/OSC colour
 *                replies, DEC mode answers. Must NEVER advance the generation, or a
 *                TUI asking where its cursor is would register as a human interfering.
 *   PROGRAMMATIC the app's own automatic payload and Enter (queue delivery, worker
 *                wake). Not human, not control. Kept distinct so a call-graph check can
 *                prove the owner is the only producer of it. Post-fusion the owner
 *                stops using `pty:write` at all and this value should have no caller.
 *
 * WHAT THIS IS NOT: a claim that the renderer can observe a supported outbound
 * human-origin signal from xterm. It cannot — public `onData` is `IEvent<string>` and
 * `wasUserInput` is public INBOUND only (`typings/xterm.d.ts:993`). The HUMAN value is
 * established by the renderer's `inputOrigin.ts` from the approved public DOM surface
 * plus explicit tags at ingress points we own (rev 13 section 13.1). It is a
 * RECONSTRUCTION with a refusal-to-arm around the cases it cannot see, and the human
 * accepted it on exactly those terms. Do not upgrade it to a guarantee in a comment.
 */
export type InputOrigin = 'HUMAN' | 'CONTROL' | 'PROGRAMMATIC';

export const INPUT_ORIGINS: readonly InputOrigin[] = ['HUMAN', 'CONTROL', 'PROGRAMMATIC'];

/** Runtime guard for the IPC boundary. A write with no recognisable origin is
 *  REFUSED there, not defaulted: an omitted origin is a missing fact, and the
 *  fail-closed disposition says a missing fact is UNKNOWN, never CONTROL. */
export function isInputOrigin(value: unknown): value is InputOrigin {
  return typeof value === 'string' && (INPUT_ORIGINS as readonly string[]).includes(value);
}

/**
 * Why a HUMAN tag was raised at a site we own. Named constants, never a boolean,
 * so a wrong classification is greppable to its reason.
 *   dom           a capture-phase DOM input event inside `term.element`
 *   paste-sync    `pasteClipboard` via the synchronous clipboard bridge
 *   paste-async   `pasteClipboard` via the async fallback — the path that would
 *                 otherwise have shipped green (rev 11 dimension 2)
 *   drop          drag-and-drop of paths into the terminal
 *   user-clear    the composer's own Ctrl-U (`clearTerminalDraft`)
 *   user-dismiss  the composer's own Escape (`dismissTerminalPicker`)
 */
export type HumanOriginReason =
  | 'dom'
  | 'paste-sync'
  | 'paste-async'
  | 'drop'
  | 'user-clear'
  | 'user-dismiss';
