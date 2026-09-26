'use strict';
/**
 * NATIVE-MEMORY (1.1.54), the parts that run in plain Node: the tokenizer, the chunker, the
 * source allow-list and migration report, the CLI text, request validation, tokens, the main-side
 * client (deadlines, crash, lazy fork), the wiring (legacy = no change), the HookServer route and
 * the `mempalace` shim. The store/engine/worker against the real natives are in
 * native-memory-electron.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'native-memory-node-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson, basicTokens } = loadTs('src/main/nativeMemory/wordpiece.ts');
const { chunkMarkdown, CHUNK_MAX_TOKENS } = loadTs('src/main/nativeMemory/chunker.ts');
const { discoverSources, safeRelativeMd, MAX_SOURCE_BYTES } = loadTs('src/main/nativeMemory/sources.ts');
const { formatSearch, formatWakeUp } = loadTs('src/main/nativeMemory/format.ts');
const { ftsQuery, rrf, compactionDecision } = loadTs('src/main/nativeMemory/store.ts');
const { validateRequest, parseMode, MemoryTokens, NativeMemoryClient, EXIT } = loadTs('src/main/nativeMemory/service.ts');
const { NativeMemoryWiring, dbFileFor, toUnpacked } = loadTs('src/main/nativeMemory/mainWiring.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const REPO = path.resolve(__dirname, '..');
const TOKENIZER = path.join(REPO, 'resources', 'models', 'all-MiniLM-L6-v2', 'tokenizer.json');
const HAVE_TOKENIZER = fs.existsSync(TOKENIZER);
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const dir = () => fs.mkdtempSync(path.join(JAIL, 'd-'));
function hive(files) {
  const root = dir();
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return root;
}

// ── tokenizer ─────────────────────────────────────────────────────────────

test('WORDPIECE: BERT-uncased ids for known text ([CLS] hello world [SEP] = 101 7592 2088 102); accents stripped, punctuation split, [UNK] for an unknown word', { skip: !HAVE_TOKENIZER }, () => {
  const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(TOKENIZER, 'utf8'))));
  assert.deepEqual(tok.encode('Hello world'), [101, 7592, 2088, 102]);
  assert.deepEqual(tok.encode('HÉLLO, world!'), [101, 7592, 1010, 2088, 999, 102]);
  assert.deepEqual(basicTokens("don't stop"), ['don', "'", 't', 'stop']);
  assert.equal(tok.encode('a'.repeat(101))[1], 100, 'a word over max_input_chars_per_word is [UNK]');
  assert.equal(tok.encode('x '.repeat(600), 256).length, 256, 'truncated to the window, [SEP] kept last');
  assert.equal(tok.encode('x '.repeat(600), 256).at(-1), 102);
});

test('WORDPIECE: a tokenizer.json of another shape is refused, never silently mis-tokenized', () => {
  assert.throws(() => wordPieceConfigFromTokenizerJson({ normalizer: { type: 'NFC' }, pre_tokenizer: { type: 'BertPreTokenizer' }, model: { type: 'WordPiece', vocab: {} } }), /unsupported normalizer/);
  assert.throws(() => wordPieceConfigFromTokenizerJson({ normalizer: { type: 'BertNormalizer', lowercase: true, handle_chinese_chars: true, clean_text: true }, pre_tokenizer: { type: 'Whitespace' }, model: { type: 'WordPiece', vocab: {} } }), /pre-tokenizer/);
});

// ── chunker ───────────────────────────────────────────────────────────────

test('CHUNKER: deterministic; every chunk within the budget; a section heading rides on each of its chunks; fenced code is not split into sections', () => {
  const md = '# Top\nintro para\n\n## A\n' + 'alpha '.repeat(500) + '\n\n## B\n```\n# not a heading\ncode\n```\nafter\n';
  const a = chunkMarkdown(md, words);
  const b = chunkMarkdown(md, words);
  assert.deepEqual(a, b);
  for (const c of a) assert.ok(words(c.content) <= CHUNK_MAX_TOKENS, `chunk of ${words(c.content)}`);
  assert.ok(a.filter((c) => c.content.startsWith('## A\n')).length >= 3, 'the long section splits, each piece keeps its heading');
  assert.ok(a.some((c) => c.content.startsWith('## B\n```\n# not a heading')), 'a # inside a fence is text');
  assert.deepEqual(a.map((c) => c.ordinal), a.map((_, i) => i));
});

test('CHUNKER: appending an entry to memory.md changes NO existing chunk (the chunk-diff premise)', () => {
  const base = Array.from({ length: 40 }, (_, i) => `## 2026-09-${(i % 28) + 1} e${i}\n- fact ${i} ${'word '.repeat(i % 30)}`).join('\n\n');
  const before = chunkMarkdown(base, words);
  const after = chunkMarkdown(`${base}\n\n## 2026-09-29 new\n- a new fact\n`, words);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length).map((c) => c.contentSha), before.map((c) => c.contentSha));
  const edited = chunkMarkdown(base.replace('- fact 3 ', '- fact 3 (edited) '), words);
  const changed = edited.filter((c, i) => c.contentSha !== before[i].contentSha).length;
  assert.equal(changed, 1, 'an edit changes only its own section');
});

// ── sources ───────────────────────────────────────────────────────────────

test('ALLOW-LIST (section 1): memory.md and direct agent .md are eligible; nested, mail, data and top-level notes are not, and every excluded .md is REPORTED by path', () => {
  const root = hive({
    'agents/a1/memory.md': 'm', 'agents/a1/AUDIT.md': 'a', 'agents/a1/data.json': '{}', 'agents/a1/run.txt': 't',
    'agents/a1/sub/NESTED.md': 'n', 'agents/a1/inbox/x.md': 'mail', 'agents/a1/.claude/skills/s/SKILL.md': 's',
    'agents/b2/memory.md': 'm2', 'board.md': 'b', 'NOTE.md': 'n', 'agents/bad id/memory.md': 'x'
  });
  const d = discoverSources(root);
  assert.deepEqual(d.eligible.map((e) => `${e.path}|${e.kind}|${e.wing}|${e.room}`).sort(), [
    'agents/a1/AUDIT.md|deliverable|a1|audit', 'agents/a1/memory.md|memory|a1|memory', 'agents/b2/memory.md|memory|b2|memory'
  ]);
  assert.deepEqual(d.excludedMd, ['NOTE.md', 'agents/a1/.claude/skills/s/SKILL.md', 'agents/a1/sub/NESTED.md', 'board.md']);
  assert.ok(!d.excludedMd.some((p) => p.includes('inbox')), 'mail is never walked');
  assert.equal(d.allowListVersion, 1);
  assert.equal(d.counts.eligible, 3);
});

test('ALLOW-LIST opt-ins (items 3-4): the god-approved top-level list and a per-agent nested include; board.md, path escapes and missing files are REJECTED', () => {
  const root = hive({
    'agents/a1/memory.md': 'm', 'agents/a1/capui-tidy-doc/PROVIDER-CAPACITY-UI-AUDIT.md': 'audit', 'NOTE.md': 'n', 'board.md': 'b',
    'memory-sources.json': JSON.stringify({ topLevel: ['NOTE.md', 'board.md', '../x.md', 'missing.md'], include: { a1: ['capui-tidy-doc/PROVIDER-CAPACITY-UI-AUDIT.md', '../../escape.md', 'C:/abs.md'] } })
  });
  const d = discoverSources(root);
  const paths = d.eligible.map((e) => e.path).sort();
  assert.deepEqual(paths, ['NOTE.md', 'agents/a1/capui-tidy-doc/PROVIDER-CAPACITY-UI-AUDIT.md', 'agents/a1/memory.md']);
  assert.equal(d.eligible.find((e) => e.path === 'NOTE.md').wing, 'hive');
  assert.deepEqual(d.rejectedConfig.sort(), ['../x.md', 'agents/a1/../../escape.md', 'agents/a1/C:/abs.md', 'board.md', 'missing.md']);
  assert.deepEqual(d.excludedMd, ['board.md']);
  assert.equal(safeRelativeMd('a/../b.md'), null);
  assert.equal(safeRelativeMd('a/b.md'), 'a/b.md');
});

test('ALLOW-LIST: a Markdown file over the size cap is excluded by rule (a pasted log is not memory)', () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'agents/a1/HUGE.md': 'x'.repeat(MAX_SOURCE_BYTES + 1) });
  const d = discoverSources(root);
  assert.deepEqual(d.eligible.map((e) => e.path), ['agents/a1/memory.md']);
  assert.deepEqual(d.excludedMd, ['agents/a1/HUGE.md']);
});

// ── text ──────────────────────────────────────────────────────────────────

test('GOLDEN search text = MemPalace 3.7.1 searcher.py (hybrid path), including the filter lines and the no-results line', () => {
  const hits = [{ chunkId: 1, wing: 'oscar-mu3300lb', room: 'general', source: 'agents/oscar-mu3300lb/UPSTREAM.md', content: 'line one\nline two\n', cosineSim: 0.4361, bm25: 1.3472, score: 1 }];
  const text = formatSearch('log rotation', { wing: 'oscar-mu3300lb', since: '2026-09-01' }, hits);
  assert.equal(text, [
    '', '='.repeat(60), '  Results for: "log rotation"', '  Wing: oscar-mu3300lb', '  Since: 2026-09-01', '='.repeat(60), '',
    '  [1] oscar-mu3300lb / general', '      Source: UPSTREAM.md', '      Match:  cosine_sim=0.436  bm25=1.347', '',
    '      line one', '      line two', '', `  ${'-'.repeat(56)}`, '', ''
  ].join('\n'));
  assert.equal(formatSearch('nothing', {}, []), '\n  No results found for: "nothing"\n');
  assert.match(formatSearch('q', {}, [{ ...hits[0], cosineSim: null, bm25: 2 }]), /cosine_sim=0\.0 {2}bm25=2\.0/);
});

test('WAKE-UP contract (section 4): L0 identity, then the newest memory entries first; bounded; the legacy frame', () => {
  const t = formatWakeUp('You are X.', [{ wing: 'x', room: 'memory', source: 'agents/x/memory.md', content: '## d\n- newest' }, { wing: 'x', room: 'audit', source: 'agents/x/AUDIT.md', content: 'y'.repeat(900) }]);
  assert.match(t, /^Wake-up text \(~\d+ tokens\):\n={50}\n## L0 — IDENTITY\nYou are X\.\n\n## L1 — ESSENTIAL STORY\n\n\[memory\]\n {2}- ## d - newest {2}\(memory\.md\)\n\n\[audit\]\n {2}- y{397}\.\.\. {2}\(AUDIT\.md\)\n$/);
  assert.match(formatWakeUp(null, []), /No identity file[\s\S]*## L1 — No memories yet\./);
});

test('FTS query + RRF + compaction policy (pure)', () => {
  assert.equal(ftsQuery('   '), null);
  assert.equal(ftsQuery('a "b" c*'), null, 'single letters alone are not a query');
  assert.equal(ftsQuery('log.jsonl rotation'), '"log" OR "jsonl" OR "rotation"');
  assert.deepEqual(rrf([1, 2, 3], [3, 4]).map((r) => r.id), [3, 1, 4, 2], '2 and 4 tie at 1/62: the one with a vector rank goes first');
  assert.deepEqual(rrf([1], [2]).map((r) => r.id), [2, 1], 'a tie goes to the vector rank');
  assert.equal(compactionDecision(20e6, 5e6, 0), 'compact');
  assert.equal(compactionDecision(15e6, 5e6, 0), 'none', 'under 16 MiB the size rule does not fire');
  assert.equal(compactionDecision(2e6, 1.9e6, 0.26), 'compact', 'freelist >= 25%');
  assert.equal(compactionDecision(90e6, 10e6, 0), 'force', 'past 8x live: forced + health row');
});

// ── requests, tokens, client ─────────────────────────────────────────────

test('VALIDATION (section 6): ranges, ISO dates, wing names, --palace must be a served path; wake-up without --wing is the CALLER\'s', () => {
  const served = ['C:\\Dunder\\hive', 'C:/Dunder/palace'];
  assert.deepEqual(validateRequest({ cmd: 'search', args: { query: 'x', results: 3 } }, 'a1', served), { op: 'search', args: { query: 'x', wing: null, room: null, results: 3, since: null, before: null } });
  for (const bad of [{ query: '' }, { query: 'x', results: 0 }, { query: 'x', results: 101 }, { query: 'x', results: 2.5 }, { query: 'x', wing: 'a b' }, { query: 'x', since: 'yesterday' }, { query: 'x'.repeat(2001) }]) {
    assert.equal(validateRequest({ cmd: 'search', args: bad }, 'a1', served).exit, EXIT.usage, JSON.stringify(bad));
  }
  assert.deepEqual(validateRequest({ cmd: 'wake-up', args: {} }, 'andy', served), { op: 'wake-up', args: { wing: 'andy' } });
  assert.deepEqual(validateRequest({ cmd: 'wake-up', args: { wing: 'jim' } }, 'andy', served), { op: 'wake-up', args: { wing: 'jim' } });
  assert.equal(validateRequest({ cmd: 'search', args: { query: 'x' }, palace: 'c:/dunder/palace/' }, 'a', served).op, 'search', '--palace = the served palace (case, slashes)');
  assert.equal(validateRequest({ cmd: 'search', args: { query: 'x' }, palace: 'D:/other' }, 'a', served).exit, EXIT.usage);
  assert.equal(validateRequest({ cmd: 'mine', args: {} }, 'a', served).exit, EXIT.usage);
  assert.equal(parseMode('{"mode":"native"}'), 'native');
  assert.equal(parseMode('{"mode":"yolo"}'), 'legacy');
  assert.equal(parseMode(null), 'legacy');
});

test('MEMORY_TOKEN: minted per agent, resolves only its own agent, revoked on exit, re-minting retires the old one', () => {
  const t = new MemoryTokens();
  const a = t.mint('a1');
  const b = t.mint('b2');
  assert.equal(t.resolve(a), 'a1');
  assert.equal(t.resolve(b), 'b2');
  assert.equal(t.resolve('0'.repeat(32)), null);
  assert.equal(t.resolve('nothex'), null);
  const a2 = t.mint('a1');
  assert.equal(t.resolve(a), null, 'a respawn retires the old token');
  assert.equal(t.resolve(a2), 'a1');
  t.revoke('a1');
  assert.equal(t.resolve(a2), null);
});

function fakeWorker() {
  const w = { posted: [], handlers: { message: [], exit: [] }, killed: false };
  w.postMessage = (m) => w.posted.push(m);
  w.on = (ev, fn) => w.handlers[ev].push(fn);
  w.kill = () => { w.killed = true; return true; };
  w.reply = (m) => w.handlers.message.forEach((f) => f(m));
  w.exit = (c) => w.handlers.exit.forEach((f) => f(c));
  return w;
}

test('CLIENT (section 3): no fork until the first request; one init; replies by id; a named degraded reply at the deadline; a crash answers in-flight requests and re-forks, bounded', async () => {
  const workers = [];
  const timers = [];
  let now = 1000;
  const c = new NativeMemoryClient({
    fork: () => { const w = fakeWorker(); workers.push(w); return w; },
    config: () => ({ hiveRoot: 'h' }), now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; }
  });
  assert.equal(c.forked, false, 'nothing forked at construction (lazy)');
  const p1 = c.request('search', { query: 'x' });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].posted[0].op, 'init');
  const req = workers[0].posted[1];
  assert.equal(req.op, 'search');
  assert.equal(req.deadline, 1000 + 2000, 'cold deadline 2 s');
  workers[0].reply({ id: req.id, ok: true, exit: 0, text: 'T' });
  assert.deepEqual(await p1, { ok: true, exit: 0, text: 'T', json: undefined, error: undefined });
  const p2 = c.request('search', { query: 'y' });
  assert.equal(workers[0].posted[2].deadline, 1000 + 250, 'warm deadline 250 ms');
  const t = timers.find((x) => !x.cleared && x.at === 1250);
  t.fn();
  assert.equal((await p2).exit, EXIT.degraded, 'the caller is never blocked past the deadline');
  const p3 = c.request('status', {});
  workers[0].exit(1);
  assert.equal((await p3).error, 'memory worker exited');
  for (let i = 0; i < 3; i++) { void c.request('status', {}); workers.at(-1).exit(1); }
  const down = await c.request('status', {});
  assert.equal(down.exit, EXIT.unavailable, 'after too many crashes the worker stays down (exit 3)');
  assert.equal(workers.length, 4);
});

test('CLIENT: no runtime pieces (no config) = exit 3 and nothing forked', async () => {
  let forks = 0;
  const c = new NativeMemoryClient({ fork: () => { forks++; return fakeWorker(); }, config: () => null });
  assert.equal((await c.request('search', { query: 'x' })).exit, EXIT.unavailable);
  assert.equal(forks, 0);
});

// ── wiring ────────────────────────────────────────────────────────────────

function wiring(root, over = {}) {
  const logs = [];
  const workers = [];
  const w = new NativeMemoryWiring({
    hiveRoot: () => root, palacePath: () => path.join(root, 'palace'), userData: path.join(root, 'ud'), resourcesDir: path.join(root, 'res'),
    workerEntry: 'w.js', fork: () => { const x = fakeWorker(); workers.push(x); return x; }, memoryBaseUrl: () => 'http://127.0.0.1:5555/memory',
    legacyBin: () => 'C:/uv/mempalace.exe', writeShim: () => path.join(root, 'bin', 'memory'), log: (r) => logs.push(r), vecLoadablePath: () => null, ...over
  });
  return { w, logs, workers };
}

test('WIRING: mode `legacy` (the default) changes NOTHING - no env, no PATH, the endpoint answers native-memory-off, nothing forked', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm' });
  const { w, workers } = wiring(root);
  assert.equal(w.mode(), 'legacy');
  assert.deepEqual(w.spawnEnv('a1', 'C:/Windows'), {});
  const tok = w.tokens.mint('a1');
  const r = await w.handle(tok, { cmd: 'search', args: { query: 'x' } });
  assert.equal(r.body.exit, EXIT.unavailable);
  assert.equal(workers.length, 0);
});

test('WIRING: past legacy an agent gets MEMORY_TOKEN, the endpoint, its hive, the legacy CLI path, and PATH with the shim dir FIRST; a bad token is 403/exit 5', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'memory-engine.json': '{"mode":"native"}' });
  const { w } = wiring(root);
  const env = w.spawnEnv('a1', 'C:\\Windows;C:\\uv');
  assert.match(env.MEMORY_TOKEN, /^[0-9a-f]{32}$/);
  assert.equal(env.MUNDER_MEMORY_URL, 'http://127.0.0.1:5555/memory');
  assert.equal(env.MUNDER_HIVE_ROOT, root);
  assert.equal(env.MUNDER_LEGACY_MEMPALACE, 'C:/uv/mempalace.exe');
  assert.equal(env.PATH.split(path.delimiter)[0], path.join(root, 'bin', 'memory'), 'the shim resolves before a uv-installed mempalace');
  assert.equal((await w.handle('f'.repeat(32), { cmd: 'status' })).status, 403);
  assert.equal(w.tokens.resolve(env.MEMORY_TOKEN), 'a1');
  w.agentExited('a1');
  assert.equal(w.tokens.resolve(env.MEMORY_TOKEN), null, 'revoked with the agent');
});

test('WIRING: shadow requests log ONLY a redacted row (a query hash, counts, overlap, latency) - never the query text', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'memory-engine.json': '{"mode":"shadow"}' });
  const { w, logs } = wiring(root);
  w.client.request = async () => ({ ok: true, exit: 0, json: [{ wing: 'a1', source: 'agents/a1/memory.md' }, { wing: 'b2', source: 'agents/b2/X.md' }] });
  const tok = w.tokens.mint('a1');
  const r = await w.handle(tok, { cmd: 'shadow', args: { query: 'secret project name', legacy: [{ rank: 1, wing: 'a1', room: 'memory', source: 'memory.md' }], legacyMs: 1600 } });
  assert.equal(r.body.exit, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'native-memory-shadow');
  assert.equal(logs[0].overlapSources, 1);
  assert.equal(logs[0].legacyMs, 1600);
  assert.ok(!JSON.stringify(logs).includes('secret'), 'no query text stored');
});

test('WIRING: the vec0 path maps from inside app.asar to app.asar.unpacked (the installed layout nests it under sqlite-vec)', () => {
  assert.equal(toUnpacked('C:\\P\\resources\\app.asar\\node_modules\\sqlite-vec\\node_modules\\sqlite-vec-windows-x64\\vec0.dll'), 'C:\\P\\resources\\app.asar.unpacked\\node_modules\\sqlite-vec\\node_modules\\sqlite-vec-windows-x64\\vec0.dll');
  assert.equal(toUnpacked('/a/app.asar/x.dll'), '/a/app.asar.unpacked/x.dll');
  assert.equal(toUnpacked('C:/dev/node_modules/sqlite-vec-windows-x64/vec0.dll'), 'C:/dev/node_modules/sqlite-vec-windows-x64/vec0.dll', 'dev: unchanged');
});

test('WIRING: the index file is keyed by the hive root (two hives / dev and stable never share one)', () => {
  assert.equal(dbFileFor('U', 'C:\\Dunder\\hive'), dbFileFor('U', 'c:/dunder/hive'));
  assert.notEqual(dbFileFor('U', 'C:/Dunder/hive'), dbFileFor('U', 'C:/Dunder/hive-dev'));
  assert.match(dbFileFor('U', 'C:/x'), /memory[\\/][0-9a-f]{16}\.sqlite$/);
});

// ── HTTP route ────────────────────────────────────────────────────────────

async function server(t) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\nm-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(dir(), 's.sock');
  const hiveStub = { sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const s = new HookServer(hiveStub, () => null, () => ({}), undefined, undefined, undefined, () => {});
  s.start(); t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return s;
}
function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': data.length } }, (res) => {
      let o = ''; res.on('data', (d) => { o += d; }); res.on('end', () => resolve({ status: res.statusCode, body: o }));
    });
    req.on('error', reject); req.end(data);
  });
}

test('ROUTE: /memory/<token> reaches the handler with the token and body; no handler = 404; oversize = 413; not a hook route', async (t) => {
  const s = await server(t);
  const base = s.memoryBaseUrl();
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/memory$/);
  const tok = 'ab'.repeat(16);
  assert.equal((await post(`${base}/${tok}`, {})).status, 404, 'no handler (legacy): the route does not exist');
  const seen = [];
  s.setMemoryHandler(async (token, body) => { seen.push({ token, body }); return { status: 200, body: { exit: 0, text: 'ok' } }; });
  const r = await post(`${base}/${tok}`, { cmd: 'status' });
  assert.deepEqual(JSON.parse(r.body), { exit: 0, text: 'ok' });
  assert.deepEqual(seen, [{ token: tok, body: { cmd: 'status' } }]);
  assert.equal((await post(`${base}/${tok}`, 'x'.repeat(70 * 1024))).status, 413);
  assert.equal((await post(`${base}/nothex`, {})).status, 404);
});

// ── the shim ──────────────────────────────────────────────────────────────

const SHIM = path.join(REPO, 'resources', 'mempalace-shim.cjs');
function loadShim(spawnSyncImpl) {
  const cp = require('node:child_process');
  const real = cp.spawnSync;
  cp.spawnSync = spawnSyncImpl;
  delete require.cache[require.resolve(SHIM)];
  try { return require(SHIM); } finally { cp.spawnSync = real; }
}
/** Run shim.main with its output captured through the injectable writers (never by patching
 *  process.stdout, which the test runner itself is writing to). */
