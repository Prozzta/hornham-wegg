/**
 * v1.1.45 unit #5 — a status badge that shows main's impact instead of "idle" while a
 * hold is real, plus (optionally) the full impact string beside it. For the Command
 * Center rows; the agent card places the same two pieces in its own layout.
 */
import type { CSSProperties } from 'react';
import { PixelBadge, type StatusKind } from './PixelBadge';
import { impactBadge } from './agentImpactView';
import { useAgentImpact } from '../hooks/useAgentImpact';

export function AgentImpactBadge({ agentId, status, showText = false, style }: {
  agentId: string;
  status: StatusKind;
  showText?: boolean;
  style?: CSSProperties;
}) {
  const view = impactBadge(status, useAgentImpact(agentId));
  return (
    <>
      <PixelBadge status={view.status} label={view.label} style={style} />
      {showText && view.impactText && (
        <span data-agent-impact="" style={{
          fontSize: 11, color: 'var(--cth-ink-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0
        }}>{view.impactText}</span>
      )}
    </>
  );
}
