const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

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
