/**
 * THE ONE OWNER OF INPUT PROVENANCE IN THE RENDERER.
 *
 * L0-FUSION rev 13 section 13.2. One module, one per-terminal HUMAN WINDOW, and one
 * place that asks it: `terminalPool`'s `term.onData` handler, which is the single
 * existing ingress for everything xterm emits. Nothing here reads private xterm state,
 * nothing infers from terminal output, and nothing forks the library.
 *
 * HOW THE WINDOW OPENS — two ways and only two:
 *   (a) a CAPTURE-PHASE DOM listener on `term.element`. Every xterm input listener sits
 *       on `element`, `screenElement` or `textarea` — all inside that subtree — and
 *       capture on the ancestor runs before xterm's own handler. So by the time xterm
 *       turns the event into `onData`, the window is already open. Public API only:
 *       `term.element` is `typings/xterm.d.ts:785`.
 *   (b) an explicit `markHumanOrigin()` call from code we own with known provenance
 *       (paste paths, drag-drop, user clear/dismiss). This is the half the human ruled
 *       admissible because "the tagging occurs at code we own; it is not inference".
 *
 * HOW IT CLOSES — two regimes, because xterm emits data on two different schedules:
 *   SAME-TICK  keydown/keypress/paste/wheel/mousedown/touchstart → `triggerDataEvent`
 *              synchronously inside the same dispatch (browser/Terminal.ts:1072, :1155,
 *              Clipboard.ts:54, Terminal.ts:824, CoreMouseService.ts:284). The window
 *              closes in a microtask, so it cannot leak into a later tick.
 *   HELD       IME and `input` events do NOT emit synchronously. CompositionHelper
 *              finalises in a `setTimeout(0)` (CompositionHelper.ts:153) and textarea
 *              diffs go through another (`:186`), emitting up to three data events
 *              (`:196`, `:198`, `:200`). So a microtask window would classify the first
 *              and LOSE THE REST — constraint (iii). For these the window is HELD and
 *              re-armed by every classified byte, closing only after HELD_DRAIN_MS of
 *              quiet. The exact drain boundary is the one thing in this design that is
 *              pinned by a test rather than derived — see the stage-4 tests.
 *
 * WHAT IS EXCLUDED BY NAME, AND WHY IT IS MEASURED RATHER THAN REASONED:
 *   `focus` / `blur`. They are registered on the textarea (Terminal.ts:467-468), INSIDE
 *   this subtree, and when the TUI has enabled focus reporting they produce `ESC[I` /
 *   `ESC[O` — correctly non-human in xterm (`wasUserInput` defaults false at :271/:295).
 *   The L0-TERMMATRIX capture measured `sendFocusMode: true` on claude. A latch that
 *   listened to focus would classify an automatic focus report as HUMAN: a user clicking
 *   into the terminal during the staged gap would raise INTERFERED on the terminal's own
 *   reply. So they are not listened to, on purpose, here.
 *
 * WHAT THIS DOES NOT SEE, AND IS NOT PRETENDING TO:
 *   Mouse drag/release reports (CoreMouseService.ts:284 via `_document` listeners,
 *   Terminal.ts:791/:794) and alt-click cursor moves (SelectionService.ts:711 via
 *   `ownerDocument`, :492-493) fire on DOCUMENT-level listeners, outside any public xterm
 *   surface. The first is REFUSED at runtime by the mouse-tracking rule; the second is
 *   REMOVED by `altClickMovesCursor: false`. Neither is inferred. This module is a
 *   reconstruction, not a supported outbound origin signal, and the human accepted it on
 *   exactly those terms — keep it written that way.
 */
import type { Terminal } from '@xterm/xterm';
import type { HumanOriginReason, InputOrigin } from '@shared/inputOrigin';

/** How long a HELD window survives after its last byte. Long enough to outlive
 *  CompositionHelper's `setTimeout(0)` hops under load; short enough that a stray
 *  `input` event cannot make the next automatic reply look human for long. */
export const HELD_DRAIN_MS = 50;

