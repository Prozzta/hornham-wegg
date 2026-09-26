/**
 * L0-FUSION stage 5 — how the ONE submit owner (`automaticSubmit.ts`) is joined to the
 * real main process: the PTY manager, the capacity runtime, the two renderer mirrors and
 * the renderer's screen oracle.
 *
 * No electron import, for the same reason the owner has none: what each effect MEANS is
 * decided here, and a decision that cannot be reached from a test is a convention. The
 * electron-facing half (the IPC handlers, the webContents send) is a few lines in
 * `index.ts` that hand this module plain functions.
 */
import { automaticAbortCapability, terminalReadyToReceive } from '../shared/providerAutomation';
import { automaticDeliveryEligibility, type TerminalInputState } from '../shared/inputProvenance';
import type { TerminalPromptState } from '../shared/promptState';
import type { AgentProvider } from '../shared/agentProvider';
import type { AdmissionDecision, WorkClass } from './capacityAdmission';
import type { AbortCapability, OutcomeRecord, OwnerClaim, OwnerDeps, ScreenReading } from './automaticSubmit';

/** The slice of `PtyManager` the owner is allowed to touch. */
export interface OwnerPty {
  write(id: string, data: string, origin: 'PROGRAMMATIC'): { ok: boolean; error?: string };
  incarnation(id: string): number | undefined;
  humanInputGeneration(id: string): number | undefined;
  lastHumanInputAt(id: string): number | undefined;
  hasOutput(id: string): boolean | undefined;
  inputState(id: string): TerminalInputState | undefined;
  promptState(id: string): TerminalPromptState | undefined;
}

/** The slice of `CapacityRuntime` the owner is allowed to touch. Nothing here answers
 *  with a boolean: a boolean collapses the tri-state verdict (section 3). */
export interface OwnerCapacity {
  admit(agentId: string, workClass: WorkClass): AdmissionDecision;
  revalidate(claim: OwnerClaim, target: string | null): { verdict: AdmissionDecision['verdict']; reason: string };
  confirmLaunch(decision: AdmissionDecision): void;
  cancelGrant(decision: AdmissionDecision): void;
  holdGrant(decision: AdmissionDecision): void;
}

export interface OwnerWiring {
  pty: OwnerPty;
  capacity: OwnerCapacity;
  /** agentId -> its live PTY id. MAIN resolves this; no caller of the owner names a PTY. */
  ptyForAgent: (agentId: string) => string | undefined;
  /** The provider running in a PTY, as resolved at spawn. Undefined = not known. */
  providerForPty: (ptyId: string) => AgentProvider | undefined;
  /** Ask the renderer that owns this PTY to read its rendered screen. Resolves null when
   *  there is no renderer to ask; may also simply never resolve — the owner times it out. */
  requestScreenReading: (ptyId: string, needle: string, expectedTail?: string) => Promise<ScreenReading | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  onOutcome?: (record: OutcomeRecord) => void;
}

