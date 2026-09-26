/**
 * LOG-STALL-AV F3 (Jim, MAIL-AV-152; 1.1.53): which EVENT-path wake breadcrumbs reach
 * log.jsonl. Decision only, no I/O and no clock of its own; `wakeDiag` in index.ts is the voice.
 *
 * One delivered message wrote ~30 wake rows (p90 43): `hook` 8.2, `facts` 5.6, `no-claim` 5.6,
 * `enter` 2.3, `schedule` 1.4, `claim`/`submit`/`settle` 1 each. Each was a synchronous append
 * the antivirus rescanned. The rule now is EDGES ONLY:
 *   - `hook` and `provider-status` log only when they moved the lifecycle (`edge`).
 *   - `no-claim` logs the FIRST time each refusal reason appears for an agent since its last
 *     claim, and carries the agent's latest `facts`, so the row still says why and from what
 *     state. (Measured on the live log: reasons flap, e.g. active/recent-output, so logging
 *     every change still wrote ~3 refusals per message; each distinct reason once does not.)
 *   - `beat` logs only when its content (the live agents) changes.
 *   - `enter`, `facts`, `schedule` (armed/coalesced) and `submit` are steps of a wake whose
 *     outcome row (`claim`, `no-claim`, `settle`, `submit-threw`) says what happened; folded.
 *   - `claim` is carried by its outcome row: `settle` (or `submit-threw`) gets the claim's
 *     fields as `claim`, so one row says what was claimed and how it ended.
 *   - `delivery` logs only when it is NOT fresh (a re-delivery): the hive's own `message` row
 *     already records every delivery.
 *   - `observer` logs only when the bridge is missing (the one case it exists to catch).
 *   - Everything else (settle, stall, throws, codex-rollout, the beats, ...) logs as before.
 * A delivered message now writes 4 rows (message, a refusal while busy, the lifecycle edge, the
 * settle) where it wrote ~30.
 * Folded rows are COUNTED, per stage, and written as one `wake-folded` row per minute, so the
 * volume stays visible. The wake telemetry counters (fleet.json) and the stall watchdog see
 * every row before this filter, exactly as before: nothing here decides a wake.
 */

export interface WakeRowState {
  /** agentId -> the refusal reasons already logged since its last claim. */
  lastRefusal: Map<string, Set<string>>;
  /** The last logged beat's signature. */
  lastBeat: string;
  /** agentId -> the latest facts, attached to the next logged no-claim. */
  lastFacts: Map<string, Record<string, unknown>>;
  /** agentId -> the pending claim, attached to its outcome row. */
  lastClaim: Map<string, Record<string, unknown>>;
  /** stage -> rows folded since the last summary. */
  folded: Map<string, number>;
}

export const newWakeRowState = (): WakeRowState => ({ lastRefusal: new Map(), lastBeat: '', lastFacts: new Map(), lastClaim: new Map(), folded: new Map() });

const ALWAYS_FOLDED = new Set(['enter', 'facts', 'submit']);

/** The fields to write for this breadcrumb, or null when it is folded (and counted). */
export function planWakeRow(state: WakeRowState, stage: string, fields: Record<string, unknown>): Record<string, unknown> | null {
  const agent = typeof fields.agentId === 'string' ? fields.agentId : '';
  const fold = (): null => { state.folded.set(stage, (state.folded.get(stage) ?? 0) + 1); return null; };
  if (stage === 'facts' && agent) {
    const { agentId: _a, ...rest } = fields;
    state.lastFacts.set(agent, rest);
  }
  if (ALWAYS_FOLDED.has(stage)) return fold();
  switch (stage) {
    case 'hook':
    case 'provider-status':
      return fields.edge ? fields : fold();
    case 'schedule':
      return fields.took === 'no-agent-id' ? fields : fold();
    case 'observer':
      return fields.bridge === false ? fields : fold();
    case 'no-claim': {
      const why = String(fields.why ?? '');
      if (agent) {
        let seen = state.lastRefusal.get(agent);
        if (!seen) { seen = new Set(); state.lastRefusal.set(agent, seen); }
        if (seen.has(why)) return fold();
        seen.add(why);
      }
      const facts = agent ? state.lastFacts.get(agent) : undefined;
      return facts ? { ...fields, facts } : fields;
    }
    case 'claim': {
      if (!agent) return fields;
      state.lastRefusal.delete(agent);
      const { agentId: _a, ...rest } = fields;
      state.lastClaim.set(agent, rest);
      return fold();
    }
    case 'settle':
    case 'submit-threw': {
      const claim = agent ? state.lastClaim.get(agent) : undefined;
      if (agent) state.lastClaim.delete(agent);
      return claim ? { ...fields, claim } : fields;
    }
    case 'beat': {
      const sig = `${String(fields.live)}|${String(fields.agents)}`;
      if (sig === state.lastBeat) return fold();
      state.lastBeat = sig;
      return fields;
    }
    case 'delivery':
      return fields.fresh === false ? fields : fold();
    default:
      return fields;
  }
}

/** The per-minute summary of folded rows, or null when nothing was folded; clears the counts. */
export function takeFolded(state: WakeRowState): Record<string, number> | null {
  if (!state.folded.size) return null;
  const counts = Object.fromEntries([...state.folded.entries()].sort(([a], [b]) => a.localeCompare(b)));
  state.folded.clear();
  return counts;
}

/** Drop an agent's remembered state (it left the floor). */
export function forgetWakeRows(state: WakeRowState, agentId: string): void {
  state.lastRefusal.delete(agentId);
  state.lastFacts.delete(agentId);
  state.lastClaim.delete(agentId);
}