/** A self-test probe: offered each classified byte, it returns TRUE to CONSUME the
 *  byte (swallow it - it is evidence, not input, and must not reach the pty) or
 *  FALSE to let it flow on normally. A CORRELATED probe consumes ONLY the specific
 *  byte it is waiting for, so an unrelated reply neither satisfies it nor is lost. */
export type ProbeConsumer = (origin: InputOrigin, data: string) => boolean;

/** ArrowRight, as xterm emits it for a synthetic keydown: `ESC[C` (normal cursor
 *  keys) or `ESC O C` (application cursor keys). The self-test's keyboard half
 *  consumes exactly this and nothing else. */
export const SELFTEST_ARROW_RIGHT = /^\x1b(\[|O)C$/;
/** The control half's request correlation (god fix-round-3 amendment; Phyllis Rank 1).
 *  DECRQM echoes the queried mode number VERBATIM: for an unrecognised ANSI mode `ESC[<n>$p`,
 *  xterm 5.5.0 replies `ESC[<n>;0$y` (InputHandler.requestMode; the ANSI branch recognises
 *  only modes 2/4/12/20, everything else -> value 0). We query a fresh RANDOM nonce per
 *  self-test, so the reply carries a token only we generated - provably ours WITHOUT relying
 *  on same-parse adjacency or xterm's non-coalescing behaviour, and uncollidable with ordinary
 *  program output. VERSION-PINNED: the echo behaviour is xterm 5.5.0's (recorded in the design
 *  note); the EXACT-match on the reply fails closed if a future xterm fragments or coalesces
 *  it (Phyllis Rank 3), a live check rather than a comment. */
export const selftestQuery = (nonce: number): string => '\x1b[' + nonce + '$p';
export const selftestReply = (nonce: number): string => '\x1b[' + nonce + ';0$y';
/** A fresh nonce in [100000, 999999] - 900k values, collision probability ~0. */
export const makeNonce = (): number => 100000 + Math.floor(Math.random() * 900000);
/** How long a self-test half waits for its correlated byte before failing closed. */
export const SELFTEST_TIMEOUT_MS = 1000;

/** DOM events whose data reaches `onData` synchronously inside the same dispatch. */
export const SAME_TICK_EVENTS = ['keydown', 'keypress', 'paste', 'wheel', 'mousedown', 'touchstart'] as const;
/** DOM events whose data is emitted by xterm on a LATER tick (see header). */
export const HELD_EVENTS = ['input', 'compositionstart', 'compositionupdate', 'compositionend'] as const;
/** Listened to by NOTHING here. Present so a test can assert they stay excluded. */
export const EXCLUDED_EVENTS = ['focus', 'blur'] as const;

interface HumanWindow {
  /** Open for the remainder of the current dispatch; a microtask closes it. */
  sameTick: boolean;
  /** Open until HELD_DRAIN_MS of quiet; re-armed by every classified byte. */
  held: boolean;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** Last reason the window was opened — diagnostics only, never a decision input. */
  lastReason: HumanOriginReason | null;
  detach: (() => void) | null;
}

const windows = new Map<string, HumanWindow>();

function ensure(ptyId: string): HumanWindow {
  let w = windows.get(ptyId);
  if (!w) {
    w = { sameTick: false, held: false, holdTimer: null, lastReason: null, detach: null };
    windows.set(ptyId, w);
  }
  return w;
}

function openSameTick(w: HumanWindow, reason: HumanOriginReason): void {
  w.lastReason = reason;
  if (w.sameTick) return;
  w.sameTick = true;
  // Microtask, not setTimeout: the close must land after xterm's synchronous
  // handler in THIS dispatch and before any other task can run.
  queueMicrotask(() => { w.sameTick = false; });
}

function rearmHold(w: HumanWindow, reason: HumanOriginReason | null): void {
  if (reason) w.lastReason = reason;
  w.held = true;
  if (w.holdTimer) clearTimeout(w.holdTimer);
  w.holdTimer = setTimeout(() => { w.held = false; w.holdTimer = null; }, HELD_DRAIN_MS);
}

/**
 * Attach the DOM half of provenance to an OPENED terminal. Returns the detach function.
 *
 * Constraint (iv): `term.element` is created inside `open()` (browser/Terminal.ts:444),
 * so before `open()` it is `undefined` and a listener attached then attaches to nothing
 * and fails silently. This THROWS rather than returning a no-op, because a provenance
 * module that quietly observes nothing is the fail-open this whole design exists to
 * remove. The caller is `attachTerminal`, after its `open()` guard.
 */
export function attachInputOrigin(ptyId: string, term: Terminal): () => void {
  const el = term.element;
  if (!el) {
    throw new Error(`inputOrigin: attach before open() for ${ptyId} — term.element is undefined`);
  }
  const w = ensure(ptyId);
  if (w.detach) return w.detach; // idempotent: one set of listeners per terminal

  const onSameTick = () => openSameTick(w, 'dom');
  const onHeld = () => rearmHold(w, 'dom');
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of SAME_TICK_EVENTS) el.addEventListener(type, onSameTick, opts);
  for (const type of HELD_EVENTS) el.addEventListener(type, onHeld, opts);
  // EXCLUDED_EVENTS are deliberately not attached. See header.

  const detach = () => {
    for (const type of SAME_TICK_EVENTS) el.removeEventListener(type, onSameTick, opts);
    for (const type of HELD_EVENTS) el.removeEventListener(type, onHeld, opts);
    if (w.holdTimer) clearTimeout(w.holdTimer);
    windows.delete(ptyId);
  };
  w.detach = detach;
  return detach;
}

