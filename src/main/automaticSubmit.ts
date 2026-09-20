/**
 * L0-FUSION — THE ONE MAIN-OWNED PROGRAMMATIC SUBMIT TRANSACTION.
 *
 * Design of record: research `notes/andy-l0-fusion-design.md` rev 13, sections 1-8.
 *
 *   ADMIT -> READY -> STAGE -> GAP -> (COMMIT | ABORT | INTERFERED)
 *
 * WHY ONE OWNER. Every programmatic stage-then-Enter path — capacity-gated queue
 * delivery, worker wake, user-released send-now, boot/seed/orientation prompts —
 * types text and then, a TUI-imposed gap later, presses Enter. Two owners of that
 * sequence can interleave their text and Enter on one prompt; an owner that lives
 * outside main cannot put its final check next to its Enter, because an IPC reply
 * sits between them. So there is one owner, it lives where the PTY is, and every
 * such path serializes through it per PTY. Raw human keystrokes do NOT come through
 * here: they stay immediate, on the declared-HUMAN ingress, unordered relative to
 * this owner. That is not a second ordering authority — it is the absence of one,
 * and it is exactly why INTERFERED exists.
 *
 * THE THREE TERMINAL BRANCHES ARE NOT INTERCHANGEABLE (section 6):
 *   COMMIT      the final check passed and the Enter went out in the same turn.
 *   ABORT       capacity refused LATE, NOBODY TYPED, and the automatic text was erased
 *               AND the erase positively verified on the rendered screen. Retryable.
 *   INTERFERED  a human wrote to this PTY after our text was staged (or we can no
 *               longer prove they did not). NO Enter. NO clear. NO overwrite. NO retry.
 *               The item is held, the human's text is preserved, and further automatic
 *               delivery to this PTY is inhibited until a HUMAN resolves it.
 * A pre-STAGE human write is NEITHER: nothing was typed, so nothing can be interfered
 * with — it is a side-effect-free refusal, and the next drain simply tries again.
 *
 * NO ELECTRON, NO PTY, NO CLOCK OF ITS OWN. Every effect is injected (the pattern
 * `workerWake.ts` already uses), so each state, each guard and each prohibition is
 * provable main-only, and a mutant of any of them can be killed by name.
 */
import { ADMISSION_REASON, type AdmissionDecision, type AdmissionVerdict, type WorkClass } from './capacityAdmission';
import type { PromptBlock } from '../shared/promptState';

export type { PromptBlock };

// ─── Admission classes: a bypass is DECLARED, never INHERITED (section 3 / 19) ─────────

/**
 * Who is asking, and therefore which admission policy applies. All three share the ONE
 * submission owner for ordering, final revalidation and commit; they differ only in
 * what is asked at ADMIT/READY.
 *
 *   CAPACITY_GATED  an automatic start nobody asked for in this moment: queue drain,
 *                   worker wake. Full gate — capacity, provenance eligibility, provider
 *                   abort capability. The only class that can reach ABORT.
 *   USER_RELEASED   a person pressed "send now". Not an automatic start, so capacity is
 *                   not asked — and therefore no late capacity refusal exists for it.
 *   BOOT_SEQUENCE   remote-control / seed / orientation prompts a spawn requires.
 *
 * The two bypass classes are NOT refused for unproven provenance or an unmeasured
 * provider, because ABORT is unreachable for them by construction (nothing revalidates
 * capacity) and a person or the spawn itself asked for the write. They still serialize
 * here, still get the final revalidation immediately before Enter, and still go
 * INTERFERED on a post-STAGE human write wherever the generation can see one.
 */
export type AdmissionClass = 'CAPACITY_GATED' | 'USER_RELEASED' | 'BOOT_SEQUENCE';

export const ADMISSION_CLASSES: readonly AdmissionClass[] = ['CAPACITY_GATED', 'USER_RELEASED', 'BOOT_SEQUENCE'];

/** Which classes ask provider capacity at all. Total, so a new class cannot be added
 *  without deciding. Only a class that asks capacity can be refused LATE by it, so only
 *  such a class can ever reach ABORT. */
export const ASKS_CAPACITY: Readonly<Record<AdmissionClass, boolean>> = {
  CAPACITY_GATED: true,
  USER_RELEASED: false,
  BOOT_SEQUENCE: false
};

/**
 * What can stand between a submission and the prompt, as main can know it.
 *
 *   ABORT_CAPABILITY_UNVERIFIED  the provider has no MEASURED clear/erase (section 8)
 *   PROVENANCE_INELIGIBLE        the input-provenance mirror says human input cannot be
 *                                proven visible on this terminal right now
 *   PROMPT_UNKNOWN               the renderer has not mirrored the prompt's state at all
 *   PROMPT_PICKER                a user-opened picker owns the input line
 *   PROMPT_DRAFT                 a human draft is sitting on the prompt
 *   PROMPT_SETTLING              the TUI is repainting after a human clear/dismiss
 *   HUMAN_INPUT_RECENT           main itself took a HUMAN write on this PTY moments ago
 *
 * The first three are SUPPORT UNPROVEN. The last four are POSITIVE EVIDENCE that the
 * prompt is a human's right now.
 *
 * WHY HUMAN_INPUT_RECENT EXISTS WHEN PROMPT_DRAFT DOES. The draft arrives by a mirror; the
 * keystroke that started it arrives by the write ingress, one IPC message EARLIER. A
 * submission admitted between those two messages sees a generation that already counts
 * the keystroke (so the pre-STAGE comparison is quiet) and a mirror that still says the
 * prompt is free. Main's own record of when it last took a human write has no such
 * window: it is set in the same operation as the write.
 */