async function capture(fn) {
  const out = []; const err = [];
  const io = { out: (d) => { out.push(String(d)); return true; }, err: (d) => { err.push(String(d)); return true; } };
  const code = await fn(io);
  return { code, out: out.join(''), err: err.join('') };
}

test('SHIM parseArgs: MemPalace 3.7.1 argv shapes (global --palace, --flag value and --flag=value, a multi-word query)', () => {
  const { parseArgs } = loadShim(() => ({}));
  assert.deepEqual(parseArgs(['--palace', 'P', 'search', 'log', 'rotation', '--wing', 'w', '--results=3']).args, { wing: 'w', results: 3, query: 'log rotation' });
  assert.equal(parseArgs(['--palace', 'P', 'search', 'x']).palace, 'P');
  assert.equal(parseArgs(['wake-up', '--wing', 'andy']).args.wing, 'andy');
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['search', 'x', '--wing']), /needs a value/);
});

test('SHIM modes: legacy / fallback-legacy EXEC the legacy CLI with the same argv; native posts to the endpoint and prints its text with its exit; mine is a named refusal', async (t) => {
  const calls = [];
  const shim = loadShim((bin, argv, o) => { calls.push({ bin, argv, stdio: o.stdio }); return { status: 7, stdout: Buffer.from('LEGACY OUT\n') }; });
  const root = hive({});
  const legacyBin = process.execPath;
  const env = (mode, extra = {}) => { fs.writeFileSync(path.join(root, 'memory-engine.json'), JSON.stringify({ mode })); return { MUNDER_HIVE_ROOT: root, MUNDER_LEGACY_MEMPALACE: legacyBin, ...extra }; };
  assert.equal((await capture((io) => shim.main(['search', 'x'], env('legacy'), io))).code, 7, 'legacy: its exit code');
  assert.deepEqual(calls[0].argv, ['search', 'x']);
  assert.equal((await capture((io) => shim.main(['--palace', 'P', 'wake-up'], env('fallback-legacy'), io))).code, 7);
  assert.deepEqual(calls[1].argv, ['--palace', 'P', 'wake-up']);
  // native, against a real loopback endpoint
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(b) });
      if (req.url.endsWith('/' + 'cd'.repeat(16))) { res.writeHead(403); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ exit: 0, text: 'NATIVE TEXT\n' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/memory`;
  const n = await capture((io) => shim.main(['search', 'log', 'rotation', '--wing', 'jim'], env('native', { MUNDER_MEMORY_URL: url, MEMORY_TOKEN: 'ab'.repeat(16), MEMPALACE_PALACE_PATH: 'C:/Dunder/palace' }), io));
  assert.deepEqual(n, { code: 0, out: 'NATIVE TEXT\n', err: '' });
  assert.deepEqual(seen[0], { url: `/memory/${'ab'.repeat(16)}`, body: { cmd: 'search', args: { wing: 'jim', query: 'log rotation' }, palace: 'C:/Dunder/palace' } });
  assert.equal((await capture((io) => shim.main(['status'], env('native', { MUNDER_MEMORY_URL: url, MEMORY_TOKEN: 'cd'.repeat(16) }), io))).code, 5, '403 -> exit 5');
  const mine = await capture((io) => shim.main(['mine', 'x'], env('native', { MUNDER_MEMORY_URL: url, MEMORY_TOKEN: 'ab'.repeat(16) }), io));
  assert.equal(mine.code, 2);
  assert.match(mine.err, /not available with the native memory engine/);
  assert.equal(calls.length, 2, 'native never runs the legacy CLI');
});

test('SHIM: app not running = exit 3 with one line of guidance; no endpoint env = exit 3; shadow prints ONLY legacy output and sends its ranks', async (t) => {
  const posts = [];
  const shim = loadShim((bin, argv) => ({ status: 0, stdout: Buffer.from('\n' + '='.repeat(60) + '\n  Results for: "q"\n' + '='.repeat(60) + '\n\n  [1] jim / general\n      Source: AUDIT.md\n      Match:  cosine_sim=0.5  bm25=1.0\n\n      x\n\n') }));
  const root = hive({});
  fs.writeFileSync(path.join(root, 'memory-engine.json'), '{"mode":"native"}');
  const down = await capture((io) => shim.main(['search', 'q'], { MUNDER_HIVE_ROOT: root, MUNDER_MEMORY_URL: 'http://127.0.0.1:1/memory', MEMORY_TOKEN: 'ab'.repeat(16) }, io));
  assert.equal(down.code, 3);
  assert.equal(down.err.trim().split('\n').length, 1);
  assert.equal((await capture((io) => shim.main(['search', 'q'], { MUNDER_HIVE_ROOT: root }, io))).code, 3);
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { posts.push(JSON.parse(b)); res.end('{"exit":0}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  fs.writeFileSync(path.join(root, 'memory-engine.json'), '{"mode":"shadow"}');
  const sh = await capture((io) => shim.main(['search', 'q'], { MUNDER_HIVE_ROOT: root, MUNDER_LEGACY_MEMPALACE: process.execPath, MUNDER_MEMORY_URL: `http://127.0.0.1:${srv.address().port}/memory`, MEMORY_TOKEN: 'ab'.repeat(16) }, io));
  assert.equal(sh.code, 0);
  assert.match(sh.out, /\[1\] jim \/ general/);
  assert.ok(!sh.out.includes('NATIVE'), 'shadow prints only the legacy answer');
  assert.equal(posts[0].cmd, 'shadow');
  assert.deepEqual(posts[0].args.legacy, [{ rank: 1, wing: 'jim', room: 'general', source: 'AUDIT.md' }]);
});

