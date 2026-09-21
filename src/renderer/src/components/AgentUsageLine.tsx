/**
 * v1.1.45 CAPUI-MONITOR — the first Monitor line for a Claude or Codex agent: a choice of
 * Budget (default) / 5H / Weekly, and, for 5H or Weekly, that window's USAGE.
 *
 * Main decides everything that is a fact: the figure (used = 100 - remaining, computed in
 * main), whether there is one at all (no reading / stale / not reported come back as
 * TEXT), and what the choice MEANS (5H / Weekly exempt the agent from the budget, applied
 * by the breaker). This file only offers the choice and draws main's answer, with the
 * strip's own meter so it cannot be confused with the 96x8 budget or context bars.
 */
import { useEffect, useState } from 'react';
import type { AgentUsageDisplay, UsageWindowView } from '@shared/agentUsage';
import { CapacityMeter, STATE_COLOR } from './CapacityStrip';

/** The three choices (UI chrome, not capacity wording); the tooltip states the budget consequence. */
export const USAGE_DISPLAY_OPTIONS: { value: AgentUsageDisplay; label: string }[] = [
  { value: 'budget', label: 'budget' },
  { value: 'fiveHour', label: '5H' },
  { value: 'weekly', label: 'Weekly' }
];

export const USAGE_SELECT_TITLE =
  'What this line shows. budget: this agent\'s token budget, and the Settings budget limits apply. '
  + '5H / Weekly: that provider window\'s usage instead, and this agent is OUTSIDE the budget '
  + '(its token limit does not apply and it is not counted in the floor budget). '
  + 'Provider capacity limits still apply either way.';

export function AgentUsageSelect({ value, onChange }: { value: AgentUsageDisplay; onChange: (v: AgentUsageDisplay) => void }) {
  return (
    <select
      data-usage-select=""
      value={value}
      title={USAGE_SELECT_TITLE}
      onChange={(e) => onChange(e.target.value as AgentUsageDisplay)}
      style={{
        fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-700)',
        background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        padding: '0 2px', height: 16, flexShrink: 0
      }}
    >
      {USAGE_DISPLAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** One window's usage as main answered it: a meter + figure, or text alone (no fill). */
export function UsageWindowFigure({ view }: { view: UsageWindowView | null }) {
  if (!view) {
    return <span data-usage-text="" style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-300)' }}>…</span>;
  }
  if (view.kind === 'TEXT') {
    return <span data-usage-text="" style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{view.text}</span>;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <CapacityMeter percent={view.usedPercent} valueText={view.text} color={STATE_COLOR[view.state]} dataRole="usage" />
      <span data-usage-figure="" style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)' }}>{view.text}</span>
    </span>
  );
}

const USAGE_POLL_MS = 5000;

/**
 * Main's usage answer for one agent's chosen window, read on the capacity:agentUsage
 * channel while the line shows 5H or Weekly (and not at all under Budget).
 */
export function useAgentUsageWindow(agentId: string, display: AgentUsageDisplay): UsageWindowView | null {
  const [view, setView] = useState<UsageWindowView | null>(null);
  useEffect(() => {
    if (display === 'budget') { setView(null); return; }
    let alive = true;
    const read = () => {
      window.cth.capacityAgentUsage(agentId)
        .then((u) => { if (alive) setView(u ? (display === 'fiveHour' ? u.fiveHour : u.weekly) : null); })
        .catch(() => { if (alive) setView(null); });
    };
    read();
    const iv = setInterval(read, USAGE_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId, display]);
  return view;
}

/** The 5H / Weekly form of the line (the Budget form stays the panel's own markup). */
export function AgentUsageWindow({ agentId, display }: { agentId: string; display: AgentUsageDisplay }) {
  return <UsageWindowFigure view={useAgentUsageWindow(agentId, display)} />;
}
