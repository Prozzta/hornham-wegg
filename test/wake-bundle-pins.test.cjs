'use strict';

/**
 * GATE-3 — the wake path survives the BUILD.
 *
 * Every other wake test reads src/. The 1.1.46 canary failed in the packaged app while
 * the whole suite was green, so "it is correct in src" was never the question worth
 * asking: the question is whether what ships still has it. These assert against
 * out/main/index.js, the bundle electron-builder packs verbatim into app.asar (verified:
 * the 1.1.46 asar entry was byte-identical to out/main/index.js).
 *
 * They are about EXISTENCE AND WIRING, not behaviour — a bundler can only drop code, not
 * change what it decides. Run `npm run build` first; the whole file skips if out/ is
 * missing so a source-only checkout is not failed for it.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const BUNDLE = join(__dirname, '..', 'out', 'main', 'index.js');
const built = existsSync(BUNDLE);
const src = built ? readFileSync(BUNDLE, 'utf8') : '';

describe('GATE-3: the built main bundle still carries the wake path', { skip: built ? false : 'out/main/index.js not built — run npm run build' }, () => {
  /** Assert a symbol survived bundling (minify-safe: these are all strings or idents
   *  that rollup keeps because they are reachable from the entry). */
  const has = (needle, why) => assert.ok(src.includes(needle), `${why} — missing from the built bundle: ${needle}`);

  test('the delivery observer is registered', () => {
    has('setDeliveryObserver', 'the one successful-delivery edge');
    has('onDelivery', 'handed to the bridge');
  });

  test('the bridge is constructed and every edge reaches it', () => {
    has('InboxWakeBridge', 'the bridge class');
    has('requestInboxWake', 'the one wake path');
    has('onCapacityChange', 'the capacity retry hint');
    has('onControlRelease', 'the control-release edge');
    has('onHook', 'the hook lifecycle stream');
    has('noteSpawn', 'boot grace is fed');
  });

  test('the 15s reconciliation beat is armed', () => {
    has('armAlwaysOnBeats', 'the always-on beat arming');
    has('runWorkerWakeBeat', 'the reconciliation beat');
    has('reconcileAll', 'over every live agent');
    // The bundler normalises numeric separators, so accept 15_000 / 15000 / 15e3.
    assert.match(src, /WORKER_WAKE_POLL_MS = (?:15_?000|15e3)/, 'the 15s cadence constant survived');
  });

  test('the heartbeat is armed and self-reschedules', () => {
    has('armHeartbeat', 'the heartbeat arming');
    has('Floor heartbeat', 'the digest it sends');
  });

  test('the durable breadcrumbs reach log.jsonl, not only the console', () => {
    // The 1.1.46 canary was blind because a packaged Windows Electron app has no console.
    // If these are gone, the next canary is blind again.
    // Quote style is the bundler's choice; the row shape is ours.
    assert.match(src, /appendLog\(\{ kind: ["']wake["'], stage/, 'the wake breadcrumb rows');
    has('whyNoClaim', 'the claim-refusal reason');
    assert.ok(/observer-missing/.test(src), 'a delivery with no observer is reported');
  });

  test('SessionStart is NOT treated as an active turn (the 1.1.46 cold-boot deadlock)', () => {
    // The one line whose regression stalled the packaged floor. Asserted on the SHIPPED
    // artifact, because that is where it mattered and where nothing was looking.
    const m = src.match(/new Set\(\[\s*(["'])UserPromptSubmit\1[^\]]*\]\)/);
    assert.ok(m, 'ACTIVE_EVENTS survived bundling and still starts at UserPromptSubmit');
    assert.ok(!/SessionStart/.test(m[0]), `SessionStart is back in ACTIVE_EVENTS: ${m[0]}`);
  });
});
