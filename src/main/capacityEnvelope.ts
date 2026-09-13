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
 * EVERY VARIABLE-WIDTH FIELD IS BOUNDED HERE, BY THIS PARSER - the account scope
 * and the attributed window id both go through `boundedIdentity` rather than being
 * copied verbatim, because "the normalizers only ever send short ones" is a fact
 * about today's callers and not a property of the envelope.
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
  /**
   * A VALIDATED account scope, or null when the arriving one is not one.
   *
   * Nullable for the same reason `windowId` is: an identity this parser cannot
   * validate is not an identity, and a weaker true claim beats a confident wrong
   * one. It is never truncated to fit - a truncated scope is a DIFFERENT scope and
   * could collide with a real one.
   */
  accountScope: string | null;
  /** A validated CURRENT window identity, or null. Never a relabelling. */
  windowId: string | null;
}

/**
 * The widest any identity field in this envelope may be, and the only characters it
 * may contain.
 *
 * WHY THIS PARSER ENFORCES IT RATHER THAN TRUSTING THE CALLER. Production
 * normalizers supply a 12-character truncated hash, so in the tree as it stands
 * these fields are already small - and that is exactly the argument that does not
 * hold. A PROPERTY THAT HOLDS BECAUSE OF WHAT CALLERS HAPPEN TO PASS IS NOT A
 * PROPERTY: this module's whole authorisation is that it parses independently and
 * emits a fixed size, and an independent parser that inherits its bound from the
 * pipeline it was written to be independent of has neither. A 20,000-character
 * scope produced a 20,143-byte "fixed size" envelope, which is the counterexample.
 *
 * The width is generous relative to every identity the codebase actually produces,
 * because the job here is to bound the field, not to re-specify the hash.
 */
const MAX_IDENTITY_CHARS = 64;
const IDENTITY_SHAPE = /^[A-Za-z0-9_.:@+-]{1,64}$/;

/** A bounded identity, or null. Never a truncation: a shortened id is another id. */
const boundedIdentity = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= MAX_IDENTITY_CHARS && IDENTITY_SHAPE.test(value)
    ? value
    : null;

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

  // Bounded FIRST, then checked for admission: a window id that is already an
  // admitted identity is still only as bounded as the payload that admitted it, and
  // the per-pool byte cap is a budget for a whole reading rather than a width for
  // one field. Both tests have to pass.
  const attributed = boundedIdentity(obs.providerAttributedLimitingWindowId);
  const windowId = attributed !== null && currentWindowIds.includes(attributed)
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
    accountScope: boundedIdentity(obs.accountScope),
    windowId
  };
}

/** The fixed reached discriminator stored in place of the provider's own string. */
export const ENVELOPE_TYPED_REACHED = 'ENVELOPE_TYPED_REACHED';
