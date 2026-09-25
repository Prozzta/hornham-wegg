'use strict';

/**
 * L0-FIX — provider-capacity fixture corpus.
 *
 * DERIVED FROM THE SPEC, NOT FROM THE IMPLEMENTATION:
 * research/notes/oscar-l0-sem.md, sha256 643D45C0…86CC, 21,515 bytes / 187 lines
 * (identity verified from disk before this corpus was written). Every `spec` field
 * below cites the clause the expectation comes from. A fixture derived from the
 * implementation only proves the implementation is self-consistent; one derived
 * from the spec can actually disagree with it, which is the only way it is worth
 * anything.
 *
 * ATTRIBUTION CAPABILITY IS A FORMAT FIELD, NOT A COMMENT.
 * The production observation type cannot express the difference between:
 *   (a) a source that CANNOT carry causal attribution — Claude's status-line has no
 *       reached-type field at all; and
 *   (b) a source that CAN, and simply did not on this reading — Codex with no typed
 *       reached signal.
 * Both appear as `providerAttributedLimitingWindowId: null, providerReachedType: null`.
 * Collapsing them is the error §1 names: "Missing attribution is not 'provider says
 * not limiting.'" So each fixture declares `attribution.capability` and
 * `attribution.present` independently, and the corpus asserts that the two are never
 * conflated. This is a FIXTURE-side encoding: adding a field to the production type
 * would be implementing, which this card forbids.
 */

const T0 = 1_800_000_000_000; // fixed epoch; nothing here reads a real clock
const LIVE_TTL_MS = 120_000; // §6 Claude status-line and Codex rollout
const ACCOUNT_TTL_MS = 300_000; // §6 Codex account/rateLimits/read
const FUTURE_SKEW_MS = 30_000; // §6 a timestamp further ahead than this is invalid

/** Which sources can ever carry causal attribution. §1, and C2.4's provider asymmetry. */
const ATTRIBUTION_CAPABILITY = {
  'claude-status-line': 'INCAPABLE',
  'codex-rollout': 'CAPABLE',
  'codex-account-read': 'CAPABLE'
};

const win = (over = {}) => ({
  windowId: 'w5h',
  kind: 'FIVE_HOUR',
  label: '5h',
  windowMinutes: 300,
  usedPercent: 20,
  remainingPercent: 80,
  resetsAt: T0 + 3_600_000,
  ...over
});

const weekly = (over = {}) =>
  win({
    windowId: 'w7d',
    kind: 'SEVEN_DAY',
    label: 'Weekly',
    windowMinutes: 10_080,
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: T0 + 5 * 86_400_000,
    ...over
  });

/**
 * Build one normalised observation. `remainingPercent` is supplied already converted,
 * because §1 puts that conversion in main once; these fixtures exercise the TRACKER,
 * not the normaliser.
 */
const obs = (over = {}) => {
  const source = over.source ?? 'codex-rollout';
  const provider = over.provider ?? (source === 'claude-status-line' ? 'claude' : 'codex');
  return {
    poolKey: `${provider}:acct-a:limit-1`,
    provider,
    accountScope: 'acct-a',
    limitId: 'limit-1',
    source,
    observedAt: T0,
    receivedAt: T0,
    windows: [win()],
    providerAttributedLimitingWindowId: null,
    providerReachedType: null,
    ordinaryUsageAllowed: null,
    planType: null,
    ...over
  };
};

/**
 * Each entry: what it encodes, the clause it comes from, and — crucially — what it
 * would CATCH. A fixture whose `catches` field is empty is decoration.
 */
