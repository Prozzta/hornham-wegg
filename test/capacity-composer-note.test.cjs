'use strict';

/**
 * v1.1.45 unit #11 — the composer's capacity note is UNCONDITIONAL. An empty queue on a
 * limited, recovering or stale pool used to say nothing (only INTERFERED escaped the
 * queue.length === 0 gate). Now the note shows in the header on its own; a fresh healthy
 * reading stays silent; the hold hints, terminal blocks and "send now" stay queue-driven.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { composerStatus } = loadTs('src/renderer/src/components/composerStatus.ts');
const { capacityStateNote, deliveryHoldView } = loadTs('src/shared/deliveryHold.ts');

const INTERFERED = { requestId: 'queue:a1:m1', reason: 'typed', at: 1 };
const view = (over = {}) => deliveryHoldView({ agentName: 'Alice', interfered: null, paused: false, headManual: false,
  capacityHold: false, capacityEvidence: null, ...over });
const status = (over = {}) => {
  const evidence = over.evidence ?? null;
  return composerStatus({ agentName: 'Alice', queueLength: 0, idle: true, block: null,
    hold: over.hold !== undefined ? over.hold : view({ capacityEvidence: evidence }),
    capacityNote: capacityStateNote(evidence), capacityEvidence: evidence, ...over.i });
};

test('empty queue + a limited, recovering or stale pool: the note is in the header', () => {
  for (const ev of ['FRESH_NOT_HEALTHY', 'RECOVERING', 'STALE_AFTER_LIMITED', 'STALE_AFTER_UNHEALTHY', 'STALE_AFTER_HEALTHY', 'POST_RESET_PROBE']) {
    const s = status({ evidence: ev });
    assert.ok(s, `${ev} is shown on an empty queue`);
    assert.equal(s.text, capacityStateNote(ev), 'main words it; the renderer composes nothing');
    assert.equal(s.title, s.text, 'no hold tooltip pointing at a message that is not there');
  }
  assert.equal(status({ evidence: 'FRESH_NOT_HEALTHY' }).text, 'provider capacity is limited');
});

test('empty queue + a capacity HOLD: the state note shows, not the hold hint or its send-now tooltip', () => {
  const hold = view({ capacityHold: true, capacityEvidence: 'FRESH_NOT_HEALTHY' });
  assert.equal(hold.kind, 'CAPACITY');
  const s = status({ evidence: 'FRESH_NOT_HEALTHY', hold });
  assert.equal(s.text, 'provider capacity is limited');
  assert.ok(!/send now/.test(s.title + s.text));
});

test('healthy stays silent on an empty queue', () => {
  assert.equal(status({ evidence: 'FRESH_HEALTHY' }), null);
  assert.equal(status({ evidence: null }), null);
  assert.equal(status({ evidence: null, hold: view({ paused: true }) }), null, 'a pause is about queued messages; none are queued');
});

test('outside capacity gating (NO_POOL) is silent on an EMPTY queue, and still said on a moving one', () => {
  assert.ok(capacityStateNote('NO_POOL'), 'main still words it');
  assert.equal(status({ evidence: 'NO_POOL' }), null, 'the ordinary case for an ungated agent: no clutter');
  assert.equal(status({ evidence: 'NO_POOL', i: { queueLength: 1 } }).text,
    `sending to Alice one-by-one… (${capacityStateNote('NO_POOL')})`, 'the moving-queue suffix is unchanged');
});

test('INTERFERED still escapes the empty queue, and still wins over the note', () => {
  const hold = view({ interfered: INTERFERED, capacityEvidence: 'FRESH_NOT_HEALTHY' });
  const s = status({ evidence: 'FRESH_NOT_HEALTHY', hold });
  assert.equal(s.text, hold.hint);
  assert.equal(s.title, hold.title);
});

test('a non-empty queue reads exactly as before: busy, hold, blocks, sending (+ note)', () => {
  const q = (over, i = {}) => status({ ...over, i: { queueLength: 2, ...i } });
  assert.equal(q({}, { idle: false }).text, 'Alice is busy — 2 queued');
  const cap = view({ capacityHold: true, capacityEvidence: 'FRESH_NOT_HEALTHY' });
  assert.deepEqual(q({ evidence: 'FRESH_NOT_HEALTHY', hold: cap }), { text: cap.hint, title: cap.title });
  assert.equal(q({ evidence: 'FRESH_NOT_HEALTHY', hold: cap }, { idle: false }).title, cap.title, 'busy keeps the hold tooltip');
  const paused = view({ paused: true });
  assert.equal(q({ hold: paused }).text, paused.hint);
  assert.match(q({}, { block: 'draft' }).text, /unsent text/);
  assert.match(q({}, { block: 'picker' }).text, /slash-command picker/);
  assert.match(q({}, { block: 'exited' }).text, /has exited/);
  assert.equal(q({}).text, 'sending to Alice one-by-one…');
  assert.equal(q({ evidence: 'STALE_AFTER_HEALTHY' }).text, `sending to Alice one-by-one… (${capacityStateNote('STALE_AFTER_HEALTHY')})`);
});

test('the composer renders composerStatus; send-now and the hold stay queue-driven', () => {
  const src = codeOnly(readSource('src/renderer/src/components/MessageQueueComposer.tsx'), 'MessageQueueComposer.tsx');
  assert.match(src, /const status = composerStatus\(\{ agentName: agent\.name, queueLength: queue\.length, idle, hold, block, capacityNote,\s+capacityEvidence: delivery\.capacityEvidence \}\);/);
  assert.match(src, /title=\{status\.title\}/);
  assert.match(src, />\{status\.text\}<\/span>/);
  assert.ok(!/statusHint/.test(src), 'the old inline gate is gone');
  assert.match(src, /const releasable = !delivery\.interfered && \(delivery\.paused \|\| delivery\.capacityHold\);/);
  assert.match(src, /headManual: !!queue\[0\]\?\.manual/);
});
