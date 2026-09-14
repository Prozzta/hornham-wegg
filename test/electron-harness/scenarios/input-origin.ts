/**
 * SCENARIO - L0-FUSION stage 4. The half of input provenance that only a REAL xterm
 * can show: the two closing regimes, the drain, the excluded events, the programmatic
 * paste, the self-test, and the mouse-mode mirror.
 *
 * The instrument is the production `terminalPool` with a bridge stub whose `writePty`
 * RECORDS the origin each byte was sent with. That is the exact fact main would receive,
 * read at the exact place it leaves the renderer, so a wrong classification here is a
 * wrong classification in production and not a re-implementation of one.
 *
 * Each arm names the mutant it kills. A test that only demonstrates the right behaviour
 * on the cases it was written from is the shape of every weak test this floor has found.
 */
import {
  acquireTerminal, attachTerminal, disposeTerminal
} from '../../../src/renderer/src/components/terminalPool';
import {
  HELD_DRAIN_MS, inspectInputOrigin, markHumanOrigin
} from '../../../src/renderer/src/components/inputOrigin';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
    cth: Record<string, unknown>;
  }
}

interface Sent { id: string; data: string; origin: string }
const sent: Sent[] = [];
const reported: unknown[] = [];

function installBridgeStub(): void {
  const unsub = () => () => { /* nothing subscribed */ };
  window.cth = {
    onPtyData: unsub(), onPtyExit: unsub(), onPtyRelaunch: unsub(),
    writePty: (id: string, data: string, origin: string) => { sent.push({ id, data, origin }); return Promise.resolve({ ok: true }); },
    redrawPty: () => { /* no pty */ }, resizePty: () => { /* no pty */ },
    copyToClipboard: () => { /* unused */ },
    readClipboard: () => Promise.resolve(''), readClipboardSync: () => '',
    statAbs: () => Promise.resolve(null), revealPath: () => Promise.resolve(),
    // The mirror, recorded rather than dropped, so the mode arm can read what main would.
    reportTerminalInputState: (_id: string, state: unknown) => { reported.push(state); return Promise.resolve({ ok: true }); }
  };
}

const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const write = (term: { write: (d: string, cb?: () => void) => void }, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, () => resolve()));
const lastOrigin = () => sent.length ? sent[sent.length - 1].origin : null;
const key = (ta: HTMLTextAreaElement, k: string, code: number) =>
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: code, which: code, bubbles: true, cancelable: true } as KeyboardEventInit));

window.__harnessRun = async () => {
  const result: Record<string, unknown> = {};
  try {
    installBridgeStub();
    const root = document.getElementById('root')!;
    const entry = acquireTerminal('io');
    attachTerminal(entry, root);
    const term = entry.term;
    const ta = term.textarea!;
    result.opened = entry.opened;
    // Let the startup self-test run to completion before measuring anything; it swallows
    // its own bytes, so `sent` must still be empty afterwards.
    for (let i = 0; i < 20 && entry.inputSelfTest === 'unknown'; i++) await tick();
    result.selfTest = entry.inputSelfTest;
    result.selfTestLeakedBytes = sent.length;
    sent.length = 0;

    // ARM 1 - keyboard, same tick. Kills: "no capture listener / listener after xterm's".
    key(ta, 'ArrowRight', 39);
    result.keyboard = { origin: lastOrigin(), data: sent[sent.length - 1]?.data };
    await tick();
    result.keyboardWindowClosed = inspectInputOrigin('io')?.sameTick === false;

    // ARM 2 - programmatic input with no DOM event. Kills: "tag everything xterm emits".
    // `term.input()` and `term.paste()` both flag wasUserInput=true INSIDE xterm; the
    // design says that flag is not ours to trust, and the classifier must say CONTROL.
    sent.length = 0; term.input('prog'); result.programmaticInput = lastOrigin();
    sent.length = 0; term.paste('pasted'); result.programmaticPaste = lastOrigin();

    // ARM 3 - the SAME action, marked at code we own, is HUMAN. Kills: "mark is a no-op".
    sent.length = 0; markHumanOrigin('io', 'paste-async'); term.paste('user');
    result.markedPaste = lastOrigin();

    // ARM 4 - a terminal protocol reply is CONTROL even right after a keystroke. Kills:
    // "the keyboard window leaks into write() processing".
    key(ta, 'ArrowRight', 39); await tick(); sent.length = 0;
    await write(term, '\x1b[6n');
    result.dsrReply = { origin: lastOrigin(), data: sent[sent.length - 1]?.data };

    // ARM 5 - focus is EXCLUDED. A focus report emitted inside a focus dispatch must
    // read CONTROL. Kills: "listen to every event inside term.element".
    sent.length = 0;
    ta.addEventListener('focus', () => { term.input('\x1b[I', false); }, { once: true });
    ta.dispatchEvent(new FocusEvent('focus'));
    result.focusReport = lastOrigin();

    // ARM 6 - the HELD regime spans a tick. Kills: "one closing regime (microtask only)".
    sent.length = 0;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await tick();                       // xterm finalises composition in a setTimeout(0)
    term.input('あ', false);        // the burst arrives on the later tick
    result.compositionNextTick = lastOrigin();
    term.input('い', false);        // and a second byte of the same burst
    result.compositionSecondByte = lastOrigin();

    // ARM 7 - the drain CLOSES. Kills: "held forever / drain never expires".
    await sleep(HELD_DRAIN_MS + 30);
    sent.length = 0; term.input('after', false);
    result.afterDrain = { origin: lastOrigin(), drainMs: HELD_DRAIN_MS };

    // ARM 8 - the mouse-mode MIRROR follows the TUI and comes back. Kills: "one-shot at
    // arm time". Read from xterm's own modes, forwarded to (the stub of) main.
    reported.length = 0;
    await write(term, '\x1b[?1000h'); await tick();
    const onReport = reported[reported.length - 1] as { mouseTrackingMode?: string } | undefined;
    await write(term, '\x1b[?1000l'); await tick();
    const offReport = reported[reported.length - 1] as { mouseTrackingMode?: string } | undefined;
    result.mirror = {
      afterOn: onReport?.mouseTrackingMode, afterOff: offReport?.mouseTrackingMode,
      xtermNow: term.modes.mouseTrackingMode, reports: reported.length
    };

    disposeTerminal('io');
    window.harness.report({ ok: true, ...result });
  } catch (e) {
    window.harness.report({ ok: false, error: String((e as Error)?.stack || e), partial: result });
  }
};