export type GateCondition =
  | 'ABORT_CAPABILITY_UNVERIFIED'
  | 'PROVENANCE_INELIGIBLE'
  | 'PROMPT_UNKNOWN'
  | 'PROMPT_PICKER'
  | 'PROMPT_DRAFT'
  | 'PROMPT_SETTLING'
  | 'HUMAN_INPUT_RECENT';

export const GATE_CONDITIONS: readonly GateCondition[] = [
  'ABORT_CAPABILITY_UNVERIFIED', 'PROVENANCE_INELIGIBLE', 'PROMPT_UNKNOWN',
  'PROMPT_PICKER', 'PROMPT_DRAFT', 'PROMPT_SETTLING', 'HUMAN_INPUT_RECENT'
];

export type GateAction = 'REFUSE' | 'PROCEED';

/**
 * THE ONE POLICY POINT: class x condition -> refuse | proceed. Total in both
 * dimensions; every guard in this file that depends on the class reads it from HERE, so
 * changing an answer is a one-cell edit, and each cell has its own test.
 *
 * HUMAN RULING, 2026-09-20 (card L0-S5-BOOT-GATE, option A), verbatim: "A: automatic
 * delivery gets the full gate with no exceptions. Boot prompts and send-now still go
 * through the one owner, still revalidate before Enter, and still stop on human
 * interference. They are not refused up front just because the provider is unmeasured."
 *
 * So the three SUPPORT-UNPROVEN rows refuse CAPACITY_GATED and nothing else. The four
 * HUMAN-OWNS-THE-LINE rows refuse EVERY class: they are not "unmeasured", they are evidence that a
 * human owns the line, and typing a boot prompt into an open picker loses the prompt
 * and feeds the picker garbage exactly as a queued message would. A refusal types
 * nothing, so the caller simply asks again.
 */
export const READY_GATE_POLICY: Readonly<Record<AdmissionClass, Readonly<Record<GateCondition, GateAction>>>> = {
  CAPACITY_GATED: {
    ABORT_CAPABILITY_UNVERIFIED: 'REFUSE',
    PROVENANCE_INELIGIBLE: 'REFUSE',
    PROMPT_UNKNOWN: 'REFUSE',
    PROMPT_PICKER: 'REFUSE',
    PROMPT_DRAFT: 'REFUSE',
    PROMPT_SETTLING: 'REFUSE',
    HUMAN_INPUT_RECENT: 'REFUSE'
  },
  USER_RELEASED: {
    ABORT_CAPABILITY_UNVERIFIED: 'PROCEED',
    PROVENANCE_INELIGIBLE: 'PROCEED',
    PROMPT_UNKNOWN: 'PROCEED',
    PROMPT_PICKER: 'REFUSE',
    PROMPT_DRAFT: 'REFUSE',
    PROMPT_SETTLING: 'REFUSE',
    HUMAN_INPUT_RECENT: 'REFUSE'
  },
  BOOT_SEQUENCE: {
    ABORT_CAPABILITY_UNVERIFIED: 'PROCEED',
    PROVENANCE_INELIGIBLE: 'PROCEED',
    PROMPT_UNKNOWN: 'PROCEED',
    PROMPT_PICKER: 'REFUSE',
    PROMPT_DRAFT: 'REFUSE',
    PROMPT_SETTLING: 'REFUSE',
    HUMAN_INPUT_RECENT: 'REFUSE'
  }
};

export function gateRefuses(cls: AdmissionClass, condition: GateCondition): boolean {
  return READY_GATE_POLICY[cls][condition] === 'REFUSE';
}

type PromptCondition = 'PROMPT_UNKNOWN' | 'PROMPT_PICKER' | 'PROMPT_DRAFT' | 'PROMPT_SETTLING';

function promptCondition(block: PromptBlock | undefined): PromptCondition | null {
  if (block === undefined) return 'PROMPT_UNKNOWN';
  if (block === 'picker') return 'PROMPT_PICKER';
  if (block === 'draft') return 'PROMPT_DRAFT';
  if (block === 'settling') return 'PROMPT_SETTLING';
  return null; // null = free; 'exited' is answered by the incarnation, not by policy
}

// ─── UNKNOWN is one decision, made by name (section 3) ────────────────────────────────

/**
 * The three EVIDENCE conditions behind an UNKNOWN verdict (Dwight section 19: different
 * evidence, whatever action each is given).
 *
 *   NO_POOL        the agent maps to no capacity pool at all. There is no capacity-control
 *                  surface for it. This is OUTSIDE CAPACITY GATING - it is NOT "available",
 *                  and nothing may label or present it as such.
 *   NO_STATE       a pool is known for the agent and nothing has been observed for it.
 *   INDETERMINATE  a pool is known and observed, and its state cannot be resolved: the
 *                  reading went stale, two readings conflict, a retention cap was breached,
 *                  it was restored across a restart and not yet confirmed, or a window's
 *                  applicability is unknown. (`ADMISSION_REASON.UNKNOWN`.)
 */
export type UnknownEvidence = 'NO_POOL' | 'NO_STATE' | 'INDETERMINATE';
export type AdmissionAction = 'PROCEED' | 'HOLD';
export type UnknownPolicy = Readonly<Record<UnknownEvidence, AdmissionAction>>;

