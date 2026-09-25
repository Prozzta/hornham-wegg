/**
 * Which wake breadcrumbs reach log.jsonl. Decision only — no I/O, no clock of its own.
 * `wakeDiag` in index.ts is the voice, the same split as wakeStall.ts.
 *
 * WHAT WENT WRONG (the 1.1.49 log storm). The reconcile beat repeats every stage for every
 * agent, so the breadcrumb only ever meant to log a CHANGE there. It kept the last row per
 * `stage:agentId` and compared a signature of the fields, ignoring the always-moving idle
 * age. That was right, and it suppressed NOTHING, because `cause` is one of the signed
 * fields and TWO independent cadences both emit with mode:'reconcile':
 *
 *     the renderer's 4s inbox hint   -> cause:'renderer'
 *     the 15s reconciliation beat    -> cause:'reconcile'
 *
 * They interleave, so every row's signature differed from the one before it and every row
 * logged. Measured on the live floor: for all six agents, the `facts` cause sequence is a
 * perfect `renderer reconcile renderer reconcile …` and the suppression rate was
 * 0 out of 14,717 — the de-duplication was not weak, it was inert.
 *
 * THE FIX is one line of meaning: a cadence may only de-duplicate against ITSELF. `cause`
 * moves out of the signature and into the KEY, so each cadence gets its own slot and an
 * idle agent logs one row per cadence per change instead of three rows per tick forever.
 *
 * WHAT THIS IS NOT. It does not suppress, delay or alter a single wake — the wake path
 * never reads this, and every guard, claim and submit runs exactly as before. It decides
 * only whether a row that says THE SAME THING AS LAST TIME is written again. Event-path
 * rows (mode:'event' — a real delivery, hook, capacity or control edge) are never
 * de-duplicated at all: those are the ones you need every instance of.
 */

/** Per-key memory of the last signature written. Caller owns the instance. */
export type BreadcrumbMemory = Map<string, string>;

export const newBreadcrumbMemory = (): BreadcrumbMemory => new Map();

/**
 * Fields whose value changes on every tick without signifying anything. Excluded from the
 * signature so a still-idle agent compares equal to itself; everything else is compared,
 * because anything else changing IS the transition worth a line.
 */
const IGNORED_FIELDS = new Set(['idleMs']);

/** Stable signature of a breadcrumb's meaning: every field except the always-moving ones. */
export function breadcrumbSignature(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).filter((k) => !IGNORED_FIELDS.has(k)).sort();
  // Sorted and built explicitly rather than JSON.stringify(spread): key ORDER must not be
  // able to change a signature, or a harmless refactor of the call site silently turns the
  // de-duplication off again — which is the exact failure this file exists to fix.
  return JSON.stringify(keys.map((k) => [k, fields[k]]));
}

/**
 * Should this breadcrumb be written? Records the signature when the answer is yes.
 *
 * Only `mode:'reconcile'` rows are candidates for suppression. The key carries `cause`, so
 * the renderer hint and the reconcile beat can never invalidate each other's entry.
 */
export function shouldLogBreadcrumb(
  memory: BreadcrumbMemory,
  stage: string,
  fields: Record<string, unknown>
): boolean {
  if (fields.mode !== 'reconcile') return true;
  const key = `${stage}:${String(fields.agentId)}:${String(fields.cause)}`;
  const sig = breadcrumbSignature(fields);
  if (memory.get(key) === sig) return false;
  memory.set(key, sig);
  return true;
}

/** Drop an agent's remembered signatures (it left the floor, or was forgotten). */
export function forgetBreadcrumbs(memory: BreadcrumbMemory, agentId: string): void {
  for (const key of [...memory.keys()]) {
    // key is `stage:agentId:cause`; the agent id is the middle segment.
    const parts = key.split(':');
    if (parts.length >= 3 && parts.slice(1, -1).join(':') === agentId) memory.delete(key);
  }
}
