/**
 * v1.1.45 unit #8 — the capacity-display threshold (design of record C2.8, as widened by
 * the human's strip-review ruling).
 *
 * ONE value, T, drives every threshold disclosure the strip makes, all through the
 * presenter's single C2.5 band: the Weekly row's reveal, and the "reset expected" hint of
 * both the 5h and the Weekly windows. It is DISPLAY ONLY: it changes the strip's
 * presentation revision and nothing else (no limit, schedule, route, breaker or
 * notification reads it).
 *
 * C2.8's input contract, exactly: an INTEGER from 1 to 99. There is no 0 and no "off"
 * (an off state would suggest the mandatory disclosures can be switched off). Empty,
 * fractional, non-numeric, NaN and out-of-range input is INVALID: it is refused, it never
 * replaces the last valid value, and it is never clamped into range.
 */

/** The provisional default (C2.3). Used only while no valid value has been stored. */
export const DEFAULT_CAPACITY_DISPLAY_THRESHOLD = 15;
export const MIN_CAPACITY_DISPLAY_THRESHOLD = 1;
export const MAX_CAPACITY_DISPLAY_THRESHOLD = 99;

/**
 * The threshold from user input or a stored value, or null when it is invalid. Accepts a
 * number, or a string of digits (what a text field holds). Never rounds, never clamps.
 */
export function parseCapacityDisplayThreshold(input: unknown): number | null {
  let n: number;
  if (typeof input === 'number') n = input;
  else if (typeof input === 'string' && /^\s*\d+\s*$/.test(input)) n = Number(input.trim());
  else return null;
  if (!Number.isInteger(n) || n < MIN_CAPACITY_DISPLAY_THRESHOLD || n > MAX_CAPACITY_DISPLAY_THRESHOLD) return null;
  return n;
}

/**
 * The threshold in force for a config: its stored value when valid, else the default. A
 * hand-edited invalid value falls back to the default rather than being repaired.
 */
export function capacityDisplayThresholdOf(config: { capacityWeeklyDisplayThreshold?: unknown } | null | undefined): number {
  return parseCapacityDisplayThreshold(config?.capacityWeeklyDisplayThreshold) ?? DEFAULT_CAPACITY_DISPLAY_THRESHOLD;
}
