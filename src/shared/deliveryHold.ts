/**
 * L0-FUSION stage 5.4b - WHAT A PERSON IS TOLD about a queue that is not moving.
 *
 * Pure wording over state MAIN computed. Nothing here decides a delivery: the hold, the
 * evidence and the inhibition all arrive already settled in the control snapshot, and this
 * module only chooses the words and names the one human action that ends the hold.
 *
 * Three rules it exists to keep, each pinned by a killer and a mutant in
 * test/delivery-hold.test.cjs:
 *
 *   1. "No pool" is OUTSIDE CAPACITY GATING. It is never worded as available, healthy or
 *      allowed - nothing was measured, so nothing is claimed (the L0-UNKNOWN ruling keeps
 *      "no pool", "held for want of evidence" and "allowed" three different things).
 *   2. A stale all-clear and a recovering pool are never worded as healthy.
 *   3. A hold that never ends on its own ("limited, no known reset") says so, and says that
 *      "send now" is the way out - a person must not be left waiting on something that will
 *      not happen. (Its old sibling, "spent, reset passed", is no longer endless: the human
 *      ruled it ONE post-reset probe, worded as one unconfirmed probe and never as healthy.)
 *
 * INTERFERED outranks everything: a human typed onto automation's staged text, main sent
 * no Enter and cleared nothing, and main refuses EVERY programmatic delivery to that
 * terminal - "send now" included - until a human says the prompt is dealt with. So its
 * action is RESOLVE, never SEND_NOW, and there is no wording that promises it will pass.
 *
 * RESOLVING IS TWO ACTIONS, NEVER ONE (human ruling, option B). A bare "resolved" could not
 * say whether the person had submitted the staged message themselves, and if they had, the
 * queue delivered it a second time. The two actions are worded so the DUPLICATE RISK is on
 * the button's own tooltip, and nothing anywhere guesses from an empty prompt.
 */

export type CapacityEvidenceName =
  | 'NO_POOL' | 'FRESH_HEALTHY' | 'STALE_AFTER_HEALTHY' | 'FRESH_NOT_HEALTHY' | 'STALE_AFTER_LIMITED'
  | 'STALE_AFTER_UNHEALTHY' | 'RECOVERING' | 'NO_STATE' | 'INDETERMINATE' | 'UNCLASSIFIED'
  | 'POST_RESET_PROBE' | 'POST_RESET_PROBE_SPENT' | 'LIMITED_NO_KNOWN_RESET';

export interface CapacityWording {
  /** The state, in words, whether or not it holds anything. */
  state: string;
  /** Can a hold on this evidence be PROMISED to end without a person? `false` = it cannot,
   *  and the hint itself must then name the way out. */
  endsByItself: boolean;
  /** Only with `endsByItself: false`: the hold USUALLY ends by itself but cannot be promised
   *  to. The hint then keeps the state and adds this, instead of claiming nothing will ever
   *  lift it - worded for the worst case without lying about the common one. */
  ifItDoesNot?: string;
}

/** TOTAL over the evidence labels main publishes (checked against main's own union). */
export const CAPACITY_WORDING: Record<CapacityEvidenceName, CapacityWording> = {
  NO_POOL: { state: 'outside capacity gating', endsByItself: true },
  FRESH_HEALTHY: { state: 'provider capacity healthy (fresh reading)', endsByItself: true },
  STALE_AFTER_HEALTHY: { state: 'capacity reading is stale; the last one was an all-clear', endsByItself: true },
  FRESH_NOT_HEALTHY: { state: 'provider capacity is limited', endsByItself: true },
  STALE_AFTER_LIMITED: { state: 'provider capacity was limited; the reading is now stale', endsByItself: true },
  STALE_AFTER_UNHEALTHY: { state: 'capacity reading is stale; the last one showed a spent window', endsByItself: true },
  RECOVERING: { state: 'recovering after a reset; one probe turn at a time, not yet confirmed', endsByItself: true },
  NO_STATE: { state: 'no capacity reading for this provider pool yet', endsByItself: true },
  INDETERMINATE: { state: 'provider capacity could not be determined', endsByItself: true },
  UNCLASSIFIED: { state: 'provider capacity state not recognised', endsByItself: true },
  POST_RESET_PROBE: { state: 'the spent window has passed its reset; one probe turn may go out, nothing is confirmed', endsByItself: true },
  // Usually the probe turn itself produces the reading that ends this. But if the probe was
  // interfered with and its terminal died, NO turn ran and no reading is coming (unproven
  // list, 13c) - and the two cannot be told apart here. So it is not promised to end.
  POST_RESET_PROBE_SPENT: {
    state: 'reset passed and the one probe turn has been used; waiting for a new capacity reading',
    endsByItself: false,
    ifItDoesNot: 'if none arrives, use "send now" (or any turn by an agent on this account)'
  },
  LIMITED_NO_KNOWN_RESET: { state: 'limited, no known reset', endsByItself: false }
};

