const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

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