export function buildOwnerDeps(w: OwnerWiring): OwnerDeps {
  /** Once a given incarnation has been ready it stays ready: the settle is about the
   *  FIRST frame, and re-waiting it before every message would add it to each delivery. */
  const readyIncarnation = new Map<string, number>();

  const abortCapability = (ptyId: string | undefined): AbortCapability => {
    const provider = ptyId ? w.providerForPty(ptyId) : undefined;
    // A PTY whose provider main never resolved is UNKNOWN, not "probably claude".
    if (!provider) return { kind: 'UNKNOWN' };
    const cap = automaticAbortCapability(provider);
    return cap.kind === 'MEASURED'
      ? { kind: 'VERIFIED', clearControl: cap.clearControl, settleMs: cap.settleMs }
      : { kind: 'UNKNOWN' };
  };

  return {
    resolvePty: (agentId) => w.ptyForAgent(agentId) ?? null,
    incarnation: (ptyId) => w.pty.incarnation(ptyId),
    humanGeneration: (ptyId) => w.pty.humanInputGeneration(ptyId),
    lastHumanInputAt: (ptyId) => w.pty.lastHumanInputAt(ptyId),
    // THE OWNER'S ONLY WRITE. Declared PROGRAMMATIC, so it can never advance the human
    // generation — the owner must not be able to interfere with itself.
    write: (ptyId, data) => w.pty.write(ptyId, data, 'PROGRAMMATIC'),
    terminalReady: (ptyId, _agentId, waitedMs) => {
      const incarnation = w.pty.incarnation(ptyId);
      if (incarnation === undefined) return 'GONE';
      if (readyIncarnation.get(ptyId) === incarnation) return 'READY';
      const provider = w.providerForPty(ptyId) ?? 'custom';
      if (!terminalReadyToReceive(w.pty.hasOutput(ptyId), waitedMs, provider)) return 'WAIT';
      readyIncarnation.set(ptyId, incarnation);
      return 'READY';
    },
    // Evaluated FRESH from the stored mirror on every ask: re-entrant by construction.
    eligibility: (ptyId) => automaticDeliveryEligibility(w.pty.inputState(ptyId)),
    // `undefined` (never mirrored) stays undefined. It is not `null`: an unknown prompt
    // is not a free prompt.
    promptBlock: (ptyId) => {
      const state = w.pty.promptState(ptyId);
      return state ? state.block : undefined;
    },
    abortCapability: (agentId) => abortCapability(w.ptyForAgent(agentId)),
    readScreen: (ptyId, needle, expectedTail) => w.requestScreenReading(ptyId, needle, expectedTail),
    capacity: {
      admit: (agentId, workClass) => w.capacity.admit(agentId, workClass),
      revalidate: (claim) => w.capacity.revalidate(claim, claim.target),
      confirmLaunch: (decision) => w.capacity.confirmLaunch(decision),
      cancelGrant: (decision) => w.capacity.cancelGrant(decision),
      holdGrant: (decision) => w.capacity.holdGrant(decision)
    },
    now: w.now ?? (() => Date.now()),
    // A submission in flight must never be the reason this process stays alive.
    setTimer: w.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      if (typeof t.unref === 'function') t.unref();
      return t;
    }),
    onOutcome: w.onOutcome
  };
}

/** Pending main -> renderer screen-reading requests, correlated by id. */
export class ScreenReadingBroker {
  private seq = 0;
  private readonly pending = new Map<string, (reading: ScreenReading | null) => void>();

  /**
   * @param send hands the request to the renderer that owns the PTY; returns false when
   *             there is nobody to hand it to, which resolves null at once.
   */
  constructor(
    private readonly send: (ptyId: string, requestId: string, needle: string, expectedTail?: string) => boolean,
    /** A request nobody answers is forgotten after this long, so a renderer that went
     *  away cannot grow this map. The OWNER has its own, shorter, timeout and does not
     *  depend on this one. */
    private readonly forgetAfterMs = 10_000,
    private readonly setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (typeof t.unref === 'function') t.unref();
      return t;
    }
  ) {}

  request(ptyId: string, needle: string, expectedTail?: string): Promise<ScreenReading | null> {
    const requestId = `scr-${(this.seq += 1)}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      let sent = false;
      try { sent = this.send(ptyId, requestId, needle, expectedTail); } catch { sent = false; }
      if (!sent) this.settle(requestId, null);
      else this.setTimer(() => this.settle(requestId, null), this.forgetAfterMs);
    });
  }

  /** A renderer answered. A malformed answer is NO answer: null, never a guess. An id
   *  that is not pending (late, replayed, invented) is dropped. */
  answer(requestId: unknown, reading: unknown): void {
    if (typeof requestId !== 'string') return;
    this.settle(requestId, isScreenReading(reading) ? {
      onPromptRow: reading.onPromptRow, screenCount: reading.screenCount,
      ...(reading.promptTailMatches === undefined ? {} : { promptTailMatches: reading.promptTailMatches })
    } : null);
  }

  get outstanding(): number {
    return this.pending.size;
  }

  private settle(requestId: string, reading: ScreenReading | null): void {
    const resolve = this.pending.get(requestId);
    if (!resolve) return;
    this.pending.delete(requestId);
    resolve(reading);
  }
}

export function isScreenReading(v: unknown): v is ScreenReading {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.onPromptRow === 'boolean'
    && typeof r.screenCount === 'number' && Number.isInteger(r.screenCount) && r.screenCount >= 0
    && (r.promptTailMatches === undefined || typeof r.promptTailMatches === 'boolean');
}