/**
 * THE UNKNOWN MAPPING, RATIFIED. One named value; every guard reads it through
 * `resolveAdmission`, so changing an answer is a one-line edit here.
 *
 * HUMAN RULING, 2026-09-20 (card L0-UNKNOWN, OPTION B), verbatim: "Automatic delivery
 * mapping: (1) NO POOL CONFIGURED -> PROCEED; (2) POOL CONFIGURED, NO OBSERVATION YET ->
 * HOLD; (3) INDETERMINATE / UNKNOWN OBSERVATION -> HOLD. Reason: 'No pool configured' means
 * Hornham does not currently have a capacity-control surface for that provider. Preserve
 * existing delivery behaviour there. But once a capacity pool IS configured, absence of
 * usable evidence must not silently collapse to AVAILABLE. UNKNOWN != AVAILABLE. [...] The
 * final revalidation remains required regardless. Do not label the no-pool case AVAILABLE.
 * It is simply outside capacity gating until a pool is configured."
 *
 * It replaces the proceed-for-all-three that four scattered `!== 'REFUSE'` inequalities
 * used to produce by accident, which stage 5.1 had named and kept only provisionally.
 *
 * HOLD IS A HOLD, NOT A DROP AND NOT AN INTERFERENCE. Nothing is typed, the item stays
 * queued, nothing is inhibited, and the caller simply asks again. THERE IS NO TIMEOUT: a
 * hold that lapsed into proceeding would be the silent collapse the ruling forbids. It
 * ends when an accepted observation gives the pool a resolvable state.
 *
 * THIS IS CAPACITY-STATE UNKNOWN ONLY. Provider abort-capability UNKNOWN and provenance
 * UNKNOWN never pass through here and must never inherit a proceed from it. And only
 * classes that ask capacity at all (`ASKS_CAPACITY`) ever reach it: send-now and boot
 * prompts do not consult this mapping anywhere.
 */
export const UNKNOWN_POLICY: UnknownPolicy = {
  NO_POOL: 'PROCEED',
  NO_STATE: 'HOLD',
  INDETERMINATE: 'HOLD'
};

function unknownEvidenceOf(reason: string): UnknownEvidence | null {
  if (reason === ADMISSION_REASON.NO_POOL) return 'NO_POOL';
  if (reason === ADMISSION_REASON.NO_STATE) return 'NO_STATE';
  if (reason === ADMISSION_REASON.UNKNOWN) return 'INDETERMINATE';
  return null;
}

export interface ResolvedAdmission { action: AdmissionAction; basis: string }

/**
 * THE ONE TYPED EXHAUSTIVE RESOLVER. Applied at ADMIT, at pre-STAGE revalidation and at
 * final COMMIT revalidation. The tri-state verdict and its reason reach here intact; no
 * authoritative path may first collapse them to a boolean, and no caller may keep a
 * private `!== 'REFUSE'`. An UNKNOWN whose reason this does not recognise HOLDS: an
 * unclassified unknown is a missing fact, and a missing fact is never permission.
 */
export function resolveAdmission(
  decision: { verdict: AdmissionVerdict; reason: string },
  policy: UnknownPolicy
): ResolvedAdmission {
  switch (decision.verdict) {
    case 'ALLOW':
      return { action: 'PROCEED', basis: decision.reason };
    case 'REFUSE':
      return { action: 'HOLD', basis: decision.reason };
    case 'UNKNOWN_NOT_INFERRED_SAFE': {
      const evidence = unknownEvidenceOf(decision.reason);
      if (!evidence) return { action: 'HOLD', basis: `UNCLASSIFIED_UNKNOWN:${decision.reason}` };
      return { action: policy[evidence], basis: `UNKNOWN:${evidence}` };
    }
    default: {
      const unreachable: never = decision.verdict;
      return { action: 'HOLD', basis: `UNRECOGNISED_VERDICT:${String(unreachable)}` };
    }
  }
}

/**
 * What capacity says about an agent, KEPT DISTINCT for anything that displays or reports
 * it. The ruling: "UI/state should preserve that distinction rather than presenting all
 * three cases as the same kind of healthy capacity." So this is never a boolean, and
 * NO_POOL is its own value - outside capacity gating - not a flavour of ALLOWED.
 */
export type CapacityEvidence = 'ALLOWED' | 'REFUSED' | UnknownEvidence | 'UNCLASSIFIED';

export interface CapacityGate {
  evidence: CapacityEvidence;
  /** Would automatic delivery be held right now? Derived through the ONE resolver. */
  holds: boolean;
  basis: string;
}

/** The gate for a probe of the admission seam, through the same resolver and the same
 *  policy every guard uses - so what a snapshot SAYS and what the owner DOES cannot drift. */
export function capacityGateOf(
  decision: { verdict: AdmissionVerdict; reason: string },
  policy: UnknownPolicy = UNKNOWN_POLICY
): CapacityGate {
  const resolved = resolveAdmission(decision, policy);
  const evidence: CapacityEvidence = decision.verdict === 'ALLOW' ? 'ALLOWED'
    : decision.verdict === 'REFUSE' ? 'REFUSED'
      : unknownEvidenceOf(decision.reason) ?? 'UNCLASSIFIED';
  return { evidence, holds: resolved.action === 'HOLD', basis: resolved.basis };
}

// ─── Effects ──────────────────────────────────────────────────────────────────────────

export interface OwnerWriteResult { ok: boolean; error?: string }

/** Provider abort capability (section 8). MEASURED or UNKNOWN — there is no third value,
 *  and UNKNOWN disables CAPACITY_GATED staging BEFORE anything is staged. */
export type AbortCapability =
  | { kind: 'VERIFIED'; clearControl: string; settleMs: number }
  | { kind: 'UNKNOWN' };

/** Provenance eligibility as `shared/inputProvenance.ts` answers it. Restated
 *  structurally so this module imports no renderer-facing type it does not need. */
