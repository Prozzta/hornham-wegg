/**
 * v1.1.45 unit #4 — the provider details panel BODY: one detail view, rendered. Pure (no
 * store, no IPC), so it can be render-tested; the connected overlay is CapacityDetailPanel.
 */
import type { ProviderCapacityDetailView } from '@shared/capacityDetail';
import { CapacityMeter, STATE_COLOR, StateDot } from './CapacityStrip';
import { detailDotOf } from '../capacity/pieDot';

/** The panel body for one detail view. Pure: rendered by the connected panel and by tests. */
export function CapacityDetailBody({ view, agentName }: {
  view: ProviderCapacityDetailView;
  agentName: (agentId: string) => string;
}) {
  const muted = { fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: 1.5 } as const;
  return (
    <div data-cap-detail={view.poolId} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--cth-ink-900)' }}>
        <StateDot look={detailDotOf(view)} state={view.state} name={view.stateText} />
        <span data-cap-detail-state="">{view.stateText}</span>
      </div>
      {view.freshness.ageText && (
        <div data-cap-detail-age="" style={{ ...muted, color: 'var(--cth-ink-700)' }}>{view.freshness.ageText}</div>
      )}
      {view.statusNote && <div data-cap-detail-status="" style={muted}>{view.statusNote}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {view.windows.map((w, i) => (
          <div key={`${w.kind}-${i}`} data-cap-detail-window={w.kind} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cth-ink-900)' }}>
              {w.remainingPercent !== undefined && (
                <CapacityMeter percent={w.remainingPercent} valueText={w.text} color={STATE_COLOR[view.state]} dataRole="detail" />
              )}
              <span>{w.text}</span>
            </span>
            {w.note && <span data-cap-detail-note="" style={{ ...muted, color: 'var(--cth-ink-700)' }}>{w.note}</span>}
            {w.resetText && <span style={muted}>{w.resetText}</span>}
          </div>
        ))}
      </div>

      <div style={muted}>{view.freshness.text}</div>
      <div style={muted}>
        <span data-cap-detail-membership="">{view.membership.text}</span>
        {view.membership.agentIds.length > 0 && <>: {view.membership.agentIds.map(agentName).join(', ')}</>}
      </div>
      <div style={muted}>Source: {view.sourceText}</div>
    </div>
  );
}
