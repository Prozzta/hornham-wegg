/**
 * v1.1.45 unit #2 — THE title-bar capacity strip (design of record §1, §3, §9, §10,
 * C2.2, C2.4, C2.6, C2.7, C2.10, C2.11 crit 1-2 and 14-15).
 *
 * One inline group per pool, in the middle run of the 36px title bar: provider mark,
 * pool label, a state word with a NON-COLOUR token, then the windows. Every string is
 * main's. This file picks which of main's strings to draw at the current width
 * (stripLayout.ts) and gives each one a shape. It composes no wording, derives no
 * state, and has no IPC of its own: it reads the one mirror through the one selector
 * family and applies the one-way expiry mask (presentPool).
 *
 * GEOMETRY IS LOAD-BEARING (§9). Capacity is a CONTINUOUS meter; the agent context
 * gauge is SEGMENTED. This file draws no segments, and a test pins that it never does.
 *
 * NEVER REFLOWS THE CHROME (C2.10). The strip is a fixed 36px row that wraps whole
 * tokens onto a hidden second line rather than growing, so a capacity change cannot
 * resize the office canvas below it.
 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import type { CapacityState } from '@shared/providerCapacity';
import { ProviderLogo } from './ProviderLogo';
import { presentPool, selectPools, type PresentedPool } from '../capacity/capacityStrip';
import { useCapacityStrip } from '../capacity/useCapacityStrip';
import { chooseCollapseLevel, poolTokens, STRIP_GEOMETRY, type CollapseLevel, type StripToken } from '../capacity/stripLayout';

/**
 * The non-colour channel (§9): a SHAPE per state, so the state survives greyscale and
 * colour blindness. The state WORD beside it is main's; the token is aria-hidden.
 */
export const STATE_TOKEN: Record<CapacityState, string> = {
  AVAILABLE: '●',
  APPROACHING: '▲',
  RESERVE_ONLY: '◐',
  LIMITED: '■',
  RECOVERING: '↻',
  UNKNOWN: '◌'
};

/** State colour. Never the only channel; UNKNOWN is deliberately NOT the healthy colour. */
export const STATE_COLOR: Record<CapacityState, string> = {
  AVAILABLE: 'var(--cth-status-success)',
  APPROACHING: 'var(--cth-status-waiting)',
  RESERVE_ONLY: 'var(--cth-status-waiting)',
  LIMITED: 'var(--cth-status-blocked)',
  RECOVERING: 'var(--cth-status-thinking)',
  UNKNOWN: 'var(--cth-status-ghost)'
};

const FONT_SIZE = 12;

/** A continuous capacity meter. Drawn only for a figure main sent a meter with. */
function Meter({ token, state }: { token: Extract<StripToken, { kind: 'meter' }>; state: CapacityState }) {
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={token.meter.remainingPercent}
      aria-valuetext={token.valueText}
      data-cap-meter={token.role}
      style={{
        display: 'inline-block', position: 'relative', flexShrink: 0,
        width: STRIP_GEOMETRY.meter, height: 6, borderRadius: 3,
        background: 'var(--cth-paper-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', overflow: 'hidden'
      }}
    >
      <span style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: `${token.meter.remainingPercent}%`, background: STATE_COLOR[state]
      }} />
    </span>
  );
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

/** One pool's group. Whole tokens wrap onto the hidden line; none is ever cut. */
function PoolGroup({ pool, level }: { pool: PresentedPool; level: CollapseLevel }) {
  return (
    <span
      role="group"
      aria-label={pool.poolLabel}
      data-cap-pool={pool.poolId}
      data-cap-presentation={pool.presentation}
      style={{
        display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', alignContent: 'flex-start',
        columnGap: STRIP_GEOMETRY.gap, height: 36, overflow: 'hidden', minWidth: 0, flexShrink: 1
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', height: 36, flexShrink: 0 }}>
        <ProviderLogo provider={pool.provider} size={STRIP_GEOMETRY.mark} />
      </span>
      <span style={{ color: 'var(--cth-ink-700)', whiteSpace: 'nowrap', lineHeight: '36px' }}>{pool.poolLabel}</span>
      <span style={{ whiteSpace: 'nowrap', lineHeight: '36px', color: 'var(--cth-ink-900)' }}>
        <span aria-hidden="true" data-cap-state-token={pool.state}
          style={{ color: STATE_COLOR[pool.state], marginRight: 4, display: 'inline-block', width: STRIP_GEOMETRY.stateToken }}>
          {STATE_TOKEN[pool.state]}
        </span>
        {pool.stateText}
      </span>
      {poolTokens(pool, level).map((t) => (
        <span key={t.key} style={{ display: 'inline-flex', alignItems: 'center', height: 36, flexShrink: 0 }}>
          <Token token={t} state={pool.state} />
        </span>
      ))}
    </span>
  );
}

/**
 * The strip for a given set of presented pools at a given collapse level. Pure:
 * rendered by the connected component below, and render-tested on its own.
 */
export function CapacityStripView({ pools, level }: { pools: readonly PresentedPool[]; level: CollapseLevel }) {
  if (!pools.length) return null;
  return (
    <>
      {pools.map((p) => <PoolGroup key={p.poolId} pool={p} level={level} />)}
    </>
  );
}

/** Canvas text measurement in the strip's own font, for the collapse decision. */
function useMeasure(host: RefObject<HTMLElement>): (text: string) => number {
  return useMemo(() => {
    let ctx: CanvasRenderingContext2D | null = null;
    return (text: string) => {
      if (!ctx && typeof document !== 'undefined') {
        ctx = document.createElement('canvas').getContext('2d');
        if (ctx && host.current) ctx.font = getComputedStyle(host.current).font || `${FONT_SIZE}px sans-serif`;
      }
      return ctx ? ctx.measureText(text).width : text.length * FONT_SIZE * 0.6;
    };
  }, [host]);
}

/**
 * The connected strip. Re-renders when main pushes, when the host resizes, and ONCE
 * at the soonest `expiresAt` among the pools (so the one-way mask fires on time):
 * a single timer armed from main's own deadline, never a poll.
 */
export function CapacityStrip() {
  const collection = useCapacityStrip();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const measure = useMeasure(host);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
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

  const level = chooseCollapseLevel(pools, width, measure);
  return (
    <div
      ref={host}
      role="group"
      aria-label="Provider capacity"
      data-cap-strip=""
      data-cap-level={level}
      style={{
        flex: '1 1 auto', minWidth: 0, height: 36, overflow: 'hidden',
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', alignContent: 'flex-start',
        columnGap: STRIP_GEOMETRY.poolGap,
        fontFamily: 'var(--cth-font-ui)', fontSize: FONT_SIZE
      }}
    >
      <CapacityStripView pools={pools} level={level} />
    </div>
  );
}
