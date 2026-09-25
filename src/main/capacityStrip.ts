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
  CapacityBanner, CapacityFreshnessView, CapacityNotice, CapacityStripCollection, CapacityStripPool, DisplayReadyMeter, FiveHourStrip,
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

/** §13: the ONLY transitions that raise an OS toast (unit #7). Everything else is strip-only. */
export const TOASTED_KINDS = ['LIMIT_REACHED', 'RECOVERED'] as const;

export const STATE_TEXT: Record<CapacityState, string> = {
  UNKNOWN: 'Capacity unknown',
  AVAILABLE: 'Available',
  APPROACHING: 'Approaching limit',
  RESERVE_ONLY: 'Reserve only',
  LIMITED: 'Limited',
  RECOVERING: 'Recovering'
};

// Antigravity's per-family labels (`Antigravity · 3P` / `Antigravity · Gemini`) are the
// strip's business and land with the two-pool UI; until then no AGY pool is ingested,
// and this entry exists so the provider set stays exhaustive here.
const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

/** Antigravity's two allowance families, as people see them. Keyed by `limitId`. */
const AGY_FAMILY_LABEL: Record<string, string> = { '3p': '3P', gemini: 'Gemini' };

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
const BLOCKED_FRAME: Partial<Record<CapacityState, { text: (n: number) => string; note: string }>> = {
  LIMITED: {
    text: (n) => `5h · ${n}% remaining · unavailable while Weekly is exhausted`,
    note: 'unavailable while Weekly is exhausted'
  },
  RESERVE_ONLY: {
    text: (n) => `5h · ${n}% remaining · ordinary work held while Weekly is at 0%`,
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
  /**
   * The lazy-row rule's two pieces of memory, per pool. EPHEMERAL and per app run: the
   * visibility latch is per run by design, and this is UI-derived state that should
   * rebuild itself from observations rather than be restored from disk. Pruned by the
   * same end-of-compose line as the latches, so a pool that leaves and returns starts
   * clean. Keyed by poolKey, not the opaque strip id: this never leaves main.
   */
  private readonly lastRemainder = new Map<string, string>();
  private readonly moving = new Set<string>();
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

  /**
   * v1.1.45 unit #7 (§13): the OS toast for a decided transition, or null when this
   * transition is not one people are told about. ONLY entering LIMITED and the confirmed
   * return to ordinary use toast; reserve-only and "recovery possible" are strip changes.
   * No figure, and the same words as the #6 banner for a LIMITED entry.
   */
  toastFor(intent: CapacityNotifyIntent, pool: PoolCapacitySnapshot | null): { title: string; body: string } | null {
    if (!(TOASTED_KINDS as readonly string[]).includes(intent.kind)) return null;
    const name = PROVIDER_LABEL[intent.provider as ProviderId] ?? intent.provider;
    if (intent.kind === 'LIMIT_REACHED') {
      const b = pool ? this.banner(pool) : null;
      return b ? { title: b.title, body: `${b.cause} ${b.consequence}` } : { title: `${name} limited`, body: 'Automatic delivery is paused until capacity returns.' };
    }
    return { title: `${name} available again`, body: `Automatic delivery to ${name} agents has resumed.` };
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
      // The lazy-row rule runs for EVERY pool, whether or not its row is shown: a pool
      // has to be observed to be seen to move, and skipping hidden pools would mean the
      // first consumption was the one reading that never got compared.
      const show = this.isMoving(pool, inputs);
      if (!show) continue;
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
    for (const k of [...this.lastRemainder.keys()]) if (!live.has(k)) this.lastRemainder.delete(k);
    for (const k of [...this.moving]) if (!live.has(k)) this.moving.delete(k);
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
        // STALE-RETAIN: a plain stale reading keeps its figures, so the mask keeps them too.
        presentation: exp.presentation === 'NORMAL' ? 'NORMAL' : 'UNKNOWN',
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
    // STALE-RETAIN (human ruling 2026-09-22; SUPERSEDES A1, which stripped a stale reading's
    // figures): a reading that has merely aged keeps its last-known figures on the strip and
    // is drawn as an ordinary pool - a figure that is not moving usually means usage is not
    // moving. The age is said in the provider details instead. Only a PLAIN stale reading
    // qualifies (the tracker's STALE_READING): an open limit epoch keeps its own look, and
    // evidence restored across a restart is not a reading this run has seen.
    const retained = !fresh && pool.state === 'UNKNOWN' && pool.stateReason === 'STALE_READING';
    const known = (fresh && pool.state !== 'UNKNOWN') || retained;
    const five = pool.windows.find((w) => w.kind === 'FIVE_HOUR' && applicabilityOf(w) === 'APPLICABLE') ?? null;
    const weekly = this.weekly(pool, fresh || retained, T, retained);
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
        : `5h · Capacity unknown · last update ${this.formatTime(pool.observedAt, now)}`
    };
    if (frame && fiveRemaining !== null) {
      const shown = Math.floor(fiveRemaining);
      fiveHour.text = frame.text(shown);
    } else if (presentation === 'NORMAL' && fiveRemaining !== null && five) {
      const m = meterOf(fiveRemaining);
      fiveHour.text = `5h · ${m.displayPercent}% remaining`;
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
      const remaining = (fresh || retained) && weekly.window ? validRemaining(weekly.window.remainingPercent) : null;
      visibleWeekly = {
        reason: weekly.reason,
        text: weeklyText(weekly.reason, remaining === null ? null : Math.floor(remaining)),
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
  private weekly(pool: PoolCapacitySnapshot, fresh: boolean, T: number, retained = false):
    { reason: WeeklyRevealReason; window: CapacityWindow | null } | null {
    // C2.6: when the whole pool is UNKNOWN the pool-level row suffices - unless it is a
    // retained stale reading (STALE-RETAIN), whose last-known weekly row stays as it was.
    if (pool.state === 'UNKNOWN' && !retained) return null;
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
    const out: CapacityNotice = { ...visible };
    if (n.kind === 'LIMIT_REACHED') out.banner = this.banner(pool);
    return out;
  }

  /**
   * The LIMITED entry banner's words (unit #6; §11, C2.12 rule 3): state, cause and
   * consequence, NO figure. The cause is causal ("limit reached") ONLY when the provider
   * attributed the window (crit 16); an unattributed refusal is reported as what it is.
   */
  private banner(pool: PoolCapacitySnapshot): CapacityBanner {
    const name = this.label(pool);
    const attributed = pool.providerAttributedLimitingWindowId
      ? pool.windows.find((w) => w.windowId === pool.providerAttributedLimitingWindowId)?.label ?? null
      : null;
    const cause = pool.stateReason === 'PROVIDER_ATTRIBUTED_LIMITING' && attributed
      ? `${name} reports the ${attributed} limit reached.`
      : pool.stateReason === 'ORDINARY_USE_DENIED'
        ? `${name} is refusing ordinary use.`
        : pool.stateReason === 'PROVIDER_REACHED_UNATTRIBUTED'
          ? `${name} reported a usage limit without naming which window.`
          : `A limit on ${name} is in effect and has not cleared yet.`;
    return {
      title: `${name} limited`,
      cause,
      consequence: `Automatic delivery to ${name} agents is paused until capacity returns. Queued messages wait; nothing is lost.`
    };
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
   * The pool's name.
   *
   * The invariant is one pool per provider-ACCOUNT-LIMIT identity - not one per provider.
   * That read the same until Antigravity: Claude and Codex each expose ONE current limit
   * identity, so the provider name was the whole label (human ruling at the strip review,
   * 2026-09-21, and still true of them). An Antigravity ACCOUNT exposes two allowance
   * families at once, so its rows carry the family as well. No second-account ordinal
   * exists for any provider.
   */
  private label(pool: PoolCapacitySnapshot): string {
    const name = PROVIDER_LABEL[pool.provider];
    // Antigravity is the one provider with two allowances per account, so the provider
    // name alone would name two different rows. The family is part of the label, and the
    // limit id IS the family (design 1.4). An unrecognised limit id falls back to the
    // provider name rather than printing a raw identifier at a person.
    if (pool.provider !== 'antigravity') return name;
    const family = AGY_FAMILY_LABEL[pool.limitId];
    return family ? `${name} · ${family}` : name;
  }

/**
   * THE LAZY-ROW RULE (human ruling, 2026-09-23): "Two POSSIBLE rows. Surely we should
   * see either 3P or Gemini moving? Once shown as moving, trigger that one. If the other
   * starts, do that as well."
   *
   * Antigravity is the first provider whose account exposes TWO allowances, and most
   * people only ever draw on one of them. Showing both from boot would put a permanently
   * idle row on the strip next to a real one. So a row appears when its pool is MOVING,
   * and thereafter stays.
   *
   * Moving is whichever comes first:
   *   - CONSUMPTION: its remaining percentage changed between two readings we trusted; or
   *   - GATING: a live agent's own readings land in this pool, i.e. its model draws on
   *     this family. (`membersOf` is the runtime's accepted mapping, so an agent gating
   *     on 3P reveals the 3P row before a single percentage has moved.)
   *
   * Applies to Antigravity only. Claude and Codex each expose ONE current limit identity,
   * so their row has always been the provider's row and hiding it would be a regression.
   */
  private isMoving(pool: PoolCapacitySnapshot, inputs: CapacityStripInputs): boolean {
    if (pool.provider !== 'antigravity') return true;
    const key = pool.poolKey;
    if (this.moving.has(key)) return true;                       // LATCHED for the run

    const gating = inputs.membersOf(key).length > 0;

    // SAFETY OVERRIDE (god, not negotiable). A pool that is out of allowance AND gating a
    // live agent is always shown, even if it never moved this run: a hidden row silently
    // blocking an agent is the one failure this strip must never have. It must not wait
    // for a prior reading to compare against, so it is checked before the memory below.
    //
    // IT IS SUBSUMED BY THE GATING RULE BELOW, AND IS KEPT ANYWAY. The ratified rule makes
    // gating a reveal on its own, so "blocking AND gating" can never be true while
    // "gating" is false - deleting these two lines changes no behaviour today, and a
    // mutant proved exactly that. They stay because the two rules answer different
    // questions: gating is a display preference about idle rows, the override is a safety
    // guarantee about blocked work. If gating is ever narrowed - to a fresh reading, to a
    // recently-active agent - the preference may change; the guarantee may not. Written
    // first and separately so that narrowing cannot silently take the guarantee with it.
    const blocking = pool.state === 'LIMITED' || pool.state === 'RESERVE_ONLY';
    if (blocking && gating) { this.moving.add(key); return true; }

    // GATING: a live agent draws on this family (ratified rule 1b).
    if (gating) { this.moving.add(key); return true; }

    // CONSUMPTION. Only a FRESH reading is evidence: a STALE-RETAIN row re-presents the
    // last safe numbers with their age, and re-reading them is not an observation. So a
    // stale value neither overwrites what we remember nor counts as a change - otherwise
    // a retained figure that happens to differ would reveal a row nobody consumed from.
    if (pool.freshness !== 'FRESH') return false;
    const now = remainderFingerprint(pool);
    if (now === null) return false;                              // nothing numeric to compare
    const before = this.lastRemainder.get(key);
    if (before === undefined) { this.lastRemainder.set(key, now); return false; }  // seed only
    if (before === now) return false;
    // Compared EXACTLY, never with a tolerance: the percentage is derived deterministically
    // from the provider's own fraction, so an unchanged reading is identical and any
    // difference is real consumption. A tolerance would swallow exactly the small movement
    // this rule exists to notice. A change that happened while the pool was STALE lands
    // here on the next fresh reading, because it is compared against the last value we
    // actually trusted - so consumption during a gap is revealed, not lost.
    this.lastRemainder.set(key, now);
    this.moving.add(key);
    return true;
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

/**
 * What "the numbers moved" compares. Every APPLICABLE window's remaining percentage, in
 * a stable order - not just one window, because a weekly allowance can be consumed while
 * the five-hour figure is unchanged, and that is still the pool moving. null when the
 * pool carries no numeric reading at all, which is not evidence of anything.
 */
function remainderFingerprint(pool: PoolCapacitySnapshot): string | null {
  const parts = pool.windows
    .filter((w) => applicabilityOf(w) === 'APPLICABLE' && validRemaining(w.remainingPercent) !== null)
    .map((w) => `${w.windowId}=${w.remainingPercent}`)
    .sort();
  return parts.length ? parts.join('|') : null;
}

function provenanceOf(pool: PoolCapacitySnapshot): ProvenanceClass {
  if (pool.stateReason === 'RESTORED_UNCONFIRMED') return 'RESTORED';
  return pool.source === 'codex-account-read' ? 'ACCOUNT_READ' : 'LIVE';
}