export type ProvenanceEligibility = { eligible: true } | { eligible: false; reason: string; detail?: string };

/** What the rendered screen says about our staged text. The ONLY erase oracle
 *  (section 5.1): the prompt row at `baseY + cursorY`, and the whole screen. */
export interface ScreenReading { onPromptRow: boolean; screenCount: number }

/** The claim capacity is re-asked under. Mirrors `capacityRuntime.DeliveryClaim`. */
export interface OwnerClaim {
  decision: AdmissionDecision;
  agentId: string;
  workClass: WorkClass;
  target: string | null;
}

export interface OwnerDeps {
  /** MAIN resolves the PTY (section 7): a caller never names one. Null = no terminal. */
  resolvePty: (agentId: string) => string | null;
  /** Identity of the LIVE incarnation behind a PTY id, or undefined when it is gone. A
   *  same-id respawn returns a DIFFERENT value: a generation is scoped to one incarnation
   *  and a judgement about a dead terminal must not transfer to its replacement. */
  incarnation: (ptyId: string) => unknown;
  /** The per-live-PTY HUMAN-origin generation (section 4). Opaque; equality only. */
  humanGeneration: (ptyId: string) => number | undefined;
  /** The owner's own write. Never advances the human generation. */
  write: (ptyId: string, data: string) => OwnerWriteResult;
  /** 'READY' to type, 'WAIT' and ask again, 'GONE' if the PTY died. Main answers this. */
  terminalReady: (ptyId: string, agentId: string, waitedMs: number) => 'READY' | 'WAIT' | 'GONE';
  /** Provenance eligibility from the live mirror. Evaluated fresh on every guard. */
  eligibility: (ptyId: string) => ProvenanceEligibility;
  /** The prompt's state as the renderer mirrors it into main: picker latch, human
   *  draft, settle. Re-read before STAGE and inside the critical section (section 5.3:
   *  a latch consulted once is a latch that can open afterwards). `undefined` = never
   *  mirrored. NEVER an interference or erase oracle: it only says whose the line is. */
  promptBlock: (ptyId: string) => PromptBlock | undefined;
  /** When main last took a declared-HUMAN write on this PTY, set in the same operation
   *  as the write. Undefined = never. */
  lastHumanInputAt: (ptyId: string) => number | undefined;
  abortCapability: (agentId: string) => AbortCapability;
  /** Read the rendered screen for `needle`. Resolves null when nothing can answer. */
  readScreen: (ptyId: string, needle: string) => Promise<ScreenReading | null>;
  capacity: {
    admit: (agentId: string, workClass: WorkClass) => AdmissionDecision;
    /** Admission's own question re-asked NOW for this claim, tri-state intact. A
     *  structurally dead claim (wrong target, moved pool, new epoch, lost grant) answers
     *  REFUSE with its reason; a RECOVERING pool whose one turn THIS claim holds answers
     *  ALLOW. */
    revalidate: (claim: OwnerClaim) => { verdict: AdmissionVerdict; reason: string };
    confirmLaunch: (decision: AdmissionDecision) => void;
    cancelGrant: (decision: AdmissionDecision) => void;
  };
  unknownPolicy?: UnknownPolicy;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** Told of every settled outcome. Diagnostics and UI; never a decision input. */
  onOutcome?: (record: OutcomeRecord) => void;
}

// ─── Requests and outcomes ────────────────────────────────────────────────────────────

export interface SubmitRequest {
  /** Idempotency key (section 7). Binds immutably to everything below. */
  requestId: string;
  agentId: string;
  admissionClass: AdmissionClass;
  text: string;
  /** How long the owner keeps holding the PTY after a COMMIT. Default SETTLE_MS. */
  settleMs?: number;
}

export type RefusalReason =
  | 'NO_PTY'
  | 'PTY_INHIBITED'
  | 'CAPACITY_HOLD'
  | 'PROVIDER_ABORT_UNVERIFIED'
  | 'PROVENANCE_INELIGIBLE'
  | 'TERMINAL_NOT_READY'
  | 'PTY_GONE'
  | 'PTY_REPLACED'
  | 'PROMPT_UNKNOWN'
  | 'PROMPT_PICKER'
  | 'PROMPT_DRAFT'
  | 'PROMPT_SETTLING'
  | 'HUMAN_INPUT_RECENT'
  | 'HUMAN_INPUT_BEFORE_STAGE'
  | 'STAGE_WRITE_FAILED';

export type InterferenceReason =
  | 'HUMAN_INPUT_AFTER_STAGE'
  | 'PICKER_LATCHED_AFTER_STAGE'
  | 'PROMPT_UNKNOWN_AFTER_STAGE'
  | 'PROVENANCE_LOST_AFTER_STAGE'
  | 'ABORT_CAPABILITY_UNVERIFIED'
  | 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE'
  | 'CLEAR_WRITE_FAILED'
  | 'ERASE_NOT_VERIFIED'
  | 'ENTER_WRITE_FAILED';

export type SubmitOutcome =
  /** The Enter went out. The one outcome a caller may acknowledge a queue item on. */
  | { kind: 'COMMITTED' }
  /** Nothing was typed. Side-effect-free: no residue, nothing inhibited. Retry freely. */
  | { kind: 'REFUSED'; reason: RefusalReason; detail?: string }
  /** Typed, then verifiably erased after a late capacity refusal. Retryable. */
  | { kind: 'ABORTED'; detail: string }
  /** Held. NOT retryable by automation. The PTY is inhibited until a human resolves it. */
  | { kind: 'INTERFERED'; reason: InterferenceReason; detail?: string }
  /** The staged text died with its terminal; nothing of ours remains anywhere. */
  | { kind: 'FAILED'; reason: 'PTY_REPLACED_AFTER_STAGE' | 'PTY_GONE_AFTER_STAGE' }
  /** The id was presented with different arguments than it is bound to. */
  | { kind: 'REJECTED'; reason: 'ID_BINDING_MISMATCH' };

