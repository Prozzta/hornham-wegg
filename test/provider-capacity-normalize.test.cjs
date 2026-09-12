'use strict';

/**
 * L0-CORE — provider payload normalisation.
 *
 * These are shape tests against REAL observed payloads, not invented ones. The
 * Codex fixture is copied verbatim from a rollout `token_count` event written by
 * codex 0.154.0 in this hive (agent home `.codex/sessions/2026/09/09/rollout-*.jsonl`),
 * which is why it is snake_case and why `resets_at` is in epoch SECONDS.
 *
 * The Claude fixture is built from the documented status-line schema. It has NOT
 * been observed in this hive: no Claude status-line payload carrying `rate_limits`
 * has been captured here yet, because the field was dropped before it reached any
 * storage. That is recorded as a verification gap rather than hidden behind a
 * passing test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { normalizeClaudeStatusLine, normalizeCodexRateLimits } = loadTs('src/main/capacityNormalize.ts');

const RECEIVED = 1_789_000_000_000;

// ── Claude status line ───────────────────────────────────────────────────────

test('claude: five_hour and seven_day normalise to remaining, with epoch reset times', () => {
  const obs = normalizeClaudeStatusLine({
    rateLimits: {
      five_hour: { used_percentage: 37, resets_at: 1789004151 },
      seven_day: { used_percentage: 88.5, resets_at: '2026-09-14T09:00:00.000Z' }
    },
    accountScope: 'acct-a',
    receivedAt: RECEIVED
  });
  assert.ok(obs);
  assert.equal(obs.provider, 'claude');
  assert.equal(obs.poolKey, 'claude:acct-a:subscription');
  assert.equal(obs.windows.length, 2);
  const five = obs.windows.find((w) => w.windowId === 'five_hour');
  assert.equal(five.kind, 'FIVE_HOUR');
  assert.equal(five.label, '5h');
  assert.equal(five.remainingPercent, 63);
  assert.equal(five.resetsAt, 1789004151000);
  const week = obs.windows.find((w) => w.windowId === 'seven_day');
  assert.equal(week.kind, 'SEVEN_DAY');
  assert.equal(week.label, 'Weekly');
  assert.equal(week.remainingPercent, 11.5);
  assert.equal(week.resetsAt, Date.parse('2026-09-14T09:00:00.000Z'));
});

test('claude: a percentage is an OBSERVATION - the status line never attributes a limiting window', () => {
  const obs = normalizeClaudeStatusLine({
    rateLimits: { five_hour: { used_percentage: 100, resets_at: 1789004151 } },
    accountScope: 'acct-a',
    receivedAt: RECEIVED
  });
  assert.equal(obs.windows[0].remainingPercent, 0);
  // Exhausted numerically, but nothing named it as limiting. C2.4: these are two
  // different facts and this path may only ever supply the first.
  assert.equal(obs.providerAttributedLimitingWindowId, null);
  assert.equal(obs.providerReachedType, null);
});

test('claude: spend/overage entries are NOT turned into capacity windows', () => {
  const obs = normalizeClaudeStatusLine({
    rateLimits: {
      five_hour: { used_percentage: 10, resets_at: 1789004151 },
      overage: { enabled: true, spend_usd: 12.5 },
      note: 'not an object'
    },
    accountScope: 'acct-a',
    receivedAt: RECEIVED
  });
  assert.deepEqual(obs.windows.map((w) => w.windowId), ['five_hour']);
});

test('claude: an unknown model-family window survives as OTHER rather than being forced into a known slot', () => {
  const obs = normalizeClaudeStatusLine({
    rateLimits: { opus_weekly: { used_percentage: 20, resets_at: 1789004151 } },
    accountScope: 'acct-a',
    receivedAt: RECEIVED
  });
  assert.equal(obs.windows[0].kind, 'OTHER');
  assert.equal(obs.windows[0].windowMinutes, null);
  assert.equal(obs.windows[0].remainingPercent, 80);
});

test('claude: a missing percentage stays NULL and never becomes zero or available', () => {
  const obs = normalizeClaudeStatusLine({
    rateLimits: { five_hour: { resets_at: 1789004151 } },
    accountScope: 'acct-a',
    receivedAt: RECEIVED
  });
  assert.equal(obs.windows[0].usedPercent, null);
  assert.equal(obs.windows[0].remainingPercent, null);
});

test('claude: no rate_limits at all yields no observation, not an empty healthy one', () => {
  assert.equal(normalizeClaudeStatusLine({ rateLimits: undefined, accountScope: 'a', receivedAt: RECEIVED }), null);
  assert.equal(normalizeClaudeStatusLine({ rateLimits: {}, accountScope: 'a', receivedAt: RECEIVED }), null);
  assert.equal(normalizeClaudeStatusLine({ rateLimits: { five_hour: {} }, accountScope: 'a', receivedAt: RECEIVED }), null);
});

// ── Codex ────────────────────────────────────────────────────────────────────

/** Verbatim from a codex 0.154.0 rollout token_count event in this hive. */
const CODEX_OBSERVED = {
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: 2.0, window_minutes: 300, resets_at: 1789004151 },
  secondary: { used_percent: 0.0, window_minutes: 10080, resets_at: 1789590951 },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  individual_limit: null,
  spend_control_reached: null,
  plan_type: 'plus',
  rate_limit_reached_type: null
};