test('SHIM on PATH (section 6): the generated wrappers run the shim on Electron-as-Node, and are rewritten only when changed', () => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = dir();
  const h = new HiveManager(() => home);
  fs.mkdirSync(path.join(home, 'hive'), { recursive: true });
  const d = h.writeMemoryShim('C:\\app\\resources\\mempalace-shim.cjs');
  assert.equal(d, path.join(home, 'hive', 'bin', 'memory'));
  if (process.platform === 'win32') {
    assert.equal(fs.readFileSync(path.join(d, 'mempalace.cmd'), 'utf8'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "C:\\app\\resources\\mempalace-shim.cjs" %*\r\n`);
    assert.equal(fs.readFileSync(path.join(d, 'mempalace'), 'utf8'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath.replace(/\\/g, '/')}" "C:/app/resources/mempalace-shim.cjs" "$@"\n`);
  }
  const m0 = fs.statSync(path.join(d, 'mempalace')).mtimeMs;
  h.writeMemoryShim('C:\\app\\resources\\mempalace-shim.cjs');
  assert.equal(fs.statSync(path.join(d, 'mempalace')).mtimeMs, m0, 'unchanged content is not rewritten');
  h.dispose();
});

// ── parity statistics (gate 4) ────────────────────────────────────────────

test('PARITY STATS: NDCG@5 / recall@10 by hand; a paired bootstrap is seeded and brackets the mean; kappa; the gate fails a real regression and passes parity', () => {
  const S = require(path.join(REPO, 'scripts', 'native-memory-parity-stats.cjs'));
  assert.ok(Math.abs(S.ndcgAt([2, 0, 1], [2, 1, 0], 5) - ((3 + 1 / 2) / (3 + 1 / Math.log2(3)))) < 1e-12);
  assert.equal(S.ndcgAt([0, 0], [0, 0], 5), null, 'no relevant item: not scored');
  assert.equal(S.recallAt([1, 0, 2], [1, 2, 1, 0], 10), 2 / 3);
  const a = S.pairedBootstrap([0.1, -0.05, 0.02, 0.0, 0.03], 2000, 7);
  const b = S.pairedBootstrap([0.1, -0.05, 0.02, 0.0, 0.03], 2000, 7);
  assert.deepEqual(a, b, 'seeded');
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
  assert.equal(S.kappa({ x: 0, y: 1, z: 2 }, { x: 0, y: 1, z: 2 }), 1);
  // Synthetic: 10 semantic queries; items A (legacy rank 1) and B (native rank 1).
  const mk = (nativeGood) => {
    const sheet = { queries: [] }; const key = []; const pub = { results: [] };
    for (let i = 1; i <= 10; i++) {
      const qid = `q${i}`;
      sheet.queries.push({ qid, items: [{ item: `${qid}-A`, label: 2 }, { item: `${qid}-B`, label: nativeGood ? 2 : 0 }] });
      key.push({ qid, cohort: 'semantic', items: [{ item: `${qid}-A`, legacyRank: 1, nativeRank: nativeGood ? 2 : null }, { item: `${qid}-B`, legacyRank: null, nativeRank: 1 }] });
      pub.results.push({ qid, legacy: [{ scope: 'in-scope' }] });
    }
    return { sheet, key, pub };
  };
  assert.equal(S.evaluate(mk(true)).pass, true, 'native as good: pass');
  const bad = S.evaluate(mk(false));
  assert.equal(bad.pass, false, 'native misses the relevant item every time: fail');
  assert.ok(bad.adjusted.overall.ndcg5.lo < -0.05);
  // The same misses, but legacy's item is out of scope (excluded): scope-adjusted, not a regression.
  const ex = mk(false);
  ex.pub.results.forEach((r) => { r.legacy[0].scope = 'excluded'; });
  const exr = S.evaluate(ex);
  assert.equal(exr.raw.overall.pass, false);
  assert.notEqual(exr.adjusted.overall.ndcg5?.lo ?? 0, bad.adjusted.overall.ndcg5.lo, 'excluded legacy hits leave the judged pool');
});

