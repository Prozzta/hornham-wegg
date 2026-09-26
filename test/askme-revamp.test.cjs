'use strict';

/**
 * ASKME-REVAMP: readable human-question cards, shared by ASK ME, the task detail and
 * (next) Dwight's Talk in-line card.
 *  - a SAFE markdown subset (paragraphs, line breaks, lists, bold/italic, code, https
 *    links), with raw HTML and unsafe links never becoming markup;
 *  - structured options {label, detail} with recommended / multi, answering through the
 *    EXISTING path (the humanQA `a` write plus the inbox message to the god);
 *  - a legacy string-only q renders as before; the answered state shows the choice;
 *  - the new fields survive the kanban re-parse.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const hq = loadTs('src/renderer/src/components/humanQuestion.ts');
const { HumanQuestionCard, SafeMarkdown, ALLOWED_ELEMENTS } = loadTs('src/renderer/src/components/HumanQuestionCard.tsx');

const card = (props) => renderToStaticMarkup(React.createElement(HumanQuestionCard, { onAnswer: () => {}, now: new Date('2026-09-26T12:00:00'), ...props }));
const md = (source) => renderToStaticMarkup(React.createElement(SafeMarkdown, { source }));

// ── safe markdown ──────────────────────────────────────────────────────────

test('markdown: paragraphs, line breaks, bullet + numbered lists, bold/italic, inline code, https links', () => {
  const html = md('First para\nsecond line\n\n- one\n- **two**\n\n1. alpha\n2. *beta*\n\nUse `npm ci` and see [docs](https://example.com/x).');
  assert.match(html, /<p style="[^"]*white-space:pre-line[^"]*">First para\nsecond line<\/p>/, 'a soft line break is kept: the paragraph renders with pre-line');
  assert.match(html, /<ul[^>]*>\s*<li[^>]*>one<\/li>\s*<li[^>]*><strong>two<\/strong><\/li>\s*<\/ul>/);
  assert.match(html, /<ol[^>]*>\s*<li[^>]*>alpha<\/li>\s*<li[^>]*><em>beta<\/em><\/li>\s*<\/ol>/);
  assert.match(html, /<code[^>]*>npm ci<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/x"[^>]*>docs<\/a>/);
});

test('XSS: raw HTML is shown as text, never markup; unsafe or non-https links are not links', () => {
  const html = md('<script>alert(1)</script> <img src=x onerror=alert(1)> <b onclick="x()">b</b> <iframe src="https://evil"></iframe>\n\n[js](javascript:alert(1)) [data](data:text/html,<x>) [http](http://plain.example) [ok](https://fine.example)\n\n<a href="javascript:alert(2)">raw</a>');
  assert.doesNotMatch(html, /<(script|img|iframe|b)[\s>]|<[^>]*\s(onerror|onclick)=/i, 'no element or handler from the source (escaped text is fine)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'shown as text');
  assert.doesNotMatch(html, /href="(javascript|data|http):/i, 'no unsafe href');
  assert.doesNotMatch(html, /<a [^>]*>(js|data|http)<\/a>/, 'unsafe links render as plain text');
  assert.match(html, /<a href="https:\/\/fine\.example"/, 'an https link stays a link');
  assert.equal((html.match(/<a /g) || []).length, 1, 'exactly one live link');
});

test('markdown: headings unwrap to text, an image becomes its alt text (F2), never an <img>; the allow-list is exactly the subset', () => {
  assert.deepEqual([...ALLOWED_ELEMENTS].sort(), ['a', 'br', 'code', 'del', 'em', 'img', 'li', 'ol', 'p', 'pre', 'strong', 'ul']);
  const html = md('## Heading text\n\n![alt text](https://x/y.png) and ![](https://x/z.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.doesNotMatch(html, /<h\d|<img|<table|y\.png|z\.png/);
  assert.match(html, /Heading text/);
  assert.match(html, /\[image: alt text\]/);
});

test('F1: a fenced or indented code block keeps its lines (pre-wrap mono block); inline code stays a chip', () => {
  const html = md('Run these:\n\n```powershell\nStop-Process -Name foo\nRemove-Item C:\\x -Recurse\n```\n\nor indented:\n\n    first line\n    second line\n\nand `inline` code.');
  assert.match(html, /<pre class="cth-hq-pre" style="[^"]*white-space:pre-wrap[^"]*"><code[^>]*>Stop-Process -Name foo\nRemove-Item C:\\x -Recurse\n<\/code><\/pre>/);
  assert.match(html, /<pre class="cth-hq-pre"[^>]*><code[^>]*>first line\nsecond line\n<\/code><\/pre>/);
  assert.match(html, /<code style="[^"]*padding:0 3px[^"]*">inline<\/code>/, 'inline code keeps the chip');
  assert.doesNotMatch(html, /<code style="[^"]*padding:0 3px[^"]*">Stop-Process/, 'a block is not a chip');
});

test('safeHref: https only (the same rule as main app:openExternal)', () => {
  assert.equal(hq.safeHref('https://a.b/c'), 'https://a.b/c');
  for (const bad of ['http://a.b', 'javascript:alert(1)', 'mailto:x@y', 'file:///c:/x', '//a.b', 'https://a b', '', null, undefined]) {
    assert.equal(hq.safeHref(bad), null, String(bad));
  }
});

// ── structure ──────────────────────────────────────────────────────────────

test('splitHeadline: short first line = headline; a long first line splits at its first sentence; lists never head', () => {
  assert.deepEqual(hq.splitHeadline('Ship 1.1.53 today?\nIt has two fixes.\n\n- a\n- b'), { headline: 'Ship 1.1.53 today?', body: 'It has two fixes.\n\n- a\n- b' });
  assert.deepEqual(hq.splitHeadline('## Pick a model\nbody'), { headline: 'Pick a model', body: 'body' });
  const long = 'Please approve the purchase of the domain. ' + 'x'.repeat(200);
  assert.equal(hq.splitHeadline(long).headline, 'Please approve the purchase of the domain.');
  assert.deepEqual(hq.splitHeadline('- a\n- b'), { headline: null, body: '- a\n- b' });
  assert.deepEqual(hq.splitHeadline('y'.repeat(300)), { headline: null, body: 'y'.repeat(300) });
});

test('questionKind: options = choice; a question mark = question; otherwise a to-do', () => {
  assert.equal(hq.questionKind({ q: 'Which?', options: [{ label: 'A' }] }), 'choice');
  assert.equal(hq.questionKind({ q: 'Should we ship?' }), 'question');
  assert.equal(hq.questionKind({ q: 'Create the GitHub token and paste it here.' }), 'todo');
  assert.equal(hq.questionKind({ q: 'TODO: test on your phone? and report' }), 'todo');
});

test('normalizeHumanQA: legacy entries unchanged; options validated and capped; recommended/multi/chosen only when valid', () => {
  assert.deepEqual(hq.normalizeHumanQA({ q: 'x', askedAt: 't' }), { q: 'x', askedAt: 't' });
  assert.equal(hq.normalizeHumanQA({ a: 'no q' }), null);
  assert.equal(hq.normalizeHumanQA('str'), null);
  const e = hq.normalizeHumanQA({
    q: 'pick', options: ['Plain', { label: '  Detailed ', detail: ' why ' }, { label: '' }, { nope: 1 }, 7, null],
    recommended: 1, multi: true, chosen: [1, 1, 5, -1, 'x', 0], junk: 'dropped'
  });
  assert.deepEqual(e, { q: 'pick', options: [{ label: 'Plain' }, { label: 'Detailed', detail: 'why' }], recommended: 1, multi: true, chosen: [1, 0] });
  assert.equal(hq.normalizeHumanQA({ q: 'x', options: [{ label: 'A' }], recommended: 3 }).recommended, undefined, 'out of range');
  assert.equal(hq.normalizeHumanQA({ q: 'x', multi: true }).multi, undefined, 'multi without options');
  assert.equal(hq.normalizeHumanQA({ q: 'x', options: Array.from({ length: 20 }, (_, i) => `o${i}`) }).options.length, hq.MAX_OPTIONS);
});

test('F3: the kanban re-parse keeps each STORED entry as written (uncapped options, invalid recommended, unknown fields), typing only what views read', () => {
  // parseTasks (TasksKanban) maps every humanQA entry through storedHumanQA; the component
  // imports the store via the @ alias, so the mapping is pinned statically and the helper is
  // exercised directly.
  const kanban = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'));
  assert.match(kanban, /\.map\(storedHumanQA\)\s*\.filter\(/);
  const many = Array.from({ length: 12 }, (_, i) => ({ label: 'L'.repeat(i === 0 ? 300 : 3) + i, detail: 'd' }));
  const raw = { q: 'pick?', options: many, recommended: 40, multi: 'yes', chosen: [11], extra: { keep: 1 }, a: 7, askedAt: 't' };
  const stored = hq.storedHumanQA(raw);
  assert.equal(stored.options, many, 'the options array is the stored one: 12 entries, a 300-char label, nothing capped');
  assert.equal(stored.recommended, 40); assert.equal(stored.multi, 'yes'); assert.deepEqual(stored.chosen, [11]);
  assert.deepEqual(stored.extra, { keep: 1 }, 'an unknown field survives');
  assert.equal(stored.a, undefined, 'a non-string answer is not handed to the views');
  assert.equal(stored.askedAt, 't');
  assert.equal(hq.storedHumanQA({ nope: 1 }), null);
  assert.deepEqual(hq.storedHumanQA({ q: 'gone', dismissedAt: 'd' }), { q: 'gone', a: undefined, askedAt: undefined, answeredAt: undefined, dismissedAt: 'd' });
  // Answering such an entry writes it back with only a/answeredAt/chosen added.
  const [answered] = hq.recordAnswer([stored], stored, { text: 'L1', chosen: [1] }, 'now');
  assert.equal(answered.options, many); assert.equal(answered.recommended, 40); assert.deepEqual(answered.extra, { keep: 1 });
  assert.equal(answered.a, 'L1'); assert.deepEqual(answered.chosen, [1]);
  // What a card RENDERS is still validated and capped.
  const shown = hq.normalizeHumanQA(stored);
  assert.equal(shown.options.length, hq.MAX_OPTIONS); assert.equal(shown.recommended, undefined); assert.equal(shown.multi, undefined);
});

// ── the card ───────────────────────────────────────────────────────────────

test('legacy string q: headline bold, body as markdown, the free-text answer box, no options', () => {
  const html = card({ entry: { q: 'Can you approve the spend?\n\nIt is **$20**/month:\n- domain\n- hosting', askedAt: '2026-09-26T09:05:00' } });
  assert.match(html, /data-kind="question"/);
  assert.match(html, /data-state="open"/);
  assert.match(html, /class="cth-hq-headline"[^>]*font-weight:700/);
  assert.match(html, /Can you approve the spend\?/);
  assert.match(html, /<strong>\$20<\/strong>/);
  assert.match(html, /<ul[^>]*>\s*<li[^>]*>domain<\/li>/);
  assert.match(html, /asked today 09:05/, 'a muted timestamp');
  assert.match(html, /<textarea[^>]*aria-label="Your answer"/);
  assert.doesNotMatch(html, /role="radio"|role="checkbox"/);
  assert.match(html, /respond &amp; unblock/);
});

