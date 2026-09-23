'use strict';

/**
 * Outbox files can be created by a non-atomic writer. The router used to parse
 * once, move a partial file to bad-*, and silently strand the intended work.
 * These tests exercise the polling boundary directly: leave a partial JSON file
 * in place for a later completed write, and make a truly malformed file visible
 * to its sender after the bounded retry budget expires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, 300));

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-rejection-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const events = [];
  const hive = new HiveManager(() => home, (channel, payload) => { events.push({ channel, payload }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { hive, events, outbox: path.join(hive.root(), 'agents', 'jim-1', 'outbox') };
}

test('a partial outbox write remains pending and routes after the writer finishes', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'partial.json');
  fs.writeFileSync(file, '{"to":"god-1","act":"inform"');

  assert.equal(hive.routeOnce(), 0);
  assert.equal(fs.existsSync(file), true, 'a first partial read must not be quarantined');
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-partial.json')), false);
  assert.equal(hive.inbox('god-1').length, 0);
  assert.equal(hive.routeOnce(), 0, 'rapid watcher hints must not consume another retry');
  assert.equal(fs.existsSync(file), true);

  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'writer finished', body: 'delivered' }));
  assert.equal(hive.routeOnce(), 1);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'partial.json')), true);
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(hive.inbox('god-1')[0].subject, 'writer finished');
});

test('a final malformed outbox rejection is logged, surfaced, and notices the sender', async (t) => {
  const { hive, events, outbox } = await floor(t);
  const file = path.join(outbox, 'broken.json');
  fs.writeFileSync(file, '{ definitely not JSON');

  assert.equal(hive.routeOnce(), 0);
  await afterDebounce();
  assert.equal(hive.routeOnce(), 0);
  assert.equal(fs.existsSync(file), true, 'the bounded retry still leaves the writer time to finish');
  assert.equal(hive.inbox('jim-1').length, 0);

  await afterDebounce();
  assert.equal(hive.routeOnce(), 0);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-broken.json')), true);
  const [notice] = hive.inbox('jim-1');
  assert.match(notice.subject, /^\[outbox rejected — malformed JSON\] broken\.json$/);
  assert.match(notice.body, /after 3 attempts/);
  const [rejection] = hive.logTail(100).filter((entry) => entry.kind === 'outbox-rejected');
  assert.equal(rejection.from, 'jim-1');
  assert.equal(rejection.file, 'broken.json');
  assert.equal(rejection.notified, true);
  assert.ok(events.some(({ channel, payload }) =>
    channel === 'hive:message' && payload.to === 'jim-1' && /^\[outbox rejected/.test(payload.subject)
  ), 'the sender notice must reach the floor event stream too');
});
