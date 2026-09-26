/**
 * ASKME-REVAMP: the pure logic behind HumanQuestionCard (no React here, so it is
 * unit-testable and shared by ASK ME, the task detail and the Talk in-line card).
 *
 * A humanQA entry is written by hand by the god, so everything is validated:
 *   { q, a?, askedAt?, answeredAt?, dismissedAt?,
 *     options?: [{ label, detail? }], recommended?: <option index>, multi?: boolean,
 *     chosen?: <option indexes the human picked> }
 * Every new field is optional: a legacy string-only entry renders exactly as before.
 */

export interface HumanQAOption {
  label: string;
  detail?: string;
}

/** The fields a humanQA entry may carry (mirrors HumanQA in main/preload). */
export interface HumanQAFields {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
  options?: HumanQAOption[];
  recommended?: number;
  multi?: boolean;
  chosen?: number[];
}

/** More than this is a form, not a choice; the rest are dropped (the note field remains). */
export const MAX_OPTIONS = 8;
const MAX_LABEL = 200;
const MAX_DETAIL = 2000;

/** Valid options only (non-empty string labels, optional string detail), capped. */
export function normalizeOptions(raw: unknown): HumanQAOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HumanQAOption[] = [];
  for (const o of raw) {
    if (out.length >= MAX_OPTIONS) break;
    // A bare string is accepted as a label (the god may write ["A", "B"]).
    const label = typeof o === 'string' ? o : (o && typeof o === 'object' ? (o as { label?: unknown }).label : undefined);
    if (typeof label !== 'string' || !label.trim()) continue;
    const detail = o && typeof o === 'object' ? (o as { detail?: unknown }).detail : undefined;
    out.push({
      label: label.trim().slice(0, MAX_LABEL),
      ...(typeof detail === 'string' && detail.trim() ? { detail: detail.trim().slice(0, MAX_DETAIL) } : {})
    });
  }
  return out.length ? out : undefined;
}

/** Normalize one raw humanQA entry, or null when it has no string q. Unknown fields are
 *  dropped; the new optional fields survive only when valid. */
export function normalizeHumanQA(raw: unknown): HumanQAFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.q !== 'string') return null;
  const options = normalizeOptions(e.options);
  const idx = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && !!options && v >= 0 && v < options.length;
  const chosen = Array.isArray(e.chosen) ? [...new Set(e.chosen.filter(idx))] : [];
  return {
    q: e.q,
    ...(typeof e.a === 'string' ? { a: e.a } : {}),
    ...(typeof e.askedAt === 'string' ? { askedAt: e.askedAt } : {}),
    ...(typeof e.answeredAt === 'string' ? { answeredAt: e.answeredAt } : {}),
    ...(typeof e.dismissedAt === 'string' ? { dismissedAt: e.dismissedAt } : {}),
    ...(options ? { options } : {}),
    ...(idx(e.recommended) ? { recommended: e.recommended } : {}),
    ...(options && e.multi === true ? { multi: true } : {}),
    ...(chosen.length ? { chosen } : {})
  };
}

const HEADLINE_MAX = 140;
const LIST_LINE = /^\s*(?:[-*+•]|\d+[.)])\s+/;

/**
 * Split a question into a short headline (shown bold) and the body below it.
 * The headline is the first line when it is short and not a list item; otherwise the
 * first sentence of the first line, when that is short. Leading markdown heading marks
 * are dropped from the headline. No split -> the whole text is the body.
 */
export function splitHeadline(q: string): { headline: string | null; body: string } {
  const text = q.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '');
  const nl = text.indexOf('\n');
  const first = (nl < 0 ? text : text.slice(0, nl)).trim();
  const rest = nl < 0 ? '' : text.slice(nl + 1);
  if (!first || LIST_LINE.test(first)) return { headline: null, body: text.trim() };
  const clean = first.replace(/^#{1,6}\s+/, '');
  if (clean.length <= HEADLINE_MAX) return { headline: clean, body: rest.trim() };
  const m = /^(.{10,}?[.?!:])\s+(.*)$/s.exec(clean);
  if (m && m[1].length <= HEADLINE_MAX) {
    return { headline: m[1], body: [m[2], rest].filter((s) => s.trim()).join('\n').trim() };
  }
  return { headline: null, body: text.trim() };
}