test('ZERO PYTHON (and zero child processes) on the native path: the built worker bundle never requires child_process; native CLI calls never run the legacy CLI (see SHIM modes)', () => {
  const bundle = path.join(REPO, 'out', 'main', 'memoryWorker.js');
  if (!fs.existsSync(bundle)) return;   // built by `npm run build`; the gate runs after it
  const src = fs.readFileSync(bundle, 'utf8');
  assert.doesNotMatch(src, /require\("(node:)?child_process"\)/);
  assert.doesNotMatch(src, /\bpython\b|\buv tool\b/i);
});

test('MAIN BUDGET (section 3): the synchronous part of a memory request in main (token, mode, validation, post) stays well under 2 ms p95', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'memory-engine.json': '{"mode":"native"}' });
  const { w } = wiring(root);
  w.client.request = () => new Promise(() => {});   // the worker's time is not main's
  const tok = w.tokens.mint('a1');
  const times = [];
  for (let i = 0; i < 400; i++) {
    const t0 = process.hrtime.bigint();
    void w.handle(tok, { cmd: 'search', args: { query: `query ${i}`, results: 5 } });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)] < 2, `p95 ${times[Math.floor(times.length * 0.95)].toFixed(3)} ms`);
});

test('IDLE UNLOAD (Jim R2): every embed re-arms ONE unload timer of MODEL_IDLE_UNLOAD_MS; firing it unloads the model', async () => {
  const { MemoryEngine, MODEL_IDLE_UNLOAD_MS } = loadTs('src/main/nativeMemory/engine.ts');
  const timers = [];
  let unloaded = 0;
  const emb = { loaded: true, embed: async (t) => t.map(() => new Float32Array(384)), unload: async () => { unloaded++; } };
  const store = { search: () => [] };
  const e = new MemoryEngine({ hiveRoot: dir(), store, embedder: emb, countTokens: words, mode: () => 'native', watch: null,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); if (ms === 0) setImmediate(fn); return t; }, clearTimer: (t) => { t.cleared = true; } });
  await e.search({ query: 'a' });
  await e.search({ query: 'b' });
  const unloadTimers = timers.filter((t) => t.ms === MODEL_IDLE_UNLOAD_MS);
  assert.equal(unloadTimers.length, 2);
  assert.equal(unloadTimers[0].cleared, true, 're-armed, not stacked');
  unloadTimers[1].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(unloaded, 1);
});

