/**
 * COMPOSER-LAG-152 F2: a text field whose value is committed to the store LATER than it is
 * typed. The private note used to call setAgentNote per keystroke, and every call built a
 * new `agents` array (a whole-App render) and persisted the roster (localStorage plus a
 * scheduled mirror write). Now the keystrokes stay in local state and the store sees:
 *   - one commit after typing pauses for `delayMs`,
 *   - an immediate commit on flush() (the caller wires it to blur),
 *   - an immediate commit on unmount (the editor closing: Esc, click-away, the row going),
 *   - an immediate commit on beforeunload (quit / reload).
 * A draft that equals the last committed value is never committed again.
 *
 * On beforeunload, a commit that happened is followed by `afterUnloadCommit`: the store's
 * own roster flush is ALSO a beforeunload listener, registered at module load and so run
 * FIRST (measured; registering ours for the capture phase does not reorder them on window),
 * and a commit after it would only reach the mirror's debounce, which never fires on quit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const DRAFT_COMMIT_DEBOUNCE_MS = 500;

export function useCommittedDraft(
  initial: string,
  commit: (value: string) => void,
  delayMs: number = DRAFT_COMMIT_DEBOUNCE_MS,
  afterUnloadCommit?: () => void
): { draft: string; setDraft: (value: string) => void; flush: () => void } {
  const [draft, setDraftState] = useState(initial);
  const pending = useRef<string | null>(null);
  const committed = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const afterUnloadRef = useRef(afterUnloadCommit);
  afterUnloadRef.current = afterUnloadCommit;

  /** Commit the pending draft now. True when something was committed. */
  const commitNow = useCallback((): boolean => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    const value = pending.current;
    pending.current = null;
    if (value === null || value === committed.current) return false;
    committed.current = value;
    commitRef.current(value);
    return true;
  }, []);
  const flush = useCallback(() => { commitNow(); }, [commitNow]);

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    pending.current = value;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  }, [flush, delayMs]);

  useEffect(() => {
    const onUnload = () => { if (commitNow()) afterUnloadRef.current?.(); };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      commitNow();
    };
  }, [commitNow]);

  return { draft, setDraft, flush };
}