export type QuestionKind = 'choice' | 'question' | 'todo';

/** What the human is being asked for: pick an option, answer a question, or do a to-do. */
export function questionKind(entry: HumanQAFields): QuestionKind {
  if (entry.options?.length) return 'choice';
  const { headline, body } = splitHeadline(entry.q);
  const lead = (headline ?? body).trim();
  if (/^(to-?do|action|please)\b/i.test(lead)) return 'todo';
  return /\?/.test(lead) || /\?\s*$/.test(entry.q.trim()) ? 'question' : 'todo';
}

/** The answer text written to `a` (what the god reads). Options answer by their labels;
 *  a note is appended; a bare note is the answer, as before. Empty -> null. */
export function composeAnswer(options: HumanQAOption[] | undefined, chosen: number[], note: string): string | null {
  const labels = (options ?? []).filter((_, i) => chosen.includes(i)).map((o) => o.label);
  const n = note.trim();
  if (!labels.length) return n || null;
  const pick = labels.join('; ');
  return n ? `${pick}\n\nNote: ${n}` : pick;
}

/** Only https links are live in a question (the same rule as main's app:openExternal);
 *  anything else renders as plain text. */
export function safeHref(href: string | undefined | null): string | null {
  if (!href) return null;
  return /^https:\/\/[^\s]+$/i.test(href) ? href : null;
}

/** "12 Sep, 14:03" style, or null for a missing/invalid stamp. */
export function formatStamp(iso: string | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `today ${hm}`;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${mon}, ${hm}`;
}

/** The picked set after clicking option `i`: multi toggles membership; single selects it
 *  (clicking the selected one again clears it). Sorted, de-duplicated. */
export function togglePick(multi: boolean | undefined, cur: number[], i: number): number[] {
  if (multi) return (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]).sort((a, b) => a - b);
  return cur.length === 1 && cur[0] === i ? [] : [i];
}

/** The answer as the card hands it to its host. */
export interface ComposedAnswer {
  text: string;
  chosen?: number[];
}

/**
 * The ASK ME answer path, entry side: the card's humanQA with the OPEN entry answered
 * (`a`, `answeredAt`, and `chosen` when options were picked). The open entry is matched
 * by identity or, after a re-parse, by its text while still unanswered. Chosen indexes
 * outside the entry's options are dropped.
 */
export function recordAnswer<T extends HumanQAFields>(qa: T[], open: T, answer: ComposedAnswer, nowIso: string): T[] {
  const opts = normalizeOptions(open.options) ?? [];
  const chosen = [...new Set((answer.chosen ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < opts.length))];
  return qa.map((e) =>
    e === open || (e.q === open.q && !e.a)
      ? { ...e, a: answer.text, answeredAt: nowIso, ...(chosen.length ? { chosen } : {}) }
      : e);
}

/** The ASK ME answer path, mail side: the inbox message the god gets. */
export function answerMail(task: { id: string; title: string }, open: HumanQAFields, answer: ComposedAnswer): { subject: string; body: string } {
  const opts = normalizeOptions(open.options) ?? [];
  const chosen = (answer.chosen ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < opts.length);
  return {
    subject: `HUMAN ANSWER on task "${task.title}"`,
    body: [
      `The human answered the open question on task ${task.id} ("${task.title}"):`,
      `Q: ${open.q}`,
      ...(chosen.length ? [`CHOSE: ${chosen.map((i) => `#${i} "${opts[i].label}"`).join(', ')}`] : []),
      `A: ${answer.text}`,
      'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
    ].join('\n')
  };
}
