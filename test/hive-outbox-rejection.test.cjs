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
const olderThanFreshWriteGrace = (file) => {
  const old = new Date(Date.now() - 2_000);
  fs.utimesSync(file, old, old);
};

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-rejection-'));
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(process.env.HOME, home, 'HOME must be jailed before HiveManager construction');
  assert.equal(process.env.USERPROFILE, home, 'USERPROFILE must be jailed before HiveManager construction');
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
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

test('a writer that remains partial for more than one second is still delivered once it finishes', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'slow.json');
  fs.writeFileSync(file, '{"to":"god-1"');

  assert.equal(hive.routeOnce(), 0, 'a fresh file spends no parse retry budget');
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(hive.routeOnce(), 0, 'the first eligible parse is still only one retry');
  assert.equal(fs.existsSync(file), true);
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'slow writer finished' }));

  assert.equal(hive.routeOnce(), 1);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'slow.json')), true);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-slow.json')), false);
  assert.equal(hive.inbox('god-1')[0].subject, 'slow writer finished');
});

test('a final malformed outbox rejection is logged, surfaced, and notices the sender', async (t) => {
  const { hive, events, outbox } = await floor(t);
  const file = path.join(outbox, 'broken.json');
  fs.writeFileSync(file, '{ definitely not JSON');
  olderThanFreshWriteGrace(file);

  assert.equal(hive.routeOnce(), 0);
  await afterDebounce();
  assert.equal(hive.routeOnce(), 0);
  assert.equal(fs.existsSync(file), true, 'the bounded retry still leaves the writer time to finish');
  assert.equal(hive.inbox('jim-1').length, 0);

  await afterDebounce();
  assert.equal(hive.routeOnce(), 0);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-broken.json')), true);
  const [notice] = hive.inbox('jim-1');
  assert.match(notice.subject, /^\[outbox rejected — malformed JSON after 3 attempts\] broken\.json$/);
  assert.match(notice.body, /after 3 attempts/);
  const [rejection] = hive.logTail(100).filter((entry) => entry.kind === 'outbox-rejected');
  assert.equal(rejection.from, 'jim-1');
  assert.equal(rejection.file, 'broken.json');
  assert.equal(rejection.reason, 'parse-failed');
  assert.match(rejection.detail, /malformed JSON after 3 attempts/);
  assert.equal(rejection.notified, true);
  assert.ok(events.some(({ channel, payload }) =>
    channel === 'hive:message' && payload.to === 'jim-1' && /^\[outbox rejected/.test(payload.subject)
  ), 'the sender notice must reach the floor event stream too');
});

test('parseable but unroutable files are rejected once with a sender notice', async (t) => {
  const { hive, events, outbox } = await floor(t);
  const cases = [
    ['null.json', 'null', /message must be an object/],
    ['number-to.json', JSON.stringify({ to: 123 }), /to must be a string/],
    ['array-to.json', JSON.stringify({ to: ['god-1'] }), /to must be a string/]
  ];

  for (const [name, content, reason] of cases) {
    fs.writeFileSync(path.join(outbox, name), content);
    assert.equal(hive.routeOnce(), 0);
    assert.equal(fs.existsSync(path.join(outbox, '.sent', `bad-${name}`)), true, name);
    const matching = hive.inbox('jim-1').filter((message) => message.subject.endsWith(name));
    assert.equal(matching.length, 1, `${name} must notify exactly once`);
    assert.match(matching[0].subject, reason);
    const rows = hive.logTail(100).filter((entry) => entry.kind === 'outbox-rejected' && entry.file === name);
    assert.equal(rows.length, 1, `${name} must have one final rejection row`);
    assert.equal(rows[0].reason, 'route-failed');
    assert.match(rows[0].detail, reason);
  }

  assert.equal(hive.routeOnce(), 0, 'archived files cannot repeatedly reject');
  assert.equal(hive.inbox('jim-1').length, cases.length);
  assert.equal(events.filter(({ channel, payload }) => channel === 'hive:message' && payload.to === 'jim-1').length, cases.length);
});

test('a delivered message retries only its archive when .sent is temporarily unavailable', async (t) => {
  const { hive, events, outbox } = await floor(t);
  const sent = path.join(outbox, '.sent');
  const heldSent = path.join(outbox, '.sent-held');
  fs.renameSync(sent, heldSent);
  t.after(() => {
    if (fs.existsSync(heldSent) && !fs.existsSync(sent)) fs.renameSync(heldSent, sent);
  });
  const file = path.join(outbox, 'delivered-before-archive.json');
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'delivered before archive' }));

  assert.equal(hive.routeOnce(), 1, 'the message must be delivered before archive retry state is recorded');
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(hive.inbox('jim-1').length, 0);
  assert.equal(fs.existsSync(file), true, 'a failed archive leaves the delivered source file in place');
  assert.equal(hive.logTail(100).filter((entry) => entry.kind === 'outbox-archive-failed').length, 1);

  assert.equal(hive.routeOnce(), 0, 'an unchanged delivered file must only retry archival');
  assert.equal(hive.inbox('god-1').length, 1, 'archive retry must never redeliver');
  assert.equal(hive.inbox('jim-1').length, 0, 'archive failure must not reject the sender');

  fs.renameSync(heldSent, sent);
  assert.equal(hive.routeOnce(), 0, 'successful archive retry is not a new route');
  assert.equal(fs.existsSync(path.join(sent, 'delivered-before-archive.json')), true);
  assert.equal(hive.inbox('god-1').length, 1, 'successful archive retry still must not redeliver');
  assert.equal(hive.inbox('jim-1').length, 0);
  assert.equal(events.filter(({ channel, payload }) =>
    channel === 'hive:message' && /^\[outbox rejected/.test(payload.subject)
  ).length, 0, 'archive failure must produce no sender rejection notice');
});

