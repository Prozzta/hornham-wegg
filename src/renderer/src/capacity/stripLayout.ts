/**
 * v1.1.45 — the title-bar strip's LAYOUT, as a pure function.
 *
 * This decides only which of main's strings and meters are drawn, and in what order.
 * It never decides what they say: every figure and word is copied from the pushed pool.
 *
 * FULL CONTENT, ALWAYS (strip-polish, human ruling 2026-09-21). The strip no longer
 * collapses to fit: it shows everything main sent and SCROLLS when that is wider than
 * the space (CapacityStrip.tsx). This replaces the C2.10 drop-meters / drop-resets /
 * compact ladder, by the human's recorded override. Because nothing is dropped for width
 * any more, the five-hour value can no longer be squeezed out either.
 *
 *   C2.7 / crit 15 ORDER IN THE BLOCKED FRAME. Weekly primary first, then exactly ONE
 *   atomic subordinate five-hour token, with no meter and no reset hint on either window.
 *   The meter check is repeated here although the schema already forbids meters outside
 *   NORMAL: C2.7 is a closure rule, and a second guard costs nothing.
 *
 *   §9 UNKNOWN DRAWS NO METER. No track and no zero-width fill, only main's text.
 */
import type { DisplayReadyMeter } from '@shared/capacityStrip';
import type { PresentedPool } from './capacityStrip';

export type StripRole = 'five-hour' | 'weekly';

export type StripToken =
  | { kind: 'meter'; key: string; role: StripRole; meter: DisplayReadyMeter; valueText: string }
  | { kind: 'figure'; key: string; role: StripRole; text: string; subordinate: boolean }
  | { kind: 'reset'; key: string; role: StripRole; text: string };

/** Fixed pixel geometry shared with the component. */
export const STRIP_GEOMETRY = {
  mark: 14,
  stateToken: 14,
  meter: 40,
  gap: 6,
  poolGap: 18
} as const;

/** The drawn tokens for one pool, in reading order. */
export function poolTokens(pool: PresentedPool): StripToken[] {
  const normal = pool.presentation === 'NORMAL';
  const out: StripToken[] = [];

  if (pool.presentation === 'BLOCKED_SUBORDINATE') {
    if (pool.weekly) out.push({ kind: 'figure', key: 'weekly', role: 'weekly', text: pool.weekly.text, subordinate: false });
    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: pool.fiveHour.text, subordinate: true });
    return out;
  }

  const window = (role: StripRole, text: string, meter: DisplayReadyMeter | undefined, resetText: string | undefined): void => {
    // Unit #14: the 5h figure's pie IS the pool's lead dot (drawn with the state), so only a
    // revealed weekly figure gets a pie token of its own here.
    if (normal && meter && role !== 'five-hour') out.push({ kind: 'meter', key: `${role}-meter`, role, meter, valueText: text });
    out.push({ kind: 'figure', key: role, role, text, subordinate: false });
    if (normal && resetText) out.push({ kind: 'reset', key: `${role}-reset`, role, text: resetText });
  };
  window('five-hour', pool.fiveHour.text, pool.fiveHour.meter, pool.fiveHour.resetText);
  if (pool.weekly) window('weekly', pool.weekly.text, pool.weekly.meter, pool.weekly.resetText);
  return out;
}
