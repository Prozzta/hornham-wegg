import { useEffect, useState } from 'react';
import type { ThreadViewEvent } from '../../../preload';
import { HumanQuestionCard, type HumanAnswer } from './HumanQuestionCard';
import { answerMail, normalizeHumanQA, recordAnswer } from './humanQuestion';
import { parseTasks, type HiveTask, type HumanQA } from './TasksKanban';

type TalkQuestion = { task: HiveTask; raw: HumanQA; index: number; entry: NonNullable<ReturnType<typeof normalizeHumanQA>> };

function askedAt(question: TalkQuestion): number {
  const at = Date.parse(question.raw.askedAt ?? '');
  return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
}

/** Michael-only readable conversation projection. Deliberately does not mount or
 * resize an xterm: switching Talk cannot cause a Codex transcript replay. */
export function ThreadTalkPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [events, setEvents] = useState<ThreadViewEvent[]>([]);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    const merge = (rows: ThreadViewEvent[]) => setEvents((previous) => {
      const byId = new Map(previous.map((event) => [event.id, event]));
      for (const row of rows) byId.set(row.id, row);
      return [...byId.values()].sort((a, b) => a.at - b.at).slice(-1000);
    });
    // Subscribe before the snapshot. A row arriving during the read merges by id,
    // so no event is lost and no repeating list/poll filesystem work is needed.
    const unsubscribe = window.cth.onThreadEvent((payload) => {
      if (live && payload.agentId === agentId) merge([payload.event]);
    });
    void window.cth.threadList(agentId).then((rows) => {
      if (!live) return; merge(rows); setState('ready');
    }).catch(() => { if (live) setState('error'); });
    // humanQA is the sole source of these cards. This one-time snapshot avoids
    // adding a Talk renderer poller alongside its initial transcript snapshot.
    void window.cth.hiveTasks().then((raw) => {
      if (live) setTasks(parseTasks(raw));
    }).catch(() => { /* Talk remains useful if the task ledger is unavailable. */ });
    return () => { live = false; unsubscribe(); };
  }, [agentId]);
  const questions: TalkQuestion[] = tasks.flatMap((task) => (task.humanQA ?? []).flatMap((raw, index) => {
    const entry = normalizeHumanQA(raw);
    return entry ? [{ task, raw, index, entry }] : [];
  })).sort((a, b) => askedAt(a) - askedAt(b));

  const answerQuestion = async (question: TalkQuestion, answer: HumanAnswer) => {
    const key = `${question.task.id}:${question.index}`;
    if (!answer.text.trim() || sending) return;
    setSending(key);
    try {
      // `raw` remains the stored entry; normalization is presentation-only, so
      // card-visible option indexes are mapped back to the god's raw positions.
      const humanQA = recordAnswer(question.task.humanQA ?? [], question.raw, answer, new Date().toISOString());
      const result = await window.cth.hivePatchTask(question.task.id, { humanQA });
      if (!result.ok) throw new Error('task changed before answer could be saved');
      setTasks((previous) => previous.map((task) => task.id === question.task.id ? { ...task, humanQA } : task));
      await window.cth.hiveSend({ to: 'god', act: 'inform', ...answerMail(question.task, question.raw, answer) }, 'human');
      setDrafts((previous) => ({ ...previous, [key]: '' }));
    } catch {
      // Preserve the draft so a transient task-ledger/mail failure is retryable.
    } finally {
      setSending(null);
    }
  };

  const renderQuestion = (question: TalkQuestion) => {
    const key = `${question.task.id}:${question.index}`;
    const open = !question.entry.a && !question.entry.dismissedAt;
    return <section key={key} aria-label={`Human question: ${question.task.title}`} style={{ marginBottom: 10, padding: 10, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', marginBottom: 7 }}>ASK ME - {question.task.title.toUpperCase()}</div>
      <HumanQuestionCard
        entry={question.entry}
        draft={drafts[key] ?? ''}
        onDraftChange={(draft) => setDrafts((previous) => ({ ...previous, [key]: draft }))}
        onAnswer={open ? (answer) => answerQuestion(question, answer) : undefined}
        sending={sending === key}
      />
    </section>;
  };

  if (state === 'error') return <ThreadEmpty title="Talk unavailable">Conversation history could not be read. Terminal remains available.</ThreadEmpty>;
  if (state === 'ready' && !events.length && questions.length) return <div aria-label={`${agentName} conversation`} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, background: 'var(--cth-paper-200)' }}>{questions.map(renderQuestion)}</div>;
  if (state === 'loading') return <ThreadEmpty title="Loading Talk">Reading private conversation history…</ThreadEmpty>;
  if (!events.length) return <ThreadEmpty title="No conversation yet">Human messages and Michael’s replies will appear here. Tools and system activity stay in Terminal.</ThreadEmpty>;
  return <div aria-label={`${agentName} conversation`} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, background: 'var(--cth-paper-200)' }}>
    {questions.map(renderQuestion)}
    {events.map((event) => <article key={event.id} style={{ marginBottom: 10, marginLeft: event.speaker === 'agent' ? 0 : 24, padding: 8, background: event.speaker === 'agent' ? 'var(--cth-cream-100)' : 'var(--cth-lilac-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4 }}>{event.speaker === 'human' ? 'YOU' : agentName.toUpperCase()} · {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)' }}>{event.text}</div>
    </article>)}
  </div>;
}

function ThreadEmpty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 20, background: 'var(--cth-paper-200)' }}><div style={{ maxWidth: 300, textAlign: 'center' }}><div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)', marginBottom: 8 }}>{title.toUpperCase()}</div><div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>{children}</div></div></div>;
}
