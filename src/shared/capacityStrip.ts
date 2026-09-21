/**
 * v1.1.45 unit #1 — the POOL-LEVEL capacity contract main pushes to the renderer.
 *
 * Design of record: research/PROVIDER-CAPACITY-UI-AUDIT.md §16 (renderer data
 * contract), §17 (one state machine in main, one renderer mirror, one presenter /
 * selector family) and C2.9 (the strip object; hidden weekly is ABSENT).
 *
 * EVERYTHING HERE IS DISPLAY-READY AND MAIN-ISSUED. The renderer receives decisions
 * and strings, never inputs to a decision: no raw provider payload, no pool key (it
 * carries the account scope), no threshold, no hide flag, no undisclosed weekly
 * figure, no comparison operand. A field that would let the renderer re-derive a
 * state, a reveal or a displayed window is a field that eventually gets used for it.
 *
 * THIS IS NOT THE PER-AGENT `control:snapshot`. That object answers "may this agent
 * send"; this one answers "what does each shared allowance look like". C2.9 forbids
 * folding the second into the first, so it has its own channel and its own schema.
 *
 * The validator below is the runtime half of `additionalProperties:false`: main runs
 * it before every push, and the renderer mirror runs it again on receipt, so a field
 * added on one side without the other is refused rather than silently carried.
 */
import { CAPACITY_STATES, PROVIDER_IDS, type CapacityState, type ProviderId } from './providerCapacity';

/** Push channel: main → every window, a complete-replace collection. */
export const CAPACITY_STRIP_CHANNEL = 'capacity:strip';
/** Pull: a (re)loaded window asks for the current collection instead of waiting. */
export const CAPACITY_STRIP_CURRENT = 'capacity:stripCurrent';
/** A person dismissed a notice. Main records it, so no reload can replay it. */
export const CAPACITY_NOTICE_DISMISS = 'capacity:dismissNotice';

/**
 * Why a weekly row is on screen. Exhaustive and in main-side precedence order (C2.4).
 * There is deliberately no BINDING or TIGHTER_THAN_5H member (C2.2, C2.11 crit 5).
 */
export const WEEKLY_REVEAL_REASONS = [
  'PROVIDER_ATTRIBUTED_LIMITING',
  'NUMERICALLY_EXHAUSTED',
  'UNKNOWN_CAPACITY',
  'UNKNOWN_APPLICABILITY',
  'BELOW_DISPLAY_THRESHOLD',
  'HYSTERESIS_HOLD'
] as const;
export type WeeklyRevealReason = (typeof WEEKLY_REVEAL_REASONS)[number];

export const WEEKLY_ATTRIBUTIONS = ['provider', 'numeric', 'unknown', 'display-policy'] as const;
export type WeeklyAttribution = (typeof WEEKLY_ATTRIBUTIONS)[number];

/**
 * The exhaustive presentation variant (C2.7). The renderer pattern-matches this and
 * derives no cross-window relation of its own.
 *   NORMAL               the five-hour row is the ordinary primary row.
 *   BLOCKED_SUBORDINATE  another window is the main-supplied blocking condition; the
 *                        five-hour observation is ONE atomic subordinate token, and
 *                        no window carries a meter.
 *   UNKNOWN              no current figure: text only, no meter anywhere (§9, §10).
 */
export const STRIP_PRESENTATIONS = ['NORMAL', 'BLOCKED_SUBORDINATE', 'UNKNOWN'] as const;
export type StripPresentation = (typeof STRIP_PRESENTATIONS)[number];

/** Safe provenance class (§16). Displayed, never compared by the renderer. */
export const PROVENANCE_CLASSES = ['LIVE', 'ACCOUNT_READ', 'RESTORED'] as const;
export type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

