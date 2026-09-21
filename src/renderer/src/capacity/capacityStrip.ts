/**
 * v1.1.45 unit #1 — THE renderer mirror and THE presenter/selector family for pool
 * capacity. Design of record §17: one renderer mirror, one presenter/selector family,
 * the same poolId AND revision across every surface.
 *
 * EVERY SURFACE READS THROUGH THIS FILE. The strip, the agent cards, the banner and
 * the detail link all select from here, so two surfaces cannot word the same object
 * differently: there is only one set of functions to word it with, and they compose
 * nothing — they pick main's strings.
 *
 * WHAT THIS MAY DO, and it is the whole list:
 *   - accept a complete-replace collection whose revision is strictly newer, after
 *     validating it against the shared schema (refused whole if it fails);
 *   - forget everything on disconnect or reload (no durable cache: the answer after
 *     a reload is "nothing yet", never the last thing seen);
 *   - apply the ONE permitted local-time fallback: past main's own `expiresAt`, swap
 *     in the degraded rows main already supplied. It can only degrade.
 * WHAT IT MAY NOT DO: parse providers, compute remaining, choose a displayed window,
 * derive a state or a reveal, advance recovery, infer membership, count down, or feed
 * anything back to scheduling.
 *
 * Pure TypeScript with no React, so the whole family is testable in Node; the hook
 * that binds it to IPC lives in `useCapacityStrip.ts`.
 */
import {
  validateCapacityStrip,
  type CapacityStripCollection, type CapacityStripPool, type CapacityNotice
} from '@shared/capacityStrip';

export type MirrorVerdict = 'ACCEPTED' | 'NOT_NEWER' | 'INVALID';

export class CapacityStripMirror {
  private collection: CapacityStripCollection | null = null;
  private readonly listeners = new Set<() => void>();

  /**
   * Offer a collection from main. Complete-replace: a strictly newer collection
   * revision replaces everything, including removing pools it no longer lists; an
   * equal or older one is ignored wholesale. A pool whose revision would go BACKWARDS
   * inside a newer collection means the two did not come from one ordered source, so
   * that collection is refused rather than partly believed.
   */
  accept(value: unknown): MirrorVerdict {
    if (validateCapacityStrip(value).length) return 'INVALID';
    const next = value as CapacityStripCollection;
    const held = this.collection;
    if (held && next.collectionRevision <= held.collectionRevision) return 'NOT_NEWER';
    if (held) {
      const prior = new Map(held.pools.map((p) => [p.poolId, p.revision]));
      for (const p of next.pools) {
        const was = prior.get(p.poolId);
        if (was !== undefined && p.revision < was) return 'INVALID';
      }
    }
    this.collection = next;
    this.emit();
    return 'ACCEPTED';
  }

  /** Disconnect, reload or window teardown: back to "nothing known". */
  reset(): void {
    if (this.collection === null) return;
    this.collection = null;
    this.emit();
  }

  get(): CapacityStripCollection | null {
    return this.collection;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

// ─── Selectors ─────────────────────────────────────────────────────────────────

/** Whether the renderer holds any collection yet. `NONE` is UNKNOWN, never "no pools". */
export type CollectionStatus = 'NONE' | 'COMPLETE' | 'INCOMPLETE';

export function selectCollectionStatus(c: CapacityStripCollection | null): CollectionStatus {
  if (!c) return 'NONE';
  return c.complete ? 'COMPLETE' : 'INCOMPLETE';
}

/** Every pool in main's order. Empty for `NONE` too — check the status first. */
export function selectPools(c: CapacityStripCollection | null): readonly CapacityStripPool[] {
  return c ? c.pools : [];
}

/** One pool by its opaque id, or null when it is not in the current collection. */
export function selectPool(c: CapacityStripCollection | null, poolId: string): CapacityStripPool | null {
  return c?.pools.find((p) => p.poolId === poolId) ?? null;
}

/** The pools an agent's own readings landed in (main's membership, not inference). */
export function selectPoolsForAgent(c: CapacityStripCollection | null, agentId: string): readonly CapacityStripPool[] {
  return selectPools(c).filter((p) => p.membership.agentIds.includes(agentId));
}

/** Open notices, for the entry banner (unit #6). Dismissed ones are main-recorded. */
export function selectOpenNotices(c: CapacityStripCollection | null): { poolId: string; notice: CapacityNotice }[] {
  const out: { poolId: string; notice: CapacityNotice }[] = [];
  for (const p of selectPools(c)) if (p.notice?.lifecycle === 'OPEN') out.push({ poolId: p.poolId, notice: p.notice });
  return out;
}

/**
 * v1.1.45 unit #6 — the LIMITED entry banners to show: an OPEN notice that carries main's
 * banner words (only an entry to LIMITED does). Dismissed ones are main-recorded, so they
 * never come back on a reload; a notice retires when the pool leaves the state it announced.
 */
export function selectLimitBanners(c: CapacityStripCollection | null):
  { poolId: string; noticeId: string; banner: NonNullable<CapacityNotice['banner']> }[] {
  const out: { poolId: string; noticeId: string; banner: NonNullable<CapacityNotice['banner']> }[] = [];
  for (const p of selectPools(c)) {
    const n = p.notice;
    if (n && n.lifecycle === 'OPEN' && n.kind === 'LIMIT_REACHED' && n.banner) out.push({ poolId: p.poolId, noticeId: n.noticeId, banner: n.banner });
  }
  return out;
}

/**
 * A pool as a surface should draw it at `now`.
 *
 * THE ONE-WAY EXPIRY MASK (§17, C2.11 crit 10). Past main's `expiresAt` — which means
 * main's own stale publication has not reached us — swap in the degraded rows main
 * supplied with this very object. The swap only removes figures and meters; the
 * result is never re-exported, and a later push from main simply replaces it.
 * Nothing local can un-mask a row, create a reveal, or pick a blocked frame.
 */
export type PresentedPool = CapacityStripPool & { masked: boolean };

export function presentPool(pool: CapacityStripPool, now: number): PresentedPool {
  const f = pool.freshness;
  if (f.expiresAt === null || !f.expired || now <= f.expiresAt) return { ...pool, masked: false };
  const { weekly: _hiddenByMask, ...rest } = pool;
  const masked: PresentedPool = {
    ...rest,
    state: f.expired.state,
    stateText: f.expired.stateText,
    presentation: f.expired.presentation,
    fiveHour: f.expired.fiveHour,
    masked: true
  };
  if (f.expired.weekly) masked.weekly = f.expired.weekly;
  return masked;
}
