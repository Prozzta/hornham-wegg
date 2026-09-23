/**
 * WAKE TELEMETRY (D8) — wake health as numbers, not as a grep.
 *
 * The durable `kind: 'wake'` breadcrumbs answer "what happened to THIS wake". They do not
 * answer "is the floor advancing itself", and that is the question the 1.1.46 stall went
 * fifteen minutes without anyone being able to ask. Reading it off the rows means scrolling
 * a log that, by design, only prints reconcile refusals when they CHANGE — so the one
 * number that mattered ("every wake for every agent has been refused for the same reason
 * all morning") was the hardest one to see.
 *
 * This counts every stage as it passes, including the rows the log folds away, and hands
 * back a per-agent and floor-wide rollup for fleet.json. It is the observability layer over
 * the wake path and NOTHING else: it decides nothing, it is never read by the wake path,
 * and removing it could not change a single wake outcome.
 *
 * Cost is a few map lookups per stage, and stages fire a handful of times per agent per
 * 15s beat. Unbounded growth is not possible: refusal reasons come from a fixed set of
 * guard names, outcome kinds from a fixed set of owner outcomes, and agent ids from the
 * roster.
 *
 * Pure: no clock of its own, no Electron, no fs.
 */

/** One agent's wake history this session. */
export interface WakeCounters {
  /** Durable inbox writes observed for this agent (the delivery edge fired). */
  deliveries: number;
  /** Times the one wake path was entered on this agent's behalf, by any trigger. */
  requests: number;
  /** Batches claimed (a wake was actually attempted). */
  claims: number;
  /** Claims handed to the submit owner. */
  submits: number;
  /** Owner outcomes by kind: COMMITTED, REFUSED, INTERFERED, ABORTED, FAILED, … */
  outcomes: Record<string, number>;
  /** Why the coordinator declined, by guard name: lifecycle-active, boot-grace, … */
  refusals: Record<string, number>;
  /** Triggers that asked for a wake: delivery, hook, control, capacity, reconcile, renderer. */
  causes: Record<string, number>;
  /** Stall-watchdog announcements (an unchanging refusal with mail waiting). */
  stalls: number;
  /** Throws reported from the wake path. */
  throws: number;
  /** Last COMMITTED wake, and the last refusal with its reason — the two facts you want first. */
  lastCommitAt: number | null;
  lastRefusalAt: number | null;
  lastRefusalWhy: string | null;
}

/** The floor rollup: every agent's counters summed, plus the things that are floor-wide. */
export interface WakeFloorCounters extends WakeCounters {
  /** Reconciliation beat ticks. Zero here with a live floor means the beat is not armed. */
  beats: number;
  /** Heartbeat ticks (the beat ran, whatever it decided to send). */
  heartbeats: number;
  /** Durable writes that found NO observer registered — a wake that could never happen. */
  observerMissing: number;
  /** Agents seen by this counter. */
  agents: number;
}

const counters = (): WakeCounters => ({
  deliveries: 0, requests: 0, claims: 0, submits: 0,
  outcomes: {}, refusals: {}, causes: {},
  stalls: 0, throws: 0,
  lastCommitAt: null, lastRefusalAt: null, lastRefusalWhy: null
});

const bump = (m: Record<string, number>, k: unknown): void => {
  const key = typeof k === 'string' && k ? k : 'unknown';
  m[key] = (m[key] ?? 0) + 1;
};

export class WakeTelemetry {
  private readonly byAgent = new Map<string, WakeCounters>();
  private beats = 0;
  private heartbeats = 0;
  private observerMissing = 0;
  private readonly since: number;

  constructor(now: number) {
    this.since = now;
  }

  private rec(agentId: string): WakeCounters {
    let r = this.byAgent.get(agentId);
    if (!r) { r = counters(); this.byAgent.set(agentId, r); }
    return r;
  }

  /**
   * Fold one breadcrumb in. Takes the SAME (stage, fields) the durable sink takes, and
   * must be called before any log-level de-duplication: the reconcile rows the log folds
   * away are exactly the ones a stall is made of.
   */
  note(stage: string, fields: Record<string, unknown>, now: number): void {
    // Floor-wide stages carry no agent.
    if (stage === 'beat') { this.beats += 1; return; }
    if (stage === 'heartbeat') { this.heartbeats += 1; return; }
    if (stage === 'observer-missing') { this.observerMissing += 1; return; }

    const agentId = typeof fields.agentId === 'string' ? fields.agentId : '';
    if (!agentId) return;
    const r = this.rec(agentId);

    switch (stage) {
      case 'observer': r.deliveries += 1; break;
      case 'enter':
        r.requests += 1;
        bump(r.causes, fields.cause);
        break;
      case 'claim': r.claims += 1; break;
      case 'submit': r.submits += 1; break;
      case 'settle': {
        bump(r.outcomes, fields.outcome);
        if (fields.outcome === 'COMMITTED') r.lastCommitAt = now;
        break;
      }
      case 'no-claim': {
        // The refusal reason is the single most useful number here: it is what turns
        // "nothing is waking" into "everything is refused as lifecycle-active".
        bump(r.refusals, fields.why);
        r.lastRefusalAt = now;
        r.lastRefusalWhy = typeof fields.why === 'string' ? fields.why : null;
        break;
      }
      case 'stall': r.stalls += 1; break;
      case 'throw':
      case 'submit-threw': r.throws += 1; break;
      default: break;   // schedule / facts / bridge-built / beats-armed: not counted
    }
  }

  /** One agent's counters, or null if it has never appeared. */
  forAgent(agentId: string): WakeCounters | null {
    const r = this.byAgent.get(agentId);
    return r ? { ...r, outcomes: { ...r.outcomes }, refusals: { ...r.refusals }, causes: { ...r.causes } } : null;
  }

  /** The floor rollup: every agent summed, plus the floor-wide stages. */
  floor(): WakeFloorCounters {
    const total: WakeFloorCounters = {
      ...counters(),
      beats: this.beats,
      heartbeats: this.heartbeats,
      observerMissing: this.observerMissing,
      agents: this.byAgent.size
    };
    for (const r of this.byAgent.values()) {
      total.deliveries += r.deliveries;
      total.requests += r.requests;
      total.claims += r.claims;
      total.submits += r.submits;
      total.stalls += r.stalls;
      total.throws += r.throws;
      for (const [k, n] of Object.entries(r.outcomes)) total.outcomes[k] = (total.outcomes[k] ?? 0) + n;
      for (const [k, n] of Object.entries(r.refusals)) total.refusals[k] = (total.refusals[k] ?? 0) + n;
      for (const [k, n] of Object.entries(r.causes)) total.causes[k] = (total.causes[k] ?? 0) + n;
      if (r.lastCommitAt !== null) total.lastCommitAt = Math.max(total.lastCommitAt ?? 0, r.lastCommitAt);
      if (r.lastRefusalAt !== null && r.lastRefusalAt > (total.lastRefusalAt ?? 0)) {
        total.lastRefusalAt = r.lastRefusalAt;
        total.lastRefusalWhy = r.lastRefusalWhy;
      }
    }
    return total;
  }

  /** What fleet.json publishes at the top level. */
  snapshot(now: number): { since: number; ts: number; floor: WakeFloorCounters } {
    return { since: this.since, ts: now, floor: this.floor() };
  }
}