export interface OutcomeRecord {
  requestId: string;
  agentId: string;
  ptyId: string | null;
  admissionClass: AdmissionClass;
  outcome: SubmitOutcome;
  at: number;
}

export interface Inhibition { requestId: string; reason: InterferenceReason; at: number; incarnation: unknown }

/** The irreducible TUI interval between a paste and its Enter. */
export const GAP_MS = 140;
/** Default hold after a COMMIT before the next submission may type. */
export const SETTLE_MS = 250;
export const READY_POLL_MS = 100;
export const READY_TIMEOUT_MS = 30_000;
export const SCREEN_ORACLE_TIMEOUT_MS = 2_000;
/** How long a settled outcome stays replayable — long enough to cover a lost reply or a
 *  renderer reload, short enough that the map stays bounded. */
export const OUTCOME_REPLAY_TTL_MS = 5 * 60_000;
/** A human write this recent means the line is theirs, whatever the mirror says yet.
 *  Longer than the renderer's own ECHO_GRACE (1000 ms), inside which even the renderer
 *  does not trust the screen to overrule a keystroke. */
export const HUMAN_QUIET_MS = 1_500;
/** A needle shorter than this matches too easily to be evidence of anything. */
export const MIN_NEEDLE = 4;
const MAX_NEEDLE = 16;

/** What the owner actually writes for `text`. Bracketed paste only for MULTI-LINE text:
 *  some TUIs (agy) treat the markers as literal input, so single-line stays raw (#24). */
export function payloadFor(text: string): string {
  return text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
}

/** The slice of our own text the screen oracle looks for: the head of the first
 *  non-empty line, short enough to survive a narrow prompt. Null = nothing usable, in
 *  which case an erase can never be positively verified and ABORT resolves INTERFERED. */
export function needleFor(text: string): string | null {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const needle = first.slice(0, MAX_NEEDLE).trimEnd();
  return needle.length >= MIN_NEEDLE ? needle : null;
}

function payloadIdentity(text: string): string {
  // Not cryptographic — it only has to tell "the same request again" from "a different
  // request under the same id". Length + FNV-1a over the text.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${text.length}:${h.toString(16)}`;
}

/** Everything the COMMIT critical section and ABORT need about one staged submission. */
interface Staged {
  req: SubmitRequest;
  ptyId: string;
  incarnation: unknown;
  /** Null for the bypass classes: capacity was never asked, so none is re-asked. */
  decision: AdmissionDecision | null;
  humanStage: number;
}

type CommitVerdict =
  | { kind: 'ENTERED'; ok: boolean; error?: string }
  | { kind: 'LATE_REFUSAL'; basis: string }
  | { kind: 'INTERFERED'; reason: InterferenceReason; detail?: string }
  | { kind: 'FAILED'; reason: 'PTY_REPLACED_AFTER_STAGE' | 'PTY_GONE_AFTER_STAGE' };

