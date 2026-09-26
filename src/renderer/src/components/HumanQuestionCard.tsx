/**
 * ASKME-REVAMP: one readable card for a humanQA entry, shared by the ASK ME tab, the task
 * detail and the Talk in-line card. PRESENTATIONAL: everything comes in through props, and
 * an answer goes out through onAnswer; the host owns persistence (the humanQA `a` write
 * plus the inbox message to the god) and any title/assignee chrome around it.
 *
 * Readability: the first line (or sentence) is a bold headline, the rest a body rendered
 * as a SAFE markdown subset: paragraphs and line breaks, bullet and numbered lists, bold,
 * italic, inline code and https links. Nothing else becomes markup: raw HTML is shown as
 * text (react-markdown without rehype-raw has no HTML sink), images and headings are
 * unwrapped to their text, and links open only through the main-process opener.
 *
 * Options ({label, detail}) render as choice buttons: pick one (or several when `multi`),
 * optionally add a note, then answer. The free-text note is always available, so the human
 * is never forced into the offered choices.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PixelButton } from './PixelButton';
import {
  composeAnswer, formatStamp, questionKind, safeHref, splitHeadline, togglePick,
  type HumanQAFields, type QuestionKind
} from './humanQuestion';

export interface HumanAnswer {
  /** The text written to the entry's `a` (option labels, then any note). */
  text: string;
  /** Indexes of the chosen options, when the entry has options. */
  chosen?: number[];
}

export interface HumanQuestionCardProps {
  entry: HumanQAFields;
  /** The note / free-text draft (host-owned so it survives remounts). Uncontrolled when omitted. */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** Called with the composed answer. Omit for a read-only card. */
  onAnswer?: (answer: HumanAnswer) => void | Promise<void>;
  /** The host is saving an answer: controls are disabled. */
  sending?: boolean;
  /** Open an https link (defaults to the main-process opener). */
  onOpenLink?: (href: string) => void;
  /** For deterministic stamps in tests. */
  now?: Date;
}

/** The markdown subset a question may use; everything else is unwrapped to its text. */
export const ALLOWED_ELEMENTS = ['p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'a', 'del'];

const KIND_LABEL: Record<QuestionKind, string> = { choice: 'CHOOSE', question: 'QUESTION', todo: 'TO-DO' };
const KIND_COLOR: Record<QuestionKind, string> = {
  choice: 'var(--cth-lilac-light)', question: 'var(--cth-sky-light)', todo: 'var(--cth-lemon-light)'
};

const prose: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '19px', color: 'var(--cth-ink-900)',
  overflowWrap: 'anywhere', minWidth: 0
};

/** Safe markdown for question text. Soft line breaks are kept (pre-line), because the god
 *  writes questions with meaningful line breaks. */
