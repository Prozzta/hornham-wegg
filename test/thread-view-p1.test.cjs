const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { Worker } = require('node:worker_threads');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadThreadStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-thread-view-'));
  const out = path.join(dir, 'threadView.cjs');
  const compiled = ts.transpileModule(read('src/main/threadView.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  fs.writeFileSync(out, compiled);
  return { store: require(out), dir };
}

test('THREAD-VIEW keeps private history outside hive and bounds it', () => {
  const source = read('src/main/threadView.ts');
  assert.match(source, /PER_AGENT_CAP = 8 \* 1024 \* 1024/);
  assert.match(source, /GLOBAL_CAP = 128 \* 1024 \* 1024/);
  assert.match(source, /resolve\(userData, 'threads'\)/);
  assert.doesNotMatch(source, /harnessHome|agents\/.*thread/);
  const list = source.slice(source.indexOf('async list('), source.indexOf('async archive('));
  assert.match(list, /LIST_PAGE_BYTES/);
  assert.match(list, /LIST_MAX_BYTES/);
  assert.match(list, /while \(end > 0/, 'history must page backward within a segment');
  assert.match(list, /await handle\.read\(/);
  assert.doesNotMatch(list, /readFile\(/, 'initial Talk history must not parse the whole projection on main');
});

test('THREAD-VIEW admits a one-time Human receipt and blocks machine interference', () => {
  const source = read('src/main/threadView.ts');
  assert.match(source, /kind: 'human-ui' \| 'human-terminal' \| 'machine'/);
  assert.match(source, /matching\.some\(\(r\) => r\.kind === 'machine'\)/);
  assert.match(source, /receipt\.consumed = true/);
  assert.match(source, /RECEIPT_TTL_MS/);
  assert.match(source, /RECEIPT_LIMIT/);
});

test('Michael starts on Talk without terminal resize churn', () => {
  const commandCenter = read('src/renderer/src/components/CommandCenterPanel.tsx');
  const talk = read('src/renderer/src/components/ThreadTalkPanel.tsx');
  assert.match(commandCenter, /useState<CCTab>\('talk'\)/);
  assert.match(commandCenter, /ThreadTalkPanel/);
  assert.match(commandCenter, /toggleThreadSplit/);
  assert.match(commandCenter, /threadLayout\?\.split/);
  assert.match(talk, /does not mount or[\s\S]*resize an xterm/);
  assert.match(talk, /onThreadEvent/);
  assert.doesNotMatch(talk, /setInterval\(load, 2000\)/, 'Talk must use normalized delta delivery, not history polling');
  assert.match(read('src/main/threadView.ts'), /this\.onAppend\?\.\(agentId, row\)/);
  const main = read('src/main/index.ts');
  assert.match(main, /new MessageChannelMain\(\)/, 'Talk deltas travel through a dedicated MessageChannel port');
  assert.match(main, /new Worker\(join\(__dirname, 'thread-tail-worker\.cjs'\)\)/, 'provider file reads run outside main');
  assert.doesNotMatch(main, /threadView\.tail\(/, 'main must not tail provider files itself');
  assert.match(read('src/main/thread-tail-worker.cjs'), /for \(let i = 0; i < complete\.length; i \+= 256\)/, 'the worker must batch without dropping a busy 64 KiB read');
});

test('THREAD-VIEW Talk is a thin humanQA card consumer and preserves raw option indexes on answer', () => {
  const talk = read('src/renderer/src/components/ThreadTalkPanel.tsx');
  assert.match(talk, /HumanQuestionCard/);
  assert.match(talk, /normalizeHumanQA\(raw\)/, 'only the rendered card receives a normalized entry');
  assert.match(talk, /recordAnswer\(question\.task\.humanQA \?\? \[\], question\.raw, answer/, 'writes use the stored raw entry');
  assert.match(talk, /answerMail\(question\.task, question\.raw, answer\)/, 'mail uses the stored raw entry');
  assert.match(talk, /hiveTasks\(\)/);
  assert.doesNotMatch(talk, /setInterval\(/, 'Talk may not introduce a task-ledger polling loop');
});

test('THREAD-VIEW preserves history on lifecycle archive and deletes only an explicit Human retire', () => {
  const main = read('src/main/index.ts');
  const lifecycle = main.slice(main.indexOf("ipcMain.handle('hive:setArchived'"), main.indexOf("ipcMain.handle('thread:retire'"));
  assert.doesNotMatch(lifecycle, /threadView\.archive/, 'PTY exit/startup lifecycle must retain Talk');
  assert.match(main, /ipcMain\.handle\('thread:retire'[\s\S]{0,300}threadView\.archive/, 'only explicit retire may delete Talk');
  assert.match(read('src/renderer/src/components/AgentDetailPanel.tsx'), /await window\.cth\.threadRetire\(agent\.id\)/);
  assert.match(read('src/renderer/src/components/FullscreenTerminal.tsx'), /await window\.cth\.threadRetire\(agent\.id\)/);
});

test('THREAD-VIEW retires only after a successful confirmed kill and never promises unarchive restores Talk', () => {
  for (const file of [
    'src/renderer/src/components/AgentDetailPanel.tsx',
    'src/renderer/src/components/FullscreenTerminal.tsx'
  ]) {
    const source = read(file);
    const kill = source.indexOf('const killed = await window.cth.killPty(agent.ptyId)');
    const guard = source.indexOf('if (!killed.ok) return', kill);
    const retire = source.indexOf('await window.cth.threadRetire(agent.id)', guard);
    assert.ok(kill >= 0 && guard > kill && retire > guard, `${file} retires only after successful kill`);
  }
  const voice = read('src/main/realtimeActions.ts');
  assert.match(voice, /private Talk history was removed; unarchive does not restore it/);
  assert.doesNotMatch(voice, /history kept\. Say unarchive to bring them back/);
  for (const file of [
    'src/renderer/src/components/AgentDetailPanel.tsx',
    'src/renderer/src/components/FullscreenTerminal.tsx'
  ]) assert.match(read(file), /its Talk history is deleted/);
});

test('THREAD-VIEW receipt admission is one-time and machine beats Human in its numbered window', () => {
  const { store, dir } = loadThreadStore();
  try {
    const view = new store.ThreadViewStore(path.join(dir, 'userData', 'threads'));
    const terminal = view.recordReceipt('michael', 'Human sentence', 'human-terminal');
    assert.equal(terminal.terminalWindow, 1);
    assert.ok(view.consumeHumanReceipt('michael', 'Human sentence'));
    assert.equal(view.consumeHumanReceipt('michael', 'Human sentence'), undefined);

    view.recordReceipt('michael', 'same content', 'human-ui');
    view.recordReceipt('michael', 'same content', 'machine');
    assert.equal(view.consumeHumanReceipt('michael', 'same content'), undefined,
      'same-window automatic content must never enter as Human speech');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THREAD-VIEW closes each provider admission latch on a non-Human turn', async () => {
  const { store: module, dir } = loadThreadStore();
  const store = new module.ThreadViewStore(path.join(dir, 'userData', 'threads'));
  const rows = async () => (await store.list('michael')).map((row) => row.text);
  const claude = (type, text) => JSON.stringify({ type, timestamp: Date.now(), message: { content: text } });
  const codex = (type, text) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, message: text } });
  try {
    for (const [ingest, user, agent] of [
      [(line) => store.ingestClaudeLine('michael', line), (text) => claude('user', text), (text) => claude('assistant', text)],
      [(line) => store.ingestCodexLine('michael', line), (text) => codex('user_message', text), (text) => codex('agent_message', text)]
    ]) {
      const human = `Human-${Math.random()}`;
      store.recordReceipt('michael', human, 'human-terminal');
      await ingest(user(human)); await ingest(agent('REPLY-TO-HUMAN'));
      await ingest(user('machine hive nudge')); await ingest(agent('REPLY-TO-HIVE-NUDGE'));
      const humanAgain = `${human}-again`;
      store.recordReceipt('michael', humanAgain, 'human-terminal');
      await ingest(user(humanAgain)); await ingest(agent('REPLY-TO-HUMAN-AGAIN'));
    }
    const result = await rows();
    assert.ok(result.includes('REPLY-TO-HUMAN'));
    assert.ok(result.includes('REPLY-TO-HUMAN-AGAIN'));
    assert.equal(result.includes('REPLY-TO-HIVE-NUDGE'), false, 'a nudge clears the previous Human admission for both providers');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THREAD-VIEW preserves a Human admission across Claude meta user records', async () => {
  const { store: module, dir } = loadThreadStore();
  const store = new module.ThreadViewStore(path.join(dir, 'userData', 'threads'));
  try {
    const human = 'Human meta-safe turn';
    store.recordReceipt('michael', human, 'human-terminal');
    await store.ingestClaudeLine('michael', JSON.stringify({ type: 'user', timestamp: Date.now(), message: { content: human } }));
    await store.ingestClaudeLine('michael', JSON.stringify({ type: 'user', isMeta: true, message: { content: '<system-reminder>context</system-reminder>' } }));
    await store.ingestClaudeLine('michael', JSON.stringify({ type: 'user', message: { subtype: 'local-command', content: 'ignored local command' } }));
    await store.ingestClaudeLine('michael', JSON.stringify({ type: 'assistant', timestamp: Date.now(), message: { content: 'REPLY-AFTER-META' } }));
    assert.deepEqual((await store.list('michael')).map((row) => row.text), ['REPLY-AFTER-META']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THREAD-VIEW restores the newest contiguous history across pages and segments', async () => {
  const { store: module, dir } = loadThreadStore();
  const store = new module.ThreadViewStore(path.join(dir, 'userData', 'threads'));
  try {
    const agentDir = path.join(dir, 'userData', 'threads', 'michael');
    fs.mkdirSync(agentDir, { recursive: true });
    const rows = Array.from({ length: 3000 }, (_, n) => JSON.stringify({ id: `id-${n}`, at: n, speaker: 'agent', source: 'claude', text: `${n}:${'x'.repeat(512)}` }) + '\n');
    fs.writeFileSync(path.join(agentDir, 'closed-100.jsonl'), rows.slice(0, 750).join(''));
    fs.writeFileSync(path.join(agentDir, 'closed-200.jsonl'), rows.slice(750, 1500).join(''));
    fs.writeFileSync(path.join(agentDir, 'closed-300.jsonl'), rows.slice(1500, 2250).join(''));
    fs.writeFileSync(path.join(agentDir, 'active.jsonl'), rows.slice(2250).join(''));
    const listed = await store.list('michael', 1000);
    assert.deepEqual(listed.map((row) => row.at), Array.from({ length: 1000 }, (_, n) => n + 2000));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THREAD-VIEW tailer starts existing files at EOF but replays a rollout discovered later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-thread-worker-'));
  const worker = new Worker(path.join(root, 'src', 'main', 'thread-tail-worker.cjs'));
  const received = [];
  worker.on('message', (row) => { if (row?.type === 'lines') received.push(...row.lines); });
  try {
    const transcript = path.join(dir, 'existing.jsonl');
    fs.writeFileSync(transcript, 'old-at-start\n');
    worker.postMessage({ type: 'source', source: { agentId: 'michael', provider: 'claude', file: transcript } });
    await sleep(40);
    assert.deepEqual(received, [], 'existing startup history must not replay');
    fs.appendFileSync(transcript, 'live-after-selection\n');
    worker.postMessage({ type: 'poll' });
    for (let i = 0; i < 20 && !received.length; i += 1) await sleep(10);
    assert.deepEqual(received, ['live-after-selection']);

    received.length = 0;
    const codexHome = path.join(dir, 'codex');
    worker.postMessage({ type: 'source', source: { agentId: 'michael', provider: 'codex', codexHome } });
    await sleep(20);
    const rollout = path.join(codexHome, 'sessions', '2026', '09', '27', 'rollout-new.jsonl');
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, 'first-after-rollout-appears\n');
    worker.postMessage({ type: 'poll' });
    for (let i = 0; i < 20 && !received.length; i += 1) await sleep(10);
    assert.deepEqual(received, ['first-after-rollout-appears']);
  } finally { await worker.terminate(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THREAD-VIEW starts queued Human UI TTL at COMMIT, not enqueue', () => {
  const { store, dir } = loadThreadStore();
  const originalNow = Date.now;
  try {
    let now = 1_000;
    Date.now = () => now;
    const view = new store.ThreadViewStore(path.join(dir, 'userData', 'threads'));
    view.recordReceipt('michael', 'queued Human message', 'human-ui');
    now += 10 * 60_000; // agent is mid-run; enqueue-time TTL must not discard it.
    assert.equal(view.commitSubmission('michael', 'queued Human message'), 'human-ui');
    now += 1_000;
    assert.ok(view.consumeHumanReceipt('michael', 'queued Human message', now));
  } finally { Date.now = originalNow; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THREAD-VIEW persists a separate validated per-agent view layout and removes it on explicit retire', async () => {
  const { store, dir } = loadThreadStore();
  try {
    const threads = path.join(dir, 'userData', 'threads');
    const view = new store.ThreadViewStore(threads);
    await view.init();
    assert.equal((await view.layout('michael', 'talk')).preferredView, 'talk');
    const saved = await view.setLayout('michael', {
      preferredView: 'terminal', split: { orientation: 'vertical', talkDock: 'left', ratio: 99 }, lastSelectedAt: 123
    }, 'talk');
    assert.equal(saved.preferredView, 'terminal');
    assert.equal(saved.split.ratio, 0.75, 'ratios are clamped before persistence');
    const reloaded = new store.ThreadViewStore(threads);
    await reloaded.init();
    assert.equal((await reloaded.layout('michael', 'talk')).preferredView, 'terminal');
    await reloaded.archive('michael');
    assert.equal((await reloaded.layout('michael', 'talk')).preferredView, 'talk');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THREAD-VIEW orphan sweep deletes only aged, manifest-bearing, registry-absent direct directories', async () => {
  const { store, dir } = loadThreadStore();
  try {
    const threads = path.join(dir, 'userData', 'threads');
    const view = new store.ThreadViewStore(threads);
    await view.init();
    for (const id of ['orphan', 'registered', 'no-manifest']) {
      const agentDir = path.join(threads, id);
      fs.mkdirSync(agentDir, { recursive: true });
      if (id !== 'no-manifest') fs.writeFileSync(path.join(agentDir, 'manifest-v1.json'), '{}');
    }
    const old = new Date(Date.now() - 2_000);
    for (const id of ['orphan', 'registered', 'no-manifest']) fs.utimesSync(path.join(threads, id), old, old);
    const removed = await view.sweepOrphans((id) => id === 'registered', Date.now() - 1_000);
    assert.deepEqual(removed, ['orphan']);
    assert.ok(!fs.existsSync(path.join(threads, 'orphan')));
    assert.ok(fs.existsSync(path.join(threads, 'registered')));
    assert.ok(fs.existsSync(path.join(threads, 'no-manifest')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THREAD-VIEW uses only a temp userData root and evicts completed per-agent segments at 8 MiB', async () => {
  const { store, dir } = loadThreadStore();
  try {
    const userData = path.join(dir, 'userData');
    const threads = path.join(userData, 'threads');
    const view = new store.ThreadViewStore(threads);
    await view.init();
    // 132 capped events create completed 1 MiB segments and force the per-agent cap.
    const payload = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 132; i += 1) {
      await view.append('michael', { speaker: 'human', text: `${i}:${payload}`, source: 'human-ui' });
    }
    const bytes = fs.readdirSync(path.join(threads, 'michael'))
      .filter((n) => n.endsWith('.jsonl'))
      .reduce((n, file) => n + fs.statSync(path.join(threads, 'michael', file)).size, 0);
    assert.ok(bytes <= store.PER_AGENT_CAP, `agent history ${bytes} exceeds cap ${store.PER_AGENT_CAP}`);
    assert.ok(fs.existsSync(threads));
    assert.ok(!fs.existsSync(path.join(root, 'threads')), 'test must never select a repository or real userData root');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
