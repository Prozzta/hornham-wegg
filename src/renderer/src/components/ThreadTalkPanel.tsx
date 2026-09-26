import { useEffect, useState } from 'react';
import type { ThreadViewEvent } from '../../../preload';

/** Michael-only readable conversation projection. Deliberately does not mount or
 * resize an xterm: switching Talk cannot cause a Codex transcript replay. */
export function ThreadTalkPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [events, setEvents] = useState<ThreadViewEvent[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    const load = () => window.cth.threadList(agentId).then((rows) => {
      if (!live) return; setEvents(rows); setState('ready');
    }).catch(() => { if (live) setState('error'); });
    void load();
    const timer = window.setInterval(load, 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [agentId]);
  if (state === 'error') return <ThreadEmpty title="Talk unavailable">Conversation history could not be read. Terminal remains available.</ThreadEmpty>;
  if (state === 'loading') return <ThreadEmpty title="Loading Talk">Reading private conversation history…</ThreadEmpty>;
  if (!events.length) return <ThreadEmpty title="No conversation yet">Human messages and Michael’s replies will appear here. Tools and system activity stay in Terminal.</ThreadEmpty>;
  return <div aria-label={`${agentName} conversation`} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, background: 'var(--cth-paper-200)' }}>
    {events.map((event) => <article key={event.id} style={{ marginBottom: 10, marginLeft: event.speaker === 'agent' ? 0 : 24, padding: 8, background: event.speaker === 'agent' ? 'var(--cth-cream-100)' : 'var(--cth-lilac-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4 }}>{event.speaker === 'human' ? 'YOU' : agentName.toUpperCase()} · {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)' }}>{event.text}</div>
    </article>)}
  </div>;
}

function ThreadEmpty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 20, background: 'var(--cth-paper-200)' }}><div style={{ maxWidth: 300, textAlign: 'center' }}><div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)', marginBottom: 8 }}>{title.toUpperCase()}</div><div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>{children}</div></div></div>;
}
