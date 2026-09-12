'use strict';

/**
 * L0-CORE — reading Codex allowance out of the rollout it already writes.
 *
 * The rollout lines below are the REAL shape: copied from a codex 0.154.0
 * `token_count` event written in this hive, with the numbers varied per test.
 * Everything runs against a temporary CODEX_HOME on disk, because the two things
 * worth proving - that the newest file wins and that an unchanged file is not
 * re-read - are filesystem behaviour and cannot be faked in memory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { CodexRolloutCapacitySource, latestUsableRateLimits } = loadTs('src/main/codexRolloutCapacity.ts');

/** Stands in for the normaliser in the pure-tail test: accept anything with windows. */
const acceptAnyWindows = (rateLimits, observedAt) =>
  (rateLimits && rateLimits.primary) ? { rateLimits, observedAt } : null;

const line = (usedPrimary, usedSecondary, ts, reached = null) => JSON.stringify({
  timestamp: ts,
  ordinal: 18,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 14155 }, model_context_window: 258400 },
    rate_limits: {
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: usedPrimary, window_minutes: 300, resets_at: 1789004151 },
      secondary: { used_percent: usedSecondary, window_minutes: 10080, resets_at: 1789590951 },
      credits: { has_credits: false, unlimited: false, balance: '0' },
      individual_limit: null,
      spend_control_reached: null,
      plan_type: 'plus',
      rate_limit_reached_type: reached
    }
  }
});

/** A CODEX_HOME with one rollout under the dated layout codex actually uses. */
function makeHome(lines, day = ['2026', '09', '09'], name = 'rollout-2026-09-09T22-42-33-aaa.jsonl') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codexcap-'));
  const dir = path.join(home, 'sessions', ...day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { home, file, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const source = () => new CodexRolloutCapacitySource(() => 'scope-x');

test('the newest snapshot in the rollout is the one reported', () => {
  const h = makeHome([
    line(2, 0, '2026-09-09T20:42:56.262Z'),
    line(37, 12, '2026-09-09T21:10:00.000Z')
  ]);
  const obs = source().observe(h.home);
  assert.ok(obs);
  assert.equal(obs.provider, 'codex');
  assert.equal(obs.poolKey, 'codex:scope-x:codex');
  assert.equal(obs.windows.find((w) => w.kind === 'FIVE_HOUR').remainingPercent, 63);
  assert.equal(obs.windows.find((w) => w.kind === 'SEVEN_DAY').remainingPercent, 88);
  // The rollout copy is authoritative at its EVENT time, not at read time.
  assert.equal(obs.observedAt, Date.parse('2026-09-09T21:10:00.000Z'));
  assert.equal(obs.source, 'codex-rollout');
  h.cleanup();
});

test('an UNCHANGED file is not read a second time - the idle path reports nothing new', () => {
  const h = makeHome([line(2, 0, '2026-09-09T20:42:56.262Z')]);
  const s = source();
  assert.ok(s.observe(h.home));
  assert.equal(s.observe(h.home), null);
  assert.equal(s.observe(h.home), null);
  h.cleanup();
});

test('an APPENDED snapshot is picked up on the next observation', () => {
  const h = makeHome([line(2, 0, '2026-09-09T20:42:56.262Z')]);
  const s = source();
  s.observe(h.home);
  fs.appendFileSync(h.file, line(50, 20, '2026-09-09T21:30:00.000Z') + '\n');
  // Force a distinct mtime: a same-millisecond append is indistinguishable from no
  // append, and this test is about the read, not about filesystem timer resolution.
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(h.file, t, t);
  const obs = s.observe(h.home);
  assert.ok(obs);
  assert.equal(obs.windows.find((w) => w.kind === 'FIVE_HOUR').remainingPercent, 50);
  h.cleanup();
});

test('a NEW session file is found on rescan, and the newest file wins', () => {
  const h = makeHome([line(2, 0, '2026-09-09T20:42:56.262Z')]);
  const s = source();
  s.observe(h.home);
  const dir = path.join(h.home, 'sessions', '2026', '09', '10');
  fs.mkdirSync(dir, { recursive: true });
  const newer = path.join(dir, 'rollout-2026-09-10T09-00-00-bbb.jsonl');
  fs.writeFileSync(newer, line(80, 40, '2026-09-10T09:00:00.000Z') + '\n');
  const t = new Date(Date.now() + 10_000);
  fs.utimesSync(newer, t, t);
  const obs = s.observe(h.home, { rescan: true });
  assert.ok(obs);
  assert.equal(obs.windows.find((w) => w.kind === 'FIVE_HOUR').remainingPercent, 20);
  h.cleanup();
});

test('a typed reached signal survives the read and attributes only when it names a window', () => {
  // A REAL member of the provider's enumeration. It is hard evidence that something
  // is limiting, and it names no window - so attribution stays null.
  const named = makeHome([line(100, 40, '2026-09-09T21:00:00.000Z', 'rate_limit_reached')]);
  const a = source().observe(named.home);
  assert.equal(a.providerReachedType, 'rate_limit_reached');
  assert.equal(a.providerAttributedLimitingWindowId, null);
  named.cleanup();

  const vague = makeHome([line(100, 40, '2026-09-09T21:00:00.000Z', 'usage')]);
  const b = source().observe(vague.home);
  assert.equal(b.providerReachedType, 'usage');
  assert.equal(b.providerAttributedLimitingWindowId, null);
  vague.cleanup();
});

test('a home with no sessions, no rollouts, or nothing but junk reports nothing rather than throwing', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codexcap-'));
  assert.equal(source().observe(empty), null);
  fs.mkdirSync(path.join(empty, 'sessions'));
  assert.equal(source().observe(empty), null);
  fs.rmSync(empty, { recursive: true, force: true });

  const junk = makeHome(['not json at all', '{"partial":']);
  assert.equal(source().observe(junk.home), null);
  junk.cleanup();
});

test('a truncated first line in the tail is skipped, not treated as corruption', () => {
  const good = line(10, 5, '2026-09-09T21:00:00.000Z');
  const tail = `{"timestamp":"2026-09-09T20:00:00.000Z","payload":{"rate_li\n${good}`;
  const found = latestUsableRateLimits(tail, acceptAnyWindows);
  assert.ok(found);
  assert.equal(found.rateLimits.primary.used_percent, 10);
});

/** A `premium` snapshot, verbatim in shape from live data: both windows null. */
const premiumLine = (ts) => JSON.stringify({
  timestamp: ts,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    rate_limits: {
      limit_id: 'premium', limit_name: null, primary: null, secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
      individual_limit: null, spend_control_reached: null, plan_type: 'plus',
      rate_limit_reached_type: null
    }
  }
});

