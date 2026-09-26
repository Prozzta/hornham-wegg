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
