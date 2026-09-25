/**
 * v1.1.45 CAPUI-MONITOR — what an agent's first Monitor line shows, and what that choice
 * means for the budget.
 *
 * The human's rules (confirmed 2026-09-21): for a Claude or Codex agent the line is a
 * choice of Budget (the default), 5H or Weekly. Choosing 5H or Weekly shows that
 * provider window's USAGE instead of the token budget, and EXEMPTS the agent from the
 * Settings budget limits. It adds no new cap: the L0 capacity gating is unchanged.
 * Choosing Budget puts the agent back under the limits. The choice persists per agent.
 *
 * Exempt means FULLY outside the budget subsystem (god's floor-blame ruling): the
 * breaker's three budget arms skip the agent, and the floor totals they compare against
 * are summed over non-exempt agents only. The behaviour-safety arms (looping, error
 * storm, velocity, no-progress) still apply to every agent.
 */

export const AGENT_USAGE_DISPLAYS = ['budget', 'fiveHour', 'weekly'] as const;
export type AgentUsageDisplay = (typeof AGENT_USAGE_DISPLAYS)[number];

/** Providers that report 5h / weekly windows. Every other provider keeps the plain budget line. */
export const USAGE_WINDOW_PROVIDERS = ['claude', 'codex'] as const;

export const isAgentUsageDisplay = (v: unknown): v is AgentUsageDisplay =>
  typeof v === 'string' && (AGENT_USAGE_DISPLAYS as readonly string[]).includes(v);

/**
 * Is this agent outside the budget limits? Only an explicit 5H or Weekly choice exempts;
 * absent, 'budget' and anything unrecognised all mean "under the budget". A malformed
 * config value must never silently switch a limit off.
 */
export function isBudgetExempt(display: unknown): boolean {
  return display === 'fiveHour' || display === 'weekly';
}

// ─── The usage projection main returns on `capacity:agentUsage` ─────────────────────────

/** Invoke channel: one agent's 5h + weekly usage. Its OWN channel, never control:snapshot. */
export const CAPACITY_AGENT_USAGE = 'capacity:agentUsage';

/** A drawn usage figure: USED, computed in main as 100 - remaining. */
export interface UsageFigure {
  kind: 'USAGE';
  /** Full precision, 0..100. */
  usedPercent: number;
  /** Rounded UP, so usage is never understated (and it pairs with the strip's rounded-down remaining). */
  displayPercent: number;
  /** Main-owned, e.g. `5h · 20% used`. */
  text: string;
  /** The pool's tracker state, for the bar colour (the strip's own colour for that state). */
  state: 'UNKNOWN' | 'AVAILABLE' | 'APPROACHING' | 'RESERVE_ONLY' | 'LIMITED' | 'RECOVERING';
}

/** No figure to draw: text only, no fill (no reading yet, stale, not reported). */
export interface UsageText {
  kind: 'TEXT';
  text: string;
}

export type UsageWindowView = UsageFigure | UsageText;

export interface AgentUsageView {
  fiveHour: UsageWindowView;
  weekly: UsageWindowView;
}

// ─── Runtime schema (additionalProperties:false), run by main before it answers ─────────

const USAGE_STATES = ['UNKNOWN', 'AVAILABLE', 'APPROACHING', 'RESERVE_ONLY', 'LIMITED', 'RECOVERING'];

function windowErrors(v: unknown, at: string): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${at}: not an object`];
  const o = v as Record<string, unknown>;
  const allowed = o.kind === 'USAGE' ? ['kind', 'usedPercent', 'displayPercent', 'text', 'state'] : ['kind', 'text'];
  const errors = Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${at}.${k}: property not allowed`);
  if (o.kind !== 'USAGE' && o.kind !== 'TEXT') errors.push(`${at}.kind: not USAGE|TEXT`);
  if (typeof o.text !== 'string' || !o.text || o.text.length > 120) errors.push(`${at}.text: not display text`);
  if (o.kind === 'USAGE') {
    const u = o.usedPercent;
    const d = o.displayPercent;
    if (typeof u !== 'number' || !Number.isFinite(u) || u < 0 || u > 100) errors.push(`${at}.usedPercent: not 0..100`);
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 100 || (typeof u === 'number' && d < u)) {
      errors.push(`${at}.displayPercent: must be the used figure rounded UP`);
    }
    if (typeof o.state !== 'string' || !USAGE_STATES.includes(o.state)) errors.push(`${at}.state: not a capacity state`);
  }
  return errors;
}

/** Validate a usage view. Empty = valid. Anything else is refused whole. */
export function validateAgentUsageView(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['$: not an object'];
  const o = v as Record<string, unknown>;
  const errors = Object.keys(o).filter((k) => k !== 'fiveHour' && k !== 'weekly').map((k) => `$.${k}: property not allowed`);
  return [...errors, ...windowErrors(o.fiveHour, '$.fiveHour'), ...windowErrors(o.weekly, '$.weekly')];
}

// ─── v1.1.45 unit #13: the usage line is PUSHED by main (crit 15: no renderer polling) ───

/** Push channel: every 5H / Weekly agent's usage, on its OWN channel (never control:snapshot). */
export const CAPACITY_AGENT_USAGE_PUSH = 'capacity:agentUsagePush';

/** One agent's row. The agent id is the only key; no pool identity crosses the bridge. */
export interface AgentUsageRow { agentId: string; view: AgentUsageView }

/** The complete set of rows for every agent whose persisted display is 5H or Weekly. */
export interface AgentUsagePush { rows: AgentUsageRow[] }

/** Validate a push. Empty = valid. Anything else is refused whole. */
export function validateAgentUsagePush(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['$: not an object'];
  const o = v as Record<string, unknown>;
  const errors = Object.keys(o).filter((k) => k !== 'rows').map((k) => `$.${k}: property not allowed`);
  if (!Array.isArray(o.rows)) return [...errors, '$.rows: not an array'];
  const seen = new Set<string>();
  o.rows.forEach((r, i) => {
    const at = `$.rows[${i}]`;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) { errors.push(`${at}: not an object`); return; }
    const row = r as Record<string, unknown>;
    for (const k of Object.keys(row)) if (k !== 'agentId' && k !== 'view') errors.push(`${at}.${k}: property not allowed`);
    if (typeof row.agentId !== 'string' || row.agentId.length === 0) errors.push(`${at}.agentId: not a non-empty string`);
    else if (seen.has(row.agentId)) errors.push(`${at}.agentId: duplicate`);
    else seen.add(row.agentId);
    errors.push(...validateAgentUsageView(row.view).map((e) => e.replace(/^\$/, `${at}.view`)));
  });
  return errors;
}