test('codex: the real observed rollout payload normalises end to end', () => {
  const obs = normalizeCodexRateLimits({
    rateLimits: CODEX_OBSERVED,
    accountScope: 'acct-b',
    observedAt: Date.parse('2026-09-09T20:42:56.262Z'),
    receivedAt: RECEIVED
  });
  assert.ok(obs);
  assert.equal(obs.poolKey, 'codex:acct-b:codex');
  assert.equal(obs.planType, 'plus');
  assert.equal(obs.source, 'codex-rollout');
  assert.equal(obs.observedAt, Date.parse('2026-09-09T20:42:56.262Z'));
  const five = obs.windows.find((w) => w.kind === 'FIVE_HOUR');
  assert.equal(five.windowId, 'five_hour');
  assert.equal(five.remainingPercent, 98);
  assert.equal(five.resetsAt, 1789004151000);
  const week = obs.windows.find((w) => w.kind === 'SEVEN_DAY');
  assert.equal(week.remainingPercent, 100);
  assert.equal(obs.providerAttributedLimitingWindowId, null);
  assert.equal(obs.ordinaryUsageAllowed, null);
});

test('codex: DURATION decides the window, not the primary/secondary slot it arrived in', () => {
  const swapped = {
    limit_id: 'codex',
    primary: { used_percent: 5, window_minutes: 10080, resets_at: 1789590951 },
    secondary: { used_percent: 40, window_minutes: 300, resets_at: 1789004151 }
  };
  const obs = normalizeCodexRateLimits({ rateLimits: swapped, accountScope: 'acct-b', receivedAt: RECEIVED });
  const week = obs.windows.find((w) => w.kind === 'SEVEN_DAY');
  const five = obs.windows.find((w) => w.kind === 'FIVE_HOUR');
  assert.equal(week.remainingPercent, 95);
  assert.equal(five.remainingPercent, 60);
});

test('codex: an unrecognised duration stays OTHER and keeps a duration-derived id', () => {
  const obs = normalizeCodexRateLimits({
    rateLimits: { primary: { used_percent: 1, window_minutes: 1440, resets_at: 1789004151 } },
    accountScope: 'acct-b',
    receivedAt: RECEIVED
  });
  assert.equal(obs.windows[0].kind, 'OTHER');
  assert.equal(obs.windows[0].windowId, 'w1440m');
});

test('codex: a reached type that names NO window attributes no window', () => {
  const obs = normalizeCodexRateLimits({
    rateLimits: { ...CODEX_OBSERVED, rate_limit_reached_type: 'usage' },
    accountScope: 'acct-b',
    receivedAt: RECEIVED
  });
  // The signal is kept - something IS limiting - but it is not evidence about
  // WHICH window, and manufacturing one would be the causal claim C2.4 forbids.
  assert.equal(obs.providerReachedType, 'usage');
  assert.equal(obs.providerAttributedLimitingWindowId, null);
});

test('codex: a reached type that DOES name a window attributes exactly that window', () => {
  const obs = normalizeCodexRateLimits({
    rateLimits: { ...CODEX_OBSERVED, rate_limit_reached_type: 'secondary' },
    accountScope: 'acct-b',
    receivedAt: RECEIVED
  });
  assert.equal(obs.providerAttributedLimitingWindowId, 'seven_day');
});

test('codex: the camelCase app-server spelling normalises identically', () => {
  const obs = normalizeCodexRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1789004151 },
      ordinaryUsageAllowed: false
    },
    accountScope: 'acct-b',
    receivedAt: RECEIVED,
    source: 'codex-account-read'
  });
  assert.equal(obs.source, 'codex-account-read');
  assert.equal(obs.windows[0].kind, 'FIVE_HOUR');
  assert.equal(obs.windows[0].remainingPercent, 98);
  assert.equal(obs.ordinaryUsageAllowed, false);
});

test('codex: ordinaryUsageAllowed is tri-state - absent and non-boolean both stay unknown', () => {
  const absent = normalizeCodexRateLimits({ rateLimits: CODEX_OBSERVED, accountScope: 'b', receivedAt: RECEIVED });
  assert.equal(absent.ordinaryUsageAllowed, null);
  const junk = normalizeCodexRateLimits({
    rateLimits: { ...CODEX_OBSERVED, ordinary_usage_allowed: 'yes' },
    accountScope: 'b',
    receivedAt: RECEIVED
  });
  assert.equal(junk.ordinaryUsageAllowed, null);
});

test('codex: over-100 used clamps to zero remaining rather than going negative', () => {
  const obs = normalizeCodexRateLimits({
    rateLimits: { primary: { used_percent: 100.4, window_minutes: 300, resets_at: 1789004151 } },
    accountScope: 'b',
    receivedAt: RECEIVED
  });
  assert.equal(obs.windows[0].remainingPercent, 0);
});

test('codex: a payload with neither windows nor a reached type yields no observation', () => {
  assert.equal(normalizeCodexRateLimits({ rateLimits: { limit_id: 'codex' }, accountScope: 'b', receivedAt: RECEIVED }), null);
  assert.equal(normalizeCodexRateLimits({ rateLimits: null, accountScope: 'b', receivedAt: RECEIVED }), null);
});

test('a reached type alone - no windows at all - is still an observation, because a typed refusal is evidence', () => {
  const obs = normalizeCodexRateLimits({
    rateLimits: { limit_id: 'codex', rate_limit_reached_type: 'usage' },
    accountScope: 'b',
    receivedAt: RECEIVED
  });
  assert.ok(obs);
  assert.equal(obs.windows.length, 0);
  assert.equal(obs.providerReachedType, 'usage');
});

test('the two accounts of one provider do not share a pool', () => {
  const a = normalizeCodexRateLimits({ rateLimits: CODEX_OBSERVED, accountScope: 'acct-a', receivedAt: RECEIVED });
  const b = normalizeCodexRateLimits({ rateLimits: CODEX_OBSERVED, accountScope: 'acct-b', receivedAt: RECEIVED });
  assert.notEqual(a.poolKey, b.poolKey);
});
