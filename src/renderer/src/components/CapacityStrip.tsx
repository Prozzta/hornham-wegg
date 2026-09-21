/**
 * v1.1.45 — THE title-bar capacity strip (design of record §1, §3, §9, §10, C2.2, C2.4,
 * C2.6, C2.7, C2.11 crit 1 and 14-15), as amended by the human at the strip review
 * (2026-09-21):
 *
 *   - STATE IS A COLOURED SHAPE, NEVER A WORD. Every pool carries its shape token in
 *     every state, healthy included; the shape is the non-colour channel (§9 kept, the
 *     word dropped). The state word survives only as the token's ACCESSIBLE NAME, so a
 *     screen reader still hears it; nothing visible says "Available".
 *   - FULL CONTENT, SCROLLED WHEN IT OVERFLOWS, replacing the C2.10 collapse ladder: a
 *     gentle back-and-forth marquee, paused on hover or focus, and no motion at all
 *     under prefers-reduced-motion (the row can then be scrolled by hand).
 *   - COLD START IS DRAWN (§10, F3): no collection yet, or no pools, shows the unknown
 *     shape and main's `emptyText` instead of nothing.
 *
 * Every string is main's. This file gives each one a shape and a place; it composes no
 * wording, derives no state, and has no IPC of its own: it reads the one mirror through
 * the one selector family and applies the one-way expiry mask (presentPool).
 *
 * GEOMETRY IS LOAD-BEARING (§9). Capacity is a CONTINUOUS meter; the agent context gauge
 * is SEGMENTED. This file draws no segments, and a test pins that it never does.
 *
 * NEVER REFLOWS THE CHROME. One fixed 36px line: overflow scrolls sideways inside it, so
 * a capacity change can never resize the office canvas below.
 */
import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { CapacityState } from '@shared/providerCapacity';
import { CAPACITY_EMPTY_TEXT } from '@shared/capacityStrip';
import { ProviderLogo } from './ProviderLogo';
import { presentPool, selectPools, type PresentedPool } from '../capacity/capacityStrip';
import { useCapacityStrip } from '../capacity/useCapacityStrip';
import { poolTokens, STRIP_GEOMETRY, type StripToken } from '../capacity/stripLayout';

/** The non-colour channel (§9): a SHAPE per state, so the state survives greyscale. */
export const STATE_TOKEN: Record<CapacityState, string> = {
  AVAILABLE: '●',
  APPROACHING: '▲',
  RESERVE_ONLY: '◐',
  LIMITED: '■',
  RECOVERING: '↻',
  UNKNOWN: '◌'
};

/**
 * State colour, strengthened at the review now that colour carries more of the meaning.
 * Six DISTINCT theme tokens (so the dark theme follows), none of them the pale ghost ink:
 * UNKNOWN is the strong neutral ink, never a healthy colour and never washed out.
 */
export const STATE_COLOR: Record<CapacityState, string> = {
  AVAILABLE: 'var(--cth-status-success)',
  APPROACHING: 'var(--cth-status-working)',
  RESERVE_ONLY: 'var(--cth-status-looping)',
  LIMITED: 'var(--cth-status-blocked)',
  RECOVERING: 'var(--cth-status-thinking)',
  UNKNOWN: 'var(--cth-ink-500)'
};

const FONT_SIZE = 12;

/** Scroll speed of the overflow marquee, and the floor on one sweep. Gentle by design. */
export const SCROLL_PX_PER_S = 30;
const MIN_SWEEP_S = 6;

/**
 * How far the track must travel to show its last pixel: zero when it fits. Pure, so the
 * overflow rule is testable without a layout engine.
 */
export function scrollDistance(trackWidth: number, hostWidth: number): number {
  return Math.max(0, Math.ceil(trackWidth - hostWidth));
}

/** Seconds for one sweep of `distance` px (it runs there and back, pausing at each end). */
export function sweepSeconds(distance: number): number {
  return Math.max(MIN_SWEEP_S, Math.round(distance / SCROLL_PX_PER_S) + 3);
}

