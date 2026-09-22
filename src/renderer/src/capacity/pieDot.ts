/**
 * v1.1.45 unit #14 (human-approved look) — the PIE-DOT, THE capacity mark of the strip.
 * Pure: which look a dot takes, the colour for a remaining figure, and the wedge geometry.
 * The components (CapacityStrip.tsx) only draw what this decides.
 *
 *   - A live figure: a PIE whose filled wedge IS the remaining fraction (100% = full disc),
 *     coloured on ONE smooth scale from full green at 100% to dark red at 0%. The colour
 *     follows the figure, not the state (the human superseded the per-state glyph tokens).
 *   - LIMITED: a STOP SIGN (red octagon), never a pie.
 *   - Never read / no usable reading: a black-and-white SPOTTED dot, never a colour.
 *   - STALE with a figure (STALE-RETAIN, human ruling 2026-09-22, SUPERSEDES S1/A1): the
 *     ORDINARY pie for its last-known figure. The age is said in the provider details.
 *   - Aged with NO figure to keep (evidence restored across a restart, a held recovery, a
 *     reading with no usable figure): a DIMMED dot with NO wedge; it says "we had a reading
 *     and it aged", which the spotted "never read" dot does not.
 *
 * No new contract field: main already sends `freshness.verdict`, and the renderer's
 * one-way expiry mask marks the pool `masked`. Either one means aged.
 *
 * Still ONE continuous fill per figure (§9: continuous = provider capacity); never segments.
 */
import type { ProviderCapacityDetailView } from '@shared/capacityDetail';
import type { PresentedPool } from './capacityStrip';

/** Pixel diameter of every pie-dot (the old state glyph was 14px text). */
export const PIE_DOT_SIZE = 20;

/**
 * The disc behind a wedge: ONE fixed light colour in both themes, so every colour on the
 * ramp keeps >= 3:1 against it, and the disc itself stands out on the dark title bar.
 */
export const PIE_TRACK = '#F6F3E8';

/** The disc's rim (fixed; the light disc carries the contrast against either theme). */
export const PIE_RIM = '#736A80';

/** The stop sign's red (fixed in both themes; a white edge keeps it clear on dark). */
export const STOP_RED = '#B3121C';

export type DotLook =
  | { kind: 'STOP' }
  | { kind: 'SPOTTED' }
  /** A live figure: `percent` remaining, 0..100. */
  | { kind: 'PIE'; percent: number }
  /** Aged with nothing to keep: dimmed, and wedge-less BY TYPE - there is no figure to carry. */
  | { kind: 'DIMMED' }
  /** A known, fresh state with no figure to draw (e.g. a live 5h that is not reported). */
  | { kind: 'RING' };

/**
 * Colour stops for the remaining scale: green at 100, amber/orange around 50, dark red at 0.
 * Interpolated in HSL between neighbours, so the ramp is smooth with no visible bands.
 * Lightness is capped so every point keeps >= 3:1 against PIE_TRACK (a test pins it).
 */
export const PIE_STOPS: readonly (readonly [number, number, number, number])[] = [
  // [remaining%, hue, saturation%, lightness%]
  [0, 0, 75, 28],
  [25, 14, 80, 38],
  [50, 34, 92, 36],
  [75, 78, 62, 30],
  [100, 128, 55, 32]
];

/** The colour for `percent` remaining (clamped to 0..100). */
export function remainingColor(percent: number): string {
  const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  let i = 0;
  while (i < PIE_STOPS.length - 2 && p > PIE_STOPS[i + 1][0]) i++;
  const [p0, h0, s0, l0] = PIE_STOPS[i];
  const [p1, h1, s1, l1] = PIE_STOPS[i + 1];
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
 * The look of a pool's LEAD dot on the strip (the state position). The live 5h figure is
 * that pie; a revealed weekly figure gets its own pie beside its text (see poolTokens).
 */
export function leadDotOf(pool: PresentedPool): DotLook {
  // An open limit stays a stop sign even once its reading ages (A1: the state is kept).
  if (pool.state === 'LIMITED') return { kind: 'STOP' };
  // A figure on the strip is drawn as the ordinary pie - live, or a stale reading's last-known
  // figure (STALE-RETAIN, supersedes A1; the age is in the provider details).
  const five = pool.fiveHour.meter?.remainingPercent;
  if (pool.presentation === 'NORMAL' && typeof five === 'number') return { kind: 'PIE', percent: five };
  // Aged with nothing to retain (restored across a restart, a held recovery, no usable figure).
  if (pool.masked || pool.freshness.verdict === 'STALE') return { kind: 'DIMMED' };
  if (pool.state === 'UNKNOWN' || pool.presentation === 'UNKNOWN') return { kind: 'SPOTTED' };
  // The A2 held frame (RESERVE_ONLY, weekly freshly at 0; S3): an EMPTY pie, no stop sign -
  // the provider did not attribute a limit.
  if (pool.presentation === 'BLOCKED_SUBORDINATE') return { kind: 'PIE', percent: 0 };
  return { kind: 'RING' };
}

/** The same rules for the provider-details header (one mark for a pool everywhere). */
export function detailDotOf(view: ProviderCapacityDetailView): DotLook {
  if (view.state === 'LIMITED') return { kind: 'STOP' };
  const kept = view.windows.find((w) => w.kind === 'FIVE_HOUR')?.lastKnownPercent;
  if (typeof kept === 'number') return { kind: 'PIE', percent: kept };
  if (view.freshness.verdict === 'STALE') return { kind: 'DIMMED' };
  if (view.state === 'UNKNOWN') return { kind: 'SPOTTED' };
  const five = view.windows.find((w) => w.kind === 'FIVE_HOUR')?.remainingPercent;
  return typeof five === 'number' ? { kind: 'PIE', percent: five } : { kind: 'RING' };
}
