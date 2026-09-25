/**
 * v1.1.45 CAPUI-MONITOR — one agent's 5h and weekly USAGE, for its Monitor line.
 *
 * Pure: the caller hands in the agent's own pool (the one its readings landed in, from
 * the runtime's mapping) and the time. The figure is USED, computed here, once, as
 * 100 - remaining (the tracker keeps remaining). Anything that is not a fresh, valid
 * reading of that window is TEXT with no figure, so the renderer never draws a fill it
 * cannot vouch for: no reading yet, restored-unconfirmed, stale, not reported, invalid.
 *
 * This is a SEPARATE projection on its own channel (`capacity:agentUsage`). It is not
 * control:snapshot (which must carry no pool data) and not the strip object (whose
 * weekly is absent when hidden): a person chose to watch this agent's window here.
 */
import { applicabilityOf, type PoolCapacitySnapshot, type WindowKind } from '../shared/providerCapacity';
import { isBudgetExempt, validateAgentUsagePush, type AgentUsagePush, type AgentUsageView, type UsageWindowView } from '../shared/agentUsage';
import { formatLocalTime } from './capacityStrip';

const LABEL: Record<'FIVE_HOUR' | 'SEVEN_DAY', string> = { FIVE_HOUR: '5h', SEVEN_DAY: 'Weekly' };

function windowView(
  pool: PoolCapacitySnapshot | null,
  kind: 'FIVE_HOUR' | 'SEVEN_DAY',
  now: number,
  formatTime: (t: number, now: number) => string
): UsageWindowView {
  const label = LABEL[kind];
  if (!pool) return { kind: 'TEXT', text: `${label} · no reading yet` };
  if (pool.stateReason === 'RESTORED_UNCONFIRMED') return { kind: 'TEXT', text: `${label} · no live reading since restart` };
  if (pool.freshness !== 'FRESH') {
    return { kind: 'TEXT', text: `${label} · usage unknown · last update ${formatTime(pool.observedAt, now)}` };
  }
  const w = pool.windows.find((x) => x.kind === (kind as WindowKind) && applicabilityOf(x) === 'APPLICABLE');
  if (!w) return { kind: 'TEXT', text: `${label} · not reported` };
  const r = w.remainingPercent;
  // No repair: anything but a finite 0..100 is unknown, never clamped into a figure.
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 100) return { kind: 'TEXT', text: `${label} · usage unknown` };
  const displayPercent = 100 - Math.floor(r);
  return { kind: 'USAGE', usedPercent: 100 - r, displayPercent, text: `${label} · ${displayPercent}% used`, state: pool.state };
}

export function agentUsageView(
  pool: PoolCapacitySnapshot | null,
  now: number,
  formatTime: (t: number, now: number) => string = formatLocalTime
): AgentUsageView {
  return {
    fiveHour: windowView(pool, 'FIVE_HOUR', now, formatTime),
    weekly: windowView(pool, 'SEVEN_DAY', now, formatTime)
  };
}

// ─── v1.1.45 unit #13: main PUSHES the usage rows (crit 15: no renderer polling) ─────────

/**
 * The rows to push: one per agent whose PERSISTED display is 5H or Weekly, in agent-id
 * order, each the same view the mount-time invoke answers. A Budget agent has no row, so
 * nothing is read or sent for it. Keyed by agent id only; no pool identity is included.
 */
export function agentUsagePushOf(
  displays: Record<string, unknown> | undefined,
  poolOf: (agentId: string) => PoolCapacitySnapshot | null,
  now: number
): AgentUsagePush {
  const ids = Object.keys(displays ?? {}).filter((id) => isBudgetExempt(displays?.[id])).sort();
  return { rows: ids.map((agentId) => ({ agentId, view: agentUsageView(poolOf(agentId), now) })) };
}

/**
 * Sends a push only when the ROWS changed. The key is the rows themselves, NOT the strip's
 * collectionRevision: the strip and the usage line are two integer-rounded projections that
 * move independently, so a shared revision would drop real usage updates (and send
 * duplicates when only the strip moved).
 */
export class AgentUsagePushGate {
  private last: string | null = null;
  /** The push to send, or null when it is unchanged or fails its own schema. */
  next(push: AgentUsagePush): AgentUsagePush | null {
    const errors = validateAgentUsagePush(push);
    if (errors.length) { console.warn('[capacity-usage] push refused:', errors.slice(0, 3).join('; ')); return null; }
    const key = JSON.stringify(push.rows);
    if (key === this.last) return null;
    this.last = key;
    return push;
  }
}