/** Reset the transient window state for a same-id process relaunch. The DOM
 *  listeners persist (xterm keeps the same `element`/`textarea` across `reset()`),
 *  so `detach` is KEPT and only the in-flight sameTick/held flags and drain timer
 *  are cleared - a held window left open from the dead process must not carry into
 *  the new one. */
export function resetInputWindow(ptyId: string): void {
  const w = windows.get(ptyId);
  if (!w) return;
  w.sameTick = false;
  w.held = false;
  if (w.holdTimer) { clearTimeout(w.holdTimer); w.holdTimer = null; }
  w.lastReason = null;
}

/** Is the DOM half attached for this terminal? The arming gate (stage 3) refuses to
 *  arm automatic delivery when this is false: unattached means every byte reads
 *  CONTROL, which is exactly the silent failure `attachInputOrigin` throws to avoid. */
export function isInputOriginAttached(ptyId: string): boolean {
  return windows.get(ptyId)?.detach != null;
}

/**
 * Explicit provenance from code we own. Call this IMMEDIATELY before the action that
 * will make xterm emit data (e.g. `term.paste(text)`), in the same synchronous run.
 * It opens the same-tick window, so the resulting `onData` classifies HUMAN even when
 * no DOM event is in flight — which is the whole point for the async paste fallback,
 * whose `.then()` runs long after the keystroke that started it.
 */
export function markHumanOrigin(ptyId: string, reason: Exclude<HumanOriginReason, 'dom'>): void {
  openSameTick(ensure(ptyId), reason);
}

/**
 * THE classification point. Called once, at `term.onData`, for every byte xterm emits.
 *
 * Returns HUMAN when a window is open, else CONTROL. Three consequences worth stating:
 *   - A programmatic `Terminal.paste()` opens no window here, so it classifies CONTROL —
 *     even though xterm itself flags it `wasUserInput: true`. Constraint (i) is met by
 *     construction: classification lives with the caller who knows, not the library
 *     that guessed.
 *   - The twelve terminal protocol replies in InputHandler.ts arrive from `write()`
 *     processing, never inside a DOM input dispatch, so they classify CONTROL by absence.
 *   - An UNATTACHED terminal classifies CONTROL for everything. That is not safe on its
 *     own; it is made safe by the arming gate consulting `isInputOriginAttached`.
 */
