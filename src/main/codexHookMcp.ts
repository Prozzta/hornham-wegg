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

/**
 * Rebuild a Codex tool hook's payload from the rollout tail.
 *  - turn_id: the newest turn_context / task_started turn (never task_complete: at a tool
 *    hook the turn is running, and a completion is the PREVIOUS turn's).
 *  - PreToolUse: the newest tool call that has no output after it (the pending one).
 *  - PostToolUse: the newest tool output, joined to its call by call_id.
 */
export function rebuildToolHook(tail: string, event: McpHookEvent): RebuiltToolHook {
  const lines = tail.split('\n');
  let turnId: string | undefined;
  const outputs = new Map<string, unknown>();
  let pending: Record<string, unknown> | null = null;
  let newestCall: Record<string, unknown> | null = null;
  const calls = new Map<string, Record<string, unknown>>();
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
      if (!calls.has(callId)) calls.set(callId, p);
      if (!newestCall) newestCall = p;
      if (!pending && !outputs.has(callId)) pending = p;
    }
  }
  if (event === 'PreToolUse') {
    if (!pending) return { turnId, degraded: true };
    return { turnId, toolName: typeof pending.name === 'string' ? pending.name : undefined, toolInput: toolInputOf(pending), callId: pending.call_id as string, degraded: typeof pending.name !== 'string' };
  }
  // PostToolUse runs as soon as the tool returns, and Codex writes the tool's OUTPUT item a
  // moment later (measured on the TUI: absent at the hook). Hooks run in order, so the newest
  // call is the one that just finished: use it, with its output when it is already there.
  const newest = newestCall;
  if (!newest) return { turnId, degraded: true };
  const newestId = newest.call_id as string;
  const response = outputs.get(newestId);
  return {
    turnId,
    toolName: typeof newest.name === 'string' ? newest.name : undefined,
    toolInput: toolInputOf(newest),
    ...(response !== undefined ? { toolResponse: response } : {}),
    callId: newestId,
    degraded: typeof newest.name !== 'string'
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
