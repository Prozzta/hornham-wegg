/**
 * v1.1.45 unit #2 — the title-bar strip's LAYOUT, as pure functions.
 *
 * This decides only which of main's strings and meters are drawn, and in what order.
 * It never decides what they say. Every figure and word is copied from the pushed
 * pool object, so the rules this file does own are all about layout:
 *
 *   C2.10 COLLAPSE ORDER. Drop meters, then reset hints, then compact both labelled
 *   figures. There is no step that drops the five-hour figure: the compact token is
 *   its last reducible form (C2.7), and a width that cannot hold it is unsupported.
 *
 *   C2.7 / crit 15 ORDER IN THE BLOCKED FRAME. Weekly primary first, then exactly ONE
 *   atomic subordinate five-hour token, with no meter and no reset hint on either
 *   window. The meter check is repeated here even though the schema already forbids
 *   meters outside NORMAL: C2.7 is a closure rule, and a second guard costs nothing.
 *
 *   §9 UNKNOWN DRAWS NO METER. No track and no zero-width fill, only main's text.
 */
import type { DisplayReadyMeter } from '@shared/capacityStrip';
import type { PresentedPool } from './capacityStrip';

/** 0 full · 1 no meters · 2 no reset hints · 3 compact figures (C2.10, in order). */
export type CollapseLevel = 0 | 1 | 2 | 3;
export const COLLAPSE_LEVELS: readonly CollapseLevel[] = [0, 1, 2, 3];

export type StripRole = 'five-hour' | 'weekly';

export type StripToken =
  | { kind: 'meter'; key: string; role: StripRole; meter: DisplayReadyMeter; valueText: string }
  | { kind: 'figure'; key: string; role: StripRole; text: string; subordinate: boolean }
  | { kind: 'reset'; key: string; role: StripRole; text: string };

/** Fixed pixel geometry the width estimate shares with the component. */
export const STRIP_GEOMETRY = {
  mark: 14,
  stateToken: 10,
  meter: 40,
  gap: 6,
  poolGap: 16
} as const;

/** The drawn tokens for one pool at one collapse level, in reading order. */
export function poolTokens(pool: PresentedPool, level: CollapseLevel): StripToken[] {
  const compact = level >= 3;
  const meters = level < 1 && pool.presentation === 'NORMAL';
  const resets = level < 2 && pool.presentation === 'NORMAL';
  const out: StripToken[] = [];
  const weeklyText = pool.weekly ? (compact ? pool.weekly.compactText : pool.weekly.text) : null;
  const fiveText = compact ? pool.fiveHour.compactText : pool.fiveHour.text;

  if (pool.presentation === 'BLOCKED_SUBORDINATE') {
    if (pool.weekly && weeklyText) out.push({ kind: 'figure', key: 'weekly', role: 'weekly', text: weeklyText, subordinate: false });
    out.push({ kind: 'figure', key: 'five-hour', role: 'five-hour', text: fiveText, subordinate: true });
    return out;
  }

  const window = (role: StripRole, text: string, meter: DisplayReadyMeter | undefined, resetText: string | undefined): void => {
    if (meters && meter) out.push({ kind: 'meter', key: `${role}-meter`, role, meter, valueText: text });
    out.push({ kind: 'figure', key: role, role, text, subordinate: false });
    if (resets && resetText) out.push({ kind: 'reset', key: `${role}-reset`, role, text: resetText });
  };
  window('five-hour', fiveText, pool.fiveHour.meter, pool.fiveHour.resetText);
  if (pool.weekly && weeklyText) window('weekly', weeklyText, pool.weekly.meter, pool.weekly.resetText);
  return out;
}

/** Estimated drawn width of one pool: mark, label, state token + word, then its tokens. */
export function poolWidth(pool: PresentedPool, level: CollapseLevel, measure: (text: string) => number): number {
  const g = STRIP_GEOMETRY;
  let w = g.mark + g.gap + measure(pool.poolLabel) + g.gap + g.stateToken + 4 + measure(pool.stateText);
  for (const t of poolTokens(pool, level)) w += g.gap + (t.kind === 'meter' ? g.meter : measure(t.text));
  return w;
}

/**
 * The least collapsed level at which every pool fits. Past the last level the strip
 * stays at 3 and the container clips WHOLE tokens (it wraps them onto a hidden second
 * line), so no token is ever cut in half and no figure is shown without its blocker.
 * An unmeasured container (width 0) renders the full form until it is measured.
 */
export function chooseCollapseLevel(
  pools: readonly PresentedPool[],
  available: number,
  measure: (text: string) => number
): CollapseLevel {
  if (available <= 0) return 0;
  for (const level of COLLAPSE_LEVELS) {
    const total = pools.reduce((sum, p, i) => sum + poolWidth(p, level, measure) + (i ? STRIP_GEOMETRY.poolGap : 0), 0);
    if (total <= available) return level;
  }
  return 3;
}