export function classifyOutbound(ptyId: string, data: string): InputOrigin {
  const w = windows.get(ptyId);
  if (!w) return 'CONTROL';
  // The same-tick window covers a synchronous DOM dispatch (a keystroke, a paste),
  // where an ESC-prefixed byte is a legitimate human arrow/escape key. So it does
  // NOT discriminate by shape - the whole byte is the human's.
  if (w.sameTick) return 'HUMAN';
  if (w.held) {
    // The held window exists ONLY for the IME/`input` drain, whose only legitimate
    // human bytes are the printable composition output (diff / DEL / newValue) - none
    // of which begins with ESC. A terminal PROTOCOL REPLY (DA/DSR/CPR/DECRQM/colour)
    // DOES begin with ESC, and one can land inside the 50 ms drain if the program
    // polls its cursor. It is CONTROL, and - critically - it must NOT rearm the
    // drain, or a TUI emitting periodic cursor reports would hold the window open
    // forever and turn every automatic delivery into a spurious INTERFERED. That
    // wholesale-HUMAN gap is exactly what Dwight's audit (section 23.2) caught: a
    // named focus/blur exclusion made the category feel handled while the general
    // case underneath it was not.
    if (isTerminalReply(data)) return 'CONTROL';
    rearmHold(w, null);
    return 'HUMAN';
  }
  return 'CONTROL';
}

/** A terminal-generated protocol reply, recognised by the one property that
 *  separates it from IME composition output inside the held window: it is an
 *  escape sequence (begins with ESC, 0x1b). Composition output is printable text
 *  and its only C0 byte is DEL (0x7f), never ESC. This is a discriminator for the
 *  HELD window only; a same-tick ESC byte is a human arrow key and stays HUMAN. */
export function isTerminalReply(data: string): boolean {
  return data.charCodeAt(0) === 0x1b;
}

/**
 * The control half's probe as a pure factory, so its correlation can be driven byte-by-byte
 * in a unit test AND installed directly by a REAL-xterm adversarial arm (the human's fix-
 * round-3 requirement: demonstrate that a FOREIGN reply FAILS token correlation, not merely
 * that the parser works). It consumes ONLY the byte that EXACTLY equals our expected nonce
 * reply; a foreign reply - a CPR, a colour report, or a DECRQM reply for a DIFFERENT nonce -
 * fails the equality and flows on untouched. A shape-only probe would swallow the first
 * CPR-shaped byte and leak ours. No same-parse adjacency is assumed.
 */
export function makeNonceCorrelatedProbe(expected: string, onResult: (origin: InputOrigin) => void): ProbeConsumer {
  return (origin, data) => {
    if (data !== expected) return false;   // not our nonce reply (incl. ANY foreign reply): flow on, stay armed
    onResult(origin);                      // our reply: its origin (must be CONTROL) decides pass
    return true;                           // consume it, never sent
  };
}

/**
 * THE STARTUP SELF-TEST (rev 13 step 7). Proves, on THIS terminal on THIS build, the two
 * things the reconstruction rests on and cannot get from any public contract:
 *   1. a keyboard event dispatched into the terminal produces a byte that classifies
 *      HUMAN - i.e. our capture listener runs before xterm's handler in the same
 *      dispatch, and xterm emits synchronously inside it;
 *   2. a terminal protocol reply (DSR, `ESC[6n`) produces a byte that classifies
 *      CONTROL - i.e. write() processing never lands inside a human window.
 *
 * NOT ONE BYTE REACHES THE PTY. The caller supplies `armProbe`, which makes the very
 * next `onData` hand its byte HERE instead of to `writePty`. Without that swallow the
 * keyboard half would type into the real program, which is worse than not testing.
 * The key is ArrowRight (keyCode 39) rather than a printable: xterm's printable path
 * needs `keyCode >= 48` (common/input/Keyboard.ts:381) which a synthetic event only has
 * if we say so, and an arrow is harmless even in the impossible case of a leak.
 *
 * 'fail' is a REFUSAL, not a warning: the predicate in shared/inputProvenance.ts makes
 * a failed self-test ineligible. Proving a property at arm time is not a contract, but
 * it converts a silent failure into a refusal - stated as a mitigation, not a fix.
 */