/**
 * The strip's own CSS. The marquee runs ONLY when the host is marked as overflowing, holds
 * still at both ends (the first and last 12% of each sweep) so either edge can be read,
 * pauses on hover or keyboard focus, and is switched OFF under prefers-reduced-motion,
 * where the row becomes hand-scrollable instead.
 */
export const STRIP_CSS = `
.cap-strip-host { flex: 0 1 auto; min-width: 0; height: 36px; overflow: hidden; position: relative; }
.cap-strip-track { display: inline-flex; align-items: center; height: 36px; column-gap: ${STRIP_GEOMETRY.poolGap}px; white-space: nowrap; }
.cap-strip-host[data-overflow="true"] .cap-strip-track {
  animation: cap-strip-scroll var(--cap-scroll-duration, 12s) ease-in-out infinite alternate;
}
.cap-strip-host:hover .cap-strip-track, .cap-strip-host:focus-within .cap-strip-track { animation-play-state: paused; }
@keyframes cap-strip-scroll {
  0%, 12% { transform: translateX(0); }
  88%, 100% { transform: translateX(var(--cap-scroll, 0px)); }
}
@media (prefers-reduced-motion: reduce) {
  .cap-strip-host[data-overflow="true"] .cap-strip-track { animation: none; }
  .cap-strip-host { overflow-x: auto; scrollbar-width: none; }
}
`;

/**
 * THE capacity meter primitive: one continuous fill (§9: continuous = provider capacity),
 * 40x6, so it can never be mistaken for the segmented context gauge or the 96x8 budget and
 * context bars. Exported so every capacity surface draws the same shape (the Monitor
 * line's usage bar, v1.1.45 CAPUI-MONITOR). Drawn only for a figure main supplied.
 */
export function CapacityMeter({ percent, valueText, color, dataRole }: {
  percent: number; valueText: string; color: string; dataRole: string;
}) {
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
      data-cap-meter={dataRole}
      style={{
        display: 'inline-block', position: 'relative', flexShrink: 0,
        width: STRIP_GEOMETRY.meter, height: 6, borderRadius: 3,
        background: 'var(--cth-paper-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', overflow: 'hidden'
      }}
    >
      <span style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: `${percent}%`, background: color
      }} />
    </span>
  );
}

/** A strip meter: the remaining figure main sent, in its pool's state colour. */
function Meter({ token, state }: { token: Extract<StripToken, { kind: 'meter' }>; state: CapacityState }) {
  return <CapacityMeter percent={token.meter.remainingPercent} valueText={token.valueText} color={STATE_COLOR[state]} dataRole={token.role} />;
}