test('ALLOW-LIST: a DIRECTORY named like a Markdown file is not a source', () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'agents/a1/notes.md/inner.txt': 'x' });
  assert.deepEqual(discoverSources(root).eligible.map((e) => e.path), ['agents/a1/memory.md']);
});

test('PARITY STATS: a cohort whose queries have no relevant item (no-match) is reported, not gated; excluded queries are not scored', () => {
  const S = require(path.join(REPO, 'scripts', 'native-memory-parity-stats.cjs'));
  const sheet = { queries: [] }; const key = []; const pub = { results: [] };
  for (let i = 1; i <= 9; i++) {
    const qid = `n${i}`;
    sheet.queries.push({ qid, items: [{ item: `${qid}-A`, label: 0 }, { item: `${qid}-B`, label: 0 }] });
    key.push({ qid, cohort: 'no-match', items: [{ item: `${qid}-A`, legacyRank: 1, nativeRank: null }, { item: `${qid}-B`, legacyRank: null, nativeRank: 1 }] });
    pub.results.push({ qid, legacy: [{ scope: 'in-scope' }] });
  }
  sheet.queries.push({ qid: 's1', items: [{ item: 's1-A', label: 2 }] });
  key.push({ qid: 's1', cohort: 'semantic', items: [{ item: 's1-A', legacyRank: 1, nativeRank: 1 }] });
  pub.results.push({ qid: 's1', legacy: [{ scope: 'in-scope' }] });
  const r = S.evaluate({ sheet, key, pub, exclude: ['n9'] });
  assert.equal(r.labelledQueries, 9, 'n9 excluded');
  assert.deepEqual(r.excluded, ['n9']);
  assert.equal(r.adjusted['no-match'].scored, 0);
  assert.equal(r.adjusted['no-match'].gated, false);
  assert.equal(r.adjusted['no-match'].pass, null);
});

