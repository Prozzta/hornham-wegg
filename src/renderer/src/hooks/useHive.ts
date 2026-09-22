import { useEffect, useRef } from 'react';
import { useStore, type Agent, type QueuedMessage, type StationKind, type ToolKind } from '@/store/store';
import {
  buildSpawnCommand,
  ASSISTANT_MODEL,
  inferAgentProvider,
  isClaudeProvider,
  tokenizeCommand,
  type HarnessConfig
} from '@/store/config';
import {
  clearCommandForProvider,
  compactionCommandForProvider,
  remoteControlCommandForProvider
} from '../../../shared/providerAutomation';
import { DEFAULT_CONTEXT_TRIGGER, type ContextRule } from '../../../shared/triggers';
import type { AgentProvider } from '../../../shared/agentProvider';
import { bridgeOf, providerPreset } from '../../../shared/agentProvider';
import { isDurableRole, preferredAgentRole, roleForHiveSpawn } from '../../../shared/agentRole';
import { acquireTerminal, resetTerminal, isTerminalAutomationSafe } from '@/components/terminalPool';
import { canDeliverToAgent, deliverWithAcknowledgement, checkPrecondition } from './queueDelivery';
import type { AutoSubmitOutcome } from '../../../preload';
import { OFFICE_CAST, DEFAULT_CHARACTER } from '@/scene/office/cast';

const GOD_ID = 'god';
/** Accent palette for MAIN-spawned (voice-hired) agents — picked deterministically
 *  from the agent id so the same agent always gets the same colour. Mirrors the
 *  AddAgentModal palette. */
const SPAWN_ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'] as const;
const GOD_PTY = `pty-${GOD_ID}`;

const REMOTE_CONTROL_SETTLE_MS = 1500;
// Provider-agnostic PTY-quiescence idle fallback (#2e). A non-Claude bridge that
// fires a 'working' event but never its turn-end signal (Stop / session.idle /
// agent_end) would pin the agent 'working' forever → the idle-only inbox-wake nudge
// never fires → a god stops draining mail and the floor stalls. So a 'working'
// agent whose PTY has emitted NOTHING for this window is treated as turn-done and
// flipped idle. A streaming turn (incl. a long tool) keeps emitting bytes → stays
// working; only true silence drifts it idle. Hook events still win — a fresh
// PreToolUse/Stop refreshes status on the next event. Checked on QUIESCE_POLL_MS.
const QUIESCE_IDLE_MS = 12000;
const QUIESCE_POLL_MS = 4000;
// After a god/agent spawn, hold off the inbox-wake + queue-drain typers for this
// long while the readiness handshake + provider-specific boot sequence runs.
const BOOT_GRACE_MS = 35_000;
// Delay before typing a one-time TUI protocol seed into a fresh worker (3b) —
// long enough for the TUI to finish painting and surface any permission prompt.
// Main's submit owner additionally waits for the terminal's readiness handshake.
const SEED_BOOT_MS = 12_000;

/** Hive-aware / hooks-bridge engines get standing goals via HookServer
 *  (SessionStart + UserPromptSubmit). Cursor and other no-hook engines need the
 *  goal prepended onto queued PTY deliveries so an Edit Agent save still lands
 *  on the next drain cycle without a restart. */
function usesHookStandingGoal(agent: Agent): boolean {
  const provider = inferAgentProvider(agent.command, agent.provider);
  const preset = providerPreset(provider);
  if (preset.hiveAware) return true;
  return bridgeOf(provider)?.kind === 'hooks';
}

/** Prepend `<goal>…</goal>` for engines that cannot inject via hooks. Reads the
 *  live store field, so a just-saved goal is picked up on the next queue flush. */
function withStandingGoal(agent: Agent, text: string): string {
  const goal = agent.goal?.trim();
  if (!goal || usesHookStandingGoal(agent)) return text;
  if (text.includes('<goal>')) return text;
  return `<goal>\n${goal}\n</goal>\n\n${text}`;
}

// The first thing Michael (god) is told on a fresh spawn — orient him and put
// him to work running the floor. Kept terse and action-oriented.
const INITIAL_GOD_PROMPT = [
  "You're online as Michael, the orchestrator of the hive. Get oriented, then start running the floor:",
  '1. Read your memory.md and drain every message in your inbox.',
  '2. Review board.md + tasks.json and the current roster of agents (active vs archived).',
  '3. Check fleet health: read fleet.json in the hive root for every agent\'s live tokens, cost, status, breaker level, and inbox backlog (`claude agents` will NOT show your hive\'s agents). Flag anyone stalled, over-budget, or breaker-armed.',
  '4. Skim COMMANDS.md (hive root) for the Claude Code commands you can use — and run `mempalace wake-up` for a memory digest if the CLI is available.',
  'Then begin orchestrating: triage requests, delegate work to the team, and keep everyone unblocked. You are fully autonomous — there is no approval queue, so handle tool-permission prompts in this session yourself (the human can approve them remotely from their phone).'
].join('\n');

// L0-FUSION stage 5.3 — THE RENDERER NO LONGER TYPES PROGRAMMATICALLY AT ALL.
//
// This file used to own a whole submit path: a per-pty promise chain (`writeChains`) that
// ordered text+Enter, a readiness poll, the `typeAndSubmit` order, and a capacity ticket
// it asked main to mint, mark and settle. Every one of those is REMOVED, not wrapped. The
// one main-owned submit transaction (`src/main/automaticSubmit.ts`) now resolves the PTY,
// asks capacity, waits for readiness, stages, holds the TUI gap, re-checks everything next
// to the Enter, and settles — for every class of programmatic message — and it serializes
// them per terminal, so two callers can still never jam their text and Enter together.
//
// What stays HERE is exactly the renderer's one job: choosing WHICH message to deliver
// and WHEN to ask, and acknowledging a queue item on a reported COMMIT. And main's
// `pty:write` now REFUSES a renderer write that declares origin PROGRAMMATIC, so this is
// not a convention this file keeps — it is a capability it no longer has.

let autoSubmitSeq = 0;
/** A one-off request id, for a message that has no stable id of its own (boot prompts). */
function oneOffRequestId(kind: string, agentId: string): string {
  return `${kind}:${agentId}:${Date.now()}:${(autoSubmitSeq += 1)}`;
}

const BOOT_PROMPT_RETRY_MS = 1500;
const BOOT_PROMPT_MAX_ATTEMPTS = 40;

/**
 * Hand a BOOT-SEQUENCE prompt (remote-control, seed, orientation) to main, and keep
 * asking while main says "not now".
 *
 * A REFUSED or ABORTED outcome left NOTHING on the prompt — the terminal was not ready, a
 * human was typing, a picker was open — so asking again is free and is the right thing:
 * a spawn needs its orientation. The SAME request id is reused, so however the retries
 * interleave the prompt is delivered at most once. Anything else (INTERFERED, FAILED,
 * REJECTED) is final and throws, exactly as a dead PTY used to.
 */
