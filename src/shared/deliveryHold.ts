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
 *   3. The two holds that never end on their own say so, and say that "send now" is the
 *      way out - a person must not be left waiting on something that will not happen.
 *
 * INTERFERED outranks everything: a human typed onto automation's staged text, main sent
 * no Enter and cleared nothing, and main refuses EVERY programmatic delivery to that
 * terminal - "send now" included - until a human says the prompt is dealt with. So its
 * action is RESOLVE, never SEND_NOW, and there is no wording that promises it will pass.
 */

export type CapacityEvidenceName =
  | 'NO_POOL' | 'FRESH_HEALTHY' | 'STALE_AFTER_HEALTHY' | 'FRESH_NOT_HEALTHY' | 'STALE_AFTER_LIMITED'
  | 'STALE_AFTER_UNHEALTHY' | 'RECOVERING' | 'NO_STATE' | 'INDETERMINATE' | 'UNCLASSIFIED'
  | 'SPENT_RESET_PASSED' | 'LIMITED_NO_KNOWN_RESET';

export interface CapacityWording {
  /** The state, in words, whether or not it holds anything. */
  state: string;
  /** Can a hold on this evidence end without a person? `false` = only "send now" ends it. */
  endsByItself: boolean;
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
  SPENT_RESET_PASSED: { state: 'spent, reset passed, no refusal', endsByItself: false },
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
        + 'and press "resolved". It does not time out.',
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
