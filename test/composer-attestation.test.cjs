'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');
const loadTs = require('./load-ts.cjs');
const { composerRegionEndsWith } = loadTs('src/renderer/src/components/composerAttestation.ts');

function write(term, text) {
  return new Promise((resolve) => term.write(text, resolve));
}

test('WAKE-155 C1: actual xterm buffers attest explicit Ink/ratatui composer rows at three widths', async () => {
  const cases = [
    { cols: 24, rows: ['> alpha beta', '  gamma delta'], tail: 'alpha beta gamma delta' },
    { cols: 34, rows: ['\u2502 > alpha beta \u2502', '\u2502   gamma delta \u2502'], tail: 'alpha beta gamma delta' },
    { cols: 46, rows: ['\u2503 \u276f alpha beta \u2503', '\u2503   gamma delta \u2503'], tail: 'alpha beta gamma delta' }
  ];
  for (const c of cases) {
    const term = new Terminal({ cols: c.cols, rows: 8, scrollback: 20 });
    await write(term, c.rows.join('\r\n'));
    const buffer = term.buffer.active;
    assert.equal(
      composerRegionEndsWith(buffer, buffer.baseY + buffer.cursorY, c.tail),
      true,
      `explicit composer rows at ${c.cols} columns are attested without isWrapped`
    );
  }
});

test('WAKE-155 C1: one human character appended to an explicit composer makes the tail fail', async () => {
  const term = new Terminal({ cols: 34, rows: 8, scrollback: 20 });
  await write(term, '\u2502 > alpha beta \u2502\r\n\u2502   gamma delta x \u2502');
  const buffer = term.buffer.active;
  assert.equal(composerRegionEndsWith(buffer, buffer.baseY + buffer.cursorY, 'alpha beta gamma delta'), false);
});