const CORPUS = [
  // ---- §4 attribution vs exhaustion, including the disagreement rows ----
  {
    id: 'ATTR-POSITIVE-NUMERIC',
    spec: '§4 row 1',
    attribution: { capability: 'CAPABLE', present: true },
    observation: obs({
      providerAttributedLimitingWindowId: 'w5h',
      providerReachedType: 'usage_limit_reached',
      windows: [win({ usedPercent: 10, remainingPercent: 90 })]
    }),
    expect: { state: 'LIMITED', attributedWindowId: 'w5h', numericallyExhausted: [] },
    catches:
      'an implementation that "corrects" the provider from the percentage, or drops the ' +
      'positive numeric observation because it contradicts the attribution'
  },
  {
    id: 'ZERO-WITHOUT-ATTRIBUTION',
    spec: '§4 row 2, §2 N-R',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ windows: [win({ usedPercent: 100, remainingPercent: 0 })] }),
    expect: { state: 'RESERVE_ONLY', attributedWindowId: null, numericallyExhausted: ['w5h'] },
    catches:
      'THE COLLAPSE THIS CARD EXISTS TO CATCH: treating a fresh numeric zero as LIMITED. ' +
      'Numeric exhaustion makes no causal claim and must not fabricate provider attribution'
  },
  {
    id: 'ATTR-W1-EXHAUSTED-W2',
    spec: '§4 row 3',
    attribution: { capability: 'CAPABLE', present: true },
    observation: obs({
      providerAttributedLimitingWindowId: 'w5h',
      providerReachedType: 'usage_limit_reached',
      windows: [win({ usedPercent: 10, remainingPercent: 90 }), weekly({ usedPercent: 100, remainingPercent: 0 })]
    }),
    expect: { state: 'LIMITED', attributedWindowId: 'w5h', numericallyExhausted: ['w7d'] },
    catches:
      'merging the two facts — inferring that the exhausted window caused the refusal, or ' +
      'that the attributed window is numerically tighter'
  },
  {
    id: 'TYPED-REFUSAL-NO-WINDOW',
    spec: '§4 row 4',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({
      providerReachedType: 'usage_limit_reached',
      windows: [win(), weekly()]
    }),
    expect: { state: 'LIMITED', attributedWindowId: null, numericallyExhausted: [] },
    catches: 'inventing a Weekly or five-hour attribution for a pool-scoped typed refusal'
  },
  {
    id: 'PERMISSION-TRUE-WITH-ZERO',
    spec: '§4 row 5',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({
      ordinaryUsageAllowed: true,
      source: 'codex-account-read',
      windows: [win({ usedPercent: 100, remainingPercent: 0 })]
    }),
    expect: { state: 'RESERVE_ONLY', attributedWindowId: null, numericallyExhausted: ['w5h'] },
    catches:
      'reading permission as permission to call zero usable — it is recovery evidence, not headroom'
  },
  {
    id: 'GENERIC-FAILURE-WITH-FRESH-POSITIVE',
    spec: '§4 row 7',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ windows: [win()] }),
    expect: { state: 'AVAILABLE', attributedWindowId: null, numericallyExhausted: [] },
    catches:
      'relabelling a generic 429, overload or context exhaustion as provider limiting — ' +
      'the error lives outside capacity facts and must not become attribution'
  },

  // ---- gap #16: capability vs missing data ----
  {
    id: 'CLAUDE-CANNOT-ATTRIBUTE',
    spec: '§1 "Missing attribution is not \'provider says not limiting\'"; C2.4 asymmetry',
    attribution: { capability: 'INCAPABLE', present: false },
    observation: obs({ source: 'claude-status-line', windows: [win(), weekly()] }),
    expect: { state: 'AVAILABLE', attributedWindowId: null, numericallyExhausted: [] },
    catches:
      'a tracker that treats a source INCAPABLE of attribution as one that affirmatively ' +
      'reported "not limiting". Paired with CODEX-DID-NOT-ATTRIBUTE, which is byte-identical ' +
      'in the production observation type and must not be conflated'
  },
  {
    id: 'CODEX-DID-NOT-ATTRIBUTE',
    spec: '§1',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ source: 'codex-rollout', windows: [win(), weekly()] }),
    expect: { state: 'AVAILABLE', attributedWindowId: null, numericallyExhausted: [] },
    catches: 'the CLAUDE-CANNOT-ATTRIBUTE pair — same payload, different epistemic meaning'
  },
  {
    id: 'CLAUDE-NUMERIC-ZERO',
    spec: '§4 row 2 on an attribution-incapable source',
    attribution: { capability: 'INCAPABLE', present: false },
    observation: obs({
      source: 'claude-status-line',
      windows: [weekly({ usedPercent: 100, remainingPercent: 0 })]
    }),
    expect: { state: 'RESERVE_ONLY', attributedWindowId: null, numericallyExhausted: ['w7d'] },
    catches:
      'inferring Weekly limiting on Claude from a numeric zero, where the source can never ' +
      'supply causal evidence to support it'
  },

  // ---- §6 freshness, at the boundary and one past it ----
  {
    id: 'LIVE-TTL-AT-BOUNDARY',
    spec: '§6, fresh through 120,000 ms',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ windows: [win()] }),
    evaluateAt: T0 + LIVE_TTL_MS,
    expect: { state: 'AVAILABLE', freshness: 'FRESH' },
    catches: 'an off-by-one that expires a reading exactly AT its TTL'
  },
  {
    id: 'LIVE-TTL-PAST-BOUNDARY',
    spec: '§6, stale when age > 120,000 ms; §2 N-U',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ windows: [win()] }),
    evaluateAt: T0 + LIVE_TTL_MS + 1,
    expect: { state: 'UNKNOWN', freshness: 'STALE' },
    catches: 'stale data continuing to read as AVAILABLE — "stale must never look healthy"'
  },
  {
    id: 'ACCOUNT-TTL-PAST-BOUNDARY',
    spec: '§6, account read stale when age > 300,000 ms',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ source: 'codex-account-read', windows: [win()] }),
    evaluateAt: T0 + ACCOUNT_TTL_MS + 1,
    expect: { state: 'UNKNOWN', freshness: 'STALE' },
    catches: 'applying the live TTL to an account read, or vice versa — they are different budgets'
  },
  {
    id: 'ACCOUNT-TTL-STILL-FRESH-PAST-LIVE-TTL',
    spec: '§6, the two TTLs are independent',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ source: 'codex-account-read', windows: [win()] }),
    evaluateAt: T0 + LIVE_TTL_MS + 1,
    expect: { state: 'AVAILABLE', freshness: 'FRESH' },
    catches: 'collapsing both sources onto one TTL constant'
  },

  // ---- §1 invalid numerics are UNKNOWN, never clamped ----
  {
    id: 'NULL-REMAINDER-IS-UNKNOWN',
    spec: '§1 "Out-of-range, non-finite, missing or malformed values are UNKNOWN"',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ windows: [win({ usedPercent: null, remainingPercent: null })] }),
    expect: { state: 'UNKNOWN' },
    catches: 'clamping a missing value to healthy or to zero, either of which is a fabricated claim'
  },

  // ---- §6 future timestamps ----
  {
    id: 'FUTURE-TIMESTAMP-REJECTED',
    spec: '§6 "A future timestamp more than 30 seconds ahead is invalid"',
    attribution: { capability: 'CAPABLE', present: false },
    observation: obs({ observedAt: T0 + FUTURE_SKEW_MS + 1_000, windows: [win()] }),
    expect: { rejected: true },
    catches: 'a clock-skewed or forged future reading being treated as very fresh'
  }
];

module.exports = {
  T0,
  LIVE_TTL_MS,
  ACCOUNT_TTL_MS,
  FUTURE_SKEW_MS,
  ATTRIBUTION_CAPABILITY,
  CORPUS,
  win,
  weekly,
  obs
};
