import { createHash } from 'node:crypto';

/**
 * TE0 — the standup delta gate.
 *
 * WHAT IS ACTUALLY EXPENSIVE. The scheduler's ops-standup costs nothing in main:
 * `fire()` writes one small JSON file into god's inbox. The bill arrives in the
 * RENDERER, where the inbox-wake loop (useHive.ts, effect #3) notices an inbox id
 * it has not nudged for and queues a nudge that effect #4 types into god's PTY
 * once he is idle. That typed nudge is a full model turn over god's whole session
 * prefix — measured at ~0.63M token units per no-change standup, rising as the
 * session grows. Suppressing the dispatch suppresses the turn with nothing else to
 * change: no new inbox id means the wake loop has nothing fresh to nudge about.
 *
 * So this module answers one question, deterministically and locally, with no
 * model in the loop: HAS THE FLOOR ACTUALLY CHANGED SINCE THE LAST STANDUP?
 *
 * ─── RULE 1: THE FINGERPRINT COVERS FLOOR INPUTS, NEVER GOD'S OWN OUTPUTS ───
 *
 * LOAD-BEARING. Get this wrong and the gate is decorative.
 *
 * god is the sole scribe of `board.md` and appends a STANDUP line to it on EVERY
 * standup — including the no-change ones (the six that motivated TE0 are
 * board.md:123-128, all of them "No change: 22/22 done, floor idle"). The same is
 * true of the `notes` and `result` prose on a task card. If any of that were
 * hashed here, every standup would change the fingerprint that the NEXT standup
 * compares against, the gate would see a delta every single time, and it would
 * suppress exactly nothing while looking like it worked.
 *
 * Hence `FloorState` below carries no board content and no task prose. What it
 * does carry is floor INPUT: who exists, whether they hold real mail, whether
 * they are coordinating, and the task ledger's {id, status, assignee}. A status
 * or assignee transition IS real change and SHOULD open the gate — that is work
 * being dispatched or closed, not god describing it.
 *
 * ─── RULE 2: FAIL OPEN ───
 *
 * Every path that cannot prove "nothing changed" must DISPATCH. Missing baseline,
 * gate disabled, unreadable state, forced by the operator, too long since the last
 * real standup — all dispatch. The cost of a wrong dispatch is one standup we
 * did not need; the cost of a wrong suppression is an unattended floor. Those are
 * not the same mistake, so they do not get the same default.
 */

/** How long a floor may stay provably unchanged before a standup runs anyway.
 *  A frozen board is not proof that nothing needs a human-visible review, so the
 *  gate expires. 24h at the shipped cadence means at most one forced audit a day. */
export const DEFAULT_MAX_AGE_MS = 86_400_000;

/** One agent's contribution to the fingerprint. Every field is a floor input that
 *  moves on its own; none of it is written by the standup that reads it. */
export interface AgentFloorState {
  id: string;
  onHold: boolean;
  /** Circuit-breaker level. An agent tripping to constrained/stopped between two
   *  standups is exactly the kind of change a standup exists to catch. */
  breaker: string;
  hasLivePty: boolean;
  /** Unread mail EXCLUDING the scheduler's own noise — see SYSTEM_SENDERS at the
   *  call site. Counting our own beats here would be the Rule 1 mistake again. */
  actionableInbox: number;
  /** Newest mtime across the agent's coordination files. Real work moves it. */
  lastCoordinationAtMs: number;
}

/** A task card reduced to the three fields that mean something changed. NOT
 *  `notes`, NOT `result`, NOT `title` — see Rule 1. */
export interface TaskFloorState {
  id: string;
  status: string;
  assignee: string;
}

/** The complete input surface of the fingerprint. Deliberately small and closed:
 *  a future field is a deliberate edit here, not something that leaks in. */
export interface FloorState {
  agents: AgentFloorState[];
  tasks: TaskFloorState[];
  spawnRequests: number;
  crashes: number;
}

/** Per-mission gate settings. Absent ⇒ off ⇒ today's unconditional dispatch. */
export interface DeltaGate {
  enabled: boolean;
  maxAgeMs?: number;
}

export type StandupReason =
  | 'gate-off'      // no gate configured — behave exactly as before TE0
  | 'forced'        // operator pressed run-now
  | 'no-baseline'   // nothing to compare against yet
  | 'delta'         // the floor moved
  | 'max-age'       // provably unchanged, but the gate has expired
  | 'no-delta';     // the only outcome that suppresses a model turn