// ── gate 6 (god's gate-4 decision): per-cohort shadow diagnostics ─────────

test('GATE-6 DIAGNOSTICS: queries are classified into the spec cohorts by shape; the review window is opt-in, dated and self-expiring', () => {
  const { classifyQuery, reviewCaptureActive } = loadTs('src/main/nativeMemory/service.ts');
  assert.equal(classifyQuery('anything', 'jim-mtujpe28'), 'wing-scoped');
  for (const q of ['LOG-STALL rotation', 'commit 4955862c', '1.1.52 palace repair', 'worker_wake stall', 'hooks.ts route']) assert.equal(classifyQuery(q, null), 'exact-identifier', q);
  for (const q of ['"kept open" log', 'C:/Dunder path', 'why: the gate', 'item (b) decision']) assert.equal(classifyQuery(q, null), 'punctuation', q);
  assert.equal(classifyQuery('how does the wake confirmation work', null), 'semantic');
  const now = Date.parse('2026-09-27T00:00:00Z');
  assert.equal(reviewCaptureActive(null, now), false, 'default: off');
  assert.equal(reviewCaptureActive('{"mode":"shadow"}', now), false);
  assert.equal(reviewCaptureActive('{"mode":"shadow","reviewCaptureUntil":"2026-09-28T00:00:00Z"}', now), true);
  assert.equal(reviewCaptureActive('{"mode":"shadow","reviewCaptureUntil":"2026-09-26T00:00:00Z"}', now), false, 'expires by itself');
  assert.equal(reviewCaptureActive('{"reviewCaptureUntil":"soon"}', now), false);
});

