import type { IBuffer } from '@xterm/xterm';

// The cursor can be on a continuation xterm row even when a TUI chose to emit
// explicit newlines rather than letting xterm set isWrapped.  Start at the
// composer prompt marker and read through the cursor instead of treating
// isWrapped as the only continuation signal.
const COMPOSER_LOOKBACK_ROWS = 128;
const TUI_EDGE = /^[\s|\u2502\u2503\u2551\u2506\u254e]+|[\s|\u2502\u2503\u2551\u2506\u254e]+$/g;
const PROMPT_MARKER = /^(?:[\s|\u2502\u2503\u2551\u2506\u254e]*)(?:>|\u276f|\u203a)\s?(.*)$/;

function unframeComposerRow(row: string): string {
  return row.replace(TUI_EDGE, '');
}

function promptText(row: string): string | null {
  const marked = row.match(PROMPT_MARKER);
  return marked ? unframeComposerRow(marked[1]) : null;
}

export function normalizeComposerText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function compactComposerText(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * Attest the visible composer region, from its prompt marker through the
 * cursor row. This deliberately does not depend on IBufferLine.isWrapped:
 * Ink and ratatui can render a multi-row editor with explicit line breaks.
 */
export function composerRegionEndsWith(buffer: IBuffer, cursorAbsoluteY: number, expectedTail: string): boolean {
  const expected = normalizeComposerText(expectedTail);
  if (!expected) return false;
  const compactExpected = compactComposerText(expectedTail);
  const first = Math.max(0, cursorAbsoluteY - COMPOSER_LOOKBACK_ROWS);
  for (let start = cursorAbsoluteY; start >= first; start -= 1) {
    const prompt = buffer.getLine(start);
    if (!prompt) continue;
    const firstText = promptText(prompt.translateToString(false));
    if (firstText === null) continue;
    const rows = [firstText];
    for (let y = start + 1; y <= cursorAbsoluteY; y += 1) {
      const row = buffer.getLine(y);
      if (!row) break;
      rows.push(unframeComposerRow(row.translateToString(false)));
    }
    const observed = rows.join('\n');
    // TUIs can hard-wrap an opaque inbox id in the middle of the token. Its inserted
    // newline is layout whitespace, not an edit; compare the compact form as well.
    return normalizeComposerText(observed).endsWith(expected)
      || compactComposerText(observed).endsWith(compactExpected);
  }
  return false;
}