/** What main says about an unresolved INTERFERED on this agent's terminal. */
export interface InterferedView { requestId: string; reason: string; at: number }

export interface DeliveryHoldInput {
  agentName: string;
  interfered: InterferedView | null;
  /** Floor-wide auto-delivery pause. */
  paused: boolean;
  /** The head of the queue was released with "send now". */
  headManual: boolean;
  capacityHold: boolean;
  capacityEvidence: CapacityEvidenceName | null;
}

export type DeliveryHoldAction = 'RESOLVE_INTERFERENCE' | 'SEND_NOW' | null;

/** One of the two ways a person ends an INTERFERED hold. `how` is what main is told. */
export interface InterferenceChoice {
  how: 'SEND_AGAIN' | 'ALREADY_HANDLED';
  label: string;
  title: string;
}

/** Is the held request a queue item (the drain's `queue:<agent>:<id>`)? A worker wake or a
 *  boot prompt can be held too, and then there is no queued message to send or drop. */
export function heldIsQueueItem(interfered: InterferedView | null): boolean {
  return !!interfered && interfered.requestId.startsWith('queue:');
}

/**
 * The two resolutions, worded for what is actually held.
 *
 * A QUEUE ITEM: "send queued message" keeps it and re-delivers it through every gate;
 * "already handled - drop" removes THAT item and nothing else, and types nothing.
 * NOT A QUEUE ITEM (a worker wake, a boot prompt): there is nothing queued to send or drop.
 * "Let it retry" only releases the hold and gives the capacity turn back - a wake fires
 * again by its own schedule, a boot prompt is NOT re-sent by anything. "Already handled"
 * releases the hold and counts the turn as used. Neither types anything.
 */
export function interferenceChoices(interfered: InterferedView | null): InterferenceChoice[] {
  if (!interfered) return [];
  if (heldIsQueueItem(interfered)) {
    return [
      { how: 'SEND_AGAIN', label: 'send queued message',
        title: 'The queued message has NOT been handled: I dealt with the prompt, deliver the message again. '
          + 'It goes through every normal check and is typed only onto a clear prompt. '
          + 'DO NOT use this if you already pressed Enter on it yourself - it would be sent TWICE. Nothing is typed by pressing this.' },
      { how: 'ALREADY_HANDLED', label: 'already handled — drop',
        title: 'I handled or submitted this content myself: drop the held message so it is NOT sent again. '
          + 'Only that one message is removed; nothing is typed, erased or submitted by pressing this.' }
    ];
  }
  return [
    { how: 'SEND_AGAIN', label: 'let it retry',
      title: 'An automatic wake-up or start-up message (not one of your queued messages) was interrupted. '
        + 'Release the hold so automatic delivery can happen again. A wake-up retries on its own schedule; a start-up message is NOT re-sent. Nothing is typed by pressing this.' },
    { how: 'ALREADY_HANDLED', label: 'already handled',
      title: 'An automatic wake-up or start-up message (not one of your queued messages) was interrupted and I dealt with it myself. '
        + 'Release the hold and count it as done. Nothing is typed by pressing this.' }
  ];
}

export interface DeliveryHoldView {
  kind: 'INTERFERED' | 'PAUSED' | 'CAPACITY';
  hint: string;
  title: string;
  /** The ONE human action that ends this hold. Never performed by anything but a click. */
  action: DeliveryHoldAction;
}