async function submitBootPrompt(agentId: string, text: string, settleMs?: number): Promise<void> {
  const requestId = oneOffRequestId('boot', agentId);
  for (let attempt = 0; attempt < BOOT_PROMPT_MAX_ATTEMPTS; attempt += 1) {
    const outcome = await window.cth.autoSubmit({ requestId, agentId, admissionClass: 'BOOT_SEQUENCE', text, settleMs });
    if (outcome.kind === 'COMMITTED') return;
    if (outcome.kind !== 'REFUSED' && outcome.kind !== 'ABORTED') {
      throw new Error(`boot prompt for ${agentId} not delivered: ${outcome.kind}`);
    }
    await new Promise((r) => setTimeout(r, BOOT_PROMPT_RETRY_MS));
  }
  throw new Error(`boot prompt for ${agentId} not delivered: still refused after ${BOOT_PROMPT_MAX_ATTEMPTS} attempts`);
}

/** Wrap a user message as an enrich task for the assistant. The assistant's
 *  system prompt has the full instructions; this just frames the one task. */
function enrichTaskPrompt(text: string): string {
  return [
    `ENRICH TASK: ${text}`,
    '',
    '(Identify the relevant project, cd in, gather READ-ONLY context, then send the improved,',
    'self-contained prompt to Michael via an outbox message with "to":"god". Do not do the task yourself.)'
  ].join('\n');
}

function terminalWorkOrderPrompt(msg: {
  id: string;
  from: string;
  act: string;
  subject: string;
  body: string;
  requiresReply: boolean;
  createdAt: string;
}): string {
  return [
    'WORK ORDER FROM HIVE',
    `Message: ${msg.id}`,
    `From: ${msg.from}`,
    `Subject: ${msg.subject}`,
    `Act: ${msg.act}${msg.requiresReply ? ' (reply expected)' : ''}`,
    `Issued: ${msg.createdAt}`,
    '',
    msg.body,
    '',
    'Notes:',
    '- This arrived through your terminal because this provider does not support hive inbox.',
    '- Work in your current cwd.',
    '- When done, report changes, validation, blockers, and next step in this terminal.'
  ].join('\n');
}

/** Tool name → where the avatar walks + what it carries. */
const TOOL_STATION: Record<string, { station: StationKind; carry?: ToolKind }> = {
  Read: { station: 'shelf', carry: 'Read' },
  Edit: { station: 'desk', carry: 'Edit' },
  Write: { station: 'desk', carry: 'Write' },
  Bash: { station: 'terminal', carry: 'Bash' },
  Grep: { station: 'shelf', carry: 'Grep' },
  Glob: { station: 'shelf', carry: 'Glob' },
  WebFetch: { station: 'web', carry: 'WebFetch' },
  WebSearch: { station: 'web', carry: 'WebSearch' },
  TodoWrite: { station: 'board', carry: 'TodoWrite' },
  // #5A — delegating to a sub-agent reads as "handing off at the outbox".
  Task: { station: 'mailbox', carry: 'TodoWrite' }
};

/** Resolve a tool name to its station/glyph. Falls back: any `mcp__*` tool →
 *  the MCP station (previously these silently sat at the desk, #5A gap); anything
 *  else → the desk. */
function stationForTool(tool: string): { station: StationKind; carry?: ToolKind } {
  if (TOOL_STATION[tool]) return TOOL_STATION[tool];
  if (tool.startsWith('mcp__')) return { station: 'mcp', carry: 'MCP' };
  // Heuristic fallback for non-Claude tool names (Antigravity sends run_command,
  // ListDir, write_file, … — its hook names differ from Claude's exact tags).
  // Match write/edit BEFORE read so "write_file" → desk, not shelf.
  const t = tool.toLowerCase();
  if (/command|bash|shell|exec|terminal|run_/.test(t)) return { station: 'terminal', carry: 'Bash' };
  if (/web|fetch|browser|http|url/.test(t)) return { station: 'web', carry: 'WebFetch' };
  if (/write|edit|create|patch|replace|apply/.test(t)) return { station: 'desk', carry: 'Write' };
  if (/read|list|view|dir|glob|grep|search|find|file|cat|\bls\b/.test(t)) return { station: 'shelf', carry: 'Read' };
  return { station: 'desk' };
}

/** At/above this window size an agent counts as "large context" and is judged
 *  against `minContextPctLargeWindow` instead. Sits between the two real-world
 *  window sizes the app ever sees (200k and 1M) so neither lands ambiguously. */
const LARGE_CONTEXT_WINDOW = 500_000;

/**
 * How full this agent's context window is, 0-100, or null when we have no
 * reading at all.
 *
 * Two sources feed the store and only one is exact: the status-line shim pushes
 * real `contextTokens` + `contextLimit` (effect 2d), while the transcript poll
 * (2c) backfills tokens ONLY. So an agent can legitimately know its token count
 * without knowing its window — infer the window the same way 2c does rather
 * than throwing the token reading away.
 */
function contextFillPct(a: Agent): number | null {
  if (a.contextTokens === undefined || !Number.isFinite(a.contextTokens)) return null;
  const limit = a.contextLimit && a.contextLimit > 0
    ? a.contextLimit
    : (/1m/i.test(a.model ?? '') ? 1_000_000 : 200_000);
  return (a.contextTokens / limit) * 100;
}

/**
 * The context-pressure gate: is this agent full enough to be worth interrupting?
 *
 * `minContextPct` of 0 disables the gate (the rule's cadence alone fires it).
 *
 * FAIL-OPEN when we have no reading. That is the deliberate choice: context
 * telemetry arrives over the Claude status-line/hook path, so most non-Claude
 * providers report nothing at all. Failing closed there would silently reinstate
 * the very bug this replaces — a fleet that never compacts — only harder to
 * notice. An unmetered agent therefore falls back to time-only firing, which is
 * exactly the old behaviour and no worse.
 */
function passesContextPressure(a: Agent, rule: ContextRule): boolean {
  const large = (a.contextLimit ?? 0) >= LARGE_CONTEXT_WINDOW;
  const bar = large ? rule.minContextPctLargeWindow : rule.minContextPct;
  if (!(bar > 0)) return true;
  const pct = contextFillPct(a);
  if (pct === null) return true;
  return pct >= bar;
}

/**
 * The renderer-side glue for the hive:
 *   1. spawns the god agent into Michael's room when none is running,
 *   2. drives avatar state from real Claude Code hook events, and
 *   3. wakes idle agents that have unread inbox messages so collaboration
 *      doesn't stall while an agent sits at its prompt.
 */
