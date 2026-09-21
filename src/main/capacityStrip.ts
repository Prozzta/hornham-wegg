/**
 * v1.1.45 unit #1 — THE pool-level presenter. Main-side, pure, no Electron.
 *
 * It projects the tracker's normalised collection into the display-ready
 * `CapacityStripCollection` (src/shared/capacityStrip.ts) and owns the three pieces
 * of DISPLAY state the design of record puts in main rather than in the renderer:
 *
 *  1. REVISIONS (§16, correction 3). A per-pool presentation revision that strictly
 *     increases whenever the pushed object changes, and a collection revision with
 *     complete-replace semantics. Counters are never reset for a pool id, so a pool
 *     that leaves and comes back cannot roll its revision back.
 *  2. WEEKLY DISCLOSURE (C2.4, C2.5). The six reveal reasons in precedence order and
 *     the fixed-band hysteresis. Hidden weekly is ABSENT from the object (C2.9).
 *  3. THE NOTICE LIFECYCLE (§13, correction 4). The notifier decides WHETHER an intent
 *     exists; this records what happened to it (toast shown or suppressed, dismissed
 *     in the app), so a reload or reconnect re-reads the record instead of replaying.
 *
 * IT DECIDES NO DOMAIN STATE. `state` is the tracker's, verbatim — including the one
 * case that looks surprising: a pool with an open limit epoch stays LIMITED after its
 * reading goes stale (the tracker ranks the epoch above staleness, because the refusal
 * is evidence and the reading's age does not end it). Here that pool keeps LIMITED and
 * loses its numbers, which is §10's "stale removes both the number and the bar"
 * without inventing a second state machine that disagrees with admission.
 *
 * Threshold changes move ONLY the presentation revision (C2.11 crit 4): nothing in
 * here feeds back into the tracker, admission, the notifier or scheduling.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { applicabilityOf, type CapacityCollectionSnapshot, type CapacityState, type CapacityWindow,
  type PoolCapacitySnapshot, type ProviderId } from '../shared/providerCapacity';
import type {
  CapacityFreshnessView, CapacityNotice, CapacityStripCollection, CapacityStripPool, DisplayReadyMeter, FiveHourStrip,
  NoticeDelivery, ProvenanceClass, StripPresentation, VisibleWeeklyStrip, WeeklyRevealReason
} from '../shared/capacityStrip';
import { CAPACITY_EMPTY_TEXT, validateCapacityStrip } from '../shared/capacityStrip';
import { DEFAULT_CAPACITY_DISPLAY_THRESHOLD } from '../shared/capacityThreshold';
import type { CapacityNotifyIntent } from './capacityNotify';

/**
 * The default the presenter falls back to when no `weeklyThreshold` source is given (tests
 * and the preview). In the app, main passes the Settings value (unit #8, C2.8) and this
 * is only its default. Either way the threshold is a presentation input only.
 */
export const DEFAULT_WEEKLY_DISPLAY_THRESHOLD = DEFAULT_CAPACITY_DISPLAY_THRESHOLD;
/** C2.5: shown → hidden only at `>= min(100, T + band)`. */
export const HYSTERESIS_BAND = 5;

export const STATE_TEXT: Record<CapacityState, string> = {
  UNKNOWN: 'Capacity unknown',
  AVAILABLE: 'Available',
  APPROACHING: 'Approaching limit',
  RESERVE_ONLY: 'Reserve only',
  LIMITED: 'Limited',
  RECOVERING: 'Recovering'
};

const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * One main-owned copy per reveal reason (C2.11 crit 18). The renderer never
 * concatenates semantic phrases, so the whole sentence is decided here.
 */
function weeklyText(reason: WeeklyRevealReason, display: number | null): string {
  switch (reason) {
    case 'PROVIDER_ATTRIBUTED_LIMITING': return 'Weekly · limit reached, reported by provider';
    case 'NUMERICALLY_EXHAUSTED': return 'Weekly · 0% remaining';
    case 'UNKNOWN_CAPACITY': return 'Weekly capacity unknown';
    case 'UNKNOWN_APPLICABILITY': return 'Additional limit status unknown';
    case 'BELOW_DISPLAY_THRESHOLD':
    case 'HYSTERESIS_HOLD': return `Weekly · ${display}% remaining`;
  }
}

