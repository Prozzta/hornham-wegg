/**
 * SCENARIO — the two preconditions that make a TUI measurement mean anything, and
 * a production hazard that falls out of the first.
 *
 * BOTH OF THESE WERE PAID FOR BY A VOID RUN. Andy's whole clear/erase matrix was
 * discarded because every row measured a first-run trust dialog instead of an input
 * box, and because a "reaction" to Ctrl-U turned out to be the same repaint frame a
 * harmless arrow key produces. Neither failure announces itself: both produce a
 * PASSING row. So they belong in the instrument, where they cost one run to find and
 * nothing thereafter, rather than in a checklist someone has to remember.
 *
 *   1. A TRUST MODAL IS NOT AN INPUT BOX. A fresh cwd is an untrusted cwd, so all
 *      three installed TUIs open on "do you trust this folder?". Measuring "the box
 *      is empty and nothing was submitted" against a dialog that HAS no box answers
 *      a question nobody asked. The harness must REFUSE, not report.
 *   2. A FALSIFIER WITH NO CONTROL PASSES ON EVERYTHING. Any claim that a key did
 *      something must be paired with a key that should do nothing. If the two
 *      reactions are identical, what was observed is a repaint, not an effect.
 *
 * The bytes below are the real boot tails, quoted from the void run rather than
 * invented, so the detector is matched against what these programs actually print.
 */
import { acquireTerminal, attachTerminal, hasTerminalDraft, disposeTerminal } from '../../../src/renderer/src/components/terminalPool';
import { terminalAutomationBlockFor } from '../../../src/renderer/src/components/terminalPool';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
    cth: Record<string, unknown>;
  }
}

function installBridgeStub(): void {
  const unsub = () => () => { /* nothing subscribed */ };
  window.cth = {
    onPtyData: unsub(), onPtyExit: unsub(), onPtyRelaunch: unsub(),
    writePty: () => { /* no pty */ }, redrawPty: () => { /* no pty */ },
    resizePty: () => { /* no pty */ }, copyToClipboard: () => { /* unused */ },
    readClipboard: () => Promise.resolve(''), readClipboardSync: () => '',
    statAbs: () => Promise.resolve(null), revealPath: () => Promise.resolve()
  };
}

const write = (term: { write: (d: string, cb?: () => void) => void }, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, () => resolve()));

/** The real first-run trust screens, as the three installed TUIs print them. */
const TRUST_SCREENS: Record<string, string> = {
  claude: '\x1b[2J\x1b[H Do you trust the files in this folder?\r\n\r\n   Yes, I trust this folder\r\n   Enter to confirm - Esc to cancel\r\n',
  codex: '\x1b[2J\x1b[H You are running Codex in a new folder.\r\n\r\n   1. Yes, continue\r\n   2. No, quit\r\n',
  agy: '\x1b[2J\x1b[H Trust this workspace?\r\n\r\n   Yes, I trust this folder\r\n   No\r\n'
};

/** An ordinary prompt box - the thing a measurement is actually entitled to read. */
const PROMPT_BOX = [
  '\x1b[2J\x1b[H',
  '╭──────────────────────────────────────╮\r\n',
  '│ ❯                                    │\r\n',
  '╰──────────────────────────────────────╯\r\n',
  '\x1b[2;1H'
].join('');

/**
 * Is the screen a first-run trust dialog rather than an input surface?
 *
 * TEST-SIDE ON PURPOSE. This is a precondition on a MEASUREMENT, not a fix: adding a
 * detector to production would be implementing a remedy nobody has asked for, on a
 * hazard that has not been designed yet. It lives here so the harness can refuse to
 * report, and the production gap is reported rather than quietly patched.
 *
 * Matched on the CONSENT AFFORDANCE rather than on the word "trust": what makes it a
 * dialog is that it is offering a choice about proceeding, and a prompt box never
 * does. Matching the word alone would also fire on an agent discussing trust.
 */