/**
 * Jim's router-148 note 1 (surviving mutant M3). The retry above remembers a delivered
 * file by FINGERPRINT, and the fingerprint is the whole guard: drop the comparison
 * (`if (true)`) and the router archives whatever now sits at that path as though it
 * were the message it already delivered. A sender who reuses a filename for a SECOND,
 * never-delivered message would have it swallowed silently - no delivery, no rejection,
 * no trace but an archived file that looks handled.
 *
 * The code handles it; nothing pinned it. This is that pin: strand a delivered file so
 * its archive fails, overwrite it with a DIFFERENT payload, restore `.sent`, and require
 * that the second payload REACHES the recipient rather than being archived on the first
 * one's ticket.
 */
test('a stranded delivered file REPLACED by a new message routes the new payload, not the archive', async (t) => {
  const { hive, events, outbox } = await floor(t);
  const sent = path.join(outbox, '.sent');
  const heldSent = path.join(outbox, '.sent-held');
  fs.renameSync(sent, heldSent);
  t.after(() => {
    if (fs.existsSync(heldSent) && !fs.existsSync(sent)) fs.renameSync(heldSent, sent);
  });

  // 1. Deliver, and strand it: .sent is gone, so the archive fails and the router
  //    remembers this exact file by fingerprint.
  const file = path.join(outbox, 'reused-name.json');
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'the first message' }));
  assert.equal(hive.routeOnce(), 1, 'the first message must be delivered before it can be stranded');
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(fs.existsSync(file), true, 'a failed archive leaves the delivered source in place');

  // 2. The sender REUSES the name for a different message. Size AND mtime both move, so
  //    the fingerprint cannot match by accident - a same-size rewrite inside one
  //    millisecond would compare equal and this test would prove nothing. mtime goes
  //    BACKWARDS, not forwards, so it can never be mistaken for a fresh partial write.
  const before = fs.statSync(file);
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'the SECOND message, same filename', body: 'x'.repeat(64) }));
  const past = new Date(Date.now() - 5_000);
  fs.utimesSync(file, past, past);
  const after = fs.statSync(file);
  assert.notEqual(`${before.size}:${before.mtimeMs}`, `${after.size}:${after.mtimeMs}`,
    'FIXTURE: the replacement must not share the stranded file\'s fingerprint, or nothing is being tested');

  // 3. .sent comes back. The new payload must be DELIVERED, not archived as the old one.
  fs.renameSync(heldSent, sent);
  assert.equal(hive.routeOnce(), 1, 'the replacement is a NEW route, not an archive retry');
  assert.equal(hive.inbox('god-1').length, 2, 'the second message must REACH the recipient');
  assert.equal(hive.inbox('god-1')[1].subject, 'the SECOND message, same filename',
    'the payload delivered must be the replacement, not a re-send of the first');
  assert.equal(fs.existsSync(path.join(sent, 'reused-name.json')), true, 'and it is archived once delivered');
  assert.equal(hive.inbox('jim-1').length, 0, 'a replaced file is not a sender error');
  assert.equal(events.filter(({ channel, payload }) =>
    channel === 'hive:message' && /^\[outbox rejected/.test(payload.subject)
  ).length, 0, 'no rejection notice for a legitimately replaced file');
});