function safeWrite(deps: OwnerDeps, ptyId: string, data: string): OwnerWriteResult {
  try {
    const r = deps.write(ptyId, data);
    return r && r.ok === true ? { ok: true } : { ok: false, error: r?.error ?? 'write refused' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The guards shared by the COMMIT section and the pre-destructive ABORT check: is the
 * line still exactly as we left it, as far as main can know? Synchronous, pure reads.
 */
function postStageGuard(s: Staged, deps: OwnerDeps): CommitVerdict | null {
  const live = deps.incarnation(s.ptyId);
  if (live === undefined) return { kind: 'FAILED', reason: 'PTY_GONE_AFTER_STAGE' };
  if (live !== s.incarnation) return { kind: 'FAILED', reason: 'PTY_REPLACED_AFTER_STAGE' };
  // ONLY A POST-STAGE CHANGE IS INTERFERENCE, and this is the post-STAGE baseline.
  if (deps.humanGeneration(s.ptyId) !== s.humanStage) {
    return { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' };
  }
  const cls = s.req.admissionClass;
  // A draft or a settle after STAGE can only come from a human action, which the
  // generation above already caught. The picker latch and an unmirrored prompt are the
  // two prompt facts the generation cannot stand in for.
  const block = deps.promptBlock(s.ptyId);
  if (block === 'picker') return { kind: 'INTERFERED', reason: 'PICKER_LATCHED_AFTER_STAGE' };
  if (block === undefined && gateRefuses(cls, 'PROMPT_UNKNOWN')) {
    return { kind: 'INTERFERED', reason: 'PROMPT_UNKNOWN_AFTER_STAGE' };
  }
  if (gateRefuses(cls, 'PROVENANCE_INELIGIBLE')) {
    // RUNTIME AND RE-ENTRANT: a TUI that turned mouse tracking on inside the gap has
    // opened an input path the generation cannot see, so "nobody typed" is no longer
    // provable. Not provable is not safe to Enter and not safe to erase.
    const e = deps.eligibility(s.ptyId);
    if (!e.eligible) return { kind: 'INTERFERED', reason: 'PROVENANCE_LOST_AFTER_STAGE', detail: e.reason };
  }
  return null;
}

/**
 * THE COMMIT CRITICAL SECTION (section 2).
 *
 * ONE NON-YIELDING main check -> terminal write -> in-turn settle. BETWEEN THE FINAL
 * CHECK AND THE RECORDED OUTCOME THERE MAY BE: no `await`, no `.then`, no timer, no
 * microtask, no IPC send or reply, no async function boundary, no dynamic import, and no
 * call into anything that can yield. That list is CONSERVATIVE, NOT THE DEFINITION
 * (section 18): a construct that is not on it is not thereby permitted — it is judged
 * against the invariant, and the list grows.
 *
 * A registered test reads this function's source for the listed constructs, and a
 * behavioural test injects an AVAILABLE->LIMITED observation that lands in the first
 * yield after the check: with the section intact the record reads `enter:AVAILABLE`
 * or `abort:LIMITED`, never `enter:LIMITED`.
 */
export function commitSection(s: Staged, deps: OwnerDeps): CommitVerdict {
  const blocked = postStageGuard(s, deps);
  if (blocked) return blocked;
  if (s.decision) {
    const claim: OwnerClaim = {
      decision: s.decision, agentId: s.req.agentId, workClass: s.decision.workClass, target: s.ptyId
    };
    const now = resolveAdmission(deps.capacity.revalidate(claim), deps.unknownPolicy ?? UNKNOWN_POLICY);
    if (now.action !== 'PROCEED') return { kind: 'LATE_REFUSAL', basis: now.basis };
  }
  const entered = safeWrite(deps, s.ptyId, '\r');
  if (s.decision) {
    if (entered.ok) deps.capacity.confirmLaunch(s.decision);
    else deps.capacity.cancelGrant(s.decision);
  }
  return { kind: 'ENTERED', ok: entered.ok, error: entered.error };
}

interface Binding { agentId: string; admissionClass: AdmissionClass; payload: string }
interface Known { binding: Binding; promise: Promise<SubmitOutcome>; settled: { at: number | null } }

export class AutomaticSubmitOwner {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly known = new Map<string, Known>();
  private readonly inhibited = new Map<string, Inhibition>();

  constructor(private readonly deps: OwnerDeps) {}

  /**
   * Submit one programmatic message. Resolves with what HAPPENED; never rejects.
   *
   * IDEMPOTENT ON `requestId` (section 7). The same id with the same binding returns the
   * same outcome — in flight or settled — and types nothing twice: a replay after COMMIT
   * writes no second Enter. The same id with ANY different argument is REJECTED; it does
   * not get the prior success for a different request.
   *
   * WHAT IS REMEMBERED, AND WHAT IS NOT. COMMITTED and INTERFERED are FACTS ABOUT THE
   * PROMPT: the message went out, or it is sitting there held. Those are recorded, so a
   * caller that lost the reply or was reloaded learns what happened instead of typing it
   * again. REFUSED, ABORTED and FAILED left NOTHING of ours on any live prompt; they are
   * "not delivered, ask again", so the id is released the moment they settle and the SAME
   * id may be retried. That is what lets a caller use one stable id per message — a
   * message is delivered AT MOST ONCE, however many times it is asked.
   */
  submit(req: SubmitRequest): Promise<SubmitOutcome> {
    this.sweep();
    const binding: Binding = {
      agentId: req.agentId, admissionClass: req.admissionClass, payload: payloadIdentity(req.text)
    };
    const prior = this.known.get(req.requestId);
    if (prior) {
      const same = prior.binding.agentId === binding.agentId
        && prior.binding.admissionClass === binding.admissionClass
        && prior.binding.payload === binding.payload;
      return same ? prior.promise : Promise.resolve({ kind: 'REJECTED', reason: 'ID_BINDING_MISMATCH' });
    }
    const ptyId = this.deps.resolvePty(req.agentId);
    const settled = { at: null as number | null };
    const promise = this.enqueue(req, ptyId).then((outcome) => {
      settled.at = this.deps.now();
      if (outcome.kind !== 'COMMITTED' && outcome.kind !== 'INTERFERED'
        && this.known.get(req.requestId)?.promise === promise) {
        this.known.delete(req.requestId);
      }
      try {
        this.deps.onOutcome?.({
          requestId: req.requestId, agentId: req.agentId, ptyId,
          admissionClass: req.admissionClass, outcome, at: settled.at
        });
      } catch { /* diagnostics never decide */ }
      return outcome;
    });
    this.known.set(req.requestId, { binding, promise, settled });
    return promise;
  }

  /** Is automatic delivery to this PTY inhibited by an unresolved INTERFERED? */
  inhibition(ptyId: string): Inhibition | null {
    const held = this.inhibited.get(ptyId);
    if (!held) return null;
    // Scoped to the incarnation it was raised on: the staged text and the human's text
    // both died with that process, and the replacement has a clean prompt.
    if (this.deps.incarnation(ptyId) !== held.incarnation) { this.inhibited.delete(ptyId); return null; }
    return held;
  }

  /** A HUMAN says the held prompt is dealt with. The ONLY way an inhibition ends while
   *  its terminal lives — there is no timer, because a timer is automation deciding that
   *  a human's text no longer matters. */
  resolveInterference(ptyId: string): boolean {
    const held = this.inhibited.get(ptyId);
    if (!held) return false;
    this.inhibited.delete(ptyId);
    // The held item is the human's to re-release or discard. Its recorded INTERFERED
    // must not answer for it any more, or re-releasing the same message would replay the
    // hold it was just released from.
    this.known.delete(held.requestId);
    return true;
  }

  private sweep(): void {
    const now = this.deps.now();
    for (const [id, k] of this.known) {
      if (k.settled.at !== null && now - k.settled.at > OUTCOME_REPLAY_TTL_MS) this.known.delete(id);
    }
  }

  /** ONE chain per PTY: every class, every caller. This is the single ordering authority
   *  for programmatic text+Enter, and the PTY is held against other programmatic writers
   *  from before STAGE until the post-COMMIT settle has elapsed. */
  private enqueue(req: SubmitRequest, ptyId: string | null): Promise<SubmitOutcome> {
    if (!ptyId) return Promise.resolve({ kind: 'REFUSED', reason: 'NO_PTY' });
    const prev = this.chains.get(ptyId) ?? Promise.resolve();
    const result = prev.then(async (): Promise<SubmitOutcome> => {
      try {
        return await this.run(req, ptyId);
      } catch (e) {
        // A bug in here must not wedge the chain or reject into a caller that was
        // promised a value. Nothing is claimed about what was typed.
        return { kind: 'REFUSED', reason: 'STAGE_WRITE_FAILED', detail: `owner error: ${String(e)}` };
      }
    });
    // The NEXT submission waits for this one AND for its post-COMMIT settle; the caller
    // does not — its outcome is a fact the moment the Enter result is recorded.
    const tail: Promise<void> = result.then((outcome) =>
      outcome.kind === 'COMMITTED' ? this.sleep(req.settleMs ?? SETTLE_MS) : undefined);
    this.chains.set(ptyId, tail);
    void tail.then(() => { if (this.chains.get(ptyId) === tail) this.chains.delete(ptyId); });
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => { this.deps.setTimer(r, ms); });
  }

  private refuse(decision: AdmissionDecision | null, reason: RefusalReason, detail?: string): SubmitOutcome {
    if (decision) this.deps.capacity.cancelGrant(decision);
    return detail === undefined ? { kind: 'REFUSED', reason } : { kind: 'REFUSED', reason, detail };
  }

  private async run(req: SubmitRequest, ptyId: string): Promise<SubmitOutcome> {
    const deps = this.deps;
    const cls = req.admissionClass;
    const policy = deps.unknownPolicy ?? UNKNOWN_POLICY;

    // ── ADMIT ────────────────────────────────────────────────────────────────────────
    if (this.inhibition(ptyId)) return this.refuse(null, 'PTY_INHIBITED');
    const incarnation = deps.incarnation(ptyId);
    if (incarnation === undefined) return this.refuse(null, 'PTY_GONE');
    let decision: AdmissionDecision | null = null;
    if (ASKS_CAPACITY[cls]) {
      decision = deps.capacity.admit(req.agentId, 'ORDINARY_TURN');
      const admitted = resolveAdmission(decision, policy);
      if (admitted.action !== 'PROCEED') return this.refuse(decision, 'CAPACITY_HOLD', admitted.basis);
    }
    const humanAdmit = deps.humanGeneration(ptyId);

    // ── READY: fail closed BEFORE anything is staged ─────────────────────────────────
    // Nothing is ever typed that cannot be un-typed (section 8). Capability UNKNOWN is
    // not capacity UNKNOWN and takes no proceed mapping from it.
    if (gateRefuses(cls, 'ABORT_CAPABILITY_UNVERIFIED') && deps.abortCapability(req.agentId).kind !== 'VERIFIED') {
      return this.refuse(decision, 'PROVIDER_ABORT_UNVERIFIED');
    }
    if (gateRefuses(cls, 'PROVENANCE_INELIGIBLE')) {
      const e = deps.eligibility(ptyId);
      if (!e.eligible) return this.refuse(decision, 'PROVENANCE_INELIGIBLE', e.reason);
    }
    const started = deps.now();
    for (;;) {
      const waited = deps.now() - started;
      const ready = deps.terminalReady(ptyId, req.agentId, waited);
      if (ready === 'READY') break;
      if (ready === 'GONE') return this.refuse(decision, 'PTY_GONE');
      if (waited >= READY_TIMEOUT_MS) return this.refuse(decision, 'TERMINAL_NOT_READY');
      await this.sleep(READY_POLL_MS);
    }

    // ── STAGE: every guard re-read IMMEDIATELY before the write, no yield between ────
    // The wait above yielded, so nothing read before it is evidence about now.
    if (deps.incarnation(ptyId) !== incarnation) return this.refuse(decision, 'PTY_REPLACED');
    if (this.inhibition(ptyId)) return this.refuse(decision, 'PTY_INHIBITED');
    const prompt = promptCondition(deps.promptBlock(ptyId));
    if (prompt && gateRefuses(cls, prompt)) return this.refuse(decision, prompt);
    const lastHuman = deps.lastHumanInputAt(ptyId);
    if (lastHuman !== undefined && deps.now() - lastHuman < HUMAN_QUIET_MS && gateRefuses(cls, 'HUMAN_INPUT_RECENT')) {
      return this.refuse(decision, 'HUMAN_INPUT_RECENT');
    }
    if (gateRefuses(cls, 'PROVENANCE_INELIGIBLE')) {
      const e = deps.eligibility(ptyId);
      if (!e.eligible) return this.refuse(decision, 'PROVENANCE_INELIGIBLE', e.reason);
    }
    if (decision) {
      const claim: OwnerClaim = { decision, agentId: req.agentId, workClass: decision.workClass, target: ptyId };
      const again = resolveAdmission(deps.capacity.revalidate(claim), policy);
      if (again.action !== 'PROCEED') return this.refuse(decision, 'CAPACITY_HOLD', again.basis);
    }
    // PRE-STAGE BASELINE. A human write since ADMIT is NOT interference — nothing of ours
    // is on the line yet. Side-effect-free refusal and re-admission: no residue, nothing
    // held, nothing inhibited (section 4).
    if (deps.humanGeneration(ptyId) !== humanAdmit) return this.refuse(decision, 'HUMAN_INPUT_BEFORE_STAGE');
    const wrote = safeWrite(deps, ptyId, payloadFor(req.text));
    if (!wrote.ok) return this.refuse(decision, 'STAGE_WRITE_FAILED', wrote.error);
    // POST-STAGE BASELINE, captured only after the payload write SUCCEEDED and in the same
    // turn: from here on a human write lands on a line that already holds our text.
    const humanStage = deps.humanGeneration(ptyId);
    if (humanStage === undefined) {
      if (decision) deps.capacity.cancelGrant(decision);
      return { kind: 'FAILED', reason: 'PTY_GONE_AFTER_STAGE' };
    }
    const staged: Staged = { req, ptyId, incarnation, decision, humanStage };

    // ── GAP ──────────────────────────────────────────────────────────────────────────
    await this.sleep(GAP_MS);

    // ── COMMIT | ABORT | INTERFERED ──────────────────────────────────────────────────
    const verdict = await Promise.resolve(commitSection(staged, deps));
    switch (verdict.kind) {
      case 'ENTERED':
        if (verdict.ok) return { kind: 'COMMITTED' };
        // The Enter did not go out and our text is still on a live prompt: residue we
        // cannot account for. Held, not retried (the grant was returned in-section).
        return this.interfere(staged, 'ENTER_WRITE_FAILED', verdict.error, false);
      case 'FAILED':
        if (decision) deps.capacity.cancelGrant(decision);
        return { kind: 'FAILED', reason: verdict.reason };
      case 'INTERFERED':
        return this.interfere(staged, verdict.reason, verdict.detail, true);
      case 'LATE_REFUSAL':
        return this.abort(staged, verdict.basis);
    }
  }

  /** INTERFERED: write NOTHING. Hold, flag, inhibit. */
  private interfere(s: Staged, reason: InterferenceReason, detail: string | undefined, returnGrant: boolean): SubmitOutcome {
    if (returnGrant && s.decision) this.deps.capacity.cancelGrant(s.decision);
    this.inhibited.set(s.ptyId, { requestId: s.req.requestId, reason, at: this.deps.now(), incarnation: s.incarnation });
    return detail === undefined ? { kind: 'INTERFERED', reason } : { kind: 'INTERFERED', reason, detail };
  }

  private readScreen(ptyId: string, needle: string): Promise<ScreenReading | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: ScreenReading | null) => { if (!done) { done = true; resolve(v); } };
      this.deps.setTimer(() => finish(null), SCREEN_ORACLE_TIMEOUT_MS);
      this.deps.readScreen(ptyId, needle).then(
        (v) => finish(v && typeof v.onPromptRow === 'boolean' && typeof v.screenCount === 'number' ? v : null),
        () => finish(null)
      );
    });
  }

  /**
   * ABORT (section 5): the NO-INTERFERENCE late refusal. Destructive, so it gets its own
   * FRESH comparison immediately before the clear — never the commit check's — and the
   * erase is POSITIVELY verified before the item is released for retry. Anything short
   * of positive verification is INTERFERED: an erase that was merely issued is not an
   * erase that happened, and one uncertain erase is held, never settled CANCELLED.
   *
   * The verification is DIFFERENTIAL. The oracle is first required to SEE our text on
   * the prompt row; only then is its later absence evidence. A TUI that shows a paste
   * as a placeholder, or a needle that wrapped, fails the first reading and is held —
   * otherwise "not found afterwards" would verify on a screen that never showed it.
   */
  private async abort(s: Staged, basis: string): Promise<SubmitOutcome> {
    const deps = this.deps;
    const cap = deps.abortCapability(s.req.agentId);
    if (cap.kind !== 'VERIFIED') return this.interfere(s, 'ABORT_CAPABILITY_UNVERIFIED', undefined, true);
    const needle = needleFor(s.req.text);
    if (!needle) return this.interfere(s, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', 'no usable needle', true);
    const before = await this.readScreen(s.ptyId, needle);
    if (!before || !before.onPromptRow || before.screenCount < 1) {
      return this.interfere(s, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', before ? 'not on the prompt row' : 'no screen reading', true);
    }
    // FRESH, and adjacent to the destructive write: no yield between this and the clear.
    const blocked = postStageGuard(s, deps);
    if (blocked) {
      if (blocked.kind === 'FAILED') { if (s.decision) deps.capacity.cancelGrant(s.decision); return { kind: 'FAILED', reason: blocked.reason }; }
      if (blocked.kind === 'INTERFERED') return this.interfere(s, blocked.reason, blocked.detail, true);
    }
    const cleared = safeWrite(deps, s.ptyId, cap.clearControl);
    if (!cleared.ok) return this.interfere(s, 'CLEAR_WRITE_FAILED', cleared.error, true);
    await this.sleep(cap.settleMs);
    const after = await this.readScreen(s.ptyId, needle);
    // BOTH halves, neither traded for the other: gone from the prompt row AND fewer on
    // the screen than before — so the text neither remains sendable nor merely moved.
    if (!after || after.onPromptRow || after.screenCount >= before.screenCount) {
      return this.interfere(s, 'ERASE_NOT_VERIFIED', after ? `row=${after.onPromptRow} count=${after.screenCount}/${before.screenCount}` : 'no screen reading', true);
    }
    if (s.decision) deps.capacity.cancelGrant(s.decision);
    return { kind: 'ABORTED', detail: basis };
  }
}
