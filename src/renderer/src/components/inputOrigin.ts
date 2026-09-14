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
export function classifyOutbound(ptyId: string): InputOrigin {
  const w = windows.get(ptyId);
  if (!w) return 'CONTROL';
  if (w.held) {
    // Every byte during a held window re-arms the drain, so a composition that
    // emits diff + DEL + newValue across ticks stays HUMAN to the last byte.
    rearmHold(w, null);
    return 'HUMAN';
  }
  return w.sameTick ? 'HUMAN' : 'CONTROL';
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
  armProbe: (cb: (origin: InputOrigin) => void) => void,
  disarmProbe: () => void
): Promise<'pass' | 'fail'> {
  const ta = term.textarea;
  if (!ta || !isInputOriginAttached(ptyId)) return 'fail';

  // Half 1: keyboard -> HUMAN, synchronously.
  // Holder object, not a `let`: TS narrows a `let` to `null` across the closure
  // assignment, and a future compiler may reject the comparison below as no-overlap.
  const key: { got: InputOrigin | null } = { got: null };
  armProbe((o) => { key.got = o; });
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true
  } as KeyboardEventInit));
  // The probe must already have fired: same dispatch, no tick between.
  const keyOk = key.got === 'HUMAN';
  disarmProbe();
  if (!keyOk) return 'fail';

  // Let the same-tick window close before the control half, or a fast reply could
  // be classified by the keyboard's window and the test would pass for the wrong reason.
  await new Promise<void>((r) => { queueMicrotask(r); });

  // Half 2: DSR reply -> CONTROL. `write(data, cb)` resolves after parsing, and the
  // reply is emitted synchronously inside that parse, so by `cb` the probe has fired.
  const ctlResult = await new Promise<InputOrigin | null>((resolve) => {
    const ctl: { got: InputOrigin | null } = { got: null };
    armProbe((o) => { ctl.got = o; });
    term.write('\x1b[6n', () => resolve(ctl.got));
  });
  disarmProbe();
  return ctlResult === 'CONTROL' ? 'pass' : 'fail';
}

/** Test seam: the window state, read-only. Not for production decisions. */
export function inspectInputOrigin(ptyId: string): { sameTick: boolean; held: boolean; lastReason: HumanOriginReason | null; attached: boolean } | null {
  const w = windows.get(ptyId);
  if (!w) return null;
  return { sameTick: w.sameTick, held: w.held, lastReason: w.lastReason, attached: w.detach != null };
}