function Token({ token, state }: { token: StripToken; state: CapacityState }) {
  if (token.kind === 'meter') return <Meter token={token} state={state} />;
  if (token.kind === 'reset') {
    return <span data-cap-reset={token.role} style={{ color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}>{token.text}</span>;
  }
  // A subordinate token is one atomic string in neutral ink: no positive colour, no
  // weight, nothing that would present the retained figure as usable (C2.7).
  return (
    <span
      data-cap-figure={token.role}
      data-cap-subordinate={token.subordinate ? 'true' : undefined}
      style={{
        whiteSpace: 'nowrap',
        color: token.subordinate ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
        fontWeight: token.subordinate ? 400 : 500
      }}
    >
      {token.text}
    </span>
  );
}

/** The coloured shape. Its accessible name is main's state word, never visible text. */
function StateShape({ state, name }: { state: CapacityState; name: string }) {
  return (
    <span
      role="img"
      aria-label={name}
      data-cap-state-token={state}
      style={{
        color: STATE_COLOR[state], fontSize: 14, fontWeight: 700, lineHeight: 1,
        display: 'inline-block', width: STRIP_GEOMETRY.stateToken, textAlign: 'center', flexShrink: 0
      }}
    >
      {STATE_TOKEN[state]}
    </span>
  );
}

function PoolGroup({ pool }: { pool: PresentedPool }) {
  return (
    <span
      role="group"
      aria-label={pool.poolLabel}
      data-cap-pool={pool.poolId}
      data-cap-presentation={pool.presentation}
      style={{ display: 'inline-flex', alignItems: 'center', columnGap: STRIP_GEOMETRY.gap, flexShrink: 0 }}
    >
      <ProviderLogo provider={pool.provider} size={STRIP_GEOMETRY.mark} />
      <span style={{ color: 'var(--cth-ink-700)', whiteSpace: 'nowrap' }}>{pool.poolLabel}</span>
      <StateShape state={pool.state} name={pool.stateText} />
      {poolTokens(pool).map((t) => <Token key={t.key} token={t} state={pool.state} />)}
    </span>
  );
}

/**
 * The strip's content for a set of presented pools. With no pools it draws the cold-start
 * chip: the unknown shape and main's `emptyText` (F3). Pure: rendered by the connected
 * component below, by the render tests, and by the static preview.
 */
export function CapacityStripView({ pools, emptyText }: { pools: readonly PresentedPool[]; emptyText: string }) {
  return (
    <>
      <style>{STRIP_CSS}</style>
      <div className="cap-strip-track" data-cap-track="">
        {pools.length
          ? pools.map((p) => <PoolGroup key={p.poolId} pool={p} />)
          : (
            <span data-cap-empty="" style={{ display: 'inline-flex', alignItems: 'center', columnGap: STRIP_GEOMETRY.gap }}>
              <StateShape state="UNKNOWN" name={emptyText} />
              <span style={{ color: 'var(--cth-ink-700)', whiteSpace: 'nowrap' }}>{emptyText}</span>
            </span>
          )}
      </div>
    </>
  );
}

/**
 * The connected strip. Re-renders when main pushes and ONCE at the soonest `expiresAt`
 * (so the one-way mask fires on time: one timer armed from main's own deadline, never a
 * poll). It measures its own overflow and sets the marquee's travel and duration; the
 * CSS does the moving.
 */
export function CapacityStrip() {
  const collection = useCapacityStrip();
  const host = useRef<HTMLDivElement>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useLayoutEffect(() => {
    const el = host.current;
    const track = el?.querySelector<HTMLElement>('[data-cap-track]');
    if (!el || !track || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const d = scrollDistance(track.scrollWidth, el.clientWidth);
      el.dataset.overflow = d > 0 ? 'true' : 'false';
      el.style.setProperty('--cap-scroll', `${-d}px`);
      el.style.setProperty('--cap-scroll-duration', `${sweepSeconds(d)}s`);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(track);
    measure();
    return () => ro.disconnect();
  }, []);

  const now = Date.now();
  const pools = selectPools(collection).map((p) => presentPool(p, now));

  const nextExpiry = selectPools(collection)
    .map((p) => p.freshness.expiresAt)
    .filter((t): t is number => t !== null && t >= now)
    .reduce<number | null>((min, t) => (min === null || t < min ? t : min), null);
  useEffect(() => {
    if (nextExpiry === null) return;
    const handle = setTimeout(rerender, Math.max(0, nextExpiry - Date.now()) + 1);
    return () => clearTimeout(handle);
  }, [nextExpiry]);

  return (
    // No-drag so hover can pause the marquee and a reduced-motion user can scroll it. The
    // host sizes to its content, so the rest of the bar's middle stays a drag region.
    <div
      ref={host}
      className="cap-strip-host cth-titlebar-nodrag"
      role="group"
      aria-label="Provider capacity"
      data-cap-strip=""
      data-overflow="false"
      tabIndex={0}
      style={{ fontFamily: 'var(--cth-font-ui)', fontSize: FONT_SIZE, color: 'var(--cth-ink-900)' }}
    >
      <CapacityStripView pools={pools} emptyText={collection?.emptyText ?? CAPACITY_EMPTY_TEXT} />
    </div>
  );
}