test('a tail whose NEWEST snapshots are empty premium ones still yields the codex reading behind them', () => {
  // The live steady state, not a contrived case: premium snapshots land about once
  // a minute and carry no windows at all, so a reader that stops at the newest line
  // holding a rate_limits key collects NOTHING while the file is full of readings.
  const h = makeHome([
    line(37, 12, '2026-09-09T20:50:00.000Z'),
    premiumLine('2026-09-09T20:54:50.000Z'),
    premiumLine('2026-09-09T20:55:50.000Z'),
    premiumLine('2026-09-09T20:57:50.000Z'),
    premiumLine('2026-09-09T20:58:50.000Z')
  ]);
  const obs = source().observe(h.home);
  assert.ok(obs, 'four trailing empty snapshots must not hide the codex reading');
  assert.equal(obs.limitId, 'codex');
  assert.equal(obs.windows.find((w) => w.kind === 'FIVE_HOUR').remainingPercent, 63);
  // Dated by ITS OWN time - not by the newer empty lines and not by now - so it
  // ages out on the normal TTL instead of being passed off as current.
  assert.equal(obs.observedAt, Date.parse('2026-09-09T20:50:00.000Z'));
  h.cleanup();
});

test('a tail containing ONLY empty premium snapshots still yields nothing', () => {
  const h = makeHome([
    premiumLine('2026-09-09T20:57:50.000Z'),
    premiumLine('2026-09-09T20:58:50.000Z')
  ]);
  // No window, no reached type, nothing to report. Walking further back must never
  // turn an absence of data into an observation.
  assert.equal(source().observe(h.home), null);
  h.cleanup();
});

test('a line with no rate_limits at all is passed over', () => {
  const noLimits = JSON.stringify({ timestamp: '2026-09-09T21:05:00.000Z', type: 'event_msg', payload: { type: 'agent_message' } });
  const h = makeHome([line(2, 0, '2026-09-09T20:42:56.262Z'), noLimits]);
  const obs = source().observe(h.home);
  assert.equal(obs.windows.find((w) => w.kind === 'FIVE_HOUR').remainingPercent, 98);
  h.cleanup();
});