export const NOTICE_KINDS = ['LIMIT_REACHED', 'RESERVE_REACHED', 'RECOVERY_POSSIBLE', 'RECOVERED'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** What happened to the OS toast for this intent. Recorded by main, once. */
export const NOTICE_DELIVERIES = ['SHOWN', 'SUPPRESSED', 'UNSUPPORTED'] as const;
export type NoticeDelivery = (typeof NOTICE_DELIVERIES)[number];

/** The in-app lifecycle. DISMISSED is main-recorded, so a reload cannot reopen it. */
export const NOTICE_LIFECYCLES = ['OPEN', 'DISMISSED'] as const;
export type NoticeLifecycle = (typeof NOTICE_LIFECYCLES)[number];

/** A continuous capacity meter, already normalised to REMAINING in the tracker. */
export interface DisplayReadyMeter {
  /** Full precision, 0..100. */
  remainingPercent: number;
  /** What the text shows: rounded DOWN, so the display never overstates what is left. */
  displayPercent: number;
}

/** The permanent five-hour row. Always present, always labelled `5h` (C2.11 crit 1). */
export interface FiveHourStrip {
  label: '5h';
  /** Full form. Label, value or status, and any blocker are inseparable in one string. */
  text: string;
  /** The last reducible form (C2.7): never drops the value, never drops the blocker. */
  compactText: string;
  meter?: DisplayReadyMeter;
  /** `reset expected ~14:30` — an expectation, never a recovery claim (§11). */
  resetText?: string;
  resetExpectedAt?: number;
}

/**
 * C2.9, plus ONE field: `compactText`. C2.10's last collapse step compacts BOTH labelled
 * figures, and a renderer that shortened `text` itself would be composing wording
 * (C2.11 crit 18), so main supplies the compact form too. The property is ABSENT when
 * weekly is normally hidden.
 */
export interface VisibleWeeklyStrip {
  reason: WeeklyRevealReason;
  text: string;
  /** The last reducible form. C2.6 UNKNOWN text is already minimal and is repeated verbatim. */
  compactText: string;
  meter?: DisplayReadyMeter;
  resetText?: string;
  attribution: WeeklyAttribution;
}

export interface CapacityFreshnessView {
  verdict: 'FRESH' | 'STALE';
  observedAt: number;
  /**
   * Wall-clock instant main's own freshness deadline lapses, or null once it has.
   * The ONE local-time input the renderer may use, and only to DEGRADE (§17).
   */
  expiresAt: number | null;
  /** Absolute wording (`updated 14:05` / `last update 14:05`): no renderer age clock. */
  text: string;
  /**
   * What this pool WILL look like once `expiresAt` passes, decided by main with the
   * same projection it uses for a stale reading. Present exactly when `expiresAt` is.
   * The renderer's one-way mask swaps this in; it composes and derives nothing.
   */
  expired?: ExpiredRows;
}

/** The degraded rows the renderer's expiry mask may substitute (§17, C2.11 crit 10). */
export interface ExpiredRows {
  state: CapacityState;
  stateText: string;
  presentation: 'UNKNOWN';
  fiveHour: FiveHourStrip;
  weekly?: VisibleWeeklyStrip;
}

export interface CapacityMembershipView {
  /** False when some running agent of this provider has no pool mapping yet. */
  known: boolean;
  /** Agents whose OWN readings landed in this pool. Evidence, never inference. */
  agentIds: string[];
}

/** Main-produced markers. The renderer displays them; it never computes one. */
export interface CapacityMarkers {
  /**
   * How many windows other than the ones on the strip carry evidence a person should
   * know exists (numeric exhaustion, provider attribution, unknown value or unknown
   * applicability). C2.2 `additionalPressure`: evidence-backed, never a raw
   * cross-window percentage comparison.
   */
  additionalPressure: number;
}

export interface CapacityNotice {
  /** Opaque and stable for the transition it announces. */
  noticeId: string;
  kind: NoticeKind;
  from: CapacityState;
  to: CapacityState;
  issuedAt: number;
  delivery: NoticeDelivery;
  lifecycle: NoticeLifecycle;
}

export interface CapacityStripPool {
  /** Opaque, stable within this process, carries no account identifier. */
  poolId: string;
  poolLabel: string;
  provider: ProviderId;
  /** Per-pool presentation revision: strictly increases whenever this object changes. */
  revision: number;
  /** The tracker revision this was projected from (same domain truth, §16). */
  domainRevision: number;
  state: CapacityState;
  stateText: string;
  presentation: StripPresentation;
  fiveHour: FiveHourStrip;
  weekly?: VisibleWeeklyStrip;
  freshness: CapacityFreshnessView;
  membership: CapacityMembershipView;
  markers: CapacityMarkers;
  provenance: ProvenanceClass;
  notice?: CapacityNotice;
}

/**
 * What the strip says when there is nothing to show: no collection yet (cold start, a
 * reload before main answered, a disconnect) or a collection with no pools (design §10's
 * cold-start / disconnected case, F3). Main sends it on every collection; the renderer
 * falls back to this same constant only while it holds NO collection at all, which is the
 * one moment main has not spoken yet. One string, one owner, no renderer wording.
 */
export const CAPACITY_EMPTY_TEXT = 'Capacity unknown';

export interface CapacityStripCollection {
  /** Complete-replace ordering: a strictly higher value replaces the whole set. */
  collectionRevision: number;
  /** The tracker collection revision it was built from. */
  domainRevision: number;
  /** False when the tracker's pool-count cap was breached: pools may be missing. */
  complete: boolean;
  /** Drawn when `pools` is empty (F3). Always `CAPACITY_EMPTY_TEXT`. */
  emptyText: string;
  pools: CapacityStripPool[];
}

// ─── Runtime schema (additionalProperties:false) ───────────────────────────────

type Check = (v: unknown, at: string, errors: string[]) => void;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRevision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

function object(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (v, at, errors) => {
    if (!isObj(v)) { errors.push(`${at}: not an object`); return; }
    for (const key of Object.keys(v)) {
      if (!(key in required) && !(key in optional)) errors.push(`${at}.${key}: property not allowed`);
    }
    for (const [key, check] of Object.entries(required)) {
      if (!(key in v)) errors.push(`${at}.${key}: required`);
      else check(v[key], `${at}.${key}`, errors);
    }
    for (const [key, check] of Object.entries(optional)) {
      // An optional property is ABSENT or valid. Present-but-undefined is a hide flag
      // by another name, so it is refused like one.
      if (key in v) check(v[key], `${at}.${key}`, errors);
    }
  };
}

const oneOf = (values: readonly string[]): Check => (v, at, errors) => {
  if (typeof v !== 'string' || !values.includes(v)) errors.push(`${at}: not one of ${values.join('|')}`);
};
const text: Check = (v, at, errors) => { if (!isText(v)) errors.push(`${at}: not display text`); };
const revision: Check = (v, at, errors) => { if (!isRevision(v)) errors.push(`${at}: not a revision`); };
const instant: Check = (v, at, errors) => { if (!isFiniteNum(v) || v < 0) errors.push(`${at}: not an instant`); };
const nullableInstant: Check = (v, at, errors) => { if (v !== null) instant(v, at, errors); };
const bool: Check = (v, at, errors) => { if (typeof v !== 'boolean') errors.push(`${at}: not a boolean`); };
const count: Check = (v, at, errors) => { if (!Number.isSafeInteger(v) || (v as number) < 0) errors.push(`${at}: not a count`); };
const exactly = (value: string): Check => (v, at, errors) => { if (v !== value) errors.push(`${at}: must be ${value}`); };
const percent: Check = (v, at, errors) => {
  if (!isFiniteNum(v) || v < 0 || v > 100) errors.push(`${at}: not a percentage in 0..100`);
};
const agentIds: Check = (v, at, errors) => {
  if (!Array.isArray(v)) { errors.push(`${at}: not an array`); return; }
  v.forEach((id, i) => { if (!isText(id)) errors.push(`${at}[${i}]: not an agent id`); });
};

const meter: Check = (v, at, errors) => {
  object({ remainingPercent: percent, displayPercent: percent })(v, at, errors);
  if (isObj(v) && isFiniteNum(v.remainingPercent) && isFiniteNum(v.displayPercent)
    && (v.displayPercent > v.remainingPercent || !Number.isInteger(v.displayPercent))) {
    errors.push(`${at}.displayPercent: must be the remaining figure rounded down`);
  }
};

const fiveHour = object(
  { label: exactly('5h'), text, compactText: text },
  { meter, resetText: text, resetExpectedAt: instant }
);

const weekly = object(
  { reason: oneOf(WEEKLY_REVEAL_REASONS), text, compactText: text, attribution: oneOf(WEEKLY_ATTRIBUTIONS) },
  { meter, resetText: text }
);

const notice = object({
  noticeId: text,
  kind: oneOf(NOTICE_KINDS),
  from: oneOf(CAPACITY_STATES),
  to: oneOf(CAPACITY_STATES),
  issuedAt: instant,
  delivery: oneOf(NOTICE_DELIVERIES),
  lifecycle: oneOf(NOTICE_LIFECYCLES)
});

const pool = object(
  {
    poolId: text,
    poolLabel: text,
    provider: oneOf(PROVIDER_IDS),
    revision,
    domainRevision: revision,
    state: oneOf(CAPACITY_STATES),
    stateText: text,
    presentation: oneOf(STRIP_PRESENTATIONS),
    fiveHour,
    freshness: object({
      verdict: oneOf(['FRESH', 'STALE']),
      observedAt: instant,
      expiresAt: nullableInstant,
      text
    }, {
      expired: object({
        state: oneOf(CAPACITY_STATES),
        stateText: text,
        presentation: exactly('UNKNOWN'),
        fiveHour
      }, { weekly })
    }),
    membership: object({ known: bool, agentIds }),
    markers: object({ additionalPressure: count }),
    provenance: oneOf(PROVENANCE_CLASSES)
  },
  { weekly, notice }
);

/**
 * Cross-field rules the property schema cannot express. Each one closes a way of
 * drawing a claim the variant forbids (C2.7, C2.6, §9).
 */
function poolInvariants(v: Record<string, unknown>, at: string, errors: string[]): void {
  const five = v.fiveHour as Record<string, unknown> | undefined;
  const wk = v.weekly as Record<string, unknown> | undefined;
  if (v.presentation !== 'NORMAL') {
    if (five && 'meter' in five) errors.push(`${at}.fiveHour.meter: no meter outside NORMAL`);
    if (wk && 'meter' in wk) errors.push(`${at}.weekly.meter: no meter outside NORMAL`);
  }
  if (v.presentation === 'BLOCKED_SUBORDINATE' && !wk) errors.push(`${at}.weekly: a blocked frame names its blocker`);
  if (wk && (wk.reason === 'UNKNOWN_CAPACITY' || wk.reason === 'UNKNOWN_APPLICABILITY') && 'meter' in wk) {
    errors.push(`${at}.weekly.meter: UNKNOWN is text only`);
  }
  const fr = v.freshness as Record<string, unknown> | undefined;
  if (fr && isObj(fr)) {
    const exp = fr.expired as Record<string, unknown> | undefined;
    if ((fr.expiresAt === null) !== (exp === undefined)) {
      errors.push(`${at}.freshness.expired: present exactly when expiresAt is`);
    }
    if (isObj(exp)) {
      const ef = exp.fiveHour as Record<string, unknown> | undefined;
      const ew = exp.weekly as Record<string, unknown> | undefined;
      if (isObj(ef) && 'meter' in ef) errors.push(`${at}.freshness.expired.fiveHour.meter: an expired row draws no meter`);
      if (isObj(ew) && 'meter' in ew) errors.push(`${at}.freshness.expired.weekly.meter: an expired row draws no meter`);
      // The expired view may only DEGRADE: it cannot disclose a weekly row the live
      // object keeps hidden (C2.9), or that would be a hidden weekly by another route.
      if (ew && !wk) errors.push(`${at}.freshness.expired.weekly: cannot reveal a weekly the strip hides`);
    }
  }
}

/** Validate a collection. An empty list means valid; anything else is refused whole. */
export function validateCapacityStrip(value: unknown): string[] {
  const errors: string[] = [];
  object({ collectionRevision: revision, domainRevision: revision, complete: bool, emptyText: text, pools: () => {} })(value, '$', errors);
  if (!isObj(value)) return errors;
  if (!Array.isArray(value.pools)) { errors.push('$.pools: not an array'); return errors; }
  const seen = new Set<unknown>();
  value.pools.forEach((p, i) => {
    const at = `$.pools[${i}]`;
    pool(p, at, errors);
    if (isObj(p)) {
      poolInvariants(p, at, errors);
      if (seen.has(p.poolId)) errors.push(`${at}.poolId: duplicate`);
      seen.add(p.poolId);
    }
  });
  return errors;
}
