/**
 * Provider payload → normalised capacity observation. PURE: no I/O, no clock, no
 * state, so every shape question is testable without a provider or a filesystem.
 *
 * Two sources, two different routes to the same identity:
 *   - Claude's status line NAMES its windows (`five_hour`, `seven_day`) and gives
 *     no duration, so the name carries the identity and the duration is implied.
 *   - Codex POSITIONS its windows (`primary`, `secondary`) and gives
 *     `window_minutes`, so the duration carries the identity and the position is
 *     discarded. A plan change can move which slot holds which duration; trusting
 *     the slot would silently retarget a window.
 *
 * Everything here refuses to invent data. An absent, non-numeric or unparsable
 * field stays null, a payload with nothing usable returns null rather than an
 * empty-looking-healthy observation, and no field is defaulted to zero.
 *
 * NOTHING in this file reads credential material. Account scope arrives already
 * computed from the collection site.
 */
import {
  type CapacityObservation,
  type CapacityWindow,
  type ObservationSource,
  type WindowKind,
  FIVE_HOUR_MINUTES,
  SEVEN_DAY_MINUTES,
  poolKeyOf,
  windowKindFromMinutes,
  windowLabel
} from '../shared/providerCapacity';

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

const finiteNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Epoch normalisation. Providers send seconds (Codex rollout: `resets_at:
 * 1789004151`) and the Claude schema documents a reset time without pinning the
 * encoding, so accept seconds, milliseconds or an ISO string. The 1e11 split is
 * safe for any time this software will run in: as milliseconds that is 1973, and
 * as seconds it is the year 5138.
 */
