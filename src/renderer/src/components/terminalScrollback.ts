/**
 * ACTIVITY-LAG-151: lines of scrollback per pooled terminal.
 *
 * Was 100,000 (upstream 81d5f759, "survive wake-resize reflow"). Every agent's xterm lives
 * for the whole session and receives every byte, and Codex appends its WHOLE transcript
 * to scrollback on each replay without ever clearing it. Measured by Jim, 3 pooled
 * terminals x 5 replays of 3 MB: +450 MB renderer private bytes at 100k against +56 MB at
 * 10k. Reflow and resize also walk the whole buffer. 10,000 lines is still far more history
 * than anyone scrolls back through in a terminal pane; the full record lives in the agent's
 * transcript either way.
 */
export const TERMINAL_SCROLLBACK_LINES = 10_000;