/**
 * WHICH STATES USE THE C2.7 BLOCKED FRAME, and the one atomic five-hour token each
 * gets. The frame's other preconditions (a fresh 5h figure above zero, and weekly
 * provider-attributed or freshly at zero) live at the single call site.
 *
 * A2, RULED BY THE HUMAN (2026-09-21): a RESERVE_ONLY pool whose weekly is freshly at
 * 0 also takes this frame. The provider did NOT attribute that limit, so its copy is
 * OBSERVATIONAL - "held while Weekly is at 0%" - never the causal "exhausted" or
 * "blocked" wording reserved for a LIMITED pool (crit 16). Copy is Jim's, as ruled.
 */
const BLOCKED_FRAME: Partial<Record<CapacityState, { text: (n: number) => string; compactText: (n: number) => string; note: string }>> = {
  LIMITED: {
    text: (n) => `5h · ${n}% remaining · unavailable while Weekly is exhausted`,
    compactText: (n) => `5h ${n}% · blocked by Weekly`,
    note: 'unavailable while Weekly is exhausted'
  },
  RESERVE_ONLY: {
    text: (n) => `5h · ${n}% remaining · ordinary work held while Weekly is at 0%`,
    compactText: (n) => `5h ${n}% · held by Weekly 0%`,
    note: 'ordinary work held while Weekly is at 0%'
  }
};

/**
 * The blocked relationship for the provider details panel (unit #4). C2.7: details may show
 * the raw five-hour observation but must PRESERVE the blocked relationship, so it reads the
 * SAME table the strip's blocked token comes from. Null when the state has no blocked frame.
 */
export function blockedFrameNote(state: CapacityState): string | null {
  return BLOCKED_FRAME[state]?.note ?? null;
}

/** The compact form of each, for C2.10's last collapse step. Same one-copy-per-reason rule. */
function weeklyCompactText(reason: WeeklyRevealReason, display: number | null): string {
  switch (reason) {
    case 'PROVIDER_ATTRIBUTED_LIMITING': return 'Weekly limit reached (provider)';
    case 'NUMERICALLY_EXHAUSTED': return 'Weekly 0%';
    case 'UNKNOWN_CAPACITY': return 'Weekly capacity unknown';
    case 'UNKNOWN_APPLICABILITY': return 'Additional limit status unknown';
    case 'BELOW_DISPLAY_THRESHOLD':
    case 'HYSTERESIS_HOLD': return `Weekly ${display}%`;
  }
}

const WEEKLY_ATTRIBUTION = {
  PROVIDER_ATTRIBUTED_LIMITING: 'provider',
  NUMERICALLY_EXHAUSTED: 'numeric',
  UNKNOWN_CAPACITY: 'unknown',
  UNKNOWN_APPLICABILITY: 'unknown',
  BELOW_DISPLAY_THRESHOLD: 'display-policy',
  HYSTERESIS_HOLD: 'display-policy'
} as const satisfies Record<WeeklyRevealReason, VisibleWeeklyStrip['attribution']>;

