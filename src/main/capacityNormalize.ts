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
 * used → remaining. No clamping in either direction, because there is nothing left
 * to clamp: `usedPercent` has already rejected anything outside `[0,100]`.
 */
function remainingFromUsed(used: number | null): number | null {
  return used === null ? null : 100 - used;
}

/**
 * A used-percentage that is a number and a POSSIBLE one. Validated in `[0,100]`
 * (L0-SEM 36); anything else is UNKNOWN.
 *
 * I ARGUED THE OTHER WAY AND THE SPEC IS RIGHT. My reasoning was that the two
 * directions are asymmetric: below 0 is nonsense, but 100.4% used is a TRUE reading
 * of a real overage, so clamping it to zero remaining reports exhaustion, which is
 * both true and conservative. That is plausible and it is wrong, because it assumes
 * the number means what it says. AN OUT-OF-RANGE VALUE IS EVIDENCE OF A PARSE OR
 * PROTOCOL PROBLEM, NOT EVIDENCE OF AN OVERAGE - the same malformed payload that
 * produced 100.4 could as easily have produced 0.4 - and treating it as a reading
 * manufactures a fact out of a symptom. Line 36 names both directions and both
 * clamp destinations: "Out-of-range, non-finite, missing or malformed values are
 * UNKNOWN; they are not clamped to healthy or zero."
 *
 * So the conservative move is not "clamp toward exhaustion", it is "do not pretend
 * to have a number". The pool lands in UNKNOWN, which suppresses ordinary work just
 * as RESERVE_ONLY would, without asserting a provider state nobody observed.
 */