export function SafeMarkdown({ source, onOpenLink }: { source: string; onOpenLink?: (href: string) => void }) {
  const open = onOpenLink ?? ((h: string) => { void window.cth?.openExternal?.(h); });
  return (
    <div className="cth-hq-md" style={prose}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        components={{
          p: ({ children }) => <p style={{ margin: '0 0 8px', whiteSpace: 'pre-line' }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: '0 0 8px', paddingLeft: 22 }}>{children}</ol>,
          li: ({ children }) => <li style={{ margin: '2px 0', whiteSpace: 'pre-line' }}>{children}</li>,
          code: ({ children }) => (
            <code style={{
              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 3px',
              background: 'var(--cth-paper-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
            }}>{children}</code>
          ),
          a: ({ href, children }) => {
            const h = safeHref(href);
            if (!h) return <span>{children}</span>;
            return (
              <a
                href={h}
                title={h}
                onClick={(e) => { e.preventDefault(); open(h); }}
                style={{ color: 'var(--cth-sky)', textDecoration: 'underline' }}
              >{children}</a>
            );
          }
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function Tag({ children, bg }: { children: ReactNode; bg: string }) {
  return (
    <span style={{
      fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px', padding: '0 5px',
      background: bg, color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      whiteSpace: 'nowrap'
    }}>{children}</span>
  );
}

export function HumanQuestionCard({
  entry, draft, onDraftChange, onAnswer, sending = false, onOpenLink, now
}: HumanQuestionCardProps) {
  const [localDraft, setLocalDraft] = useState('');
  const note = draft ?? localDraft;
  const setNote = (v: string) => { if (onDraftChange) onDraftChange(v); else setLocalDraft(v); };
  const [picked, setPicked] = useState<number[]>([]);

  const answered = typeof entry.a === 'string';
  const options = entry.options ?? [];
  const kind = questionKind(entry);
  const { headline, body } = splitHeadline(entry.q);
  const chosen = answered ? (entry.chosen ?? []) : picked;
  const answer = composeAnswer(entry.options, picked, note);
  const interactive = !answered && !!onAnswer;

  const toggle = (i: number) => {
    if (!interactive || sending) return;
    setPicked((cur) => togglePick(entry.multi, cur, i));
  };
  const submit = () => {
    if (!interactive || sending || !answer) return;
    void onAnswer!({ text: answer, ...(options.length ? { chosen: picked } : {}) });
  };

  const asked = formatStamp(entry.askedAt, now);
  const answeredAt = formatStamp(entry.answeredAt, now);

  return (
    <div className="cth-hq" data-kind={kind} data-state={answered ? 'answered' : 'open'} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      {/* kind + stamp */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Tag bg={KIND_COLOR[kind]}>{KIND_LABEL[kind]}{entry.multi && options.length ? ' · ANY' : ''}</Tag>
        {asked && <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>asked {asked}</span>}
      </div>

      {headline && (
        <div className="cth-hq-headline" style={{ ...prose, fontSize: 14, lineHeight: '20px', fontWeight: 700 }}>
          <SafeMarkdown source={headline} onOpenLink={onOpenLink} />
        </div>
      )}
      {body && <SafeMarkdown source={body} onOpenLink={onOpenLink} />}

      {/* options */}
      {options.length > 0 && (
        <div role={entry.multi ? 'group' : 'radiogroup'} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {options.map((o, i) => {
            const on = chosen.includes(i);
            const rec = entry.recommended === i;
            return (
              <button
                key={i}
                type="button"
                role={entry.multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                data-option={i}
                disabled={!interactive || sending}
                onClick={() => toggle(i)}
                style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left', width: '100%',
                  padding: '7px 9px', border: 'none', cursor: interactive && !sending ? 'pointer' : 'default',
                  background: on ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
                  boxShadow: on ? 'inset 0 0 0 2px var(--cth-mint)' : 'inset 0 0 0 1px var(--cth-ink-300)',
                  opacity: answered && !on ? 0.6 : 1, color: 'var(--cth-ink-900)'
                }}
              >
                <span aria-hidden style={{
                  flexShrink: 0, width: 14, height: 14, marginTop: 2, borderRadius: entry.multi ? 0 : 7,
                  boxShadow: 'inset 0 0 0 2px var(--cth-ink-500)',
                  background: on ? 'var(--cth-mint)' : 'transparent'
                }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ ...prose, fontWeight: 700 }}>{o.label}</span>
                    {rec && <Tag bg="var(--cth-lemon-light)">RECOMMENDED</Tag>}
                  </span>
                  {o.detail && (
                    <span style={{ ...prose, fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
                      <SafeMarkdown source={o.detail} onOpenLink={onOpenLink} />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* answered state */}
      {answered && (
        <div className="cth-hq-answer" style={{
          padding: '7px 9px', background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', flexDirection: 'column', gap: 4
        }}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Tag bg="var(--cth-mint-light)">ANSWERED</Tag>
            {answeredAt && <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{answeredAt}</span>}
          </span>
          <SafeMarkdown source={entry.a!} onOpenLink={onOpenLink} />
        </div>
      )}

      {/* the note / free-text answer, always available while open */}
      {interactive && (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            rows={options.length ? 2 : 3}
            disabled={sending}
            aria-label={options.length ? 'Other / add a note' : 'Your answer'}
            placeholder={options.length
              ? 'Other / add a note (optional)… (Ctrl+Enter to send)'
              : kind === 'todo' ? "Done? Say so, with the result… (Ctrl+Enter to send)" : 'Your answer… (Ctrl+Enter to send)'}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical',
              background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              ...prose, outline: 'none'
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <PixelButton variant="primary" size="sm" disabled={!answer || sending} onClick={submit}>
              {sending ? 'sending…' : picked.length ? `answer: ${options.filter((_, i) => picked.includes(i)).map((o) => o.label).join(', ').slice(0, 40)}` : 'respond & unblock'}
            </PixelButton>
          </div>
        </>
      )}
    </div>
  );
}