function looksLikeTrustDialog(screen: string): boolean {
  const s = screen.toLowerCase();
  const consent = [
    'yes, i trust this folder',
    '1. yes, continue',
    'enter to confirm',
    'trust the files in this folder',
    'trust this workspace'
  ];
  return consent.some((c) => s.includes(c));
}

function fullScreen(entry: { term: { rows: number; buffer: { active: any } } }): string {
  const buf = entry.term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < entry.term.rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    if (line) out.push(line.translateToString(true));
  }
  return out.join('\n');
}

window.__harnessRun = async () => {
  const result: Record<string, unknown> = {};
  try {
    installBridgeStub();
    const root = document.getElementById('root')!;
    const entry = acquireTerminal('tui');
    attachTerminal(entry, root);

    // ── 1. Every installed TUI opens on a dialog, and the harness must refuse ──
    const trust: Record<string, unknown> = {};
    for (const [name, frame] of Object.entries(TRUST_SCREENS)) {
      await write(entry.term, frame);
      const screen = fullScreen(entry);
      trust[name] = {
        detectedAsDialog: looksLikeTrustDialog(screen),
        // What a measurement WOULD have reported had it not refused. Recorded so
        // the cost of skipping the precondition is visible rather than argued.
        naiveHasDraft: hasTerminalDraft('tui', Date.now() + 5_000),
        // AND THE PRODUCTION HAZARD: nothing in the app's automation block knows a
        // modal owns the screen. `opensInteractiveTerminalUi` matches what the USER
        // TYPED against a set of slash-commands; a first-run dialog is opened by the
        // PROGRAM, so no input ever passes through that check and the block cannot
        // latch. This is the precondition for text being swallowed by the modal.
        automationBlock: terminalAutomationBlockFor('tui', Date.now() + 5_000) ?? null
      };
    }
    result.trustScreens = trust;

    // A real prompt box must NOT trip the detector, or it refuses everything and
    // the precondition becomes a way of never measuring anything.
    await write(entry.term, PROMPT_BOX);
    result.promptBoxIsNotADialog = looksLikeTrustDialog(fullScreen(entry)) === false;

    // ── 2. The control. A reaction with nothing to compare it against ──────────
    // A TUI that repaints its frame on ANY key looks like it "reacted" to Ctrl-U.
    // Codex really does this: the same 16 bytes for Ctrl-U as for an arrow key.
    const REPAINT = '\x1b[2;1H\x1b[K│ ❯ │';
    /**
     * EACH REACTION IS MEASURED FROM THE SAME BASELINE, and that is not fussiness.
     * Measuring them in sequence made the SECOND key look inert - the first had
     * already applied the repaint, so the screen no longer moved. Read carelessly
     * that says "the arrow did nothing, so Ctrl-U's change was real", which is the
     * exact wrong conclusion the control exists to prevent. An order artifact that
     * happens to support the conclusion is worse than no control at all.
     */
    const reactionTo = async (key: string) => {
      await write(entry.term, PROMPT_BOX); // reset to a known screen first
      const before = fullScreen(entry);
      entry.term.input(key);
      await write(entry.term, REPAINT); // what this TUI emits for ANY key
      return { key, changed: fullScreen(entry) !== before, screen: fullScreen(entry) };
    };
    const ctrlU = await reactionTo('\x15');
    const arrow = await reactionTo('\x1b[C'); // right arrow: should do nothing
    result.control = {
      ctrlUChanged: ctrlU.changed,
      arrowChanged: arrow.changed,
      // THE DISCRIMINATOR. Identical reactions mean a repaint was observed, not an
      // effect. Without the control key, `ctrlUChanged` alone reads as a pass.
      identicalReaction: ctrlU.screen === arrow.screen,
      verdict: ctrlU.screen === arrow.screen ? 'REPAINT_NOT_EFFECT' : 'REAL_EFFECT'
    };

    disposeTerminal('tui');
    window.harness.report({ ok: true, ...result });
  } catch (e) {
    window.harness.report({ ok: false, error: String((e as Error)?.stack || e), partial: result });
  }
};
