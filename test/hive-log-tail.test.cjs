'use strict';
/**
 * logTail() must return the SAME rows as reading the whole file, without reading it.
 *
 * The 1.1.49 crawl was logTail doing readFileSync(whole file).trim().split('\n') on the
 * Electron MAIN process, called by `hive:log` every 3 seconds. Against the 61 MB log this
 * floor grew, one call measured 328 ms of blocked main thread.
 *
 * A faster logTail that returns different rows is worthless, so every test here compares
 * against the naive whole-file answer rather than against a hand-written expectation - the
 * naive version is the oracle, and the cases chosen are the ones a windowed read gets
 * wrong: a window that splits a line, a file smaller than the window, an n larger than
 * the window holds, and a file with no trailing newline.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

/** The old implementation, kept as the ORACLE. */
function naiveTail(file, n) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-logtail-'));
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(process.env.HOME, home, 'HOME must be jailed before HiveManager construction');
  assert.equal(process.env.USERPROFILE, home, 'USERPROFILE must be jailed before HiveManager construction');
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const hive = new HiveManager(() => home, () => {});
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  return { hive, log: path.join(hive.root(), 'log.jsonl') };
}

/** Rows shaped like the real wake spam, so line lengths match production. */
const writeRows = (file, count, pad = '') => {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += JSON.stringify({
      ts: 1790000000000 + i, kind: 'wake', stage: 'facts', agentId: 'andy-1',
      cause: i % 2 ? 'renderer' : 'reconcile', mode: 'reconcile', inboxIds: 0,
      idleMs: i * 1000, seq: i, pad
    }) + '\n';
  }
  fs.writeFileSync(file, out);
};

test('a log far larger than the read window returns exactly the naive answer', async (t) => {
  const { hive, log } = await floor(t);
  writeRows(log, 20000); // comfortably past the 256 KB first window
  assert.ok(fs.statSync(log).size > 1_000_000, 'fixture must exceed the window, or nothing is tested');
  for (const n of [1, 60, 200, 1000]) {
    assert.deepEqual(hive.logTail(n), naiveTail(log, n), `n=${n} must match the whole-file read`);
  }
});

test('the newest row is the LAST one - a tail read must not return the head', async (t) => {
  const { hive, log } = await floor(t);
  writeRows(log, 20000);
  const got = hive.logTail(3);
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((r) => r.seq), [19997, 19998, 19999], 'must be the NEWEST three');
});

test('n larger than the first window still works (the window grows)', async (t) => {
  const { hive, log } = await floor(t);
  writeRows(log, 20000);
  const n = 8000; // ~1.4 MB of rows, far past the 256 KB first window
  assert.deepEqual(hive.logTail(n), naiveTail(log, n));
  assert.equal(hive.logTail(n).length, n);
});

test('asking for more rows than exist returns all of them, not a padded or short list', async (t) => {
  const { hive, log } = await floor(t);
  writeRows(log, 5);
  assert.deepEqual(hive.logTail(500), naiveTail(log, 500));
  assert.equal(hive.logTail(500).length, 5);
});

test('a file with NO trailing newline keeps its last row', async (t) => {
  const { hive, log } = await floor(t);
  writeRows(log, 2000);
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/\n$/, ''));
  assert.deepEqual(hive.logTail(10), naiveTail(log, 10));
  assert.equal(hive.logTail(1)[0].seq, 1999, 'the unterminated final row must survive');
});

test('a window that lands MID-LINE never yields a corrupt row', async (t) => {
  const { hive, log } = await floor(t);
  // Long rows, so the 256 KB boundary is very likely to split one.
  writeRows(log, 4000, 'x'.repeat(400));
  const got = hive.logTail(200);
  assert.deepEqual(got, naiveTail(log, 200));
  for (const r of got) {
    assert.ok(!('raw' in r), 'a split line must be discarded, never handed back as a {raw} row');
    assert.equal(typeof r.seq, 'number');
  }
});

test('empty and missing logs answer like the naive version', async (t) => {
  const { hive, log } = await floor(t);
  // NOT asserted as [] - ensureAgent() already wrote a spawn row, so an empty-list
  // expectation here would be a fixture claim, not a logTail claim. The oracle decides.
  assert.deepEqual(hive.logTail(10), naiveTail(log, 10), 'whatever is there, both agree');

  fs.writeFileSync(log, '');
  assert.deepEqual(hive.logTail(10), naiveTail(log, 10), 'truly empty file');
  assert.deepEqual(hive.logTail(10), [], 'and an empty file really is no rows');

  fs.rmSync(log);
  assert.deepEqual(hive.logTail(10), [], 'missing log file');

  writeRows(log, 5);
  assert.deepEqual(hive.logTail(0), [], 'n=0 asks for nothing');
});

test('a malformed line is still reported as {raw}, exactly as before', async (t) => {
  const { hive, log } = await floor(t);
  writeRows(log, 50);
  fs.appendFileSync(log, 'this is not json\n');
  assert.deepEqual(hive.logTail(3), naiveTail(log, 3));
  assert.equal(hive.logTail(1)[0].raw, 'this is not json');
});

test('COST: the tail read does not scale with file size', async (t) => {
  const { hive, log } = await floor(t);
  writeRows(log, 2000);
  const small = fs.statSync(log).size;
  const tSmall = (() => { const a = process.hrtime.bigint(); for (let i = 0; i < 20; i++) hive.logTail(60); return Number(process.hrtime.bigint() - a) / 1e6; })();

  writeRows(log, 200000);
  const big = fs.statSync(log).size;
  assert.ok(big > small * 50, `fixture must actually be much bigger (${small} -> ${big})`);
  const tBig = (() => { const a = process.hrtime.bigint(); for (let i = 0; i < 20; i++) hive.logTail(60); return Number(process.hrtime.bigint() - a) / 1e6; })();

  // The naive version is linear in file size; 50x the bytes cost ~50x the time. Allow a
  // generous constant factor for filesystem noise - this fails loudly if anyone restores a
  // whole-file read, and does not flake on a slow machine.
  assert.ok(tBig < tSmall * 10 + 200,
    `logTail must not scale with the file: ${small}B took ${tSmall.toFixed(0)}ms, ${big}B took ${tBig.toFixed(0)}ms`);
});