function parseEpochMs(v: unknown): number | null {
  const n = finiteNumber(v);
  if (n !== null) {
    if (n <= 0) return null;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  if (typeof v === 'string' && v.trim()) {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * used → remaining, done once here so nothing downstream does arithmetic on
 * provider numbers.
 *
 * THE TWO OUT-OF-RANGE DIRECTIONS ARE NOT SYMMETRIC, AND TREATING THEM AS ONE WAS
 * THE DEFECT. Above 100 is a real reading of a real state: a provider reporting
 * 100.4% used is over its allowance, and clamping to zero remaining reports
 * exhaustion, which is true and is the conservative direction. Below 0 is not a
 * reading at all - no allowance can be negatively consumed - and the old clamp
 * turned that nonsense into 100% REMAINING, which is the one thing this design
 * says must never happen: an invalid number becoming a healthy-looking fact. So an
 * impossible used figure yields NO NUMBER, and the window lands in UNKNOWN with
 * the rest of its incomplete siblings rather than in AVAILABLE.
 */
function remainingFromUsed(used: number | null): number | null {
  if (used === null) return null;
  return Math.max(0, 100 - used);
}

/**
 * A used-percentage that is a number but not a possible one. Rejected at the
 * source so the invalid figure never reaches EITHER published field - a window
 * carrying `usedPercent: -50` would be a nonsense number on a surface even with
 * its remainder correctly suppressed.
 */
function usedPercent(v: unknown): number | null {
  const n = finiteNumber(v);
  return n === null || n < 0 ? null : n;
}

/** Claude names its windows; the duration is implied by the documented name. */
const CLAUDE_WINDOW_KINDS: Record<string, { kind: WindowKind; minutes: number }> = {
  five_hour: { kind: 'FIVE_HOUR', minutes: FIVE_HOUR_MINUTES },
  seven_day: { kind: 'SEVEN_DAY', minutes: SEVEN_DAY_MINUTES }
};

/**
 * Claude status-line `rate_limits`.
 *
 * The schema may also carry model-family windows and overage/spend fields, so an
 * entry is only treated as a window when it actually looks like one. A spend or
 * overage object turned into a window would put a currency figure on a capacity
 * row, which is the kind of category error this whole design exists to prevent.
 */
export function normalizeClaudeStatusLine(input: {
  rateLimits: unknown;
  accountScope: string;
  observedAt?: number | null;
  receivedAt: number;
}): CapacityObservation | null {
  const rl = input.rateLimits;
  if (!isDict(rl)) return null;

  const windows: CapacityWindow[] = [];
  for (const [key, raw] of Object.entries(rl)) {
    if (!isDict(raw)) continue;
    const hasUsed = 'used_percentage' in raw;
    const hasReset = 'resets_at' in raw;
    if (!hasUsed && !hasReset) continue;
    const used = usedPercent(raw.used_percentage);
    const resetsAt = parseEpochMs(raw.resets_at);
    // An entry with neither a usable number nor a usable time carries nothing; it
    // is dropped rather than kept as a window of unknowns, which would read on a
    // surface as "a limit exists and we know nothing about it" when in fact the
    // provider said nothing at all.
    if (used === null && resetsAt === null) continue;
    const known = CLAUDE_WINDOW_KINDS[key];
    const kind = known?.kind ?? 'OTHER';
    const minutes = known?.minutes ?? null;
    windows.push({
      windowId: key,
      kind,
      // A DOCUMENTED window name identifies a window we know constrains this
      // subscription. An unrecognised key is a window we cannot identify - not one
      // we know is irrelevant - so its applicability is UNKNOWN and the pool is
      // UNKNOWN with it, rather than AVAILABLE on whatever else parsed.
      applicability: known ? 'APPLICABLE' : 'UNKNOWN',
      label: known ? windowLabel(kind, minutes) : key,
      windowMinutes: minutes,
      usedPercent: used,
      remainingPercent: remainingFromUsed(used),
      resetsAt
    });
  }

  if (!windows.length) return null;

  // Claude's status-line schema carries no causal attribution and no limit
  // identity: a percentage is an observation, not a statement that this window is
  // limiting the account (C2.4). Attribution therefore stays null on this path,
  // and Claude copy stays numeric and observational downstream.
  return {
    poolKey: poolKeyOf('claude', input.accountScope, 'subscription'),
    provider: 'claude',
    accountScope: input.accountScope,
    limitId: 'subscription',
    source: 'claude-status-line' satisfies ObservationSource,
    observedAt: finiteNumber(input.observedAt) ?? input.receivedAt,
    receivedAt: input.receivedAt,
    windows,
    providerAttributedLimitingWindowId: null,
    providerReachedType: null,
    ordinaryUsageAllowed: null,
    planType: null
  };
}

/**
 * `spend_control_reached` is a boolean, not a named type, so a name is needed to
 * carry it in the one field that records what the provider said. It is deliberately
 * NOT one of the protocol's own enum values: it did not come from that enum, and a
 * downstream reader comparing against the closed set below must not match it.
 */
export const SPEND_CONTROL_REACHED = 'spend_control_reached';

/**
 * The provider's CLOSED set of reached types, and what each attributes.
 *
 * READ THE VALUES: NOT ONE OF THEM NAMES A WINDOW. `rate_limit_reached`,
 * credits-depleted and usage-limit-reached, owner and member - the protocol says
 * THAT something is limiting and never WHICH window, so every entry maps to null.
 * That is the finding, and it is why this replaces a substring test rather than
 * tightening one: the old code searched these strings for 'primary', 'weekly' and
 * '5h', which no member of the enum contains, so it was scanning for a capability
 * the provider does not have. Against today's payloads it attributed nothing and
 * looked correct; against any future or unrecognised string it could manufacture a
 * causal claim out of a coincidental substring.
 *
 * An unrecognised string is kept VERBATIM as evidence that something is limiting -
 * that much is true whatever the string says - and attributes nothing. Adding a
 * mapping here requires a provider value that genuinely identifies a window, and a
 * fixture carrying it.
 */
const CODEX_REACHED_TYPES: Record<string, string | null> = {
  rate_limit_reached: null,
  workspace_owner_credits_depleted: null,
  workspace_member_credits_depleted: null,
  workspace_owner_usage_limit_reached: null,
  workspace_member_usage_limit_reached: null
};

/**
 * Which window, if any, a reached type names. Exact match against the closed set;
 * anything else attributes nothing. Attribution is a CAUSAL claim, and C2.4 permits
 * one only where the provider made it.
 */
function attributedWindowFor(reachedType: string | null, rl: Dict): string | null {
  if (!reachedType) return null;
  const slot = CODEX_REACHED_TYPES[reachedType];
  if (!slot) return null;
  return codexWindow(slot, rl[slot])?.windowId ?? null;
}

/** Codex slot → normalised window, identified by duration rather than by slot. */
function codexWindow(slot: string, raw: unknown): CapacityWindow | null {
  if (!isDict(raw)) return null;
  const used = usedPercent(raw.used_percent ?? raw.usedPercent);
  const minutes = finiteNumber(raw.window_minutes ?? raw.windowDurationMins);
  const resetsAt = parseEpochMs(raw.resets_at ?? raw.resetsAt);
  if (used === null && resetsAt === null) return null;
  const kind = windowKindFromMinutes(minutes);
  return {
    // Duration-derived where known. Falling back to the slot name is the honest
    // last resort: it is a weaker identity, and it is marked OTHER so nothing
    // downstream can mistake it for a known window.
    windowId: kind === 'OTHER' ? (minutes !== null ? `w${minutes}m` : slot) : kind.toLowerCase(),
    kind,
    // A window with a real duration is a real window and it applies. Without one we
    // could not identify it at all - we fell back to the SLOT name, which a plan
    // change can move - so we do not know what it constrains. That is UNKNOWN
    // applicability, and it is exactly the case L0-SEM 121 refuses to let pass as
    // healthy.
    applicability: minutes !== null ? 'APPLICABLE' : 'UNKNOWN',
    label: windowLabel(kind, minutes),
    windowMinutes: minutes,
    usedPercent: used,
    remainingPercent: remainingFromUsed(used),
    resetsAt
  };
}

/**
 * Codex `rate_limits`, as it appears in a rollout `token_count` event and in the
 * app-server account snapshot. Both spellings are accepted because the rollout
 * JSONL is snake_case while the app-server protocol is camelCase.
 *
 * TWO REACHED FACTS, NOT ONE. The snapshot carries `rate_limit_reached_type` and
 * the sibling boolean `spend_control_reached`, and both are provider-native
 * statements that ordinary use is blocked. Reading only the first left a payload
 * whose spend control had tripped looking AVAILABLE.
 *
 * ATTRIBUTION IS CONSERVATIVE, AND NOW CLOSED. A reached type is retained verbatim
 * whenever the provider sets it, but it only becomes an attributed WINDOW by exact
 * match against the provider's own enumeration - and no member of that enumeration
 * names a window. A reached signal that names no window is real evidence that
 * something is limiting and is NOT evidence about which window, so inventing the
 * window would manufacture exactly the causal claim C2.4 forbids.
 *
 * A ROLLOUT LINE MUST CARRY ITS OWN TIME. `codex-rollout` is a REPLAY source: the
 * line was written at some past moment and read later, so substituting receipt time
 * would date a stale reading to now and publish it as FRESH. L0-SEM section 6 is
 * explicit — "replaying an old line does not make it fresh", and Codex replay
 * requires a valid embedded time where Claude's LIVE hook may use local receipt
 * time. So a rollout line without a usable timestamp yields NO OBSERVATION, which
 * is the same answer section 7 already gives for a malformed or truncated trailing
 * line. The account read keeps receipt time: it is a live RPC answered now, not a
 * replay of something written earlier.
 */
export function normalizeCodexRateLimits(input: {
  rateLimits: unknown;
  accountScope: string;
  observedAt?: number | null;
  receivedAt: number;
  source?: Extract<ObservationSource, 'codex-rollout' | 'codex-account-read'>;
}): CapacityObservation | null {
  const rl = input.rateLimits;
  if (!isDict(rl)) return null;

  const windows: CapacityWindow[] = [];
  for (const slot of ['primary', 'secondary']) {
    const w = codexWindow(slot, rl[slot]);
    if (w) windows.push(w);
  }

  const reachedRaw = rl.rate_limit_reached_type ?? rl.rateLimitReachedType;
  const reachedType = typeof reachedRaw === 'string' && reachedRaw ? reachedRaw : null;
  // A SECOND provider-native reached fact, a sibling of the first in the same
  // snapshot. Only a real `true` counts: absent and false are both "not reached",
  // and a spend control that has not tripped says nothing about allowance.
  const spendRaw = rl.spend_control_reached ?? rl.spendControlReached;
  const spendReached = spendRaw === true;
  const providerReachedType = reachedType ?? (spendReached ? SPEND_CONTROL_REACHED : null);

  // Nothing usable at all — return null rather than a healthy-looking empty record.
  if (!windows.length && !providerReachedType) return null;

  const attributed = attributedWindowFor(reachedType, rl);

  const limitIdRaw = rl.limit_id ?? rl.limitId;
  const planRaw = rl.plan_type ?? rl.planType;
  const allowedRaw = rl.ordinary_usage_allowed ?? rl.ordinaryUsageAllowed;

  const source = input.source ?? 'codex-rollout';
  const observedAt = finiteNumber(input.observedAt);
  // The guard, placed at the fallback that caused the defect rather than at the one
  // caller that happened to trip it, so a future caller cannot reintroduce it.
  if (source === 'codex-rollout' && observedAt === null) return null;

  const limitId = typeof limitIdRaw === 'string' && limitIdRaw ? limitIdRaw : 'codex';
  return {
    poolKey: poolKeyOf('codex', input.accountScope, limitId),
    provider: 'codex',
    accountScope: input.accountScope,
    limitId,
    source,
    observedAt: observedAt ?? input.receivedAt,
    receivedAt: input.receivedAt,
    windows,
    providerAttributedLimitingWindowId: attributed,
    providerReachedType,
    // Tri-state and strict: only a real boolean counts. An absent field stays
    // unknown, because "not stated" must never become "ordinary use is allowed".
    ordinaryUsageAllowed: typeof allowedRaw === 'boolean' ? allowedRaw : null,
    planType: typeof planRaw === 'string' && planRaw ? planRaw : null
  };
}

/** Exported for the tracker's own reset arithmetic; kept in one place. */
export { parseEpochMs };