/** No renderer repair (§16): anything but a finite 0..100 is UNKNOWN, never clamped. */
const validRemaining = (v: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;

const meterOf = (remaining: number): DisplayReadyMeter =>
  ({ remainingPercent: remaining, displayPercent: Math.floor(remaining) });

const pad2 = (n: number): string => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Absolute local wall time: `14:05` today, `Mon 14:05` otherwise. Absolute on purpose
 * (§10): main pushes on transitions, not on a clock, so a relative "44m ago" would
 * freeze and quietly become false between pushes.
 */
export function formatLocalTime(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${WEEKDAYS[d.getDay()]} ${hm}`;
}

export interface CapacityStripInputs {
  snapshot: CapacityCollectionSnapshot;
  /** Agents whose own readings landed in this pool (the runtime's mapping). */
  membersOf: (poolKey: string) => readonly string[];
  /** False while a running agent of this provider has produced no reading yet. */
  membershipKnown: (provider: ProviderId) => boolean;
  /** Wall instant the tracker's own freshness deadline lapses, or null once it has. */
  freshUntil: (poolKey: string) => number | null;
  now: number;
}

export interface CapacityStripPresenterOptions {
  weeklyThreshold?: () => number;
  formatTime?: (t: number, now: number) => string;
  /** Key for the opaque ids. Random per process by default: ids are not durable. */
  idKey?: Buffer;
}

interface WeeklyLatch {
  shown: boolean;
  /** The weekly reset the latch was set under. A re-anchor re-evaluates from hidden (C2.5). */
  anchor: number | null;
}

interface StoredNotice extends CapacityNotice { identity: string }

type PoolBody = Omit<CapacityStripPool, 'revision'>;

export class CapacityStripPresenter {
  private readonly threshold: () => number;
  private readonly formatTime: (t: number, now: number) => string;
  private readonly idKey: Buffer;
  /** poolId → last revision and the body it was issued for. Never pruned: no rollback. */
  private readonly revisions = new Map<string, { revision: number; body: string }>();
  /**
   * C2.5 fixed-band latches, one per (pool, purpose): the weekly REVEAL (`<poolKey>`) and
   * the reset-text gate of each window (`<poolKey>|reset|five`, `<poolKey>|reset|weekly`).
   * One band implementation for all of them (`band`), so they cannot drift apart.
   */
  private readonly latches = new Map<string, WeeklyLatch>();
  private readonly notices = new Map<string, StoredNotice>();
  private collection: CapacityStripCollection = {
    collectionRevision: 0, domainRevision: 0, complete: true, emptyText: CAPACITY_EMPTY_TEXT, pools: []
  };
  private collectionBody = JSON.stringify({ complete: true, pools: [] });

  constructor(opts: CapacityStripPresenterOptions = {}) {
    this.threshold = opts.weeklyThreshold ?? (() => DEFAULT_WEEKLY_DISPLAY_THRESHOLD);
    this.formatTime = opts.formatTime ?? formatLocalTime;
    this.idKey = opts.idKey ?? randomBytes(32);
  }

  /** The last presented collection. What a (re)loaded window pulls. */
  current(): CapacityStripCollection {
    return this.collection;
  }

  /**
   * Record a decided transition and what its OS toast did. The notifier has already
   * guaranteed at most one intent per identity; this only attaches it to its pool.
   */
  noteIntent(intent: CapacityNotifyIntent, delivery: NoticeDelivery): void {
    this.notices.set(intent.poolKey, {
      identity: intent.identity,
      noticeId: `notice-${this.opaque(intent.identity)}`,
      kind: intent.kind,
      from: intent.from,
      to: intent.to,
      issuedAt: intent.at,
      delivery,
      lifecycle: 'OPEN'
    });
  }

  /** A person dismissed a notice. True when it changed something (caller re-presents). */
  dismissNotice(noticeId: string): boolean {
    for (const n of this.notices.values()) {
      if (n.noticeId === noticeId && n.lifecycle === 'OPEN') { n.lifecycle = 'DISMISSED'; return true; }
    }
    return false;
  }

  /**
   * Re-project everything and return the collection. The collection revision moves
   * once per call at most, and only if something a renderer would see changed.
   */
  present(inputs: CapacityStripInputs): CapacityStripCollection {
    const T = this.threshold();
    const live = new Set<string>();
    const pools: CapacityStripPool[] = [];
    for (const pool of inputs.snapshot.pools) {
      live.add(pool.poolKey);
      const body = this.poolBody(pool, inputs, T);
      const key = JSON.stringify(body);
      const prev = this.revisions.get(body.poolId);
      const revision = !prev ? 1 : prev.body === key ? prev.revision : prev.revision + 1;
      this.revisions.set(body.poolId, { revision, body: key });
      pools.push({ ...body, revision });
    }
    // A pool that left the complete-replace snapshot is gone: its latch and notice go
    // with it. Its revision counter stays, so a return continues upward.
    for (const k of [...this.latches.keys()]) if (!live.has(k.split('|')[0])) this.latches.delete(k);
    for (const k of [...this.notices.keys()]) if (!live.has(k)) this.notices.delete(k);

    const complete = inputs.snapshot.overflow === null;
    const shape = JSON.stringify({ complete, pools: pools.map((p) => [p.poolId, p.revision]) });
    if (shape !== this.collectionBody || this.collection.domainRevision !== inputs.snapshot.collectionRevision) {
      const next: CapacityStripCollection = {
        collectionRevision: this.collection.collectionRevision + 1,
        domainRevision: inputs.snapshot.collectionRevision,
        complete,
        emptyText: CAPACITY_EMPTY_TEXT,
        pools
      };
      const errors = validateCapacityStrip(next);
      // Refuse to publish an object the contract forbids. Keeping the last valid
      // collection is safe: the renderer's expiry mask degrades it on time.
      if (errors.length) throw new Error(`capacity strip failed its own schema: ${errors.slice(0, 3).join('; ')}`);
      this.collection = next;
      this.collectionBody = shape;
    }
    return this.collection;
  }

  private poolBody(pool: PoolCapacitySnapshot, inputs: CapacityStripInputs, T: number): PoolBody {
    const now = inputs.now;
    const fresh = pool.freshness === 'FRESH';
    const live = this.rows(pool, now, T);
    const lastUpdate = this.formatTime(pool.observedAt, now);

    const shownIds = new Set<string>([live.fiveWindowId, live.weeklyWindowId].filter((x): x is string => !!x));
    const additionalPressure = pool.state === 'UNKNOWN' ? 0 : pool.windows.filter((w) =>
      !shownIds.has(w.windowId) && (
        applicabilityOf(w) === 'UNKNOWN'
        || (applicabilityOf(w) === 'APPLICABLE' && (validRemaining(w.remainingPercent) === null
          || pool.numericallyExhaustedWindowIds.includes(w.windowId)
          || pool.providerAttributedLimitingWindowId === w.windowId)))).length;

    const expiresAt = fresh ? inputs.freshUntil(pool.poolKey) : null;
    const freshness: CapacityFreshnessView = {
      verdict: pool.freshness,
      observedAt: pool.observedAt,
      expiresAt,
      text: fresh ? `updated ${lastUpdate}` : `last update ${lastUpdate}`
    };
    if (expiresAt !== null) {
      // What the tracker itself will publish once this reading goes stale: an open
      // limit epoch keeps LIMITED/RECOVERING (the refusal is evidence; the reading's
      // age does not end it), anything else becomes UNKNOWN. Projected by the SAME
      // rows() so the mask and main's own stale push cannot word it differently.
      const held = pool.limitEpochAt !== null && (pool.state === 'LIMITED' || pool.state === 'RECOVERING');
      const stale: PoolCapacitySnapshot = {
        ...pool,
        freshness: 'STALE',
        state: held ? pool.state : 'UNKNOWN',
        stateReason: held ? pool.stateReason : 'STALE_READING'
      };
      const exp = this.rows(stale, now, T);
      freshness.expired = {
        state: stale.state,
        stateText: STATE_TEXT[stale.state],
        presentation: 'UNKNOWN',
        fiveHour: exp.fiveHour
      };
      // Degrade only: the mask may keep a weekly row the strip shows (minus its
      // figures), never add one the strip hides. Main's own stale push decides that.
      if (exp.weekly && live.weekly) freshness.expired.weekly = exp.weekly;
    }

    const notice = this.noticeFor(pool);
    const body: PoolBody = {
      poolId: this.poolIdOf(pool.poolKey),
      poolLabel: this.label(pool),
      provider: pool.provider,
      domainRevision: pool.revision,
      state: pool.state,
      stateText: STATE_TEXT[pool.state],
      presentation: live.presentation,
      fiveHour: live.fiveHour,
      freshness,
      membership: {
        known: inputs.membershipKnown(pool.provider),
        agentIds: [...inputs.membersOf(pool.poolKey)].sort()
      },
      markers: { additionalPressure },
      provenance: provenanceOf(pool)
    };
    if (live.weekly) body.weekly = live.weekly;
    if (notice) body.notice = notice;
    return body;
  }

  /**
   * The strip rows for one pool: the presentation variant, the permanent five-hour
   * row and the optional weekly row. One function for the live object AND for the
   * expired view, so there is exactly one wording path per case (C2.11 crit 18).
   */
  private rows(pool: PoolCapacitySnapshot, now: number, T: number): {
    presentation: StripPresentation; fiveHour: FiveHourStrip; weekly?: VisibleWeeklyStrip;
    fiveWindowId: string | null; weeklyWindowId: string | null;
  } {
    const fresh = pool.freshness === 'FRESH';
    const known = fresh && pool.state !== 'UNKNOWN';
    const five = pool.windows.find((w) => w.kind === 'FIVE_HOUR' && applicabilityOf(w) === 'APPLICABLE') ?? null;
    const weekly = this.weekly(pool, fresh, T);
    const fiveRemaining = known && five ? validRemaining(five.remainingPercent) : null;

    // C2.7: the blocked frame needs MAIN evidence that weekly blocks ordinary use -
    // a pool in a BLOCKED_FRAME state whose weekly the provider named, or a fresh
    // reading shows at zero. The state table below is the whole trigger.
    const frame = known && fiveRemaining !== null && fiveRemaining > 0
      && (weekly?.reason === 'PROVIDER_ATTRIBUTED_LIMITING' || weekly?.reason === 'NUMERICALLY_EXHAUSTED')
      ? BLOCKED_FRAME[pool.state] : undefined;
    const presentation: StripPresentation = !known ? 'UNKNOWN' : frame ? 'BLOCKED_SUBORDINATE' : 'NORMAL';

    const fiveHour: FiveHourStrip = {
      label: '5h',
      text: pool.stateReason === 'RESTORED_UNCONFIRMED'
        ? '5h · Capacity unknown · no live reading since restart'
        : `5h · Capacity unknown · last update ${this.formatTime(pool.observedAt, now)}`,
      compactText: '5h · Capacity unknown'
    };
    if (frame && fiveRemaining !== null) {
      const shown = Math.floor(fiveRemaining);
      fiveHour.text = frame.text(shown);
      fiveHour.compactText = frame.compactText(shown);
    } else if (presentation === 'NORMAL' && fiveRemaining !== null && five) {
      const m = meterOf(fiveRemaining);
      fiveHour.text = `5h · ${m.displayPercent}% remaining`;
      fiveHour.compactText = `5h ${m.displayPercent}%`;
      fiveHour.meter = m;
      if (five.resetsAt !== null && five.resetsAt > now
        && this.band(`${pool.poolKey}|reset|five`, fiveRemaining, five.resetsAt, T) !== null) {
        fiveHour.resetText = `reset expected ~${this.formatTime(five.resetsAt, now)}`;
        fiveHour.resetExpectedAt = five.resetsAt;
      }
    } else if (known) {
      fiveHour.text = '5h · Capacity unknown';
    }

    let visibleWeekly: VisibleWeeklyStrip | undefined;
    if (weekly) {
      const remaining = fresh && weekly.window ? validRemaining(weekly.window.remainingPercent) : null;
      visibleWeekly = {
        reason: weekly.reason,
        text: weeklyText(weekly.reason, remaining === null ? null : Math.floor(remaining)),
        compactText: weeklyCompactText(weekly.reason, remaining === null ? null : Math.floor(remaining)),
        attribution: WEEKLY_ATTRIBUTION[weekly.reason]
      };
      const numeric = weekly.reason !== 'UNKNOWN_CAPACITY' && weekly.reason !== 'UNKNOWN_APPLICABILITY';
      if (presentation === 'NORMAL' && numeric && remaining !== null) {
        visibleWeekly.meter = meterOf(remaining);
        const r = weekly.window?.resetsAt ?? null;
        if (r !== null && r > now && this.band(`${pool.poolKey}|reset|weekly`, remaining, r, T) !== null) {
          visibleWeekly.resetText = `reset expected ~${this.formatTime(r, now)}`;
        }
      }
    }
    const out: ReturnType<CapacityStripPresenter['rows']> = {
      presentation, fiveHour, fiveWindowId: five?.windowId ?? null, weeklyWindowId: weekly?.window?.windowId ?? null
    };
    if (visibleWeekly) out.weekly = visibleWeekly;
    return out;
  }

  /**
   * C2.4 precedence, C2.5 band. Returns null when weekly is normally hidden, and the
   * caller then leaves the property OUT — there is no hidden variant to send.
   */
  private weekly(pool: PoolCapacitySnapshot, fresh: boolean, T: number):
    { reason: WeeklyRevealReason; window: CapacityWindow | null } | null {
    // C2.6: when the whole pool is UNKNOWN the pool-level row suffices.
    if (pool.state === 'UNKNOWN') return null;
    const wk = pool.windows.find((w) => w.kind === 'SEVEN_DAY' && applicabilityOf(w) === 'APPLICABLE') ?? null;
    const value = wk && fresh ? validRemaining(wk.remainingPercent) : null;

    // The band is evaluated on every FRESH value, whichever reason ends up winning, so
    // a stronger reason ending does not leave the latch describing an older sample.
    // No fresh value: the latch is left exactly as it was (C2.5, UNKNOWN clause).
    const band = wk && value !== null ? this.band(pool.poolKey, value, wk.resetsAt, T) : null;
    const banded: WeeklyRevealReason | null =
      band === 'BELOW' ? 'BELOW_DISPLAY_THRESHOLD' : band === 'HOLD' ? 'HYSTERESIS_HOLD' : null;

    if (wk && pool.providerAttributedLimitingWindowId === wk.windowId) return { reason: 'PROVIDER_ATTRIBUTED_LIMITING', window: wk };
    if (wk && fresh && pool.numericallyExhaustedWindowIds.includes(wk.windowId)) return { reason: 'NUMERICALLY_EXHAUSTED', window: wk };
    if (wk && value === null) return { reason: 'UNKNOWN_CAPACITY', window: wk };
    if (!wk && pool.windows.some((w) => applicabilityOf(w) === 'UNKNOWN')) return { reason: 'UNKNOWN_APPLICABILITY', window: null };
    return banded ? { reason: banded, window: wk } : null;
  }

  /** The pool's notice while the state it announced still holds; retired after. */
  private noticeFor(pool: PoolCapacitySnapshot): CapacityNotice | undefined {
    const n = this.notices.get(pool.poolKey);
    if (!n) return undefined;
    if (n.to !== pool.state) { this.notices.delete(pool.poolKey); return undefined; }
    const { identity: _identity, ...visible } = n;
    return { ...visible };
  }

  /**
   * The pool's user-safe label, the SAME one the strip shows (unit #5: an agent card names
   * its pool exactly as the strip does). A label, never pool data.
   */
  labelOf(pool: PoolCapacitySnapshot): string {
    return this.label(pool);
  }

  /** The strip's opaque id for a pool key (unit #4 resolves a clicked poolId back to its pool). */
  poolIdOf(poolKey: string): string {
    return `pool-${this.opaque(poolKey)}`;
  }

  /**
   * The provider's name. There is only ever ONE pool per provider (human ruling at the
   * strip review, 2026-09-21): at most two pools, Claude and Codex, so the name is the
   * whole label and no second-account ordinal exists.
   */
  private label(pool: PoolCapacitySnapshot): string {
    return PROVIDER_LABEL[pool.provider];
  }

  /**
   * THE C2.5 fixed band, for every threshold-driven disclosure the strip makes: weekly
   * reveal, and (strip-polish, human ruling) the reset hint of each window. Evaluated on a
   * FRESH full-precision value only. Enter at `< T`; hold until `>= min(100, T + band)`;
   * a re-anchored window (its reset moved) re-evaluates from hidden.
   * Returns BELOW (under T), HOLD (inside the band after entering), or null (hidden).
   */
  private band(key: string, value: number, anchor: number | null, T: number): 'BELOW' | 'HOLD' | null {
    let latch = this.latches.get(key) ?? { shown: false, anchor };
    if (latch.anchor !== anchor) latch = { shown: false, anchor };
    let out: 'BELOW' | 'HOLD' | null = null;
    if (value < T) { latch.shown = true; out = 'BELOW'; }
    else if (latch.shown && value < Math.min(100, T + HYSTERESIS_BAND)) out = 'HOLD';
    else latch.shown = false;
    this.latches.set(key, latch);
    return out;
  }

  /** Keyed hash: stable in this process, not reversible to an account scope. */
  private opaque(value: string): string {
    return createHmac('sha256', this.idKey).update(value).digest('hex').slice(0, 16);
  }
}

function provenanceOf(pool: PoolCapacitySnapshot): ProvenanceClass {
  if (pool.stateReason === 'RESTORED_UNCONFIRMED') return 'RESTORED';
  return pool.source === 'codex-account-read' ? 'ACCOUNT_READ' : 'LIVE';
}
