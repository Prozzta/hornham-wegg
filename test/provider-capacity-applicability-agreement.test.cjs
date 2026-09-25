'use strict';

/**
 * L0-VAL3 — the two normaliser writers must decide APPLICABILITY by the same rule.
 *
 * WHAT WAS ALREADY CHECKED, AND WHAT WAS NOT. Mutation showed that changing either
 * writer's applicability decision is caught, each by a different test: writer 1 by
 * the documented-Claude-window case, writer 2 by the Codex-duration case. So each
 * writer is individually pinned. What no test anywhere asserted is that the two
 * write the SAME rule — `applicabilityOf` does not exist, and before this file the
 * identifier `applicability` appeared in no cross-path assertion at all. "One rule,
 * two evidence sources, so they cannot disagree" was carried by coincidence of
 * separate coverage rather than by structure.
 *
 * WHY AGREEMENT IS A REAL PROPERTY AND NOT A TIDINESS PREFERENCE. The classifier
 * reads ONE field with ONE meaning and cannot know which writer produced it:
 * L0-SEM 121 excludes known-inapplicable windows and sends unknown applicability to
 * UNKNOWN, provider-independently. If the writers disagree about what makes a
 * window identifiable, the same real situation yields a different pool state
 * depending on which provider happened to report it — and 121 is then applied
 * unevenly by construction, with nothing in the classifier able to notice.
 *
 * WHAT "EQUIVALENT INPUT" CAN HONESTLY MEAN HERE. The two schemas share no fields:
 * Claude NAMES its windows and states no duration, Codex POSITIONS them and states
 * a duration. So two payloads can only be equivalent in the one property the rule
 * reads — whether the window is identifiable — and the pairs below are matched on
 * that and nothing else. That is a choice I am making explicit rather than hiding
 * in a fixture: if the rule's real input is something other than identifiability,
 * these pairs are the wrong pairs, and the header is where that argument belongs.
 *
 * BOTH SIDES, BECAUSE AGREEMENT ALONE IS TRIVIAL. Two writers that answer UNKNOWN
 * to everything agree perfectly. Each test therefore asserts the agreement AND the
 * verdict: a matched-identifiable pair must both be APPLICABLE, a matched-
 * unidentifiable pair must both be UNKNOWN. Either half alone passes against an
 * implementation that fails the other.
 *
 * Independence: derived from L0-SEM 121 and from the two writers' stated rules. No
 * classification logic was read, and this file does not touch the duplication — the
 * single-shared-function fix is carded and is not mine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { normalizeClaudeStatusLine, normalizeCodexRateLimits } = loadTs('src/main/capacityNormalize.ts');
const { FIVE_HOUR_MINUTES, SEVEN_DAY_MINUTES } = loadTs('src/shared/providerCapacity.ts');

const RECEIVED = 1_789_000_000_000;
const OBSERVED = RECEIVED - 30_000;
/** A reading present on both sides, so the pairs differ ONLY in identifiability. */
const USED = 41;
const RESETS_AT = 1_789_004_151;

/** Claude's route to identity: the window's documented NAME. */
function claudeApplicability(windowKey) {
  const obs = normalizeClaudeStatusLine({
    rateLimits: { [windowKey]: { used_percentage: USED, resets_at: RESETS_AT } },
    accountScope: 'acct-agree',
    receivedAt: RECEIVED
  });
  assert.ok(obs, `claude normaliser produced no observation for ${windowKey}`);
  assert.equal(obs.windows.length, 1, 'one window in, one window out');
  return obs.windows[0].applicability;
}

/** Codex's route to identity: the window's DURATION. The slot is discarded. */
function codexApplicability(windowMinutes) {
  const primary = { used_percent: USED, resets_at: RESETS_AT };
  // Absent rather than null, because "the provider did not state a duration" is the
  // condition under test and a null field is a different payload.
  if (windowMinutes !== null) primary.window_minutes = windowMinutes;
  const obs = normalizeCodexRateLimits({
    rateLimits: { primary },
    accountScope: 'acct-agree',
    observedAt: OBSERVED,
    receivedAt: RECEIVED
  });
  assert.ok(obs, `codex normaliser produced no observation for minutes=${windowMinutes}`);
  assert.equal(obs.windows.length, 1, 'one window in, one window out');
  return obs.windows[0].applicability;
}

test('a window identifiable on BOTH paths gets the same verdict, and that verdict is APPLICABLE', () => {
  for (const [key, minutes] of [['five_hour', FIVE_HOUR_MINUTES], ['seven_day', SEVEN_DAY_MINUTES]]) {
    const viaName = claudeApplicability(key);
    const viaDuration = codexApplicability(minutes);
    assert.equal(
      viaName,
      viaDuration,
      `THE AGREEMENT: ${key} is identifiable by name and ${minutes}m is identifiable by ` +
        `duration, so the two writers must return the same applicability; they returned ` +
        `${viaName} and ${viaDuration}. The classifier reads one field and cannot tell them apart.`
    );
    // And the verdict itself, because equality alone is satisfied by two writers
    // that answer UNKNOWN to everything.
    assert.equal(viaName, 'APPLICABLE', `an identified window applies (${key})`);
  }
});

test('a window identifiable on NEITHER path gets the same verdict, and that verdict is UNKNOWN', () => {
  // The other side of the same rule. An unrecognised Claude key and a Codex slot
  // with no stated duration are the same situation in the only respect the rule
  // reads: the window cannot be identified, so what it constrains is not known.
  const viaName = claudeApplicability('opus_model_family');
  const viaDuration = codexApplicability(null);
  assert.equal(
    viaName,
    viaDuration,
    `THE AGREEMENT, other side: an undocumented name and an absent duration are both ` +
      `"cannot identify this window", so both writers must answer the same; they answered ` +
      `${viaName} and ${viaDuration}.`
  );
  assert.equal(
    viaName,
    'UNKNOWN',
    'an unidentifiable window is UNKNOWN applicability, not APPLICABLE on whatever else parsed (L0-SEM 121)'
  );
});

test('identifiability is NOT the derived window kind: a stated duration applies even when the kind is OTHER', () => {
  // NOT part of the agreement claim, and deliberately here rather than in a report
  // nobody will read when the carded fix lands. A 47-minute window has a real
  // duration, so Codex CAN identify it; its kind is still OTHER because it matches
  // no documented window. So the predicate both writers share is "is there identity
  // evidence", NOT "is the derived kind known" — and a single shared function keyed
  // on the derived kind would answer UNKNOWN here and silently narrow the Codex
  // path while every agreement assertion above stayed green.
  assert.equal(
    codexApplicability(47),
    'APPLICABLE',
    'a duration IS identity evidence; deduplicating on the derived kind would change this'
  );
});
