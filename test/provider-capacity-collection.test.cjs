'use strict';

/**
 * L0-CORE — the collection seam: does a real status-line payload actually reach a
 * capacity observation, and does account scope separate two accounts?
 *
 * HookServer.handle is exercised directly. It is `private` in TypeScript, which is
 * a compile-time marker only, and driving it here is the difference between
 * testing the normaliser (already covered) and testing that the WIRING fires at
 * all. The alternative - standing up the domain socket - would test node's
 * networking rather than this code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HookServer } = loadTs('src/main/hooks.ts');
const { claudeAccountScope, codexAccountScope } = loadTs('src/main/capacityScope.ts');

function server(onCapacity) {
  const hive = { sockPath: () => null, recordSession: () => {} };
  return new HookServer(hive, () => null, () => ({}), undefined, undefined, undefined, undefined, onCapacity);
}

const statusPayload = (over = {}) => ({
  hook_event_name: 'Status',
  agent_id: 'jim',
  context_window: { total_input_tokens: 1000, context_window_size: 200000 },
  ...over
});

test('a status tick carrying rate_limits produces exactly one capacity observation', () => {
  const seen = [];
  const s = server((obs) => seen.push(obs));
  s.handle(statusPayload({
    rate_limits: {
      five_hour: { used_percentage: 37, resets_at: 1789004151 },
      seven_day: { used_percentage: 88, resets_at: 1789590951 }
    }
  }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'claude');
  assert.equal(seen[0].source, 'claude-status-line');
  assert.equal(seen[0].windows.find((w) => w.kind === 'FIVE_HOUR').remainingPercent, 63);
  // The status line cannot attribute a limiting window, and this path must never
  // invent one on the way through.
  assert.equal(seen[0].providerAttributedLimitingWindowId, null);
});

test('a status tick WITHOUT rate_limits observes nothing - absence is not an empty reading', () => {
  const seen = [];
  server((obs) => seen.push(obs)).handle(statusPayload());
  assert.equal(seen.length, 0);
});

test('a malformed rate_limits payload is ignored and never throws on a status tick', () => {
  for (const junk of ['nonsense', 42, [], { five_hour: 'nope' }, { five_hour: {} }]) {
    const seen = [];
    const s = server((obs) => seen.push(obs));
    assert.doesNotThrow(() => s.handle(statusPayload({ rate_limits: junk })));
    assert.equal(seen.length, 0, `expected no observation for ${JSON.stringify(junk)}`);
  }
});

test('capacity is collected from status ticks only, never from ordinary hook events', () => {
  const seen = [];
  const s = server((obs) => seen.push(obs));
  s.handle({
    hook_event_name: 'PostToolUse',
    agent_id: 'jim',
    rate_limits: { five_hour: { used_percentage: 37, resets_at: 1789004151 } }
  });
  assert.equal(seen.length, 0);
});

test('the status branch still works with no capacity sink wired at all', () => {
  const s = server(undefined);
  assert.doesNotThrow(() => s.handle(statusPayload({ rate_limits: { five_hour: { used_percentage: 1 } } })));
});

// ── account scope ────────────────────────────────────────────────────────────

test('claude account scope is stable, opaque, and carries no path', () => {
  const a = claudeAccountScope({ CLAUDE_CONFIG_DIR: 'C:\\Users\\someone\\.claude' });
  assert.equal(a, claudeAccountScope({ CLAUDE_CONFIG_DIR: 'C:\\Users\\someone\\.claude' }));
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a.includes('someone'), false);
});

test('two codex homes with their own credentials are two different accounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-capscope-'));
  const homeA = path.join(root, 'a');
  const homeB = path.join(root, 'b');
  fs.mkdirSync(homeA); fs.mkdirSync(homeB);
  // Written, never read: the scope is computed from the PATH. Content is a marker
  // only, and nothing in this code path opens the file.
  fs.writeFileSync(path.join(homeA, 'auth.json'), '{}');
  fs.writeFileSync(path.join(homeB, 'auth.json'), '{}');
  const a = codexAccountScope(homeA);
  const b = codexAccountScope(homeB);
  assert.notEqual(a, b);
  assert.equal(a, codexAccountScope(homeA));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a codex home with no credential still yields a scope rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-capscope-'));
  assert.match(codexAccountScope(root), /^[0-9a-f]{12}$/);
  assert.match(codexAccountScope(path.join(root, 'does-not-exist')), /^[0-9a-f]{12}$/);
  fs.rmSync(root, { recursive: true, force: true });
});
