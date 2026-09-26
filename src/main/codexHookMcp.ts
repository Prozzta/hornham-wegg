/**
 * HOOK-BROKER P3 (Jim's spike, god's go): Codex's high-volume hooks (PreToolUse/PostToolUse)
 * as `mcp_tool` hooks into the in-app MCP endpoint instead of cold-starting the shim (2
 * processes, ~450 ms each). Measured by the spike: 0 processes, 2-4 ms, 0 model tokens.
 *
 * The catch: an `mcp_tool` hook receives only its STATIC `input` table and `_meta.threadId`,
 * not the hook payload (no tool_name, tool_input, turn_id). Codex has already written the
 * payload to the rollout by the time the hook runs (the pending tool call lands ~25 ms before
 * PreToolUse), so the payload is rebuilt from a bounded rollout tail. What cannot be found is
 * delivered as DEGRADED, and the gates treat that conservatively (hooks.ts).
 *
 * Pure helpers here; the route lives in HookServer.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readTail } from './codexRolloutCapacity';

export const MCP_SERVER_NAME = 'munder_hooks';
export const HIVE_HOOK_TOOL = 'hive_hook';
/** The only events routed through mcp_tool; every other Codex hook keeps the command shim. */
export const MCP_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
export type McpHookEvent = typeof MCP_HOOK_EVENTS[number];
/** The rollout tail read for one hook (the same bound as the lifecycle probe). */
export const MCP_HOOK_TAIL_BYTES = 64 * 1024;

export interface RebuiltToolHook {
  turnId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  callId?: string;
  degraded: boolean;
}

const CALL_TYPES = new Set(['custom_tool_call', 'function_call', 'local_shell_call']);
const OUTPUT_TYPES = new Set(['custom_tool_call_output', 'function_call_output', 'local_shell_call_output']);

function toolInputOf(p: Record<string, unknown>): unknown {
  if (typeof p.input === 'string') return { input: p.input };
  if (typeof p.arguments === 'string') {
    try { return JSON.parse(p.arguments); } catch { return { arguments: p.arguments }; }
  }
  if (p.action !== undefined) return p.action;
  return {};
}

/** The balanced `{...}` starting at `from` (string-aware), or null. */
function objectSpan(src: string, from: number): string | null {
  if (src[from] !== '{') return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return src.slice(from, i + 1);
  }
  return null;
}