const wordingOf = (evidence: CapacityEvidenceName | null): CapacityWording =>
  (evidence && CAPACITY_WORDING[evidence]) || CAPACITY_WORDING.UNCLASSIFIED;

/** Why main is holding this agent's queue, in words - or null when it is not. */
export function deliveryHoldView(i: DeliveryHoldInput): DeliveryHoldView | null {
  if (i.interfered) {
    return {
      kind: 'INTERFERED',
      hint: `held — someone typed into ${i.agentName}'s terminal while a message was being delivered`,
      title: `A queued message was typed onto ${i.agentName}'s prompt and a person typed before it was submitted. `
        + 'Nothing was submitted and nothing was erased: the text is still on that prompt, and it is yours. '
        + 'Automatic delivery to this terminal stays off - "send now" included - until you deal with the prompt '
        + 'and then say which happened: the message still needs sending, or you already handled it. It does not time out.',
      action: 'RESOLVE_INTERFERENCE'
    };
  }
  if (i.paused && !i.headManual) {
    return {
      kind: 'PAUSED',
      hint: 'held — delivery paused floor-wide',
      title: 'Auto-delivery is paused for the whole floor. Resume it in the Command Center, or use "send now" on a message below.',
      action: 'SEND_NOW'
    };
  }
  if (i.capacityHold && !i.headManual) {
    const w = wordingOf(i.capacityEvidence);
    if (!w.endsByItself && w.ifItDoesNot) {
      return {
        kind: 'CAPACITY',
        hint: `held — ${w.state} — ${w.ifItDoesNot}`,
        title: `Automatic delivery to ${i.agentName} is held (${w.state}). A new reading normally arrives and lifts this by itself, `
          + 'but that cannot be promised: if the probe turn never actually ran, no reading is coming. '
          + '"send now" on a message below, or any turn by an agent on this account, is the way out.',
        action: 'SEND_NOW'
      };
    }
    return w.endsByItself
      ? {
          kind: 'CAPACITY',
          hint: `held — ${w.state}`,
          title: `Automatic delivery to ${i.agentName} waits for provider capacity (${w.state}). `
            + 'It resumes by itself when a newer reading allows it. "send now" on a message below delivers it anyway.',
          action: 'SEND_NOW'
        }
      : {
          kind: 'CAPACITY',
          hint: `held — ${w.state}: nothing will lift this on its own — use "send now"`,
          title: `Automatic delivery to ${i.agentName} is held (${w.state}) and NOTHING AUTOMATIC WILL RELEASE IT: `
            + 'no reading is coming that could lift this hold. "send now" on a message below is the way out.',
          action: 'SEND_NOW'
        };
  }
  return null;
}

/** The capacity state in words for a queue that IS moving - so "no pool" is never
 *  mistaken for a measured all-clear. Null when there is nothing worth saying. */
export function capacityStateNote(evidence: CapacityEvidenceName | null | undefined): string | null {
  if (!evidence || evidence === 'FRESH_HEALTHY') return null;
  return wordingOf(evidence).state;
}

/** Is this queue row the item main is holding under INTERFERED? The drain's request id is
 *  `queue:<agent>:<messageId>`; a worker wake or a boot prompt matches no row. */
export function isHeldQueueItem(interfered: InterferedView | null, messageId: string): boolean {
  return !!interfered && interfered.requestId.startsWith('queue:') && interfered.requestId.endsWith(`:${messageId}`);
}

// ─── Agent impact (v1.1.45 unit #5) ───────────────────────────────────────────────────────

/**
 * WHAT AN AGENT'S CARD SAYS WHILE A HOLD IS REAL (design of record §5, §6, C2.11 crit 13).
 *
 * An agent whose automatic delivery is held must never just read "idle": it is not idle,
 * it is waiting on something, and "idle" tells a person there is nothing to do. So main
 * produces ONE string per hold kind, from the same settled facts `deliveryHoldView`
 * words. The renderer shows the string as given and composes nothing.
 *
 * The copy is Jim's, blessed for unit #5. `<pool>` is the capacity strip's own pool label,
 * so the card and the strip name a pool the same way ("Codex 2" included). No figure ever
 * appears here: the number lives once, on the strip (§6; crit 14's duplicate-text arm).
 *
 * The precedence is `deliveryHoldView`'s: INTERFERED, then the auto-delivery pause, then
 * capacity. The first real hold names the impact. No hold at all means NO string: absence
 * is how "nothing is held" is said, including a manual send with no hold behind it.
 */