test('GATE-6 DIAGNOSTICS: the redacted shadow row carries the cohort and ranked source HASHES (never text); the review flag reaches the worker only inside the window', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'memory-engine.json': '{"mode":"shadow"}' });
  const { w, logs } = wiring(root);
  const sent = [];
  w.client.request = async (op, args) => { sent.push({ op, args }); return { ok: true, exit: 0, json: [{ wing: 'a1', source: 'agents/a1/memory.md' }] }; };
  const tok = w.tokens.mint('a1');
  await w.handle(tok, { cmd: 'shadow', args: { query: 'LOG-STALL secret text', legacy: [{ rank: 1, wing: 'a1', room: 'memory', source: 'memory.md' }], legacyMs: 1500 } });
  assert.equal(logs[0].cohort, 'exact-identifier');
  assert.equal(logs[0].legacyRanked.length, 1);
  assert.deepEqual(logs[0].legacyRanked, logs[0].nativeRanked, 'same wing|source -> same hash');
  assert.equal(logs[0].reviewCaptured, false);
  assert.equal(sent[0].args.review, false);
  assert.ok(!JSON.stringify(logs).includes('secret'));
  await w.handle(tok, { cmd: 'shadow', args: { query: 'nothing found here', legacy: [] } });
  assert.equal(logs[1].cohort, 'no-match', 'legacy answered nothing');
  fs.writeFileSync(path.join(root, 'memory-engine.json'), JSON.stringify({ mode: 'shadow', reviewCaptureUntil: new Date(Date.now() + 3600e3).toISOString() }));
  await w.handle(tok, { cmd: 'shadow', args: { query: 'q', legacy: [] } });
  assert.equal(sent[2].args.review, true, 'inside the window the worker is told to capture');
  assert.equal(sent[2].args.agent, 'a1');
  assert.equal(logs[2].reviewCaptured, true);
  assert.ok(!JSON.stringify(logs).includes('"q"'), 'the hive log still has no text');
});
