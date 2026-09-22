/**
 * v1.1.45 unit #6 — the LIMITED entry banner (design of record §11, C2.12 rule 3).
 *
 * A small DOM overlay over the office, shown when a pool ENTERS LIMITED. It is driven by
 * the one notice lifecycle main already runs (#1): the CapacityNotifier decides the entry
 * (at most once per limit episode, and a first sighting after a restart is only a
 * baseline), and the presenter records a dismissal in MAIN. So the banner never repeats
 * for an unchanged state and never replays on a reload. It retires by itself when the pool
 * leaves LIMITED.
 *
 * NO FIGURE (C2.12 rule 3): it names the state, the cause and the consequence, all in
 * main's words, and leaves the number to the strip row that is on screen with it.
 */
import { useCapacityStrip, dismissCapacityNotice } from '../capacity/useCapacityStrip';
import { selectLimitBanners } from '../capacity/capacityStrip';
import { StateDot } from './CapacityStrip';
import type { CapacityBanner } from '@shared/capacityStrip';

export interface BannerItem { poolId: string; noticeId: string; banner: CapacityBanner }

/** The banners for these items. Pure: rendered by the connected banner and by tests. */
export function CapacityLimitBannerView({ items, onDismiss }: { items: readonly BannerItem[]; onDismiss: (noticeId: string) => void }) {
  if (!items.length) return null;
  return (
    <div data-cap-banners="" style={{
      position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 44,
      display: 'flex', flexDirection: 'column', gap: 6, width: 'min(520px, calc(100% - 32px))'
    }}>
      {items.map((it) => (
        <div
          key={it.noticeId}
          role="status"
          data-cap-banner={it.poolId}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px',
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1.5px var(--cth-status-blocked)',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
          }}
        >
          <span style={{ paddingTop: 1 }}><StateDot look={{ kind: 'STOP' }} state="LIMITED" name={it.banner.title} /></span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{it.banner.title}</span>
            <span style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>{it.banner.cause}</span>
            <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{it.banner.consequence}</span>
          </span>
          <button
            type="button"
            data-cap-banner-dismiss=""
            aria-label="Dismiss"
            onClick={() => onDismiss(it.noticeId)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: 'var(--cth-ink-500)', padding: 0 }}
          >×</button>
        </div>
      ))}
    </div>
  );
}

/** The connected banner. The dismissal is recorded in main; the banner clears on main's push. */
export function CapacityLimitBanner() {
  const items = selectLimitBanners(useCapacityStrip());
  return <CapacityLimitBannerView items={items} onDismiss={(id) => { void dismissCapacityNotice(id); }} />;
}