export function useHive(config: HarnessConfig | null): void {
  // Per-agent context size at the last auto-/compact queued. See the latch note
  // in the context-trigger effect: an idle agent's token count is frozen, so
  // without this the pressure gate re-fires on the identical number every cycle.
  const lastCompactUsed = useRef<Record<string, number>>({});
  // Per-agent timestamp of the last queued-message we submitted. Guards against
  // re-sending the next message before the agent's hooks have flipped it to
  // 'working' (there's a short window where it still reads 'idle' right after we
  // type into it). One message per cooldown keeps delivery strictly one-by-one.
  const lastFlush = useRef<Record<string, number>>({});
  // Queue-drain delivery tracking (#36): a message now stays IN the queue until
  // its PTY write chain resolves, so `inFlightSends` (message ids mid-write)
  // stops a store-update burst from double-sending the head, and `sendFailures`
  // bounds retries — after MAX_SEND_ATTEMPTS failed writes the message is
  // dropped WITH a console.warn instead of being silently destroyed.
  const inFlightSends = useRef<Set<string>>(new Set());
  const sendFailures = useRef<Record<string, number>>({});
  // In-flight spawn guard so a re-render / StrictMode double-mount can't spawn
  // Michael twice (the window between the listPtys check and spawnPty is racy).
  const godSpawning = useRef(false);
  // Per-agent timestamp until which auto-typers (inbox-wake #3, queue-drain #4)
  // must leave the agent alone — set while its boot sequence is typing so nothing
  // collides with /remote-control + the orientation prompt.
  const bootGraceUntil = useRef<Record<string, number>>({});
  // Agents whose one-time TUI protocol seed (Crush, seedDelivery:'type-into-tui')
  // has already been typed — guards effect #3b against re-seeding. (ondev-b)
  const seeded = useRef<Set<string>>(new Set());
  const seenTerminalHandoffs = useRef<Set<string>>(new Set());
  // Per-pty timestamp guarding auto-revive (effect #7) against a double-respawn
  // when power-resume + screen-unlock arrive back-to-back: an id revived (or
  // mid-revive) within REVIVE_DEBOUNCE_MS is skipped. Set BEFORE the async spawn
  // so a re-entrant event can't race a second respawn for the same id.
  const reviving = useRef<Record<string, number>>({});
  // Reactive so the assistant bootstrap (effect #1b) re-runs once Michael is ready.
  const godStatus = useStore((s) => s.godStatus);
  // Per-pty `lastOutputAt`, refreshed by the quiescence sweep (#2e) and read by
  // the queue drain (#4) so it can tell a terminal parked at its prompt from one
  // mid-turn. Kept here rather than fetched again in #4 — #2e already polls
  // listPtys on exactly the cadence the drain needs, and one reading keeps the
  // two loops from disagreeing about whether an agent is quiet.
  const ptyLastOutput = useRef<Record<string, number>>({});
  // #5C/#7C.4 — latest circuit-breaker level per agent. When 'constrained'/
  // 'stopped' the avatar is pinned to 'looping' and hook events must NOT flip it
  // back to 'working' (the flicker the spec calls out); only a genuine Stop clears it.
  const breakerLevel = useRef<Record<string, string>>({});

  // 0) Heal roster `description` from hive `role` when the floor caption was
  //    overwritten by a status string ("on standby") after hire.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    void window.cth.hiveRegistry().then((reg) => {
      const roles: Record<string, string> = {};
      for (const [id, entry] of Object.entries(reg.agents ?? {})) {
        if (typeof entry.role === 'string' && entry.role.trim()) roles[id] = entry.role.trim();
      }
      useStore.getState().syncDescriptionsFromRoles(roles);
      const { agents, archivedAgents } = useStore.getState();
      for (const a of [...agents, ...archivedAgents]) {
        const next = preferredAgentRole(a.description, roles[a.id], !!a.isGod);
        if (isDurableRole(next) && next !== roles[a.id]) {
          void window.cth.hivePatchAgentRole(a.id, next);
        }
      }
    }).catch(() => { /* hive not ready yet */ });
  }, [config?.onboardingComplete]);

  // 1) Bootstrap the god agent (source of truth = live PTYs, to dodge restarts).
  useEffect(() => {
    if (!config?.onboardingComplete || !config.harnessHome) return;
    let cancelled = false;
    useStore.getState().setGodStatus('booting');
    const t = setTimeout(async () => {
      if (cancelled) return;
      const live = await window.cth.listPtys().catch(() => []);
      if (live.some((p) => p.id === GOD_PTY)) { // already running — keep restored entry
        if (!cancelled) useStore.getState().setGodStatus('ready');
        return;
      }
      // Synchronous guard (no await between check and set) → exactly one spawn.
      if (cancelled || godSpawning.current) return;
      godSpawning.current = true;
      useStore.getState().removeAgent(GOD_ID); // clear any stale restored entry

      const godProvider = config.godProvider ?? 'claude';
      const godModel = config.godModel;
      const command = buildSpawnCommand(config, godModel, godProvider);
      const [exe, ...args] = tokenizeCommand(command.trim());
      const res = await window.cth.spawnPty({
        id: GOD_PTY,
        cwd: config.harnessHome!,
        command: exe,
        provider: godProvider,
        args,
        cols: 100,
        rows: 30,
        // Restore Michael's prior conversation across an app restart. His session
        // id lives in the hive registry (recorded from his hooks), so the main
        // process attaches `--resume <id>`; a missing transcript falls back to a
        // fresh session. Without this the most important context on the floor —
        // the orchestrator's — was lost on every restart.
        resume: true,
        hive: { id: GOD_ID, name: 'Michael', provider: godProvider, cwd: config.harnessHome!, isGod: true, role: 'orchestrator (god)' }
      });
      if (cancelled) { godSpawning.current = false; return; }
      if (!res.ok) { godSpawning.current = false; useStore.getState().setGodStatus('failed'); return; }
      const god: Agent = {
        id: GOD_ID,
        name: 'Michael',
        character: 'michael',
        accent: 'lemon',
        description: 'god — runs the floor, triages requests, escalates only critical calls to you',
        project: 'hive',
        tmuxTarget: '',
        cwd: config.harnessHome!,
        status: 'idle',
        action: 'running the floor',
        progress: 0,
        currentStation: 'desk',
        ptyId: GOD_PTY,
        command: command.trim(),
        provider: godProvider,
        model: godModel,
        isGod: true,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(god);
      useStore.getState().setGodStatus('ready');

      // Kick Michael off once his TUI is up. Always re-enable remote control so
      // the human can approve permission prompts from their phone (best-effort — a
      // failed/unknown slash command just prints to his terminal and is harmless).
      // Then, ONLY on a genuinely fresh spawn, hand him the orientation prompt —
      // a RESUMED Michael already has his full context and must not be re-oriented
      // mid-thread (that would reset the floor's situational awareness). Both go
      // through the per-pty submit chain, so they're strictly sequential and can't
      // jam together; the boot-grace window keeps the inbox-wake/drain loops off
      // Michael until he's settled. The live-PTY branch above skips this entirely.
      const resumedGod = res.resumed === true;
      bootGraceUntil.current[GOD_ID] = Date.now() + BOOT_GRACE_MS;
      void (async () => {
        try {
          const remoteCommand = remoteControlCommandForProvider(godProvider, 'Michael');
          if (remoteCommand) {
            // settleMs pauses the chain ~1.5s after /remote-control before the
            // orientation prompt (fresh spawns only) is submitted next.
            await submitBootPrompt(GOD_ID, remoteCommand, REMOTE_CONTROL_SETTLE_MS);
          }
          if (!cancelled && !resumedGod) {
            // A type-into-tui god (Crush) can't ride its hive protocol on argv, so the
            // main process hands it back as seedPrompt — type it FIRST (identity), then
            // the orientation kick. Serialized by main's submit owner so they can't jam. (ondev-b)
            if (res.seedPrompt) await submitBootPrompt(GOD_ID, res.seedPrompt);
            await submitBootPrompt(GOD_ID, INITIAL_GOD_PROMPT);
          }
        } catch { /* PTY may have died during startup */ }
        finally { bootGraceUntil.current[GOD_ID] = 0; }
      })();
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [config?.onboardingComplete, config?.harnessHome]);

  // 2) Drive avatars from real hook events emitted by each agent's shim.
  useEffect(() => {
    return window.cth.onHiveHookEvent((e) => {
      if (!e.agentId) return;
      const { updateAgent, agents } = useStore.getState();
      const self = agents.find((a) => a.id === e.agentId);
      if (!self) return;
      // Breaker precedence (#5C): a constrained/stopped agent stays 'looping'
      // regardless of in-flight tool/prompt/compact events.
      const blevel = breakerLevel.current[e.agentId];
      const breakerArmed = blevel === 'constrained' || blevel === 'stopped';
      // Hook events are the authoritative status source for real agents (the
      // pty-stream parser only refines the on-floor action/station).
      if (e.event === 'PreCompact') {
        // #5C — agent entered /compact; show it's boxing up context, not frozen.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'compacting', action: 'compacting context', carrying: undefined });
      } else if (e.event === 'PostCompact') {
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'resumed', carrying: undefined });
      } else if (e.event === 'PreToolUse' && e.tool) {
        const m = stationForTool(e.tool);
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', currentStation: m.station, carrying: m.carry, action: `using ${e.tool}` });
        useStore.getState().bumpToolCount(e.agentId); // usage proxy for the command center
      } else if (e.event === 'PostToolUse' || e.event === 'UserPromptSubmit') {
        // A turn is in progress (prompt submitted / tool just finished) — keep
        // it working so it doesn't flicker idle between tool calls.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working' });
      } else if (e.event === 'PreInvocation') {
        // Antigravity (agy): the model is being called — it's thinking/working.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'thinking' });
      } else if (e.event === 'PostInvocation') {
        // agy's per-turn boundary. Unlike Claude, agy's Stop fires only on process
        // EXIT, so without this an agy worker would never register as idle and the
        // inbox-wake nudge (idle-only) could never reach it — its mail would sit
        // undrained. Treat it as idle; a follow-up tool/turn re-sets working.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {
        // A blocked Stop means the agent is being re-engaged to process its
        // inbox — it's NOT idle, so keep it working until it genuinely stops.
        if (e.blocked) {
          if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'reading inbox', carrying: undefined });
        } else {
          // A genuine stop clears any breaker override — the run is over.
          breakerLevel.current[e.agentId] = 'healthy';
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      } else if (e.event === 'Notification' && !breakerArmed) {
        // Claude Code fires Notification for two very different situations:
        //   1. it genuinely needs the human (a permission / approval prompt), or
        //   2. the prompt has merely gone idle ("Claude is waiting for your
        //      input") — i.e. the agent answered and has nothing queued.
        // Only (1) is a real "needs you". Treating (2) as blocked made Michael
        // march to the door with a red "!" right after finishing, so detect the
        // idle case and let him linger on the floor instead.
        const msg = (e.message ?? '').toLowerCase();
        const idleWaiting = !msg
          || msg.includes('waiting for your input')
          || msg.includes('is idle')
          || msg.includes('waiting for input');
        const needsHuman = msg.includes('permission')
          || msg.includes('approve')
          || msg.includes('confirm')
          || msg.includes('needs your');
        if (needsHuman && !idleWaiting) {
          // Only the god agent escalates to the human; sub-agents are autonomous
          // and read as "waiting" (parked on god, not on you).
          updateAgent(e.agentId, { status: self.isGod ? 'blocked' : 'waiting' });
        } else {
          // Idle notification — responded, nothing to do. Linger, don't flag.
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    });
  }, []);

  // 2b) Consume circuit-breaker state (#7C.4/#5C). Lane A's breaker policy (#6)
  //     pushes BreakerState on `control:breakerState`; this gives it PRECEDENCE
  //     over hook-derived status: a constrained/stopped agent is pinned to
  //     'looping' (see the breakerArmed guard above) until it genuinely Stops.
  useEffect(() => {
    return window.cth.onBreakerState((s) => {
      breakerLevel.current[s.agentId] = s.level;
      const { updateAgent, agents } = useStore.getState();
      if (!agents.some((a) => a.id === s.agentId)) return;
      if (s.level === 'constrained' || s.level === 'stopped') {
        updateAgent(s.agentId, { status: 'looping', action: s.reason || 'breaker armed', carrying: undefined });
      }
      // 'healthy'/'steering' clear the pin; the next hook event refreshes status.
    });
  }, []);

  // 2c) Context gauge backfill: poll each live agent's current context size
  //     (tokens) from its session transcript — only until the status line
  //     (effect 2d) has delivered exact numbers for that agent.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const poll = async () => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId) continue;
        // The status line pushes exact numbers after every response (effect
        // 2d) — this transcript poll only backfills agents whose status line
        // hasn't fired yet (e.g. freshly restored, no response so far).
        if (a.contextLimit !== undefined) continue;
        try {
          const ctx = await window.cth.agentContext(a.id);
          if (ctx === null) continue;
          const hinted = /1m/i.test(a.model ?? '') ? 1_000_000 : 200_000;
          const limit = Math.max(hinted, ctx > 200_000 ? 1_000_000 : 0);
          const progress = Math.max(0, Math.min(8, Math.round((ctx / limit) * 8)));
          updateAgent(a.id, { contextTokens: ctx, progress });
        } catch { /* ignore — try again next tick */ }
      }
    };
    const t = setTimeout(poll, 3000); // first fill shortly after boot
    const iv = setInterval(poll, 15000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 2d) Push-based context gauge: the status-line shim forwards the session's
  //     EXACT context accounting (tokens + real window size) after every
  //     response — no probing, no transcript guesswork.
  useEffect(() => {
    return window.cth.onHiveContextUpdate(({ agentId, tokens, limit }) => {
      // Defense-in-depth: the main process already filters limit > 0, but the
      // renderer must not trust IPC blindly — limit 0 would put NaN progress
      // into the store (NaN survives the Math.min/max clamp).
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(tokens)) return;
      const progress = Math.max(0, Math.min(8, Math.round((tokens / limit) * 8)));
      useStore.getState().updateAgent(agentId, { contextTokens: tokens, contextLimit: limit, progress });
    });
  }, []);

  // 2e) Non-Claude providers cannot drain hive inbox. Direct hive mail to them
  //     arrives here as a terminal work order and is queued through the same
  //     idle-only PTY drain as human-composed messages.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveTerminalHandoff((msg) => {
      if (seenTerminalHandoffs.current.has(msg.id)) return;
      const { agents, enqueueMessage, messageQueues } = useStore.getState();
      const target = agents.find((a) => a.id === msg.to);
      if (target?.ptyId) {
        const marker = `Message: ${msg.id}`;
        if ((messageQueues[target.id] ?? []).some((queued) => queued.text.includes(marker))) return;
        seenTerminalHandoffs.current.add(msg.id);
        enqueueMessage(target.id, terminalWorkOrderPrompt(msg));
        return;
      }
      seenTerminalHandoffs.current.add(msg.id);
      enqueueMessage(
        GOD_ID,
        [
          `Terminal handoff failed for ${msg.to}: ${msg.subject}`,
          '',
          `Message ${msg.id} from ${msg.from} could not be queued because ${msg.to} has no live PTY. Route it manually or respawn the agent.`
        ].join('\n')
      );
    });
  }, [config?.onboardingComplete]);

  // 2e) PROVIDER-AGNOSTIC PTY-QUIESCENCE IDLE FALLBACK (the linchpin that makes
  //     canReceiveInbox:true safe for the live-unverified OpenCode/Crush/pi bridges).
  //     Hook events are the authoritative status source, but a bridge whose turn-end
  //     signal (Stop/session.idle/agent_end) doesn't fire leaves the agent pinned
  //     'working' — and BOTH delivery paths (#3 nudge, #4 queue-drain) are idle-gated,
  //     so the agent silently stops draining mail. usePtyParser has a 4s idle drift,
  //     but it's Claude-TUI-tuned AND only runs for the mounted terminal — a
  //     backgrounded god gets none. This is the floor-wide, provider-agnostic backstop:
  //     it reads each live PTY's lastOutputAt (already tracked in the main process) and
  //     flips any 'working' agent quiet for QUIESCE_IDLE_MS to idle so the nudge can
  //     drain it. Safe because a genuinely-working agent (incl. a long streaming tool)
  //     keeps emitting bytes; a false idle self-corrects on the next hook event.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const ptys = await window.cth.listPtys().catch(() => []);
      const lastOut: Record<string, number> = {};
      for (const p of ptys) lastOut[p.id] = p.lastOutputAt;
      // Publish BEFORE the early return and before the 'working' filter below,
      // so the drain (#4) also gets a reading for breaker-pinned agents — and so
      // a vanished PTY clears its entry instead of leaving a stale one.
      ptyLastOutput.current = lastOut;
      if (!ptys.length) return;
      const now = Date.now();
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId || a.status !== 'working') continue;
        // Never fight the breaker pin (a constrained/stopped agent stays 'looping')
        // or a still-booting agent (its boot sequence is mid-type).
        const bl = breakerLevel.current[a.id];
        if (bl === 'constrained' || bl === 'stopped') continue;
        if ((bootGraceUntil.current[a.id] ?? 0) > now) continue;
        const last = lastOut[a.ptyId];
        if (typeof last === 'number' && last > 0 && now - last > QUIESCE_IDLE_MS) {
          updateAgent(a.id, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    }, QUIESCE_POLL_MS);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 3) REMOVED (pre-M1 event-wake bridge). The renderer no longer produces inbox-wake
  //    prompts: main is the ONLY producer. A durable delivery, a Stop / idle edge, a
  //    control release or main's reconciliation beat asks main's inbox-wake bridge,
  //    which submits one CAPACITY_GATED wake through the submit owner under a stable
  //    request id. A renderer copy would enqueue a second wake for the same inbox edge
  //    under a different id, which the owner can serialize but cannot recognise as a
  //    duplicate. Ordinary queued messages still drain through effect #4.

  // 3b) Seed a fresh "type-into-tui" worker (Crush) with the hive protocol. Its
  //     bare TUI rejects a positional seed (Cobra reads it as a subcommand →
  //     `Unknown command`), so the main process spawns it bare and hands the
  //     protocol back as `seedPrompt`; we TYPE it as the worker's first turn after a
  //     boot-grace (TUI finished painting), ONCE per agent. Routed through the SAME
  //     per-pty submit chain + boot-grace as the inbox-wake nudge so the seed and a
  //     nudge can never jam onto one line. (god-as-Crush is seeded in its own boot
  //     sequence above; this covers workers.) (ondev-b)
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(() => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId || a.isGod || !a.seedPrompt || seeded.current.has(a.id)) continue;
        seeded.current.add(a.id);
        const ptyId = a.ptyId;
        const seed = a.seedPrompt;
        // Hold the nudge/quiesce typers off this agent until the seed lands + settles.
        bootGraceUntil.current[a.id] = Date.now() + BOOT_GRACE_MS;
        // Clear the record now so it isn't re-seen (the ref also guards) or persisted.
        updateAgent(a.id, { seedPrompt: undefined });
        setTimeout(() => {
          // Permission-prompt safety (#5): if the worker surfaced an approval /
          // needs-human prompt while its TUI booted ('waiting'/'blocked'), the
          // seed's trailing Enter would confirm it. Put the seed back and let a
          // later tick retry once the prompt clears; if the agent vanished
          // (killed mid-boot), don't type into its orphaned pty at all.
          const live = useStore.getState().agents.find((x) => x.id === a.id);
          if (!live) return;
          if (live.status === 'waiting' || live.status === 'blocked') {
            seeded.current.delete(a.id);
            useStore.getState().updateAgent(a.id, { seedPrompt: seed });
            return;
          }
          submitBootPrompt(live.id, withStandingGoal(live, seed))
            .catch(() => { /* pty may have died */ });
        }, SEED_BOOT_MS);
      }
    }, 1500);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 4) Drain each agent's queued messages to its terminal, one at a time, the
  //    moment the agent goes idle. This is what lets the user keep sending
  //    messages while the agent's "cloud terminal" is mid-run: the messages
  //    park in the store and get typed in (and submitted) as soon as it's free.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const FLUSH_COOLDOWN_MS = 4500;
    // A message that fails this many PTY writes (dead/crashed pty that the store
    // still thinks is idle) is dropped WITH a console.warn — bounded so the drain
    // never spins forever on a corpse, loud so the loss is diagnosable. (#113)
    const MAX_SEND_ATTEMPTS = 3;
    const inFlight = new Set<string>();
    const sendFailures: Record<string, number> = {};

    /** How long this terminal has been silent, or null when we have no reading
     *  (never polled, PTY gone, or it has emitted nothing at all). canDeliverToAgent
     *  fails closed on null — unmeasured silence is not evidence of silence. */
    const ptyQuietMs = (ptyId: string, now: number): number | null => {
      const last = ptyLastOutput.current[ptyId];
      return typeof last === 'number' && last > 0 ? now - last : null;
    };

    // Send the front of `srcId`'s queue into `target`'s pty (verbatim or wrapped),
    // gated on the target being idle, free of interactive menus, and off
    // cooldown. The queue item is acknowledged only after BOTH PTY writes
    // succeed; failures stay visible and retry automatically (bounded by
    // MAX_SEND_ATTEMPTS so the drain never spins forever on a corpse).
    const dispatch = async (
      srcId: string,
      target: Agent | undefined,
      wrap?: (m: QueuedMessage) => string
    ): Promise<{ sent: boolean; message?: QueuedMessage }> => {
      const { messageQueues, removeQueuedMessage } = useStore.getState();
      const next = messageQueues[srcId]?.[0];
      if (!next || !target?.ptyId) return { sent: false };
      const now = Date.now();
      // Idle, or breaker-pinned with a terminal that has genuinely gone quiet.
      // This gate is a don't-type-mid-stream safety check, so `manual` does NOT
      // bypass it — "send now" releases the auto-delivery PAUSE below, not this.
      if (!canDeliverToAgent(target.status, ptyQuietMs(target.ptyId, now), QUIESCE_IDLE_MS)) {
        return { sent: false };
      }
      const control = await window.cth.controlSnapshot(target.id);
      // The pause gate holds everything EXCEPT messages the user explicitly
      // released with "send now" (m.manual) — otherwise a paused floor leaves
      // the queue with no escape hatch at all. Idle/draft/picker safety below
      // still applies to manual messages; only the pause is bypassed.
      if (control?.autoDeliveryPaused && !next.manual) return { sent: false };
      // Provider capacity refuses an automatic turn on this agent's pool. MAIN
      // decides this — the flag arrives computed and is never derived here — and the
      // message stays at the head of the queue: this early return costs no send
      // attempt, so a limited provider delays work instead of destroying it. `manual`
      // bypasses it for the same reason it bypasses the pause: a person pressing
      // "send now" is not an automatic start.
      if (control?.capacityHold && !next.manual) return { sent: false };
      // Hold queued messages until the target finishes its boot sequence.
      if ((bootGraceUntil.current[target.id] ?? 0) >= now) return { sent: false };
      // The user owns the prompt: a draft they are writing, or a menu they
      // opened, holds delivery. Both blocks expire after half an hour, and when
      // one does we simply type after whatever is there — automation never
      // erases the user's text and never closes the user's menu.
      if (!isTerminalAutomationSafe(target.ptyId, now)) return { sent: false };
      if (now - (lastFlush.current[target.id] ?? 0) < FLUSH_COOLDOWN_MS) return { sent: false };
      // Last gate before we type: re-check the message's delivery-time
      // precondition. A queue item is decided at enqueue time and delivered an
      // arbitrary interval later, and the inbox nudge is only worth sending if
      // there is still something in the inbox — the agent routinely drains it in
      // the very turn the nudge was queued from. Stale ones are DROPPED, not
      // deferred, so they cannot park at the queue head and starve the rest.
      if (await checkPrecondition(next, () => window.cth.hiveInbox(srcId)) === 'drop') {
        removeQueuedMessage(srcId, next.id);
        return { sent: false };
      }
      const flightKey = `${srcId}:${next.id}`;
      if (inFlight.has(flightKey)) return { sent: false };
      inFlight.add(flightKey);
      lastFlush.current[target.id] = now;
      try {
        // MAIN DELIVERS; this only asks. `manual` ("send now") is USER_RELEASED: a person
        // asked for it, so main does not ask capacity — it still serializes, still
        // revalidates immediately before Enter, and still stops on human interference.
        // Everything else is CAPACITY_GATED and gets main's full fail-closed gate.
        //
        // The request id is the queue item's OWN id, stable for as long as the item lives.
        // Main delivers an id AT MOST ONCE: a refusal frees it for the next ask, a COMMIT
        // is remembered — so a reload between main's Enter and this acknowledgement can
        // no longer type the message twice.
        let outcome: AutoSubmitOutcome;
        try {
          outcome = await window.cth.autoSubmit({
            requestId: `queue:${srcId}:${next.id}`,
            agentId: target.id,
            admissionClass: next.manual ? 'USER_RELEASED' : 'CAPACITY_GATED',
            // `instruction` (when present) is the authoritative text to type into
            // the PTY; UI/card surfaces continue to show the readable `text`.
            text: withStandingGoal(target, wrap ? wrap(next) : (next.instruction ?? next.text))
          });
        } catch (e) {
          outcome = { kind: 'FAILED', reason: `ipc: ${String(e)}` };
        }
        const sent = await deliverWithAcknowledgement(
          async () => { if (outcome.kind !== 'COMMITTED') throw new Error(outcome.kind); },
          () => {
            removeQueuedMessage(srcId, next.id);
            // Zero the gauge on a DELIVERED /clear — the new session's context
            // isn't known until statusLine fires after the first post-clear
            // response, so leaving it at the old value shows a stale-full bar.
            if (next.text.trim().toLowerCase() === '/clear') {
              useStore.getState().updateAgent(target.id, {
                contextTokens: 0,
                contextLimit: undefined,
                progress: 0
              });
            }
          }
        );
        if (sent) {
          delete sendFailures[next.id];
          return { sent: true, message: next };
        }
        // NOT DELIVERED, AND NOTHING OF OURS IS ON THE PROMPT (REFUSED / ABORTED): main
        // declined before typing, or typed and verifiably erased. That is "not now", not
        // a failure — capacity held it, a human owns the line, the terminal cannot be
        // proven safe — so the item simply stays queued and costs no send attempt.
        if (outcome.kind === 'REFUSED' || outcome.kind === 'ABORTED') return { sent: false };
        // HUMAN_HANDLED: a person resolved an INTERFERED hold on THIS message with "already
        // handled - drop". Main recorded that against the id; it is never typed again. The
        // composer normally removes the row itself - this is the backstop for a copy that
        // was asked for again before it did. It is not a delivery: no send side-effects.
        if (outcome.kind === 'HUMAN_HANDLED') {
          delete sendFailures[next.id];
          removeQueuedMessage(srcId, next.id);
          console.warn(`[queue-drain] message ${next.id} for ${target.id} dropped: a person marked it already handled`);
          return { sent: false };
        }
        // INTERFERED: a human wrote onto our staged text. Main sent no Enter and cleared
        // nothing, and it now refuses automatic delivery to that terminal until a human
        // resolves it. The item is HELD — never retried into the prompt, never dropped.
        // It is SHOWN as held by the composer, which reads the hold from main's control
        // snapshot (`interfered`) rather than from a flag kept here: main owns the hold,
        // and a copy in this window would outlive the terminal it was raised on.
        if (outcome.kind === 'INTERFERED') {
          console.warn(`[queue-drain] message ${next.id} for ${target.id} is HELD: a human typed after it was staged (${outcome.reason})`);
          return { sent: false };
        }
        // FAILED / REJECTED: the terminal died under the message, or the request was
        // malformed. Retry on the next cooldown-spaced flush, but only MAX_SEND_ATTEMPTS
        // times — then drop LOUDLY so the loss is diagnosable. (#113/#36)
        const attempts = (sendFailures[next.id] ?? 0) + 1;
        sendFailures[next.id] = attempts;
        if (attempts >= MAX_SEND_ATTEMPTS) {
          delete sendFailures[next.id];
          removeQueuedMessage(srcId, next.id);
          console.warn(
            `[queue-drain] dropping message ${next.id} for ${target.id} after ${attempts} failed deliveries ` +
            `("${next.text.slice(0, 80)}${next.text.length > 80 ? '…' : ''}")`
          );
        }
        return { sent: false };
      } finally {
        inFlight.delete(flightKey);
      }
    };

    // Promote a genuine Slack-origin work item to a stamped kanban card the first
    // time it's dispatched to the office. The card carries slack:{channel,thread_ts}
    // (origin thread) so the main-process done-observer can post its one summary
    // reply in-thread once the card later reaches 'done'. ADDITIVE + idempotent +
    // best-effort: a failure here never affects the dispatch that already happened,
    // and only dispatched work items land here (slash commands/acks never do).
    type SlackTaskCard = Parameters<typeof window.cth.hiveAddTask>[0];
    const ensureSlackCard = async (m: QueuedMessage): Promise<void> => {
      const slack = m.slack;
      if (!slack) return;
      try {
        const raw = await window.cth.hiveTasks();
        const existing: SlackTaskCard[] =
          raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
            ? (raw as { tasks: SlackTaskCard[] }).tasks
            : [];
        const id = `slack-${slack.thread_ts}-${m.id}`;
        if (existing.some((t) => t.id === id)) return; // already promoted — no dup
        const title = m.text.length > 80 ? `${m.text.slice(0, 79)}…` : m.text;
        const card: SlackTaskCard = {
          id,
          title,
          description: m.text,
          status: 'todo',
          dependsOn: [],
          priority: 1,
          createdAt: new Date().toISOString(),
          slack
        };
        await window.cth.hiveAddTask(card);
      } catch { /* best-effort: card promotion must never sink dispatch */ }
    };

    const flush = () => {
      const { agents, messageQueues } = useStore.getState();
      const byId = (id: string) => agents.find((a) => a.id === id);
      const now = Date.now();

      for (const a of agents) {
        // Same gate as dispatch() — this pre-filter runs first, so relaxing only
        // the one inside dispatch would have changed nothing.
        if (!a.ptyId || !canDeliverToAgent(a.status, ptyQuietMs(a.ptyId, now), QUIESCE_IDLE_MS)) continue;
        if (!messageQueues[a.id]?.length) continue;
        void dispatch(a.id, a).then(({ sent, message }) => {
          if (sent && message?.slack) void ensureSlackCard(message);
        });
      }
    };

    // Run on every store change (status flips, new queue items) — debounced so a
    // burst of pty-stream updates coalesces — plus a periodic backstop.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; flush(); }, 200);
    };
    const unsub = useStore.subscribe(schedule);
    const iv = setInterval(flush, 3000);
    schedule();
    return () => { unsub(); if (debounce) clearTimeout(debounce); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 5) Pipe inbound Slack messages into Michael's queue. The main-process Slack
  //    webhook server pushes each verified message here via IPC; enqueueing to
  //    GOD_ID lands it in Michael's queue exactly as if the user had typed it
  //    into the composer — effect #4 above then drains it to his PTY.
  //    We immediately ack in the triggering thread and stash the thread coords
  //    so the office can post its summary back later.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onSlackMessage((msg) => {
      const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
      if (!msg?.text?.trim() && !hasFiles) return;
      let text = msg.text.trim();
      // Append local file paths so the agent (Claude Code) can Read them directly.
      if (hasFiles) {
        const fileLines = msg.files!.map((f) => `- ${f.path} (${f.name})`).join('\n');
        text = text ? `${text}\n\nAttached files:\n${fileLines}` : `Attached files:\n${fileLines}`;
      }
      const slack = { channel: msg.channel, thread_ts: msg.thread_ts };
      // `text` (raw user request + any attachment lines) drives the human-facing
      // kanban card title/description. The autonomy preamble — supplied verbatim
      // by main, the authoritative source — is prepended ONLY to god's working
      // instruction (what gets typed into his PTY), so the board stays readable
      // while every Slack-origin god-session runs under the autonomy policy. When
      // main sends no preamble (older build), god just gets the raw text.
      const instruction = msg.autonomyPreamble ? `${msg.autonomyPreamble}${text}` : undefined;
      useStore.getState().enqueueMessage(GOD_ID, text, { slack, instruction });
      // Immediate "queued" acknowledgement in the originating Slack thread.
      void window.cth.slackReply({
        channel: msg.channel,
        thread_ts: msg.thread_ts,
        text: ':hourglass_flowing_sand: *Received.* Your request has been queued — the team is on it and will reply here when done.'
      });
    });
  }, [config?.onboardingComplete]);

  // 5b) Pipe hive tasks addressed to non-Claude agents (e.g. Codex) into their
  //     terminal queues. When main routes a message to a non-claude provider it
  //     emits 'hive:enqueueToAgent' instead of bouncing; we enqueue the raw
  //     task text here so effect #4 types it into the REPL when the agent idles.
  //     No inbox nudge, no /compact — just the verbatim subject+body text.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveEnqueue?.((msg) => {
      if (!msg?.targetId || !msg?.text?.trim()) return;
      useStore.getState().enqueueMessage(msg.targetId, msg.text.trim());
    });
  }, [config?.onboardingComplete]);

  // 5b) MAIN-initiated roster changes (rt-5 voice spawn/kill). The renderer store is
  //     only mutated by renderer-initiated hires (AddAgentModal); a voice hire/kill
  //     runs in MAIN (spawnAgentCore / teardownPty, owner=null) and would otherwise
  //     be invisible on the floor. Main broadcasts; we build/archive the card here.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const offSpawn = window.cth.onHiveAgentSpawned?.((rec) => {
      if (!rec?.id) return;
      // addAgent is idempotent, but bail early if the renderer already carded it.
      if (useStore.getState().agents.some((a) => a.id === rec.id)) return;
      // An explicit character wins; otherwise infer it from the name, which is
      // what makes "spawn one called Meredith" land on the Meredith avatar with
      // nothing else asked for. The explicit field covers what inference cannot
      // express: an agent named something else that should still look like a
      // particular character. Unknown values fall through to the inference rather
      // than breaking the card.
      const castMember = (q?: string) =>
        q ? OFFICE_CAST.find((m) => m.name === q || m.displayName.toLowerCase() === q)?.name : undefined;
      const character =
        castMember(rec.character?.trim().toLowerCase()) ??
        castMember((rec.name || rec.id).toLowerCase()) ??
        DEFAULT_CHARACTER;
      // Accent is otherwise hashed from the worker id, which is stable but not
      // choosable. An unrecognised accent keeps the hash.
      const askedAccent = SPAWN_ACCENTS.find((a) => a === rec.accent?.trim().toLowerCase());
      let h = 0;
      for (const ch of rec.id) h = (h + ch.charCodeAt(0)) % SPAWN_ACCENTS.length;
      const project = (rec.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'hive';
      const agent: Agent = {
        id: rec.id,
        name: rec.name || rec.id,
        character,
        accent: askedAccent ?? SPAWN_ACCENTS[h],
        description: rec.role || 'a fresh harness',
        project,
        tmuxTarget: '',
        cwd: rec.cwd,
        status: 'idle',
        action: 'starting up',
        progress: 0,
        currentStation: 'desk',
        ptyId: rec.id,
        command: rec.command,
        provider: rec.provider as Agent['provider'],
        isGod: false,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(agent);
    });
    const offArchive = window.cth.onHiveAgentArchived?.((e) => {
      if (e?.id) useStore.getState().archiveAgent(e.id);
    });
    return () => { offSpawn?.(); offArchive?.(); };
  }, [config?.onboardingComplete]);

  // 5c) v0.3.4 voice bridge: main stages queue insertions (clear_context) and
  //     pushes them here, so delivery rides EVERY existing gate — idle-only,
  //     boot grace, draft/picker safety, auto-delivery pause. Main owns the
  //     confirm policy; this is just the enqueue.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onRealtimeEnqueue?.((evt) => {
      if (!evt?.agentId || typeof evt.text !== 'string' || !evt.text.trim()) return;
      const { agents, enqueueMessage } = useStore.getState();
      if (!agents.some((a) => a.id === evt.agentId)) return;
      enqueueMessage(evt.agentId, evt.text.trim());
    });
  }, [config?.onboardingComplete]);

  // 6) CONTEXT TRIGGERS (compact / clear). Main decides WHEN — cadence, and which
  //    half of the rule fired — and pushes `{action, rule}`; this decides WHO, then
  //    queues the provider's own command so the drain (#4) delivers it only at an
  //    idle prompt, never jamming a working terminal.
  //
  //    THE PRESSURE GATE. main/config.ts has long DOCUMENTED that auto-compact
  //    "only compacts agents whose context has filled past a threshold (30% for
  //    ~250k windows, 20% for ~1M windows)". No such check was ever implemented:
  //    every live agent with a resolvable command got compacted on every tick,
  //    hourly, however empty its window was. This makes the documented behaviour
  //    real — `rule.minContextPct`, or `minContextPctLargeWindow` once the window
  //    is >= LARGE_CONTEXT_WINDOW, must be met before an agent is interrupted.
  //    (The shipped bars are now 60/40, twice the stale doc's numbers; see
  //    DEFAULT_CONTEXT_TRIGGER. The doc comment in config.ts is still stale.)
  //
  //    Dedupe generalises to both actions: keyed on the command's own verb, so a
  //    queued `/compact` blocks a second compact without blocking a `/clear`.
  useEffect(() => {
    if (!config?.onboardingComplete) return;

    const fire = (action: 'compact' | 'clear', rule: ContextRule): void => {
      const { agents, messageQueues, enqueueMessage } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId) continue;
        const provider = inferAgentProvider(a.command, a.provider);
        const command = action === 'clear'
          ? clearCommandForProvider(provider, rule.message)
          : compactionCommandForProvider(provider, rule.message);
        // No trustworthy command for this CLI (Crush's palette-only TUI, Copilot's
        // print mode, an unknown custom binary) — leave its terminal alone.
        if (!command) continue;
        if (!passesContextPressure(a, rule)) continue;
        const verb = command.trimStart().split(/\s+/)[0];
        const queued = messageQueues[a.id] ?? [];
        if (queued.some((m) => m.text.trimStart().startsWith(verb))) continue;
        // The latch, compact only. `used` reaches this gate from Claude's status
        // line, which only reports after an API call. A /compact on an agent that
        // has done nothing since the last one makes no call at all — Claude refuses
        // it locally with "Not enough messages to compact" — so the count stays
        // byte-identical and the pressure gate passes on the same number the next
        // cycle, and the next. Seen in the wild: /compact every hour for 15 straight
        // hours at exactly 400958 tokens, then 11 more at exactly 221772, each a
        // no-op the agent still had to read and answer. Higher thresholds make it
        // rarer, not absent: any agent parked above its bar repeats forever.
        //
        // So remember the count at the last compact queued and skip while it is
        // byte-identical. Deliberately equality and not "hasn't grown": the rule's
        // thresholds own that decision, and an agent still above them deserves its
        // /compact whether the count moved up or down. A frozen count is the one
        // state those thresholds cannot reason about, because nothing they could do
        // would ever change it. /clear needs no equivalent — the queue drain zeroes
        // the store reading when it lands.
        const used = a.contextTokens ?? 0;
        if (action === 'compact') {
          if (lastCompactUsed.current[a.id] === used) continue;
          lastCompactUsed.current[a.id] = used;
        }
        enqueueMessage(a.id, command);
      }
    };

    // The typed `onContextTrigger` arrives with the main-process/preload change
    // that emits it; access it defensively so this lands independently of that.
    const off = (window.cth as unknown as {
      onContextTrigger?: (
        cb: (p: { action: 'compact' | 'clear'; rule: ContextRule }) => void
      ) => () => void;
    }).onContextTrigger?.((p) => {
      if (!p?.rule) return;
      fire(p.action === 'clear' ? 'clear' : 'compact', p.rule);
    });

    // LEGACY fallback: main still emits the old parameterless auto-compact until
    // it switches over. Treat it as the default compact rule so behaviour is
    // continuous across that landing. Harmless if both fire — the dedupe above
    // drops the duplicate.
    const offLegacy = window.cth.onAutoCompact(
      () => fire('compact', DEFAULT_CONTEXT_TRIGGER.compact)
    );

    return () => { off?.(); offLegacy?.(); };
  }, [config?.onboardingComplete]);

  // 7) Auto-revive wedged PTYs after the Mac sleeps/locks. Kevin's main-process
  //    keepalive catches up its schedules on wake and DETECTS terminals that were
  //    live before sleep but went silent after resume — it reports those ids on
  //    `power:resume`. We respawn EXACTLY those, resuming each agent's prior CLI
  //    session (--resume) so the terminal self-heals instead of the user clicking
  //    "Restart & Continue". This reuses the same resume-spawn flow as that button
  //    (CommandCenterPanel.restartWithModel) and restoreTeam's worktree handling.
  //    Pure addition: an empty `dead[]` is a no-op; healthy PTYs are never touched.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    // Skip an id we revived (or are mid-reviving) within this window — coalesces
    // a resume + unlock that arrive back-to-back (main also coalesces on its side).
    const REVIVE_DEBOUNCE_MS = 8000;

    const revive = async (deadId: string): Promise<void> => {
      const now = Date.now();
      if (now - (reviving.current[deadId] ?? 0) < REVIVE_DEBOUNCE_MS) return;
      reviving.current[deadId] = now; // claim BEFORE any await so re-entry can't double-spawn
      // Only respawn a PTY we actually own; never touch an unknown/healthy id.
      const a = useStore.getState().agents.find((x) => x.ptyId === deadId);
      if (!a) return;
      try {
        const cfg = await window.cth.getConfig();
        // Isolated agents run inside their worktree (a.cwd is the base repo); re-enter
        // it if it still exists, else fall back to the base cwd — same as restoreTeam.
        let cwd = a.cwd;
        if (a.worktreePath && (await window.cth.gitIsRepo(a.worktreePath))) cwd = a.worktreePath;
        await window.cth.killPty(deadId);
        // Soft-reset the pooled xterm in place (no-op if none): re-arm input and
        // clear the stale frame so the revived TUI paints clean — like the button.
        resetTerminal(deadId);
        const provider = inferAgentProvider(a.command, a.provider);
        // Prefer the agent's exact recorded command (same model/flags); fall back to
        // a rebuilt one only if it predates the persisted `command` field.
        const command = (a.command ?? '').trim() || buildSpawnCommand(cfg, a.model, provider);
        const [exe, ...args] = tokenizeCommand(command);
        const hive = a.isGod
          ? { id: a.id, name: a.name, cwd, provider, isGod: true, role: roleForHiveSpawn(a) }
          : a.isAssistant
          ? { id: a.id, name: a.name, cwd, provider, isAssistant: true, role: roleForHiveSpawn(a) }
          : { id: a.id, name: a.name, cwd, provider, role: roleForHiveSpawn(a) };
        // Spawn at the terminal's real grid so the TUI's absolute cursor moves land
        // in the right cells (a size mismatch scatters the redraw).
        const entry = acquireTerminal(deadId);
        let cols = 100, rows = 30;
        try { entry.fit.fit(); cols = entry.term.cols; rows = entry.term.rows; } catch { /* host not sized yet */ }
        const res = await window.cth.spawnPty({
          id: deadId,
          cwd,
          command: exe,
          provider,
          args,
          cols,
          rows,
          // The worktree (if any) already exists on disk — re-enter it, do NOT
          // re-isolate (that conflicts on the existing path/branch).
          isolate: false,
          // Reattach the agent's prior session so no context is lost on revive.
          resume: true,
          hive
        });
        if (res.ok) {
          reviving.current[deadId] = Date.now(); // re-stamp so the debounce covers the spawn
          useStore.getState().updateAgent(a.id, { status: 'idle', action: 'revived after sleep' });
        } else {
          delete reviving.current[deadId]; // let a later power:resume retry it
          console.error('[autorevive] respawn failed for', a.id, res.error);
        }
      } catch (err) {
        delete reviving.current[deadId];
        console.error('[autorevive] respawn threw for', deadId, err);
      }
    };

    return window.cth.onPowerResume?.((e) => {
      const dead = Array.isArray(e?.dead) ? e.dead : [];
      if (!dead.length) return; // healthy wake — nothing wedged, no-op
      for (const id of dead) void revive(id);
    });
  }, [config?.onboardingComplete]);
}
