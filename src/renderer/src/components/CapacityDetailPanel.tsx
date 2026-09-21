/**
 * v1.1.45 unit #4 — THE provider details panel (design of record §12, C2.9): the one
 * canonical place a pool is shown in full. Opened by clicking a pool in the title-bar strip
 * (or the link in Settings → Capacity display).
 *
 * It renders main's SEPARATE detail projection (capacity:detail), never the strip object:
 * every window the pool has, weekly and any model-specific one included, with its figure,
 * its reset expectation and any relationship main knows about it; the freshness verdict;
 * who shares the pool, or "Membership unknown"; and the source. No credentials, account
 * ids or pool keys exist in what it is given.
 *
 * LIFECYCLE (C2.9, crit 17). The view is asked for only while the panel is open, re-asked
 * whenever the strip's collection revision moves (so it stays at the same domain truth),
 * and DROPPED on close, on a switch to another pool, and when the pool leaves the
 * collection. Nothing is cached across a reload: the component starts empty.
 */
import { useEffect, useState } from 'react';
import type { ProviderCapacityDetailView } from '@shared/capacityDetail';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { CapacityDetailBody } from './CapacityDetailBody';
import { useCapacityStrip } from '../capacity/useCapacityStrip';
import { selectPool } from '../capacity/capacityStrip';
import { closeCapacityDetail, useOpenCapacityDetail } from '../capacity/detailSelection';
import { useStore } from '@/store/store';

/** The connected overlay. Renders nothing while closed. */
export function CapacityDetailPanel() {
  const poolId = useOpenCapacityDetail();
  const collection = useCapacityStrip();
  const agents = useStore((s) => s.agents);
  const [view, setView] = useState<ProviderCapacityDetailView | null>(null);
  const revision = collection?.collectionRevision ?? null;
  // A pool that left the collection cannot keep a panel open (crit 17).
  const gone = poolId !== null && collection !== null && selectPool(collection, poolId) === null;

  useEffect(() => { if (gone) closeCapacityDetail(); }, [gone]);

  useEffect(() => {
    setView(null);                                  // a switch never shows the previous pool
    if (poolId === null) return;
    let alive = true;
    window.cth.capacityDetail(poolId)
      .then((v) => { if (alive) setView(v && v.poolId === poolId ? v : null); })
      .catch(() => { if (alive) setView(null); });
    return () => { alive = false; };
  }, [poolId, revision]);

  if (poolId === null || gone) return null;
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <div data-cap-detail-panel="" style={{ position: 'absolute', top: 12, right: 12, width: 340, zIndex: 45 }}>
      <PixelPanel variant="dialog" title={view ? `${view.poolLabel.toUpperCase()} · PROVIDER DETAILS` : 'PROVIDER DETAILS'} noPadding>
        {view
          ? <CapacityDetailBody view={view} agentName={nameOf} />
          : <div style={{ padding: 14, fontSize: 12, color: 'var(--cth-ink-500)' }}>…</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 14px 12px' }}>
          <PixelButton variant="secondary" size="sm" onClick={() => { setView(null); closeCapacityDetail(); }}>close</PixelButton>
        </div>
      </PixelPanel>
    </div>
  );
}
