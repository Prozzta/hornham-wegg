/**
 * The admission-critical envelope (L0-SEM 14).
 *
 * THE PROBLEM IT SOLVES. Section 13 rejects a cap-breaching observation whole, which
 * is right for bulk data and wrong for one fact: if the provider SAID it was
 * refusing, throwing that away leaves the pool UNKNOWN — and UNKNOWN is explicitly
 * not a refusal in the admission seam, so the caller PROCEEDS. Work would start
 * against a provider that had just refused, by a route nobody designed. So exactly
 * one constant-size fact survives a bulk rejection, and nothing else does.
 *
 * WHY THIS IS NOT "TRUSTING A PAYLOAD WE JUST DECLARED UNTRUSTWORTHY". The obvious
 * objection to honouring any field from a rejected observation is that it reopens
 * the channel the rejection closed. It does not, and the reason is structural rather
 * than a promise: this parser is INDEPENDENT and its output is FIXED SIZE. It reads
 * a handful of already-typed scalars, validates each against a closed set, and emits
 * a record with no provider-supplied strings in it at all — no reached text, no
 * percentages, no reset data, no unknown fields. Honouring it cannot reintroduce
 * unbounded retention because there is nowhere for unbounded data to go.
 *
 * THE DISQUALIFICATION LIST IS THE IMPORTANT HALF. A generic 429, overload or
 * refusal text, a SUBSTRING of an allowlisted value, the string "false", a missing
 * or null or zero field, a truncated value, an unknown source: none of these
 * qualify, and an invalid envelope leaves section 13's UNKNOWN exactly as it was.
 * Nothing here scans raw or truncated payload, and nothing here matches on a
 * fragment — that is the defect this codebase already had once, where reached
 * strings were searched for window words no provider value contains.
 */
import type { CapacityObservation, ObservationSource } from '../shared/providerCapacity';

/** Which kind of hard limit the provider stated. A FIXED discriminator — never the
 *  provider's own string, which is what keeps the envelope constant-size. */
export type HardLimitKind = 'TYPED_REACHED' | 'ORDINARY_USE_DENIED';

/**
 * Everything that survives a bulk rejection. Deliberately tiny, and deliberately
 * made of discriminators and identity rather than provider text.
 */
export interface AdmissionEnvelope {
  hardLimit: HardLimitKind;
  /** Trusted source discriminator, from the closed source set. */
  source: ObservationSource;
  /** Effective observation time and order value, so it orders like any reading. */
  observedAt: number;
  sourceSequence: number | null;
  /** Already a truncated hash of a path. Bounded, and never a credential. */
  accountScope: string;
  /** A validated CURRENT window identity, or null. Never a relabelling. */
  windowId: string | null;
}

/**
 * The sources an envelope may arrive through. A closed set: an observation whose
 * source is not one of these is an unknown source and cannot carry a safety fact.
 */
const TRUSTED_SOURCES: readonly ObservationSource[] = [
  'claude-status-line',
  'codex-rollout',
  'codex-account-read'
];

/**
 * Provider-stated reached values that count as a TYPED hard limit. EXACT MATCH
 * ONLY — this is the same closed enumeration the normaliser validates against, and
 * a value that merely contains one of these is not one of these.
 *
 * `spend_control_reached` is here because it is the name this codebase gives to a
 * provider-native BOOLEAN that was literally `true`; it is not a string the provider
 * sent us, so there is no text to be fooled by.
 */
const TYPED_REACHED: readonly string[] = [
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
  'spend_control_reached'
];

/**
 * Extract the envelope from an observation, or null if it does not qualify.
 *
 * `currentWindowIds` are the window identities already admitted for this pool. An
 * attributed window is retained ONLY if it is one of them: a window id from a
 * rejected bulk payload is not a validated identity, and inventing one would be the
 * relabelling C2.4 forbids. Otherwise the fact stays pool-scoped with a null window,
 * which is a weaker claim and a true one.
 */
export function admissionEnvelopeOf(
  obs: CapacityObservation,
  currentWindowIds: readonly string[] = []
): AdmissionEnvelope | null {
  // Provenance. An unknown source disqualifies before anything else is looked at.
  if (!TRUSTED_SOURCES.includes(obs.source)) return null;

  // Ordering. A fact with no usable position cannot be ordered against the readings
  // it would override, so it cannot be trusted to be current.
  if (typeof obs.observedAt !== 'number' || !Number.isFinite(obs.observedAt) || obs.observedAt <= 0) return null;

  // The fact itself. Literal `false` only: not falsy, not 0, not the string "false",
  // not null, not absent. `=== false` is doing real work here.
  const denied = obs.ordinaryUsageAllowed === false;
  const reached = typeof obs.providerReachedType === 'string'
    && TYPED_REACHED.includes(obs.providerReachedType);
  if (!denied && !reached) return null;

  const attributed = obs.providerAttributedLimitingWindowId;
  const windowId = typeof attributed === 'string' && currentWindowIds.includes(attributed)
    ? attributed
    : null;

  return {
    // Explicit denial outranks a typed signal: it is the stronger statement, and
    // both open the same epoch, so the discriminator records the better evidence.
    hardLimit: denied ? 'ORDINARY_USE_DENIED' : 'TYPED_REACHED',
    source: obs.source,
    observedAt: obs.observedAt,
    sourceSequence: typeof obs.sourceSequence === 'number' && Number.isFinite(obs.sourceSequence)
      ? obs.sourceSequence
      : null,
    accountScope: obs.accountScope,
    windowId
  };
}

/** The fixed reached discriminator stored in place of the provider's own string. */
export const ENVELOPE_TYPED_REACHED = 'ENVELOPE_TYPED_REACHED';