test('options: choice buttons with their detail, the RECOMMENDED tag, and the note field (Other) always there', () => {
  const html = card({ entry: { q: 'Which model for Phyllis?', options: [{ label: 'Opus 5.5', detail: 'best, **pricier**' }, { label: 'Sonnet 5' }], recommended: 1 } });
  assert.match(html, /data-kind="choice"/);
  assert.equal((html.match(/role="radio"/g) || []).length, 2);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /Opus 5\.5/); assert.match(html, /<strong>pricier<\/strong>/);
  const recIdx = html.indexOf('RECOMMENDED'); assert.ok(recIdx > html.indexOf('data-option="1"'), 'the tag sits on option 1');
  assert.match(html, /<textarea[^>]*aria-label="Other \/ add a note"/);
  const multi = card({ entry: { q: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multi: true } });
  assert.equal((multi.match(/role="checkbox"/g) || []).length, 2);
  assert.match(multi, /CHOOSE · ANY/);
});

test('answered state: the chosen option is marked, the answer shown, no input; a read-only card has no input either', () => {
  const html = card({ entry: { q: 'Which?', options: [{ label: 'A' }, { label: 'B' }], chosen: [1], a: 'B\n\nNote: soon', answeredAt: '2026-09-25T08:00:00' } });
  assert.match(html, /data-state="answered"/);
  assert.match(html, /data-option="1"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-option="1"/);
  assert.match(html, /aria-checked="false"[^>]*data-option="0"|data-option="0"[^>]*aria-checked="false"/);
  assert.match(html, /ANSWERED/); assert.match(html, /25 Sep, 08:00/); assert.match(html, /Note: soon/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(card({ entry: { q: 'Q?' }, onAnswer: undefined }), /<textarea/);
});

test('the card never renders raw HTML from q, option labels/details or the answer', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = card({ entry: { q: `${evil} headline?\n${evil}`, options: [{ label: evil, detail: evil }], a: undefined } });
  assert.doesNotMatch(html, /<img[\s>]|<[^>]*\sonerror=/);
  const answered = card({ entry: { q: 'q?', a: evil } });
  assert.doesNotMatch(answered, /<img[\s>]|<[^>]*\sonerror=/);
});

