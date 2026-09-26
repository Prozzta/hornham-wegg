import type { CSSProperties } from 'react';
import { DRAFT_COMMIT_DEBOUNCE_MS, useCommittedDraft } from '@/hooks/useCommittedDraft';
import { flushRosterNow } from '@/store/store';

/**
 * The focus-mode roster's private-note editor (COMPOSER-LAG-152 F2). Mounted only while the
 * popover is open, so the draft starts from the saved note on every open, and closing the
 * popover (Esc, click-away) unmounts it, which commits the last edit. Keystrokes stay here;
 * the store is written after a pause, on blur, on close and on quit (useCommittedDraft).
 */
export function PrivateNoteTextarea({ note, onCommit, onEscape, ariaLabel, style }: {
  note: string;
  onCommit: (note: string) => void;
  onEscape: () => void;
  ariaLabel: string;
  style: CSSProperties;
}) {
  const { draft, setDraft, flush } = useCommittedDraft(note, onCommit, DRAFT_COMMIT_DEBOUNCE_MS, flushRosterNow);
  return (
    // A textarea, not an input: the note is a bullet list, so Enter has to make a new line
    // rather than doing nothing. autoFocus is safe now that opening is an explicit click,
    // not a pointer fly-by.
    <textarea
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={flush}
      onKeyDown={(e) => {
        e.stopPropagation(); // don't let Esc/typing reach the fullscreen handler
        if (e.key === 'Escape') onEscape();
      }}
      placeholder="one line per bullet…"
      aria-label={ariaLabel}
      style={style}
    />
  );
}
