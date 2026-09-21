/**
 * v1.1.45 unit #11 — the composer HEADER's status line. Pure.
 *
 * Before this unit an EMPTY queue said nothing (only INTERFERED escaped), so an agent on a
 * LIMITED, recovering or stale pool looked exactly like one on a healthy pool until a
 * message was queued. Now the capacity note shows in the header UNCONDITIONALLY: with an
 * empty queue it stands alone; with a moving queue it rides on "sending … one-by-one".
 *
 * Only the NOTE lost its queue gate. Everything that is about the queue itself — busy,
 * the pause/capacity hold hint, the terminal blocks, and the "send now" controls — still
 * needs a queued message, exactly as before. INTERFERED still shows with nothing queued.
 *
 * The words are MAIN's (`capacityStateNote`, shared/deliveryHold.ts); a fresh healthy
 * reading has no note, so a healthy empty composer stays silent.
 */
import type { DeliveryHoldView } from '@shared/deliveryHold';
import type { TerminalAutomationBlock } from './terminalAutomation';

export interface ComposerStatusInput {
  agentName: string;
  queueLength: number;
  idle: boolean;
  hold: DeliveryHoldView | null;
  block: TerminalAutomationBlock;
  capacityNote: string | null;
}

export interface ComposerStatus {
  text: string;
  /** Tooltip: the hold's full explanation while a message is held behind it (as before);
   *  the note itself on an empty queue, where "send now on a message below" has no row. */
  title: string;
}

export function composerStatus(i: ComposerStatusInput): ComposerStatus | null {
  const own = (text: string): ComposerStatus => ({ text, title: text });
  if (i.hold?.kind === 'INTERFERED') return { text: i.hold.hint, title: i.hold.title };
  if (i.queueLength === 0) return i.capacityNote ? own(i.capacityNote) : null;
  if (!i.idle) {
    const text = `${i.agentName} is busy — ${i.queueLength} queued`;
    return { text, title: i.hold ? i.hold.title : text };
  }
  if (i.hold) return { text: i.hold.hint, title: i.hold.title };
  if (i.block === 'draft') return own(`held — ${i.agentName}'s terminal has unsent text on its prompt`);
  if (i.block === 'picker') return own(`held — a slash-command picker is open in ${i.agentName}'s terminal`);
  if (i.block === 'exited') return own(`held — ${i.agentName}'s terminal has exited`);
  return own(`sending to ${i.agentName} one-by-one…${i.capacityNote ? ` (${i.capacityNote})` : ''}`);
}