export interface StandupDecision {
  dispatch: boolean;
  reason: StandupReason;
  /** Always present, including on a skip: the caller stores it as the next
   *  comparison baseline only when it dispatches, but logs it either way. */
  fingerprint: string;
}

/** One line of `<hive>/standup-skips.jsonl`.
 *
 *  NOT `log.jsonl`, and that is a decision rather than a preference: log.jsonl's
 *  mtime is an INPUT to isFloorQuiet(), so recording every skip there would keep
 *  the floor looking permanently busy and quietly disable the heartbeat's
 *  re-engage. The heartbeat is disabled in the live config today, which is
 *  precisely what would have let that ship unnoticed. */
export interface StandupSkipRecord {
  ts: number;
  kind: 'standup-skipped';
  missionId: string;
  fingerprint: string;
  reason: StandupReason;
  sinceLastDispatchMs: number | null;
}

/** Reduce a raw tasks.json payload to the ledger the fingerprint hashes.
 *
 *  This is where Rule 1 is enforced for tasks, so it is exported and tested
 *  directly rather than inlined at the call site: prose fields must be dropped
 *  HERE, before anything can hash them. Accepts the array form and the
 *  `{tasks:[...]}`/`{cards:[...]}` wrappers the hive has used. */
export function projectTasks(raw: unknown): TaskFloorState[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { tasks?: unknown })?.tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : Array.isArray((raw as { cards?: unknown })?.cards)
        ? (raw as { cards: unknown[] }).cards
        : [];
  const out: TaskFloorState[] = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const c = t as Record<string, unknown>;
    out.push({
      id: String(c.id ?? ''),
      status: String(c.status ?? ''),
      assignee: String(c.assignee ?? '')
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Canonical text for hashing.
 *
 *  Nested ARRAYS, not objects: an array's order is written here, so the digest
 *  cannot drift because a key was renamed or because V8 handed back a different
 *  insertion order. Collections are sorted by id so "same floor, different
 *  readdir order" is the same fingerprint. */
export function canonicalize(state: FloorState): string {
  const agents = [...state.agents]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => [
      a.id,
      a.onHold ? 1 : 0,
      a.breaker,
      a.hasLivePty ? 1 : 0,
      a.actionableInbox,
      a.lastCoordinationAtMs
    ]);
  const tasks = [...state.tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => [t.id, t.status, t.assignee]);
  return JSON.stringify(['te0/1', agents, tasks, state.spawnRequests, state.crashes]);
}

/** sha256 of the canonical form. Hex, so it is greppable in the skip log. */
export function fingerprintFloor(state: FloorState): string {
  return createHash('sha256').update(canonicalize(state), 'utf8').digest('hex');
}

/**
 * The whole decision. Pure: no clock, no filesystem, no Electron — `now` and the
 * state are handed in, so every branch is reachable from a unit test.
 *
 * Order matters. `gate-off` and `forced` come before any comparison so neither
 * can be defeated by a hashing bug, and `no-baseline` precedes the comparison so
 * a first run (or a cleared config) always dispatches.
 */
export function decideStandup(input: {
  state: FloorState;
  gate?: DeltaGate;
  lastFingerprint?: string;
  lastDispatchAt?: number;
  now: number;
  forced?: boolean;
}): StandupDecision {
  const fingerprint = fingerprintFloor(input.state);
  if (!input.gate?.enabled) return { dispatch: true, reason: 'gate-off', fingerprint };
  if (input.forced) return { dispatch: true, reason: 'forced', fingerprint };
  if (!input.lastFingerprint) return { dispatch: true, reason: 'no-baseline', fingerprint };
  if (input.lastFingerprint !== fingerprint) return { dispatch: true, reason: 'delta', fingerprint };
  const maxAgeMs = input.gate.maxAgeMs && input.gate.maxAgeMs > 0
    ? input.gate.maxAgeMs
    : DEFAULT_MAX_AGE_MS;
  if (input.now - (input.lastDispatchAt ?? 0) >= maxAgeMs) {
    return { dispatch: true, reason: 'max-age', fingerprint };
  }
  return { dispatch: false, reason: 'no-delta', fingerprint };
}

/** Build the durable record of a suppressed standup. */
export function skipRecord(
  missionId: string,
  decision: StandupDecision,
  now: number,
  lastDispatchAt?: number
): StandupSkipRecord {
  return {
    ts: now,
    kind: 'standup-skipped',
    missionId,
    fingerprint: decision.fingerprint,
    reason: decision.reason,
    sinceLastDispatchMs: lastDispatchAt ? now - lastDispatchAt : null
  };
}