export async function runInputOriginSelfTest(
  ptyId: string,
  term: Terminal,
  setProbe: (consumer: ProbeConsumer) => void,
  clearProbe: () => void
): Promise<'pass' | 'fail'> {
  const ta = term.textarea;
  if (!ta || !isInputOriginAttached(ptyId)) return 'fail';

  // Each half installs a CORRELATED probe: it consumes ONLY the byte whose shape it
  // is waiting for (returns true) and lets anything else flow on untouched (returns
  // false, staying armed). Dwight 23.1: an uncorrelated one-shot could be satisfied
  // by an unrelated reply and then let the INTENDED byte reach the pty. Correlation
  // is what makes 'not one byte reaches the pty' true for the bytes we generate,
  // rather than true only in a quiescent scenario. A half that never sees its byte
  // TIMES OUT to 'fail' - fail-closed, never a hang.
  const await1 = (match: RegExp): Promise<InputOrigin | 'timeout'> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => { clearProbe(); resolve('timeout'); }, SELFTEST_TIMEOUT_MS);
      setProbe((origin, data) => {
        if (!match.test(data)) return false;   // not our byte: let it flow, stay armed
        clearTimeout(timer); clearProbe(); resolve(origin);
        return true;                            // our byte: consume it, never sent
      });
    });

  // Half 1: a synthetic ArrowRight keydown must emit `ESC[C`/`ESC O C` and classify HUMAN.
  const keyResult = await1(SELFTEST_ARROW_RIGHT);
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true
  } as KeyboardEventInit));
  if ((await keyResult) !== 'HUMAN') return 'fail';

  // Close the same-tick window before the control half so its byte cannot ride it.
  await new Promise<void>((r) => { queueMicrotask(r); });

  // Half 2, NONCE-CORRELATED DECRQM (god fix-round-3 amendment; Phyllis Rank 1). A CPR is only
  // SHAPE-correlated, and my earlier fixed-mode marker rested on SAME-PARSE ADJACENCY; a nonce
  // removes both as load-bearing. We (a) BARRIER: await an empty write, which the WriteBuffer
  // queues in FIFO order, so all prequeued PTY output is parsed and flushed BEFORE we arm;
  // then (b) query ANSI DECRQM for a fresh RANDOM nonce - `ESC[<nonce>$p` - which xterm 5.5.0
  // echoes VERBATIM as `ESC[<nonce>;0$y` for an unrecognised mode. The reply carries a token
  // only we generated, so it is provably ours without adjacency or non-coalescing; a foreign
  // or previous reply cannot satisfy it. We match it EXACTLY (Phyllis Rank 3), so a fragmented
  // or coalesced chunk fails closed. The reply begins with ESC, so the held-window discriminator
  // still reads it CONTROL. Public API only: `terminal.write(data[, callback])` is in xterm.d.ts (R1).
  await new Promise<void>((r) => { term.write('', () => r()); });
  const nonce = makeNonce();
  const expected = selftestReply(nonce);
  const ctlResult = new Promise<InputOrigin | 'timeout'>((resolve) => {
    const timer = setTimeout(() => { clearProbe(); resolve('timeout'); }, SELFTEST_TIMEOUT_MS);
    setProbe(makeNonceCorrelatedProbe(expected, (origin) => {
      clearTimeout(timer); clearProbe(); resolve(origin);
    }));
  });
  term.write(selftestQuery(nonce));
  return (await ctlResult) === 'CONTROL' ? 'pass' : 'fail';
}

/** Test seam: the window state, read-only. Not for production decisions. */
export function inspectInputOrigin(ptyId: string): { sameTick: boolean; held: boolean; lastReason: HumanOriginReason | null; attached: boolean } | null {
  const w = windows.get(ptyId);
  if (!w) return null;
  return { sameTick: w.sameTick, held: w.held, lastReason: w.lastReason, attached: w.detach != null };
}