export type AgentImpactKind =
  | 'INTERFERED'
  | 'DELIVERY_PAUSED'
  | 'CAPACITY_LIMITED'
  | 'CAPACITY_RESERVE_ONLY'
  | 'CAPACITY_RECOVERING'
  | 'CAPACITY_PROBE_USED'
  | 'CAPACITY_UNKNOWN';

/** The leading word of the string, for a badge. The same word, never a second one. */
export type AgentImpactVerb = 'held' | 'paused' | 'waiting';

export interface AgentImpact {
  kind: AgentImpactKind;
  verb: AgentImpactVerb;
  text: string;
}

/** The capacity-pool state the hold is about, as the tracker publishes it. */
export type ImpactPoolState = 'UNKNOWN' | 'AVAILABLE' | 'APPROACHING' | 'RESERVE_ONLY' | 'LIMITED' | 'RECOVERING';

export interface AgentImpactInput {
  interfered: boolean;
  /** Auto-delivery paused for this agent (the Command Center's floor switch sets it for all). */
  autoDeliveryPaused: boolean;
  capacityHold: boolean;
  capacityEvidence: CapacityEvidenceName | null;
  /** The held pool's tracker state, or null when the hold has no resolvable pool. */
  poolState: ImpactPoolState | null;
  /** The strip's label for that pool, or null when there is none to name. */
  poolLabel: string | null;
}

const impact = (kind: AgentImpactKind, verb: AgentImpactVerb, rest: string): AgentImpact =>
  ({ kind, verb, text: `${verb} · ${rest}` });

/**
 * A pool with no label (a binding the pool-count cap left unresolved) is named generically,
 * "paused · capacity limited" (Jim, I3): a hold with no pool must never invent a provider name.
 */
const poolName = (label: string | null): string => label ?? 'capacity';

/** The impact string for one agent, or null when nothing is held. */
export function agentImpactOf(i: AgentImpactInput): AgentImpact | null {
  if (i.interfered) return impact('INTERFERED', 'held', 'a typed-over message needs you');
  // "(floor)" is exact today: the only auto-delivery pause in the UI is the Command Center's
  // floor-wide switch (the per-agent pause was removed in v0.3.4). IF a per-agent pause ever
  // returns to the UI, main must pass a floor-wide bit here and drop "(floor)" for a solo pause.
  if (i.autoDeliveryPaused) return impact('DELIVERY_PAUSED', 'paused', 'auto-delivery off (floor)');
  if (!i.capacityHold) return null;
  const pool = poolName(i.poolLabel);
  // A SPENT probe outranks recovering (F4): the pool may still read RECOVERING, but the one
  // turn it allows is already out, so the agent is waiting for a reading, not recovering.
  if (i.capacityEvidence === 'POST_RESET_PROBE_SPENT') {
    return impact('CAPACITY_PROBE_USED', 'waiting', `${pool} probe used, awaiting reading`);
  }
  if (i.capacityEvidence === 'RECOVERING' || i.poolState === 'RECOVERING') {
    return impact('CAPACITY_RECOVERING', 'waiting', `${pool} recovering`);
  }
  if (i.poolState === 'RESERVE_ONLY') return impact('CAPACITY_RESERVE_ONLY', 'paused', `${pool} reserve only`);
  if (i.poolState === 'LIMITED' || i.capacityEvidence === 'FRESH_NOT_HEALTHY'
    || i.capacityEvidence === 'STALE_AFTER_LIMITED' || i.capacityEvidence === 'LIMITED_NO_KNOWN_RESET') {
    return impact('CAPACITY_LIMITED', 'paused', `${pool} limited`);
  }
  // Held for want of evidence (the L0-UNKNOWN ruling holds NO_STATE, STALE_AFTER_UNHEALTHY,
  // INDETERMINATE and anything unclassified): the one string that claims nothing, so a held
  // agent still never reads idle. Blessed (Jim, I1).
  return impact('CAPACITY_UNKNOWN', 'waiting', `${pool} capacity unknown`);
}