const EXEC_COMMAND_CALL = /\btools\s*\.\s*exec_command\s*\(\s*/;

/**
 * A1 (Jim): Codex's `exec` tool is a JS program that calls nested tools, and Codex's COMMAND
 * hooks report each nested `tools.exec_command({cmd})` as tool_name "Bash", tool_input
 * {command: cmd}. Gates and the breaker match on that, so the rebuilt payload must too.
 * Normalised only when the program makes exactly ONE nested call, it is exec_command, and its
 * argument is a plain JSON object with a string `cmd` (so the command is exactly what runs).
 * Anything else (0 or several nested calls, another tool, an alias of `tools`, a computed
 * command) cannot be named honestly: null, and the caller delivers DEGRADED (a gate fails closed).
 */
export function normaliseCodexExec(program: string): { toolName: 'Bash'; toolInput: { command: string } } | null {
  const m = EXEC_COMMAND_CALL.exec(program);
  if (!m) return null;
  const argAt = m.index + m[0].length;
  const span = objectSpan(program, argAt);
  if (!span) return null;
  let arg: unknown;
  try { arg = JSON.parse(span); } catch { return null; }
  const cmd = (arg as { cmd?: unknown } | null)?.cmd;
  if (typeof cmd !== 'string') return null;
  // With the argument taken out, `tools` must appear exactly once (this call): a second nested
  // call, another tool, or an alias (`const t = tools`) is not nameable.
  const rest = program.slice(0, argAt) + program.slice(argAt + span.length);
  if ((rest.match(/\btools\b/g) ?? []).length !== 1) return null;
  return { toolName: 'Bash', toolInput: { command: cmd } };
}

/** The name/input a hook reports for a rollout call, Codex-command-hook compatible. */
function describeCall(p: Record<string, unknown>): { toolName?: string; toolInput: unknown; degraded: boolean } {
  if (typeof p.name !== 'string') return { toolInput: toolInputOf(p), degraded: true };
  if (p.name === 'exec' && typeof p.input === 'string') {
    const n = normaliseCodexExec(p.input);
    return n ? { ...n, degraded: false } : { toolInput: toolInputOf(p), degraded: true };
  }
  return { toolName: p.name, toolInput: toolInputOf(p), degraded: false };
}

/**
 * Rebuild a Codex tool hook's payload from the rollout tail.
 *  - turn_id: the newest turn_context / task_started turn (never task_complete: at a tool
 *    hook the turn is running, and a completion is the PREVIOUS turn's).
 *  - PreToolUse: the newest tool call that has no output after it (the pending one), counted
 *    only within the CURRENT turn: a call an earlier, aborted turn never answered is not pending
 *    (it would make every later PreToolUse ambiguous until it scrolled out; Jim N-P3a).
 *  - PostToolUse: the newest tool output, joined to its call by call_id.
 */
export function rebuildToolHook(tail: string, event: McpHookEvent): RebuiltToolHook {
  const lines = tail.split('\n');
  let turnId: string | undefined;
  const outputs = new Map<string, unknown>();
  let pending: Record<string, unknown> | null = null;
  let newestCall: Record<string, unknown> | null = null;
  /** Calls seen before (newer than) the newest turn marker: this turn's. */
  const turnCalls = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let j: { type?: unknown; payload?: Record<string, unknown> };
    try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload;
    if (!p || typeof p !== 'object') continue;
    if (turnId === undefined) {
      if (j.type === 'turn_context' && typeof p.turn_id === 'string') turnId = p.turn_id;
      else if (j.type === 'event_msg' && p.type === 'task_started' && typeof p.turn_id === 'string') turnId = p.turn_id;
    }
    if (j.type !== 'response_item' || typeof p.type !== 'string') continue;
    const callId = typeof p.call_id === 'string' ? p.call_id : '';
    if (OUTPUT_TYPES.has(p.type) && callId) {
      if (!outputs.has(callId)) outputs.set(callId, p.output);
    } else if (CALL_TYPES.has(p.type) && callId) {
      if (!newestCall) newestCall = p;
      const inTurn = turnId === undefined;
      if (inTurn) turnCalls.add(callId);
      if (!pending && inTurn && !outputs.has(callId)) pending = p;
    }
  }
  if (event === 'PreToolUse') {
    if (!pending) return { turnId, degraded: true };
    // Two or more calls still pending (parallel tool calls): which one this hook is for is not
    // knowable from the rollout, so no name is claimed (a gate then fails closed if active).
    let open = 0;
    for (const id of turnCalls) if (!outputs.has(id)) open += 1;
    if (open >= 2) return { turnId, degraded: true };
    const d = describeCall(pending);
    return d.degraded ? { turnId, degraded: true } : { turnId, toolName: d.toolName, toolInput: d.toolInput, callId: pending.call_id as string, degraded: false };
  }
  // PostToolUse runs as soon as the tool returns, and Codex writes the tool's OUTPUT item a
  // moment later (measured on the TUI: absent at the hook). Hooks run in order, so the newest
  // call is the one that just finished: use it, with its output when it is already there.
  const newest = newestCall;
  if (!newest) return { turnId, degraded: true };
  const newestId = newest.call_id as string;
  const response = outputs.get(newestId);
  const d = describeCall(newest);
  if (d.degraded) return { turnId, degraded: true };
  return {
    turnId,
    toolName: d.toolName,
    toolInput: d.toolInput,
    ...(response !== undefined ? { toolResponse: response } : {}),
    callId: newestId,
    degraded: false
  };
}

/** A per-home cache of threadId -> rollout path (a rollout's file name ends in its thread id). */
export class CodexThreadRollouts {
  private cache = new Map<string, string>();

  find(codexHome: string, threadId: string): string | null {
    if (!/^[0-9a-f-]{8,}$/i.test(threadId)) return null;
    const key = `${codexHome}|${threadId}`;
    const hit = this.cache.get(key);
    if (hit) { try { statSync(hit); return hit; } catch { this.cache.delete(key); } }
    const suffix = `-${threadId}.jsonl`;
    const walk = (dir: string, depth: number): string | null => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return null; }
      // Newest first: sessions/YYYY/MM/DD sort lexically.
      for (const n of names.sort().reverse()) {
        const p = join(dir, n);
        if (n.endsWith(suffix)) return p;
        if (depth < 3 && /^\d+$/.test(n)) { const f = walk(p, depth + 1); if (f) return f; }
      }
      return null;
    };
    const found = walk(join(codexHome, 'sessions'), 0);
    if (found) this.cache.set(key, found);
    return found;
  }

  tail(path: string): string {
    return readTail(path, MCP_HOOK_TAIL_BYTES);
  }
}

/** Seconds a Codex MCP hook may take. A healthy one takes 2-4 ms; this only bounds a server that
 *  is connected but hung. (A server that is DOWN fails open in ~2 s per hook regardless: that is
 *  Codex's MCP client, not this timeout; see the re-listen in hooks.ts.) */
export const MCP_HOOK_TIMEOUT_S = 5;

/** The per-agent Codex config lines for the MCP-routed hooks (TOML). */
export function codexMcpHookToml(url: string, token: string): { server: string; hook: (event: McpHookEvent) => string } {
  return {
    server: `\n[mcp_servers.${MCP_SERVER_NAME}]\nurl = "${url}"\ntool_timeout_sec = ${MCP_HOOK_TIMEOUT_S}\n`,
    hook: (event) => `\n[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "mcp_tool"\nserver = "${MCP_SERVER_NAME}"\ntool = "${HIVE_HOOK_TOOL}"\ninput = { event = "${event}", k = "${token}" }\ntimeout = ${MCP_HOOK_TIMEOUT_S}\n`
  };
}