// ── the answer path ───────────────────────────────────────────────────────

test('picking: single selects one (re-click clears); multi toggles, sorted', () => {
  assert.deepEqual(hq.togglePick(false, [], 2), [2]);
  assert.deepEqual(hq.togglePick(false, [2], 0), [0]);
  assert.deepEqual(hq.togglePick(false, [2], 2), []);
  assert.deepEqual(hq.togglePick(true, [2], 0), [0, 2]);
  assert.deepEqual(hq.togglePick(true, [0, 2], 2), [0]);
});

test('composeAnswer: labels, then the note; a bare note is the answer; nothing = no answer', () => {
  const o = [{ label: 'Opus' }, { label: 'Sonnet' }, { label: 'Haiku' }];
  assert.equal(hq.composeAnswer(o, [1], ''), 'Sonnet');
  assert.equal(hq.composeAnswer(o, [0, 2], '  cheap first '), 'Opus; Haiku\n\nNote: cheap first');
  assert.equal(hq.composeAnswer(o, [], 'something else'), 'something else');
  assert.equal(hq.composeAnswer(undefined, [], ' free text '), 'free text');
  assert.equal(hq.composeAnswer(o, [], '  '), null);
});

test('options answer through the SAME path: the open entry gets a/answeredAt/chosen, and the god gets the inbox message', () => {
  const open = { q: 'Which?', options: [{ label: 'A' }, { label: 'B' }], askedAt: 't0' };
  const qa = [{ q: 'older', a: 'x' }, open];
  const next = hq.recordAnswer(qa, open, { text: 'B\n\nNote: n', chosen: [1, 9] }, '2026-09-26T12:00:00.000Z');
  assert.deepEqual(next[1], { ...open, a: 'B\n\nNote: n', answeredAt: '2026-09-26T12:00:00.000Z', chosen: [1] });
  assert.equal(next[0], qa[0], 'other entries untouched');
  const legacy = hq.recordAnswer([{ q: 'Q?' }], { q: 'Q?' }, { text: 'yes' }, 'now');
  assert.deepEqual(legacy[0], { q: 'Q?', a: 'yes', answeredAt: 'now' }, 'legacy: no chosen field');
  const mail = hq.answerMail({ id: 't1', title: 'Pick' }, open, { text: 'B', chosen: [1] });
  assert.equal(mail.subject, 'HUMAN ANSWER on task "Pick"');
  assert.match(mail.body, /^The human answered the open question on task t1 \("Pick"\):\nQ: Which\?\nCHOSE: #1 "B"\nA: B\n/);
  assert.doesNotMatch(hq.answerMail({ id: 't', title: 'x' }, { q: 'Q?' }, { text: 'yes' }).body, /CHOSE/);
});

test('ASK ME wiring: the shared card answers via hivePatchTask(recordAnswer) + hiveSend(answerMail) to god', () => {
  const src = codeOnly(readSource('src/renderer/src/components/AskMeTab.tsx'));
  assert.match(src, /<HumanQuestionCard[\s\S]*?onAnswer=\{\(ans\) => sendAnswer\(t, ans\)\}/);
  assert.match(src, /entry=\{normalizeHumanQA\(open\) \?\? \{ q: open\.q \}\}/, 'the card gets the validated entry (options included)');
  assert.match(src, /recordAnswer\(t\.humanQA \?\? \[\], open, ans, nowIso\)/);
  assert.match(src, /window\.cth\.hivePatchTask\(task\.id, \{ humanQA: updated\.humanQA \}\)/);
  assert.match(src, /window\.cth\.hiveSend\(\{ to: 'god', act: 'inform', \.\.\.answerMail\(task, open, ans\) \}, 'human'\)/);
  assert.doesNotMatch(src, /whiteSpace: 'pre-wrap' \}\}>\s*\{open\.q\}/, 'the raw pre-wrap question is gone');
  const kanban = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'));
  assert.match(kanban, /<SafeMarkdown source=\{e\.q\} \/>/);
  assert.match(kanban, /<SafeMarkdown source=\{e\.a\} \/>/);
});

