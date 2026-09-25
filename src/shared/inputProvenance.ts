/**
 * Per-terminal input-provenance state, mirrored renderer -> main, and the ONE pure
 * predicate that says whether automatic delivery may arm on it.
 *
 * L0-FUSION rev 13 section 13.2 steps 6-7, as amended by the human's ruling: the
 * mouse-tracking rule is RUNTIME and RE-ENTRANT, not an arm-time gate. A one-shot check
 * cannot satisfy it - a TUI can enable tracking after arming, which is exactly the
 * unmeasured case the TERMMATRIX capture could not reach (it never sends Enter, so it
 * never sees a picker or a diff view). So the state is a live mirror and the predicate
 * is evaluated on EVERY guard from that mirror, never cached as a verdict.
 *
 * WHY THIS IS A MIRROR AND NOT A MAIN-SIDE PARSE. The fact lives in the renderer:
 * `term.modes.mouseTrackingMode` is xterm's own, public, stable reading of the DEC modes
 * the program set (`typings/xterm.d.ts:1890`, derived from `coreMouseService.activeProtocol`).
 * Main could instead regex the DECSET bytes out of the PTY stream it already handles -
 * faster, no IPC - but that is literally inference from terminal output, which the human's
 * test forbids, and it re-implements a list xterm already maintains. So the renderer asks
 * xterm and forwards the answer; main stores it per live PTY and discards it with the PTY.
 *
 * FAIL-CLOSED SHAPE: a PTY with NO mirror yet is UNKNOWN, and UNKNOWN is ineligible. That
 * is not a bug to work around by defaulting; it is the rule. Whether that rule is wired
 * into today's automatic paths, and how a never-attached terminal acquires a mirror at all,
 * is a product decision recorded in the stage-3 pin, not taken here.
 */
/** xterm's public `IModes.mouseTrackingMode` union, restated so main (no xterm dependency)
 *  types the mirrored value against the same five words. Source of truth:
 *  `@xterm/xterm/typings/xterm.d.ts:1890` at the pinned 5.5.0. */
export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/** Outcome of the renderer's provenance self-test on one terminal. */
export type InputOriginSelfTest = 'unknown' | 'pass' | 'fail';

export interface TerminalInputState {
  /** xterm's own `modes.mouseTrackingMode`. Anything but 'none' means mouse-origin
   *  input can reach the PTY through document-level listeners we cannot observe. */
  mouseTrackingMode: MouseTrackingMode;
  /** The DOM half of inputOrigin is attached (after open()). Unattached means every
   *  byte classifies CONTROL - safe ONLY because this predicate refuses. */
  inputOriginAttached: boolean;
  /** Did a synthetic keydown classify HUMAN and a DSR reply classify CONTROL, with
   *  neither byte reaching the PTY? 'fail' means the reconstruction's ordering
   *  assumption does not hold on this build, and nothing may arm on it. */
  selfTest: InputOriginSelfTest;
}

export type IneligibilityReason =
  | 'NO_STATE'          // no mirror received for this PTY yet - UNKNOWN, fails closed
  | 'UNATTACHED'        // inputOrigin not attached; all bytes would read CONTROL
  | 'SELFTEST_UNKNOWN'  // self-test has not completed
  | 'SELFTEST_FAILED'   // self-test ran and the reconstruction did not hold
  | 'MOUSE_TRACKING';   // TUI has mouse tracking on right now; invisible producers live

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: IneligibilityReason; detail?: string };

/**
 * THE predicate. Pure, synchronous, no I/O, evaluated fresh on every call so that a
 * mode change between two guards changes the answer (re-entrant by construction).
 * Order of checks is the order of evidence quality: absence, attachment, proof, mode.
 */
export function automaticDeliveryEligibility(state: TerminalInputState | undefined | null): Eligibility {
  if (!state) return { eligible: false, reason: 'NO_STATE' };
  if (!state.inputOriginAttached) return { eligible: false, reason: 'UNATTACHED' };
  if (state.selfTest === 'unknown') return { eligible: false, reason: 'SELFTEST_UNKNOWN' };
  if (state.selfTest === 'fail') return { eligible: false, reason: 'SELFTEST_FAILED' };
  if (state.mouseTrackingMode !== 'none') {
    return { eligible: false, reason: 'MOUSE_TRACKING', detail: state.mouseTrackingMode };
  }
  return { eligible: true };
}

/** Runtime guard for the IPC boundary: refuse a malformed mirror rather than store it. */
export function isTerminalInputState(v: unknown): v is TerminalInputState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    (s.mouseTrackingMode === 'none' || s.mouseTrackingMode === 'x10' || s.mouseTrackingMode === 'vt200'
      || s.mouseTrackingMode === 'drag' || s.mouseTrackingMode === 'any')
    && typeof s.inputOriginAttached === 'boolean'
    && (s.selfTest === 'unknown' || s.selfTest === 'pass' || s.selfTest === 'fail')
  );
}

/** Structural equality, so the renderer reports only on change and main is not spammed. */
export function sameInputState(a: TerminalInputState | undefined, b: TerminalInputState): boolean {
  return !!a && a.mouseTrackingMode === b.mouseTrackingMode
    && a.inputOriginAttached === b.inputOriginAttached && a.selfTest === b.selfTest;
}
