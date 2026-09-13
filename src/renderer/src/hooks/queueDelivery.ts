/** Run one queued delivery and acknowledge it only after the sender resolves.
 * Rejections deliberately leave the queue item untouched for the next retry. */
export async function deliverWithAcknowledgement(
  send: () => Promise<void>,
  acknowledge: () => void
): Promise<boolean> {
  try {
    await send();
    acknowledge();
    return true;
  } catch {
    return false;
  }
}

/**
 * May the drain type into this agent's terminal right now?
 *
 * The gate used to be `status === 'idle'`, full stop, and that stranded mail
 * indefinitely. `looping` is not a terminal state the agent recovers from on its
 * own — it is the circuit breaker's PIN, re-asserted on every beat for as long
 * as the agent is `constrained` or `stopped`. The PTY-quiescence fallback only
 * un-pins `working`, so a breaker-armed agent never returned to `idle` and its
 * queue never drained. Observed live: an agent over its token cap sat pinned
 * while a nudge enqueued two seconds after the message landed went undelivered
 * for minutes, until something outside the app woke it.
 *
 * That is self-defeating, because the breaker STEERS by mailing the agent it
 * armed ("stop, write a plan, send it to god"). Under the old gate the one
 * message meant to unwedge a wedged agent was exactly the message that could
 * never arrive.
 *
 * So a pinned agent is deliverable once its terminal has been silent for
 * `quiesceMs` — the same evidence the idle fallback already trusts to decide a
 * turn is over. The pin stays on the avatar and the badge; it just stops
 * doubling as a delivery lock.
 *
 * Everything else still holds the prompt:
 *   - `working` / `thinking`: mid-turn. The quiescence fallback flips a genuinely
 *     finished turn to `idle`, and then the ordinary gate applies.
 *   - `waiting` / `blocked`: an interactive prompt is on screen. The drain ends
 *     every delivery with Enter, which would ANSWER it — the same reason the
 *     one-time TUI seed refuses to type at those two statuses.
 *
 * Fails CLOSED on an unknown `ptyQuietMs` (no reading, or a PTY that has never
 * emitted): silence we cannot measure is not evidence of silence.
 */
export function canDeliverToAgent(
  status: string,
  ptyQuietMs: number | null,
  quiesceMs: number
): boolean {
  if (status === 'idle') return true;
  if (status !== 'looping') return false;
  return ptyQuietMs !== null && ptyQuietMs >= quiesceMs;
}

/** The subset of a QueuedMessage this module needs. Kept structural so the
 *  gate is testable without dragging the store (and zustand) into the test. */
export interface DeliveryGateMessage {
  precondition?: 'inbox-nonempty';
}

export type PreconditionVerdict = 'send' | 'drop';

/** Re-check a queued message's delivery-time precondition, immediately before it
 *  is typed into a PTY.
 *
 *  A queue item is decided at enqueue time and delivered an arbitrary interval
 *  later, so some messages describe a world that may no longer exist by the time
 *  their turn comes. The inbox-wake nudge is the motivating case: an agent that
 *  is already awake routinely drains its whole inbox during the same turn the
 *  nudge was queued from, and delivering it afterwards spends a full turn
 *  discovering there is nothing to read.
 *
 *  Returns 'drop', never 'defer': a stale message left at the head of the queue
 *  would block every message behind it forever.
 *
 *  Fails OPEN. If the inbox cannot be read we send, because a spurious nudge
 *  costs one turn whereas a swallowed one can leave real mail unread
 *  indefinitely. */
export async function checkPrecondition(
  message: DeliveryGateMessage,
  readInbox: () => Promise<{ id?: string }[]>
): Promise<PreconditionVerdict> {
  if (message.precondition !== 'inbox-nonempty') return 'send';
  try {
    return (await readInbox()).length > 0 ? 'send' : 'drop';
  } catch {
    return 'send';
  }
}

/** One terminal write, as `window.cth.writePty` answers it. */
export interface PtyWriteResult { ok: boolean; error?: string }

/** The four effects a submission is made of, injected so the ORDER can be tested. */
export interface SubmitSteps {
  /**
   * Asked FIRST, and awaited. `false` - or a rejection - means nothing is typed at
   * all. Absent for a submission that holds no reservation, e.g. a manual send.
   */
  maySubmit?: () => Promise<boolean>;
  /** Stage the message text in the terminal input box. */
  writePayload: () => Promise<PtyWriteResult>;
  /** The gap the TUI needs between a paste and its Enter. */
  pause: () => Promise<void>;
  /** The submit keystroke. */
  writeSubmit: () => Promise<PtyWriteResult>;
}

/**
 * Type one message into a terminal and submit it — in the one order that leaves
 * NOTHING BEHIND when the submission is refused.
 *
 * L0-STAGED. The gate used to be asked after the payload had already been written and
 * the TUI pause had already elapsed, so a refusal withheld only the Enter: THE MESSAGE
 * TEXT WAS LEFT SITTING IN THE INPUT BOX, where a retry could append to it and where a
 * human could submit it by pressing Enter without ever knowing capacity had refused.
 * A REFUSAL THAT LEAVES TEXT A HUMAN CAN SEND IS A REFUSAL THAT DID NOT REFUSE — the
 * same failure as a turn spent that nothing authorised, arriving by a different route.
 *
 * WHY THE ORDER RATHER THAN A CLEANUP. Clearing the box on refusal is the smaller
 * change and it cannot be made safe: the only cleanup that reaches every character
 * this delivery staged is one that also wipes whatever a HUMAN had typed into the same
 * prompt, which turns a capacity refusal into data loss for someone who was not
 * involved. A bounded cleanup — count the characters back — has to model wrapping,
 * bracketed paste and TUI redraw to be correct, and it still leaves a window in which
 * the text is sendable. THE ONLY CLEANUP THAT CANNOT DAMAGE A HUMAN'S TYPING IS THE
 * ONE THAT NEVER HAS TO HAPPEN. So the residue is not removed; it is never created.
 *
 * WHAT THE ORDER COSTS, STATED RATHER THAN GLOSSED. Asking first widens the window
 * between "main has recorded the write" and "the keystroke goes out" by the payload
 * write plus the pause. A death in THAT window means main believes a write that never
 * happened: one missed turn, visible and retryable. The window it removes fails the
 * other way — text a human can send that nothing authorised, which nobody sees. A
 * window that fails safe was traded for a window that does not.
 *
 * Rejections are not swallowed here. Every failure throws, and the caller settles the
 * delivery as NOT launched, so the reservation goes back and the message stays queued.
 */
export async function typeAndSubmit(ptyId: string, steps: SubmitSteps): Promise<void> {
  // THE FIRST STATEMENT IS THE FIX. Moving it below the payload write restores the
  // defect exactly, and would still pass any test that only checks the Enter.
  if (steps.maySubmit && !(await steps.maySubmit())) {
    throw new Error(`capacity refused the submit keystroke for ${ptyId}: the ticket is no longer held`);
  }
  const wrote = await steps.writePayload();
  if (!wrote?.ok) throw new Error(wrote?.error ?? `pty write failed: ${ptyId}`);
  await steps.pause();
  const submitted = await steps.writeSubmit();
  if (!submitted?.ok) throw new Error(submitted?.error ?? `pty write failed: ${ptyId}`);
}