test('no HTML sink anywhere in the card code', () => {
  for (const f of ['src/renderer/src/components/HumanQuestionCard.tsx', 'src/renderer/src/components/humanQuestion.ts']) {
    const src = codeOnly(readSource(f));
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML|rehype-raw|rehypeRaw/, f);
  }
});

// ── T1: select-then-send, driven through the component's own handlers ─────

/** Render the card as a plain function with a minimal useState shim, so its real onClick /
 *  onKeyDown handlers can be invoked without a DOM (the repo has no DOM library). */
function drive(props) {
  const real = React.useState;
  const states = []; let n = 0;
  React.useState = (init) => { const i = n++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
    return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; };
  const render = () => { n = 0; try { return HumanQuestionCard(props); } finally { /* keep shim for re-renders */ } };
  const find = (el, pred, out = []) => {
    if (!el || typeof el !== 'object') return out;
    if (Array.isArray(el)) { for (const c of el) find(c, pred, out); return out; }
    if (el.props) { if (pred(el)) out.push(el); find(el.props.children, pred, out); }
    return out;
  };
  return { render, find, restore: () => { React.useState = real; } };
}

test('T1: clicking an option only selects it (never answers); the send button or Ctrl+Enter answers, once', () => {
  const calls = [];
  const d = drive({ entry: { q: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, onAnswer: (a) => { calls.push(a); } });
  try {
    let tree = d.render();
    const opt = (t, i) => d.find(t, (e) => e.props['data-option'] === i)[0];
    opt(tree, 1).props.onClick();
    tree = d.render();
    assert.deepEqual(calls, [], 'an option click never calls onAnswer');
    assert.equal(opt(tree, 1).props['aria-checked'], true, 'it is selected');
    opt(tree, 0).props.onClick(); tree = d.render();
    assert.deepEqual(calls, [], 'switching the selection does not answer either');
    const send = d.find(tree, (e) => typeof e.props.onClick === 'function' && e.props.variant === 'primary')[0];
    assert.ok(send, 'the send button');
    send.props.onClick();
    assert.deepEqual(calls, [{ text: 'A', chosen: [0] }], 'the button answers with the selection');
    const ta = d.find(tree, (e) => e.type === 'textarea')[0];
    ta.props.onKeyDown({ key: 'Enter', ctrlKey: true, metaKey: false });
    assert.equal(calls.length, 2, 'Ctrl+Enter answers too');
    ta.props.onKeyDown({ key: 'Enter', ctrlKey: false, metaKey: false });
    assert.equal(calls.length, 2, 'a plain Enter does not');
  } finally { d.restore(); }
});

test('T1: with nothing chosen and no note there is nothing to send', () => {
  const calls = [];
  const d = drive({ entry: { q: 'Which?', options: [{ label: 'A' }] }, onAnswer: (a) => { calls.push(a); } });
  try {
    const tree = d.render();
    const send = d.find(tree, (e) => typeof e.props.onClick === 'function' && e.props.variant === 'primary')[0];
    assert.equal(send.props.disabled, true);
    send.props.onClick();
    assert.deepEqual(calls, []);
  } finally { d.restore(); }
});

test('T2: an answer lands on the OPEN entry only, never on an earlier answered entry with the same q', () => {
  const earlier = { q: 'Same?', a: 'old answer', answeredAt: 'then' };
  const open = { q: 'Same?', askedAt: 'now' };
  const next = hq.recordAnswer([earlier, { ...open }], open, { text: 'new' }, 't');
  assert.deepEqual(next[0], earlier, 'the earlier answer is untouched');
  assert.equal(next[1].a, 'new', 'the re-parsed open copy (same q, unanswered) is answered');
});
