/**
 * v1.1.45 unit #8 — Settings → General → Capacity display (design of record C2.8).
 *
 * Its own section, directly after Notifications and away from the breaker and budget
 * controls (C2.8: adjacency to a behavioural control would claim a behavioural effect),
 * with its OWN save lifecycle: nothing else on the page saves it, and it saves nothing
 * else.
 *
 * C2.8's input contract: an integer 1-99, no 0 and no off. Invalid input is refused with
 * a message and NEVER replaces the stored value; nothing is clamped. Main validates again
 * and is the one that stores it. The value takes effect on the strip immediately.
 *
 * WORDING (flagged for the human's wording pass): C2.8's canonical line is "Show Weekly
 * capacity below [15] % remaining". The human has since ruled that the same value also
 * gates the reset-time hint of BOTH windows, so that line alone would now under-describe
 * it. This uses a broader line and extends the help text to say both things.
 */
import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import {
  DEFAULT_CAPACITY_DISPLAY_THRESHOLD, capacityDisplayThresholdOf, parseCapacityDisplayThreshold
} from '@shared/capacityThreshold';

export const CAPACITY_DISPLAY_COPY = {
  heading: 'Capacity display',
  title: 'Provider capacity display',
  before: 'Show provider capacity detail below',
  after: '% remaining',
  help: 'Shows the Weekly window, and the expected reset time of the 5h and Weekly windows, in the capacity strip '
    + 'when their remaining capacity falls below this value. Display only: it does not change provider limits, '
    + 'scheduling, routing, circuit breakers, or determine which window is limiting. Weekly is also shown when it '
    + 'is numerically exhausted, when the provider identifies it as limiting, or when its status is unknown.',
  invalid: (current: number) => `Enter a whole number from 1 to 99. The current value (${current}) is unchanged.`
};

/**
 * What pressing "set" (or Enter) does with the field's text. Pure. Invalid input yields
 * a message and NO value: the caller keeps the stored value exactly as it was.
 */
export function decideThresholdCommit(draft: string, stored: number):
  { kind: 'invalid'; message: string } | { kind: 'unchanged' } | { kind: 'save'; value: number } {
  const t = parseCapacityDisplayThreshold(draft);
  if (t === null) return { kind: 'invalid', message: CAPACITY_DISPLAY_COPY.invalid(stored) };
  return t === stored ? { kind: 'unchanged' } : { kind: 'save', value: t };
}

export function CapacityDisplaySetting() {
  const [stored, setStored] = useState<number>(DEFAULT_CAPACITY_DISPLAY_THRESHOLD);
  const [draft, setDraft] = useState<string>(String(DEFAULT_CAPACITY_DISPLAY_THRESHOLD));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.cth.getConfig().then((c) => {
      const t = capacityDisplayThresholdOf(c);
      setStored(t);
      setDraft(String(t));
    }).catch(() => { /* keep the default */ });
  }, []);

  const commit = () => {
    const d = decideThresholdCommit(draft, stored);
    if (d.kind === 'invalid') { setError(d.message); return; }
    setError(null);
    if (d.kind === 'unchanged') return;
    void window.cth.setCapacityDisplayThreshold(d.value).then((c) => {
      const saved = capacityDisplayThresholdOf(c);
      setStored(saved);
      setDraft(String(saved));
    }).catch(() => { setError(CAPACITY_DISPLAY_COPY.invalid(stored)); });
  };

  return (
    <div data-capacity-display-setting="">
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        {CAPACITY_DISPLAY_COPY.heading}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{CAPACITY_DISPLAY_COPY.title}</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--cth-ink-900)' }}>
          {CAPACITY_DISPLAY_COPY.before}
          <input
            data-capacity-threshold=""
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            aria-invalid={error !== null}
            style={{
              width: 48, padding: '2px 6px', fontSize: 13, textAlign: 'right',
              background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
              border: 'none', boxShadow: `inset 0 0 0 1px ${error ? 'var(--cth-status-blocked)' : 'var(--cth-ink-300)'}`
            }}
          />
          {CAPACITY_DISPLAY_COPY.after}
          <PixelButton variant="secondary" size="sm" onClick={commit}>set</PixelButton>
        </label>
        {error && <span role="alert" style={{ fontSize: 12, color: 'var(--cth-status-blocked)' }}>{error}</span>}
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{CAPACITY_DISPLAY_COPY.help}</span>
      </div>
    </div>
  );
}
