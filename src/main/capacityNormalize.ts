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

/** used → remaining, done once here so nothing downstream does arithmetic on provider numbers. */
function remainingFromUsed(used: number | null): number | null {
  if (used === null) return null;
  const remaining = 100 - used;
  // Clamp rather than drop: a provider reporting 100.4% used means exhausted, and a
  // negative remainder would be a false reading of a true fact.
  return Math.min(100, Math.max(0, remaining));
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
    const used = finiteNumber(raw.used_percentage);
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

/** Codex slot → normalised window, identified by duration rather than by slot. */
function codexWindow(slot: string, raw: unknown): CapacityWindow | null {
  if (!isDict(raw)) return null;
  const used = finiteNumber(raw.used_percent ?? raw.usedPercent);
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
 * ATTRIBUTION IS CONSERVATIVE. `rate_limit_reached_type` is retained verbatim
 * whenever the provider sets it, but it only becomes an attributed WINDOW when it
 * actually identifies one. A reached signal that names no window is real evidence
 * that something is limiting and is NOT evidence about which window, so inventing
 * the window would manufacture exactly the causal claim C2.4 forbids.
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
  const providerReachedType = typeof reachedRaw === 'string' && reachedRaw ? reachedRaw : null;

  // Nothing usable at all — return null rather than a healthy-looking empty record.
  if (!windows.length && !providerReachedType) return null;

  let attributed: string | null = null;
  if (providerReachedType) {
    const hint = providerReachedType.toLowerCase();
    const bySlot = hint.includes('secondary') || hint.includes('weekly')
      ? 'secondary'
      : hint.includes('primary') || hint.includes('5h') || hint.includes('five')
        ? 'primary'
        : null;
    if (bySlot) {
      const w = codexWindow(bySlot, rl[bySlot]);
      if (w) attributed = w.windowId;
    }
  }

  const limitIdRaw = rl.limit_id ?? rl.limitId;
  const planRaw = rl.plan_type ?? rl.planType;
  const allowedRaw = rl.ordinary_usage_allowed ?? rl.ordinaryUsageAllowed;

  const limitId = typeof limitIdRaw === 'string' && limitIdRaw ? limitIdRaw : 'codex';
  return {
    poolKey: poolKeyOf('codex', input.accountScope, limitId),
    provider: 'codex',
    accountScope: input.accountScope,
    limitId,
    source: input.source ?? 'codex-rollout',
    observedAt: finiteNumber(input.observedAt) ?? input.receivedAt,
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
