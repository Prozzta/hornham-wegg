'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');
const loadTs = require('./load-ts.cjs');
const { composerRegionEndsWith } = loadTs('src/renderer/src/components/composerAttestation.ts');

function write(term, text) {
  return new Promise((resolve) => term.write(text, resolve));
}

const NUDGE = 'You have new hive inbox message(s) at least: 2026-09-27T01-40-00-000Z-god-oscarwakec, 2026-09-27T01-41-00-000Z-jim-wake155r-oscar. Read your inbox, act on everything pending, and move handled messages to inbox/.done/.';

function boxedComposerRows(text, cols, marker = '>') {
  const usable = cols - 6; // "│ > " / "│   " plus " │"
  const rows = [];
  let row = '';
  for (const word of text.split(' ')) {
    const next = row ? `${row} ${word}` : word;
    if (row && next.length > usable) {
      rows.push(row);
      row = word;
    } else {
      row = next;
    }
  }
  if (row) rows.push(row);
  return rows.map((value, index) => `\u2502 ${index ? '  ' : `${marker} `}${value} \u2502`);
}

test('WAKE-155 C1: actual xterm buffers attest a real-shape explicit composer at three widths', async () => {
  const cases = [
    { cols: 48, marker: '>' },
    { cols: 60, marker: '\u276f' },
    { cols: 100, marker: '\u203a' }
  ];
  for (const c of cases) {
    const term = new Terminal({ cols: c.cols, rows: 8, scrollback: 20 });
    await write(term, boxedComposerRows(NUDGE, c.cols, c.marker).join('\r\n'));
    const buffer = term.buffer.active;
    assert.equal(
      composerRegionEndsWith(buffer, buffer.baseY + buffer.cursorY, NUDGE),
      true,
      `explicit composer rows at ${c.cols} columns are attested without isWrapped`
    );
  }
});

test('WAKE-155 C1: one human character inserted into an explicit composer makes the tail fail', async () => {
  const term = new Terminal({ cols: 60, rows: 8, scrollback: 20 });
  await write(term, boxedComposerRows(NUDGE.replace('inbox message', 'inboxX message'), 60).join('\r\n'));
  const buffer = term.buffer.active;
  assert.equal(composerRegionEndsWith(buffer, buffer.baseY + buffer.cursorY, NUDGE), false);
});
