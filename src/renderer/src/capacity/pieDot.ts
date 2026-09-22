/**
 * v1.1.45 unit #14 (human visual feedback) — the PIE-DOT that replaces the strip's bar.
 * Pure: which look a pool's dot takes, the colour for a remaining figure, and the wedge
 * geometry. The component (CapacityStrip.tsx) only draws what this decides.
 *
 *   - A live figure: a PIE whose filled wedge IS the remaining fraction (100% = full disc),
 *     coloured on ONE smooth scale from full green at 100% to dark red at 0%. The colour
 *     follows the figure, not the state (the human superseded the per-state tokens).
 *   - LIMITED: a STOP SIGN (red octagon), never a pie.
 *   - UNKNOWN (no reading, cold start): a black-and-white SPOTTED dot, never a colour.
 *   - STALE (an aged, last-known reading): the DIMMED look by default. The human may pick
 *     the spotted look instead; that is one constant, STALE_LOOK.
 *
 * Still ONE continuous fill per figure (§9: continuous = provider capacity); never segments.
 */
import type { PresentedPool } from './capacityStrip';

/** Pixel diameter of every pie-dot (the old state token was 14px text). */
export const PIE_DOT_SIZE = 20;

/** How a STALE pool's dot looks. DIMMED is the default the human will confirm. */
export const STALE_LOOK: 'DIMMED' | 'SPOTTED' = 'DIMMED';

export type DotLook =
  | { kind: 'STOP' }
  | { kind: 'SPOTTED' }
  /** A live figure: `percent` remaining, 0..100. */
  | { kind: 'PIE'; percent: number }
  /** Stale. `percent` is the last-known figure when one is available, else null (a ring). */
  | { kind: 'DIMMED'; percent: number | null }
  /** A known state with no figure to draw (e.g. a live 5h that is not reported). */
  | { kind: 'RING' };

/**
 * Colour stops for the remaining scale: green at 100, amber/orange around 50, dark red at 0.
 * Interpolated in HSL between neighbours, so the ramp is smooth with no visible bands.
 */
const STOPS: readonly (readonly [number, number, number, number])[] = [
  // [remaining%, hue, saturation%, lightness%]
  [0, 0, 75, 28],
  [25, 14, 80, 42],
  [50, 36, 90, 47],
  [75, 80, 60, 40],
  [100, 128, 55, 36]
];

/** The colour for `percent` remaining (clamped to 0..100). */
export function remainingColor(percent: number): string {
  const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  let i = 0;
  while (i < STOPS.length - 2 && p > STOPS[i + 1][0]) i++;
  const [p0, h0, s0, l0] = STOPS[i];
  const [p1, h1, s1, l1] = STOPS[i + 1];
  const t = (p - p0) / (p1 - p0);
  const mix = (a: number, b: number) => Math.round((a + (b - a) * t) * 10) / 10;
  return `hsl(${mix(h0, h1)}, ${mix(s0, s1)}%, ${mix(l0, l1)}%)`;
}

/**
 * The wedge for `percent` remaining in a circle of radius `r` centred at (`c`, `c`),
 * starting at 12 o'clock and sweeping clockwise. `null` at 0 (nothing to fill) and
 * 'FULL' at 100 (drawn as a whole disc: an SVG arc cannot sweep a full circle).
 */
export function wedgePath(percent: number, r: number, c: number): string | 'FULL' | null {
  const p = Math.min(100, Math.max(0, percent));
  if (p <= 0) return null;
  if (p >= 100) return 'FULL';
  const a = (p / 100) * 2 * Math.PI;
  const x = c + r * Math.sin(a);
  const y = c - r * Math.cos(a);
  const large = p > 50 ? 1 : 0;
  const f = (n: number) => Math.round(n * 1000) / 1000;
  return `M ${f(c)} ${f(c)} L ${f(c)} ${f(c - r)} A ${f(r)} ${f(r)} 0 ${large} 1 ${f(x)} ${f(y)} Z`;
}

/**
 * The look of a pool's LEAD dot (the state position). The 5h figure is the live pie; a
 * revealed weekly figure gets its own pie beside its text (see poolTokens).
 */
export function leadDotOf(pool: PresentedPool): DotLook {
  if (pool.state === 'LIMITED') return { kind: 'STOP' };
  if (pool.state === 'UNKNOWN') return { kind: 'SPOTTED' };
  // A known state whose figures were removed: the reading aged out, or the one-way
  // expiry mask fired (A1: the state is kept, the figures are not).
  if (pool.presentation === 'UNKNOWN') return STALE_LOOK === 'SPOTTED' ? { kind: 'SPOTTED' } : { kind: 'DIMMED', percent: null };
  // The A2 held frame (RESERVE_ONLY, weekly freshly at 0): the weekly figure is primary.
  if (pool.presentation === 'BLOCKED_SUBORDINATE') return { kind: 'PIE', percent: 0 };
  const five = pool.fiveHour.meter?.remainingPercent;
  return typeof five === 'number' ? { kind: 'PIE', percent: five } : { kind: 'RING' };
}
