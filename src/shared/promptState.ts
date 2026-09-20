/**
 * Whose is the prompt right now? — mirrored renderer -> main, per live PTY.
 *
 * L0-FUSION section 5.3: the picker latch is a precondition the main-owned submit
 * transaction must read IN MAIN, before STAGE and again inside its critical section, and
 * until now it existed only in the renderer's `terminalPool` (zero hits in `src/main`).
 * The same is true of the human-draft and settle blocks: the renderer drain consulted
 * them, and the main-process worker wake typed without them because it could not see
 * them. This is the one fact that closes both.
 *
 * A SEPARATE MIRROR, ON PURPOSE. The input-provenance mirror (`inputProvenance.ts`) is a
 * validated mechanism with its own predicate; this is not provenance and does not touch
 * it. Same discipline, though: validated at the IPC boundary, stored on the live session,
 * discarded with it, and ABSENT MEANS UNKNOWN — which the owner's policy table refuses
 * for automatic delivery.
 *
 * WHAT IT IS NOT. It is not an interference oracle and not an erase oracle. A draft is
 * detected from keystrokes xterm saw, so it is blind to automatically staged text by
 * construction (design section 5.1). It answers exactly one question — may automation
 * take this line — and it is asked BEFORE anything is typed. Whether a human typed
 * AFTER staging is decided by main's own human-input generation, never by this.
 */

/** Why automation may not own the prompt, exactly as `terminalAutomation.ts` computes it
 *  in the renderer (including the half-hour expiry of an untouched draft or picker). */
export type PromptBlock = 'exited' | 'picker' | 'draft' | 'settling' | null;

export interface TerminalPromptState {
  block: PromptBlock;
}

/** Runtime guard for the IPC boundary: refuse a malformed mirror rather than store it. */
export function isTerminalPromptState(v: unknown): v is TerminalPromptState {
  if (!v || typeof v !== 'object') return false;
  const b = (v as Record<string, unknown>).block;
  return b === null || b === 'exited' || b === 'picker' || b === 'draft' || b === 'settling';
}