function usedPercent(v: unknown): number | null {
  const n = finiteNumber(v);
  return n === null || n < 0 || n > 100 ? null : n;
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
  streamId?: string | null;
  sourceSequence?: number | null;
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
    // The status line is a LIVE tick with no numbering of its own: one stream per
    // account scope, ordered by time alone.
    streamId: input.streamId ?? `claude-status:${input.accountScope}`,
    sourceSequence: finiteNumber(input.sourceSequence),
    source: 'claude-status-line' satisfies ObservationSource,
    // Claude's status line states no schema version on the path we read.
    sourceVersion: null,
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
  streamId?: string | null;
  sourceSequence?: number | null;
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
    // A rollout FILE is the stream: Codex restarts `ordinal` at zero in each new
    // session file, so an ordinal is only meaningful beside the file it came from.
    streamId: input.streamId ?? null,
    sourceSequence: finiteNumber(input.sourceSequence),
    source,
    // Neither Codex path states a version.
    sourceVersion: null,
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

// ─── Antigravity statusline (1.1.48) ─────────────────────────────────────────

/** The four quota buckets, and nothing else. Two families x two windows. */
export const AGY_QUOTA_KEYS = ['3p-5h', '3p-weekly', 'gemini-5h', 'gemini-weekly'] as const;
type AgyQuotaKey = (typeof AGY_QUOTA_KEYS)[number];

/** The fields a bucket carries, and nothing else. */
const AGY_BUCKET_KEYS = ['remaining_fraction', 'reset_time', 'reset_in_seconds'] as const;

/**
 * The MEASURED `agent_state` set, closed. `tool_use` is one of its VALUES - there is no
 * boolean `tool_use` property in the schema (Oscar's captures; Jim MF-1). A confirmation
 * prompt is `agent_state: 'tool_use'` together with `tool_confirmation_pending: true`.
 */
export const AGY_AGENT_STATES = ['authenticating', 'idle', 'working', 'tool_use'] as const;

/** The two allowance families. Also the two `limitId`s. */
export type AgyFamily = '3p' | 'gemini';

/** The canonical lifecycle one tick states. Never derived from anything but the tick. */
export type AgyLifecycle = 'idle' | 'running' | 'waiting_for_confirmation';

export interface AgyStatusTick {
  version: string;
  activeLimitId: AgyFamily;
  /** Always `[3p, gemini]`, in that order. Never merged, never one without the other. */
  observations: readonly [CapacityObservation, CapacityObservation];
  lifecycle: AgyLifecycle;
  /** The session/conversation this tick speaks for, or null when it names none.
   *  Carried on the TICK - not read back out of `observations[].streamId` - because
   *  the incarnation guard in the wake coordinator is a lifecycle concern and must
   *  not reach through the capacity domain to learn which turn it is looking at. */
  sessionId: string | null;
}

/**
 * Why a tick was refused. A CLOSED set of fixed strings, so a drift diagnostic can be
 * counted and logged without carrying one byte of the payload that caused it.
 */
export const AGY_DRIFT_CODES = [
  'not-object',
  'version',
  'model',
  'quota-missing',
  'quota-keys',
  'bucket-keys',
  'fraction',
  'reset-time',
  'reset-seconds',
  'reset-disagree',
  'agent-state',
  'confirmation-flag',
  'authenticating'
] as const;
export type AgyDriftCode = (typeof AGY_DRIFT_CODES)[number];

export type AgyClassification =
  | { ok: true; tick: AgyStatusTick }
  /** `version` only when it was itself a valid version string; never anything else. */
  | { ok: false; driftCode: AgyDriftCode; version: string | null };

/** Receipt-relative reset seconds and the stated reset instant must agree this closely. */
export const AGY_RESET_TOLERANCE_MS = 5_000;

/** Longer than any real version string; short enough to be a safe diagnostic key. */
const AGY_VERSION_MAX_CHARS = 64;

/**
 * RFC 3339 date-time, with a mandatory offset. `Date.parse` alone accepts a zoo of
 * formats, including offset-less local times that would shift by the machine's zone -
 * so the shape is checked first and the parse only supplies the instant.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const exactKeys = (d: Dict, keys: readonly string[]): boolean => {
  const own = Object.keys(d);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(d, k));
};

/**
 * Which family a MEASURED model id draws from. Gemini-branded models draw the Gemini
 * allowance; every other model draws 3P.
 *
 * CASE-SENSITIVE ON PURPOSE. The measured id is a display label, `Gemini 3.8 Flash
 * (High)`. If a future build reports a slug (`gemini-3.8-flash`) this deliberately
 * binds to 3P, and the golden-fixture test fails - which is the point: a silent
 * lowercase match would keep working on a shape nobody has verified.
 */
export function agyFamilyOfModel(modelId: string): AgyFamily {
  return modelId.startsWith('Gemini ') ? 'gemini' : '3p';
}

/**
 * Classify one Antigravity statusline payload. See `normalizeAgyStatusLine`.
 *
 * ALL OR NOTHING. A valid tick needs every one of the four buckets, each complete and
 * self-consistent, AND a recognised lifecycle. Anything short of that is refused
 * whole: there is no clamping, no synthesised window, no positional fallback, and no
 * publishing the valid half of a malformed tick - the half that parsed is exactly as
 * suspect as the half that did not, because we cannot know which part the provider
 * changed. Unknown TOP-LEVEL properties are ignored, so a new display-only field is not
 * by itself drift; unknown keys inside `quota` or inside a bucket are.
 */
export function classifyAgyStatusLine(input: {
  payload: unknown;
  accountScope: string;
  receivedAt: number;
}): AgyClassification {
  const p = input.payload;
  if (!isDict(p)) return { ok: false, driftCode: 'not-object', version: null };

  const version = typeof p.version === 'string' && p.version.length > 0
    && p.version.length <= AGY_VERSION_MAX_CHARS && /^[\x21-\x7e]+$/.test(p.version)
    ? p.version : null;
  const drift = (driftCode: AgyDriftCode): AgyClassification => ({ ok: false, driftCode, version });
  if (version === null) return drift('version');

  // LIFECYCLE FIRST, because the boot tick is decided here. It carries
  // `agent_state: 'authenticating'`, `model: null` and no quota map, and the ratified
  // N-1 choice (b) is to accept an UNKNOWN lifecycle at boot rather than invent a
  // lifecycle-only observation to make authentication look active.
  const state = p.agent_state;
  if (typeof state !== 'string' || !(AGY_AGENT_STATES as readonly string[]).includes(state)) {
    return drift('agent-state');
  }
  const pendingRaw = p.tool_confirmation_pending;
  if (pendingRaw !== undefined && typeof pendingRaw !== 'boolean') return drift('confirmation-flag');
  let lifecycle: AgyLifecycle;
  if (pendingRaw === true) lifecycle = 'waiting_for_confirmation';
  else if (state === 'working' || state === 'tool_use') lifecycle = 'running';
  else if (state === 'idle') lifecycle = 'idle';
  else return drift('authenticating');

  // The MEASURED model, never the configured one: the CLI default and an in-session
  // switch can both differ from whatever `--model` said at launch.
  const model = p.model;
  if (!isDict(model) || typeof model.id !== 'string' || !model.id.trim()) return drift('model');
  const activeLimitId = agyFamilyOfModel(model.id);

  const quota = p.quota;
  if (!isDict(quota)) return drift('quota-missing');
  if (!exactKeys(quota, AGY_QUOTA_KEYS)) return drift('quota-keys');

  const windows = {} as Record<AgyQuotaKey, CapacityWindow>;
  for (const key of AGY_QUOTA_KEYS) {
    const b = quota[key];
    if (!isDict(b) || !exactKeys(b, AGY_BUCKET_KEYS)) return drift('bucket-keys');
    const f = b.remaining_fraction;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f > 1) return drift('fraction');
    const rt = b.reset_time;
    const resetsAt = typeof rt === 'string' && RFC3339.test(rt) ? Date.parse(rt) : NaN;
    if (!Number.isFinite(resetsAt)) return drift('reset-time');
    const rs = b.reset_in_seconds;
    if (typeof rs !== 'number' || !Number.isFinite(rs) || rs < 0) return drift('reset-seconds');
    // A CONSISTENCY CHECK, not a fallback. `reset_time` is the reset; the seconds are
    // there to catch a payload whose two statements of it disagree. Measured drift
    // across 116 real pairs was at most 0.9 s.
    if (Math.abs(resetsAt - (input.receivedAt + rs * 1000)) > AGY_RESET_TOLERANCE_MS) return drift('reset-disagree');

    const fiveHour = key.endsWith('-5h');
    const kind = fiveHour ? 'FIVE_HOUR' : 'SEVEN_DAY';
    const minutes = fiveHour ? FIVE_HOUR_MINUTES : SEVEN_DAY_MINUTES;
    const remaining = f * 100;
    windows[key] = {
      // The family stays IN the window id as well as the limit id. Redundant on
      // purpose: a log line, a fixture or a drift report names the window without
      // anyone having to reconstruct which pool it came from.
      windowId: key,
      kind,
      applicability: 'APPLICABLE',
      label: windowLabel(kind, minutes),
      windowMinutes: minutes,
      // From the SAME number, so the pair always sums to exactly 100.
      usedPercent: 100 - remaining,
      remainingPercent: remaining,
      resetsAt
    };
  }

  const sid = [p.session_id, p.conversation_id].find((v): v is string => typeof v === 'string' && v.length > 0);
  const obs = (family: AgyFamily): CapacityObservation => ({
    poolKey: poolKeyOf('antigravity', input.accountScope, family),
    provider: 'antigravity',
    accountScope: input.accountScope,
    limitId: family,
    streamId: sid ?? null,
    sourceSequence: null,
    source: 'antigravity-status-line' satisfies ObservationSource,
    sourceVersion: version,
    // The payload has no authoritative observation time of its own.
    observedAt: input.receivedAt,
    receivedAt: input.receivedAt,
    windows: [windows[`${family}-5h`], windows[`${family}-weekly`]],
    // A zero remainder is NUMERICAL exhaustion only: the tracker derives it into
    // `numericallyExhaustedWindowIds` and RESERVE_ONLY. Antigravity states no refusal
    // and names no limiting window, so nothing here may claim it did (C2.4).
    providerAttributedLimitingWindowId: null,
    providerReachedType: null,
    ordinaryUsageAllowed: null,
    planType: null
  });

  return {
    ok: true,
    tick: { version, activeLimitId, observations: [obs('3p'), obs('gemini')], lifecycle, sessionId: sid ?? null }
  };
}

/**
 * Antigravity statusline payload → exactly two observations, or null.
 *
 * One tick describes TWO pools - `antigravity:<scope>:3p` and
 * `antigravity:<scope>:gemini` - and both are always returned together. They are never
 * merged, compared by percentage, or reduced to a provider-wide worst value; the model
 * reported in the same tick only chooses which of them gates the emitting agent.
 *
 * THE EMAIL IS NEVER READ. The payload carries one; this function does not look at it,
 * and the account scope arrives already computed from the Gemini home path.
 */
export function normalizeAgyStatusLine(input: {
  payload: unknown;
  accountScope: string;
  receivedAt: number;
}): AgyStatusTick | null {
  const c = classifyAgyStatusLine(input);
  return c.ok ? c.tick : null;
}

/** Exported for the tracker's own reset arithmetic; kept in one place. */
export { parseEpochMs };
