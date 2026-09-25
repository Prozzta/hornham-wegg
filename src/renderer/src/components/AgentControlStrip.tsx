import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { PixelButton } from './PixelButton';
import { AgentHoldButton } from './AgentHoldButton';

/**
 * Operator control for one agent (#7C.1-7C.3) — pause (deny tools at the next
 * boundary), graceful halt (clean stop), and mid-run steering (inject context
 * without typing into the TUI). All ride Claude Code's hook-return protocol; no
 * PTY keystrokes. A thin strip under the agent header.
 *
 * The labels used to be "CONTROL", "pause", "halt", "steer", which told you the
 * mechanism and nothing about the consequence. "Control" what, and what is the
 * difference between pausing and halting? Both stop something; only one is
 * recoverable in the same breath. So each button says what HAPPENS, and the
 * explanations are on a styled hover tip rather than a native `title` that
 * waits a second and then renders an unstyled OS bubble.
 *
 * The heading is gone: once the buttons read as sentences it was labelling the
 * obvious, and a row of three clear verbs needs no title above it.
 *
 * The 1:1 hold sits here too. It is a different KIND of control — the other two
 * restrain the AGENT, 1:1 restrains MICHAEL, and the agent keeps running and
 * answering you — so that distinction now lives in its tooltip rather than in
 * the layout.
 */
/** One line, never wraps, never grows its row: a status sentence that does not fit is cut
 *  with an ellipsis and read in full from its tooltip. */
const STATUS_TEXT: CSSProperties = {
  fontSize: 11, lineHeight: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0
};

interface Snapshot {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

export function AgentControlStrip({ agentId }: { agentId: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [steer, setSteer] = useState('');
  const [note, setNote] = useState('');
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    window.cth.controlSnapshot(agentId).then((s) => { if (alive && s) setSnap(s); }).catch(() => { /* none */ });
    return () => { alive = false; };
  }, [agentId]);

  const flash = (m: string) => {
    setNote(m);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 1800);
  };

  const togglePause = async () => {
    const s = snap?.paused ? await window.cth.controlResume(agentId) : await window.cth.controlPause(agentId, true);
    if (s) setSnap(s);
    flash(snap?.paused ? 'tools allowed again' : 'tools blocked from the next call on');
  };
  const halt = async () => {
    const s = await window.cth.controlHalt(agentId);
    if (s) setSnap(s);
    flash('will stop after the current step');
  };
  const sendSteer = async () => {
    const t = steer.trim();
    if (!t) return;
    const s = await window.cth.controlSteer(agentId, t);
    if (s) setSnap(s);
    setSteer('');
    flash('note queued, arrives on its next turn');
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '6px 8px', background: 'var(--cth-paper-100)',
      borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
        {/* Neither of these kills anything, and the old two-word labels never
            said so — the difference is WHEN the agent stops and whether it keeps
            its session. Say the consequence on the button, the detail on hover. */}
        <PixelButton variant={snap?.paused ? 'primary' : 'secondary'} size="sm" onClick={togglePause}>
          <span
            className="cth-tip cth-tip-left cth-tip-wrap"
            data-tip={snap?.paused
              ? 'Give its tools back. The agent keeps its session and picks up where it stopped.'
              : 'The agent keeps thinking and talking to you, but cannot read, write or run anything until you allow it again. Immediate, and reversible.'}
            aria-label={snap?.paused ? 'Allow tools again' : 'Block this agent from using tools'}
          >
            {snap?.paused ? 'allow tools' : 'block tools'}
          </span>
        </PixelButton>
        <PixelButton variant="destructive" size="sm" onClick={halt}>
          <span
            className="cth-tip cth-tip-left cth-tip-wrap"
            data-tip="Let it finish the step it is on, then stop. The process and its session survive, so Restart and Continue can pick it back up. To end the process outright, use the X."
            aria-label="Stop this agent after the current step"
          >
            stop after this step
          </span>
        </PixelButton>
        {/* Sits with them at the founder's call. It is a different KIND of
            control — the two above restrain the agent, this one restrains
            Michael — so the tooltip carries that distinction now that the
            grouping no longer does. */}
        <AgentHoldButton agentId={agentId} />
        {/* v0.3.4: the auto-delivery switch moved to the god's Command Center
            header — ONE floor-wide control instead of a per-agent toggle. */}
        {/* CODEX-REDRAW-151: status text is ONE line that never wraps (ellipsis, the whole
            sentence on hover). Wrapping in the narrow sidebar grew this strip, shrank the
            terminal below it, and Codex replays its whole transcript on every grid change. */}
        {snap?.autoDeliveryPaused && (
          <span title="queued messages held (whole floor)" style={{ ...STATUS_TEXT, color: 'var(--cth-ink-500)' }}>queued messages held (whole floor)</span>
        )}
        {snap?.halted && <span title="stopping after this step…" style={{ ...STATUS_TEXT, color: 'var(--cth-coral)' }}>stopping after this step…</span>}
        {!!snap?.pendingSteers && <span title={`${snap.pendingSteers} note${snap.pendingSteers === 1 ? '' : 's'} waiting`} style={{ ...STATUS_TEXT, color: 'var(--cth-ink-500)' }}>{snap.pendingSteers} note{snap.pendingSteers === 1 ? '' : 's'} waiting</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="cth-input"
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendSteer(); }}
          placeholder="send this agent a note… (arrives as context on its next turn, nothing is typed into its terminal)"
          style={{
            flex: 1, padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12, color: 'var(--cth-ink-900)', outline: 'none'
          }}
        />
        <PixelButton variant="secondary" size="sm" onClick={sendSteer} disabled={!steer.trim()}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip="Hands the agent a note at its next turn boundary. It does not interrupt what it is doing now, and nothing is typed into its terminal."
            aria-label="Send this agent a note"
          >send</span>
        </PixelButton>
      </div>
      {/* CODEX-REDRAW-151: the confirmation flash used to be an in-flow line that appeared
          for 1.8 s after EVERY click here and wrapped onto 2-3 lines in the sidebar: the
          terminal below lost those rows and got them back, two full Codex transcript replays
          per click (measured on 1.1.50: 17 -> 14 -> 17 rows). It now sits in a zero-height
          anchor that is always present and floats over the top of what follows. */}
      <div data-transient-anchor style={{ position: 'relative', height: 0 }}>
        {note && (
          <span role="status" style={{
            position: 'absolute', top: 0, right: 0, zIndex: 20, maxWidth: '100%',
            ...STATUS_TEXT, padding: '2px 6px', pointerEvents: 'none',
            color: 'var(--cth-ink-700)', background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>{note}</span>
        )}
      </div>
    </div>
  );
}
