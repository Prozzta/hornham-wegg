/**
 * HookServer — the bridge between `claude` lifecycle hooks and the harness.
 *
 * Each spawned agent is launched with `--settings` pointing its hooks at a tiny
 * shim (see HOOK_SHIM in hive.ts) that forwards the hook payload to the Unix
 * domain socket this server listens on. We then:
 *   - drive avatar state from PreToolUse/PostToolUse/Notification/etc., and
 *   - report lifecycle boundaries while renderer-side guarded queues deliver
 *     inbox work only after the session reaches a safe idle prompt.
 *
 * Runs in the Electron main process.
 */
import { createServer, type Server } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { Notification, type WebContents } from 'electron';
import type { HiveManager } from './hive';
import { modelForHiveSpawn, type HarnessConfig } from './config';
import type { ControlRegistry } from './control';
import type { CircuitBreaker } from './breaker';
import { estimateCostUsd } from './pricing';
import { classifyAgyStatusLine, normalizeClaudeStatusLine, type AgyStatusTick } from './capacityNormalize';
import { agyAccountScope, claudeAccountScope } from './capacityScope';
import { CodexRolloutCapacitySource } from './codexRolloutCapacity';
import type { CapacityObservation } from '../shared/providerCapacity';

interface HookPayload {
  hook_event_name?: string;
  agent_id?: string | null;
  /** CODEX-HOOK-AGENTID: the provider's OWN agent id, when it sent one that is not the hive's
   *  (a Codex or Claude subagent). The shim stamps agent_id with the hive id regardless. */
  provider_agent_id?: string | null;
  session_id?: string;
  transcript_path?: string;
  /** Status-line payloads only: the session's live context accounting. */
  context_window?: { total_input_tokens?: number; context_window_size?: number };
  /** Status-line payloads only: the subscription's rolling allowance windows
   *  (`five_hour`, `seven_day`, possibly model-family windows). The shim already
   *  forwards the WHOLE status JSON, so this field has always arrived here — it was
   *  simply not declared, and therefore dropped. Typed as unknown because the
   *  schema is the provider's and may grow; shape checking lives in the
   *  normaliser, which is pure and tested. */
  rate_limits?: unknown;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  notification_type?: string;
  /** Notification hook text, e.g. "Claude is waiting for your input" (idle) vs a
   *  permission request. Used to tell "needs you" from "just done / lingering". */
  message?: string;
  /** Status payloads carry Claude's model object; CostSample uses a string. */
  model?: string | { id?: unknown };
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
  /** AgyStatusLine envelopes only: Antigravity's statusline payload, forwarded whole by
   *  the statusline shim. NEVER logged, retained or re-sent - it carries the account's
   *  email. The normaliser reads the fields it needs and everything else is dropped. */
  agy_status?: unknown;
  /** AgyStatusLine envelopes only: when the SHIM read the status, on this machine's
   *  clock. Untrusted input - the normaliser clamps it to the receipt time. */
  read_at?: unknown;
  /** Antigravity `Stop` only: the provider's own terminal qualifier, preserved by the
   *  agy hook shim. Claude never sends it, so absent must keep meaning "terminal" -
   *  only an explicit `false` refuses the Stop. Never a capacity or account fact. */
  fully_idle?: boolean;
  /** Codex hook payloads only: the turn this event belongs to (Codex stamps turn_id on
   *  UserPromptSubmit, PreToolUse, PostToolUse and Stop). Lets the wake coordinator
   *  recognise a tool event that arrives AFTER its own turn's Stop (FALSEACTIVE-STALL-2). */
  turn_id?: string;
  /** HOOK-BROKER: stamped on ARRIVAL, before handle(): a per-agent monotonic counter and
   *  the transport it came over. Never trusted from the sender (overwritten). */
  seq?: number;
  transport?: HookTransport;
}

export type HookTransport = 'http' | 'pipe';

/** HOOK-BROKER: the largest HTTP hook body accepted (a PostToolUse tool_response can be big). */
export const HOOK_HTTP_BODY_MAX = 8 * 1024 * 1024;
/** HOOK-BROKER: after a listener error, re-listen on the SAME port (live agents' settings name
 *  it) with these delays; when they are exhausted (~30 s) the broker is down and new spawns get
 *  the command hooks. */
export const HOOK_HTTP_RELISTEN_DELAYS_MS = [250, 1_000, 2_000, 5_000, 10_000, 12_000];
/** The only URL the broker serves: /hook/<agentId>/<32-hex token>. */
const HOOK_ROUTE = /^\/hook\/([^/?#]+)\/([0-9a-f]{32})$/;

/** Rewrite an HTTP hook body's identity from the AUTHENTICATED URL (9082b05c rules, now
 *  server-side): an incoming provider_agent_id is never trusted; a differing body agent_id is
 *  the provider's own (a subagent) and becomes provider_agent_id; agent_id is the URL's. */
export function applyUrlIdentity(p: Record<string, unknown>, urlAgentId: string): void {
  delete p.provider_agent_id;
  const own = typeof p.agent_id === 'string' && p.agent_id !== '' ? p.agent_id : null;
  if (own && own !== urlAgentId) p.provider_agent_id = own;
  p.agent_id = urlAgentId;
}

/** How many distinct {version, driftCode} pairs are counted before they share one bucket. */
const AGY_DRIFT_KEYS_MAX = 32;

export class HookServer {
  private server: Server | null = null;
  /** agentId → the live session's transcript file, learned from hook payloads.
   *  Lets the harness read per-agent telemetry (e.g. current context size)
   *  even when several agents share one cwd. */
  private transcriptPaths = new Map<string, string>();
  /** agentId → the latest context-window accounting from the statusLine shim
   *  (current tokens + the REAL window size — 200k vs 1M, which nothing else
   *  exposes). The renderer already gets this pushed live on `hive:contextUpdate`;
   *  we also retain the last value here so a main-side read (the voice read-layer's
   *  get_agent_detail / list_agents) can report "how full is each agent's context"
   *  without depending on a renderer round-trip. */
  private contextById = new Map<string, { tokens: number; limit: number; ts: number }>();
  /** L0 — Codex allowance, read from the rollout a Codex worker is already writing.
   *  Holds only a per-home cache (newest rollout path + last mtime seen). */
  private codexCapacity = new CodexRolloutCapacitySource();

  constructor(
    private hive: HiveManager,
    private getWebContents: () => WebContents | null,
    private getConfig: () => HarnessConfig,
    /** #7C — operator control state. Optional so tests can omit it. */
    private control?: ControlRegistry,
    /** Circuit breaker (Lane A #6.6b) — fed the hook-derived signals (session id,
     *  repeated identical tool calls). Optional so the server still runs without it. */
    private breaker?: CircuitBreaker,
    /** Standing goal text for an agent (from the durable roster). Optional so
     *  tests can omit it; when set, injected on SessionStart / UserPromptSubmit. */
    private getStandingGoal?: (agentId: string) => string | null,
    /** Optional OBSERVER of every hook boundary (agentId, event, message), called
     *  synchronously BEFORE this server returns its hook response. It must not submit
     *  or block: the inbox-wake bridge only records lifecycle/HITL state here and defers
     *  any retry with setImmediate, so the response (Stop included) is unchanged. */
    private onEvent?: (agentId: string | undefined, event: string, message: string | undefined, fullyIdle?: boolean, turnId?: string) => void,
    /** L0 — provider allowance observed on the status line. Optional so the server
     *  runs unchanged where no tracker is wired (tests, and any build without L0).
     *  HookServer deliberately does not hold the tracker: it hands over a
     *  normalised observation and knows nothing about states, thresholds or pools. */
    private onCapacity?: (agentId: string | null, obs: CapacityObservation) => void,
    /** AGY 1.1.48 - one COHERENT Antigravity statusline tick: both family observations
     *  plus the canonical lifecycle. `agentId` is null for a user's own session. Optional
     *  and unwired in a build with no capacity runtime, in which case a tick is
     *  normalised, counted if it drifts, and otherwise dropped.
     *
     *  ONE CALLBACK CARRIES BOTH the allowance pair and the lifecycle, because they are
     *  one indivisible reading: the tick that says which family is active is the same
     *  tick that says whether the turn is running. Splitting it into a capacity callback
     *  and a lifecycle callback would let a build accept half of a reading, and "the half
     *  that parsed is exactly as suspect as the half that did not" is the rule this
     *  normaliser is already built on. HookServer still knows nothing about pools, wake
     *  or admission; it hands over the canonical record and the caller routes it. */
    private onAgyTick?: (agentId: string | null, tick: AgyStatusTick) => void
  ) {}

  /** Bounded drift tally, keyed `version|driftCode`. Fixed-string keys only: the payload
   *  that drifted is never stored, so this can be read out or logged safely. */
  private agyDrift = new Map<string, number>();

  /** A snapshot of the drift tally (diagnostics, tests). */
  agyDriftCounts(): Record<string, number> {
    return Object.fromEntries(this.agyDrift);
  }

  start(): void {
    const sock = this.hive.sockPath();
    if (!sock || this.server) return;
    // Clear a stale socket file left by a previous run.
    try { if (existsSync(sock)) rmSync(sock); } catch { /* noop */ }

    this.server = createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // wait for the full line
        let payload: HookPayload = {};
        try { payload = JSON.parse(buf.slice(0, nl)); } catch { /* ignore */ }
        let res: unknown = {};
        try { res = this.handle(this.stampArrival(payload, 'pipe')); } catch { res = {}; }
        conn.end(JSON.stringify(res ?? {}));
      });
      conn.on('error', () => { /* shim hung up — ignore */ });
    });
    this.server.on('error', (e) => console.error('[hive] hook server error:', e));
    this.server.listen(sock);
    this.startHttp();
  }

  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    const sock = this.hive.sockPath();
    try { if (sock && existsSync(sock)) rmSync(sock); } catch { /* noop */ }
    this.stopHttp();
  }

  // — HOOK-BROKER: Claude's native HTTP hooks, handled in-process (0 processes per hook) —
  //
  // Every command hook cost two process creations (cmd.exe + Electron-as-node running the
  // shim): ~450 ms each, an antivirus scan target, and the jitter that let a hook overtake a
  // later one. Claude Code can POST a hook to a URL instead. The broker is this server with a
  // second listener, on loopback, calling the SAME handle(): every gate behaves identically,
  // and it spawns nothing, so there is nothing to orphan. Providers that can only run a
  // command keep the pipe and the shim exactly as before.

  private http: HttpServer | null = null;
  private httpPort: number | null = null;
  private httpDown = false;
  private httpStopped = true;
  private relistenAttempt = 0;
  private relistenTimer: ReturnType<typeof setTimeout> | null = null;
  /** agentId -> the token minted for its CURRENT spawn (revoked on archive, replaced on respawn). */
  private hookTokens = new Map<string, Buffer>();
  private seqByAgent = new Map<string, number>();
  /** Hooks per agent per transport in the current minute; flushed to log.jsonl on rollover. */
  private transportCounts = new Map<string, { http: number; pipe: number }>();
  private countsMinute = 0;
  private oversizeLogged = new Set<string>();
  private brokerDownLogged = false;

  private startHttp(port = 0): void {
    this.httpStopped = false;
    const server = createHttpServer((req, res) => this.onHttp(req, res));
    server.headersTimeout = 5_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.on('error', (e) => this.onHttpError(server, e));
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        this.httpPort = addr.port;
        this.httpDown = false;
        this.relistenAttempt = 0;
      }
    });
    this.http = server;
  }

  private onHttpError(server: HttpServer, e: unknown): void {
    if (this.http !== server || this.httpStopped) return;
    try { server.close(); } catch { /* noop */ }
    this.http = null;
    const delay = HOOK_HTTP_RELISTEN_DELAYS_MS[this.relistenAttempt];
    if (delay === undefined) {
      // Persistent: new spawns get the command hooks from now on. Live agents' HTTP hooks
      // fail as non-blocking errors, and the inbox-wake reconcile beat still covers wake.
      this.httpDown = true;
      if (!this.brokerDownLogged) {
        this.brokerDownLogged = true;
        console.error('[hive] hook broker down; new agents use command hooks:', e);
        try { this.hive.appendLog({ kind: 'hook-broker-down', error: String(e).slice(0, 200) }); } catch { /* best effort */ }
      }
      return;
    }
    this.relistenAttempt += 1;
    // The SAME port: the URLs in running agents' settings name it. With no port yet (the
    // first bind failed), any port will do, and nobody has a URL to lose.
    const port = this.httpPort ?? 0;
    this.relistenTimer = setTimeout(() => { this.relistenTimer = null; if (!this.httpStopped) this.startHttp(port); }, delay);
    this.relistenTimer.unref?.();
  }

  private stopHttp(): void {
    this.httpStopped = true;
    if (this.relistenTimer) { clearTimeout(this.relistenTimer); this.relistenTimer = null; }
    try { this.http?.close(); } catch { /* noop */ }
    this.http = null;
    this.httpPort = null;
    this.hookTokens.clear();
    this.flushTransportCounts();
  }

  /** The URL this agent's Claude hooks POST to, minting a fresh token (the previous spawn's is
   *  revoked). Null when the broker is not listening: the caller then writes command hooks. */
  hookUrl(agentId: string): string | null {
    if (!this.http || this.httpPort === null || this.httpDown || this.httpStopped || !agentId) return null;
    const token = randomBytes(16);
    this.hookTokens.set(agentId, token);
    return `http://127.0.0.1:${this.httpPort}/hook/${encodeURIComponent(agentId)}/${token.toString('hex')}`;
  }

  revokeHookToken(agentId: string): void {
    this.hookTokens.delete(agentId);
  }

  /** The bound broker port (diagnostics, tests), or null. */
  hookBrokerPort(): number | null { return this.httpDown ? null : this.httpPort; }

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number, body: unknown): void => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    };
    const m = req.method === 'POST' && req.url ? HOOK_ROUTE.exec(req.url) : null;
    if (!m) { req.resume(); reply(404, {}); return; }
    let agentId: string;
    try { agentId = decodeURIComponent(m[1]); } catch { req.resume(); reply(404, {}); return; }
    const expected = this.hookTokens.get(agentId);
    const given = Buffer.from(m[2], 'hex');
    // Constant-time, and never handled unless it matches: another local process cannot
    // forge a hook for an agent.
    if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      req.resume(); reply(403, {}); return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (d: Buffer) => {
      if (tooBig) return;
      size += d.length;
      if (size > HOOK_HTTP_BODY_MAX) {
        tooBig = true;
        if (!this.oversizeLogged.has(agentId)) {
          this.oversizeLogged.add(agentId);
          console.error(`[hive] hook body over ${HOOK_HTTP_BODY_MAX} bytes from ${agentId}; refused`);
        }
        reply(413, {});
        req.resume();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (tooBig) return;
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch { /* an unreadable body is an empty hook */ }
      applyUrlIdentity(payload, agentId);
      let out: unknown = {};
      try { out = this.handle(this.stampArrival(payload as HookPayload, 'http')); } catch { out = {}; }
      reply(200, out);
    });
    req.on('error', () => { /* client went away */ });
  }

  /** Stamp the arrival order and transport before handle() (never trusted from the body),
   *  and count it for the per-minute transport log. */
  private stampArrival(p: HookPayload, transport: HookTransport): HookPayload {
    p.transport = transport;
    const agentId = typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null;
    if (!agentId) { delete p.seq; return p; }
    const seq = (this.seqByAgent.get(agentId) ?? 0) + 1;
    this.seqByAgent.set(agentId, seq);
    p.seq = seq;
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.countsMinute) { this.flushTransportCounts(); this.countsMinute = minute; }
    const c = this.transportCounts.get(agentId) ?? { http: 0, pipe: 0 };
    c[transport] += 1;
    this.transportCounts.set(agentId, c);
    return p;
  }

  /** One log row per minute with hooks by transport per agent (http = 0 processes per hook,
   *  pipe = 2): the measure of what the broker removed. */
  private flushTransportCounts(): void {
    if (!this.transportCounts.size) return;
    const counts = Object.fromEntries(this.transportCounts);
    this.transportCounts = new Map();
    try { this.hive.appendLog({ kind: 'hook-transport', minute: this.countsMinute, counts }); } catch { /* best effort */ }
  }

  /** Hooks by transport per agent in the current minute (diagnostics, tests). */
  transportCountsNow(): Record<string, { http: number; pipe: number }> {
    return Object.fromEntries(this.transportCounts);
  }

  /** Read this agent's Codex allowance, if it is a Codex worker and anything moved. */
  private observeCodexCapacity(agentId: string, event: string): void {
    try {
      const home = this.hive.codexHomeFor(agentId);
      if (!home) return;
      const obs = this.codexCapacity.observe(home, { rescan: event === 'SessionStart' });
      // The agent is carried with the reading: a pool key is a provider fact, and
      // which agents draw on it can only be learned from readings that arrived.
      if (obs) this.onCapacity?.(agentId, obs);
    } catch { /* telemetry must never break a hook boundary */ }
  }

  /**
   * One Antigravity statusline envelope. Always answers `{}`.
   *
   * A refused tick changes NOTHING - not the last good pool, not the lifecycle - and
   * is counted under its fixed drift code. The raw payload goes no further than the
   * normaliser: it is not logged, not stored, and not passed on.
   */
  private handleAgyStatus(p: HookPayload): unknown {
    try {
      const c = classifyAgyStatusLine({
        payload: p.agy_status,
        accountScope: agyAccountScope(),
        receivedAt: Date.now(),
        readAt: p.read_at
      });
      if (!c.ok) {
        // The boot tick is refused by design (N-1 b); it is not drift worth counting.
        if (c.driftCode === 'authenticating') return {};
        const key = `${c.version ?? '-'}|${c.driftCode}`;
        const bucket = this.agyDrift.has(key) || this.agyDrift.size < AGY_DRIFT_KEYS_MAX ? key : 'overflow';
        const n = (this.agyDrift.get(bucket) ?? 0) + 1;
        this.agyDrift.set(bucket, n);
        // First sighting of each kind only: a drifting build ticks after every render. To
        // the event log as well as the console, because log.jsonl is where a drift after an
        // AGY upgrade gets noticed - and the row is the fixed code and version, nothing else.
        if (n === 1) {
          console.warn('[agy-statusline] drift', { version: c.version, driftCode: c.driftCode });
          try { this.hive.appendLog({ kind: 'agy-statusline-drift', version: c.version, driftCode: c.driftCode }); } catch { /* best effort */ }
        }
        return {};
      }
      const agentId = typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null;
      this.onAgyTick?.(agentId, c.tick);
    } catch { /* telemetry must never break the pipe */ }
    return {};
  }

  /** The transcript file of an agent's CURRENT session, if any hook has fired. */
  transcriptPath(agentId: string): string | undefined {
    return this.transcriptPaths.get(agentId);
  }

  /** The latest context-window accounting for an agent (current tokens + the real
   *  window size), or undefined if no statusLine tick has fired for it yet. */
  contextFor(agentId: string): { tokens: number; limit: number; ts: number } | undefined {
    return this.contextById.get(agentId);
  }

  private handle(p: HookPayload): unknown {
    const agentId = p.agent_id ?? undefined;
    const event = p.hook_event_name ?? 'Unknown';
    // AGY statusline telemetry is not a hook boundary, and it is handled BEFORE
    // everything else here: before the lifecycle observer (a tick is not a hook event
    // and must not be mistaken for one), before transcript capture, and before the
    // halt gate, the breaker and session recording. It can arrive with agent_id null
    // from a session nobody spawned, and none of that machinery is for it.
    if (event === 'AgyStatusLine') return this.handleAgyStatus(p);
    // CODEX-HOOK-AGENTID: a SUBAGENT's hook belongs to this agent (the halt gate, the breaker,
    // the activity feed all apply), but it does not describe the agent's OWN session: its
    // session id, transcript and turn are the subagent's. So it never records the session or
    // transcript, never drives the wake lifecycle (a subagent's late tool hook would re-open
    // a finished turn), and a subagent's Stop is not this agent's Stop.
    const fromSubagent = typeof p.provider_agent_id === 'string' && p.provider_agent_id !== '' && p.provider_agent_id !== agentId;
    if (!fromSubagent) {
      this.onEvent?.(agentId, event, p.message, typeof p.fully_idle === 'boolean' ? p.fully_idle : undefined,
        typeof p.turn_id === 'string' && p.turn_id ? p.turn_id : undefined);
    }
    if (agentId && !fromSubagent && typeof p.transcript_path === 'string' && p.transcript_path) {
      this.transcriptPaths.set(agentId, p.transcript_path);
    }

    // L0 — Codex has no status line. It stamps its rate-limit snapshot onto the
    // token_count event of every turn in the rollout it is already writing, so the
    // hook boundary we are standing on IS the event-driven refresh: by the time a
    // hook fires, the turn that produced a fresh snapshot has been written. Reading
    // it costs a stat on an unchanged file and a short tail read on a changed one,
    // and it makes no provider request of any kind. Non-Codex agents cost one
    // existence check. Session boundaries force a rescan, because a new session
    // means a new rollout file rather than an append to the old one.
    if (agentId && this.onCapacity) this.observeCodexCapacity(agentId, event);

    // Status-line payloads carry the session's EXACT context accounting —
    // current tokens AND the real window size (200k vs 1M, which nothing else
    // exposes). Forward to the renderer for the agent-card context gauge.
    // Handled FIRST and returned early: this is pure telemetry from the
    // statusLine shim, not a real hook boundary — it must never trip the
    // HALT gate or feed the breaker's loop detector below. The early return
    // also (deliberately) skips recordSession for status ticks: a statusLine
    // payload's session_id adds nothing the real hooks don't already record.
    // The model is the exception: it is the authoritative per-agent `/model`
    // observation and must survive a restart. transcript_path IS still captured
    // above, where every payload shape benefits from it.
    if (event === 'Status') {
      const statusModel = typeof p.model === 'object' && p.model !== null && typeof p.model.id === 'string'
        ? p.model.id.trim()
        : '';
      if (agentId && statusModel) {
        const agent = this.hive.registry().agents[agentId];
        // Do not let a bridged provider's display model become a future Claude
        // argv. `recordModel` repeats this gate at the persistence boundary.
        if (agent?.provider === 'claude') {
          this.hive.recordModel(agentId, statusModel, modelForHiveSpawn(agent, this.getConfig()));
        }
      }
      const cw = p.context_window;
      if (agentId && cw && typeof cw.total_input_tokens === 'number'
        && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
        // Retain for main-side reads (voice get_agent_detail / list_agents) …
        this.contextById.set(agentId, {
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size,
          ts: Date.now()
        });
        // … and forward live to the renderer's agent-card context gauge.
        this.getWebContents()?.send('hive:contextUpdate', {
          agentId,
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size
        });
      }
      // L0 — the same payload carries the SUBSCRIPTION's rolling allowance
      // windows, which is a different quantity from the context accounting above:
      // context is per session and per agent, allowance is shared at account scope
      // across every session drawing on it. This is the supported machine-readable
      // pre-limit signal for a Claude subscription, and it arrives here for free on
      // a status tick that is already happening — no poll, no extra request, and no
      // credential is touched. Guarded so a payload without the field, or with a
      // shape we do not recognise, changes nothing.
      if (p.rate_limits !== undefined && this.onCapacity) {
        try {
          const now = Date.now();
          const obs = normalizeClaudeStatusLine({
            rateLimits: p.rate_limits,
            accountScope: claudeAccountScope(),
            receivedAt: now
          });
          if (obs) this.onCapacity(agentId ?? null, obs);
        } catch { /* telemetry must never break a status tick */ }
      }
      return {};
    }

    // 7C.3 — a graceful operator HALT overrides everything (incl. the inbox
    // drain below): stop the agent CLEANLY at this hook boundary rather than
    // killing the PTY. session_id is in the payload for a later --resume.
    if (agentId && this.control?.shouldHalt(agentId)) {
      // A subagent's Stop is not this agent's Stop, halted or not (the renderer reads any
      // emitted Stop as this agent going idle). The halt still applies to the subagent.
      if (!(fromSubagent && (event === 'Stop' || event === 'SubagentStop'))) this.emit(agentId, event, p);
      return { continue: false, stopReason: 'Halted by the operator from the floor.' };
    }

    // Capture the Claude Code session id for idempotent --resume + cost dedup
    // (Lane A #6.6a). Cheap: recordSession writes only when it changes.
    if (agentId && p.session_id && !fromSubagent) this.hive.recordSession(agentId, p.session_id);

    // CostSample — synthesized by the proxy-bridge sidecar (qwen) on every
    // response with usage. Persist it to the SAME cost ledger as Claude's OTel
    // path, keyed by the synthesized session_id, then return early so cost stays
    // OUT of the Claude-only OTel/breaker/drain paths below. `usd` is the fallback
    // per-model estimate (a local model normally costs ~$0, but the row keeps the
    // accounting schema uniform). Pure telemetry — never feeds the loop detector.
    if (event === 'CostSample') {
      if (agentId && p.session_id) {
        const model = typeof p.model === 'string' ? p.model : '';
        const input = p.input ?? 0;
        const output = p.output ?? 0;
        const cacheRead = p.cache_read ?? 0;
        const cacheCreation = p.cache_creation ?? 0;
        this.hive.appendCostLedger({
          agentId,
          sessionId: p.session_id,
          ts: Date.now(),
          input,
          output,
          cacheRead,
          cacheCreation,
          model,
          usd: estimateCostUsd(model, {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheCreation
          })
        });
      }
      return {};
    }

    // Feed the breaker its hook-derived loop signal: a tool that actually ran.
    // A repeated identical (name+input) PostToolUse is the runaway-loop tell.
    if (event === 'PostToolUse' && agentId) {
      this.breaker?.recordToolUse(agentId, p.tool_name, p.tool_input);
    }

    // Compaction exemption (issue #109): PreCompact opens it so the compaction
    // token burst can't trip the Δoutput arms; PostCompact — or any SessionStart,
    // since a fresh session makes in-flight compaction state moot — closes it
    // down to the trailing grace (a no-op when nothing was compacting).
    if (event === 'PreCompact' && agentId) this.breaker?.recordCompactStart(agentId);
    if ((event === 'PostCompact' || event === 'SessionStart') && agentId) {
      this.breaker?.recordCompactEnd(agentId);
    }

    if ((event === 'Stop' || event === 'SubagentStop') && agentId && fromSubagent) {
      // Not emitted: the renderer reads any Stop/SubagentStop as THIS agent going idle (and
      // clears its breaker), and the agent itself is still working.
      return {};
    }
    if ((event === 'Stop' || event === 'SubagentStop') && agentId) {
      // Respect any upstream Stop hook that already re-entered this boundary.
      if (p.stop_hook_active) { this.emit(agentId, event, p); return {}; }
      // Never turn unread hive mail into a forced continuation at Stop. That old
      // path bypassed terminal-draft/HITL safety and could spend credits while a
      // user was answering a question. Inbox files remain durable; main's inbox-wake
      // bridge treats this Stop as a retry EDGE and wakes the agent after this response,
      // through the one guarded submit owner. This return stays non-blocking.
      this.notify(agentId ?? 'Agent', 'finished — idle');
      this.emit(agentId, event, p);
      return {};
    }

    // 7C.1 — HITL gate: deny a tool call at the PreToolUse boundary when the
    // agent is paused or this tool is gated. Race-free (immediate return, no
    // renderer round-trip → can't hit the shim timeout). Slow human APPROVAL is
    // deliberately left to Claude's native permission prompt.
    if (event === 'PreToolUse' && agentId && this.control) {
      const d = this.control.toolDecision(agentId, p.tool_name ?? '');
      if (d.deny) {
        this.emitControl(agentId, p.tool_name, d.reason);
        this.emit(agentId, event, p);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: d.reason ?? 'Denied by operator.'
          }
        };
      }
    }

    // 7C.2 — mid-run steering: inject queued operator guidance as context on the
    // next eligible hook (no fragile typing into the TUI). Delivered once.
    // Merged with the roster line below so the two injections never displace each
    // other (only ONE additionalContext can be returned per hook).
    let steer: string | null = null;
    // Not for a subagent's hook: the one-shot steer is meant for the agent itself, and a
    // subagent consuming it would lose it (HOOK-BROKER audit N1).
    if ((event === 'UserPromptSubmit' || event === 'PostToolUse') && agentId && this.control && !fromSubagent) {
      steer = this.control.takeSteer(agentId) ?? null;
    }

    // Keep god's roster CURRENT. fleet.json is always fresh on disk, but god's
    // context is not: after a restart it resumes a transcript describing the old
    // floor and messages agents that are long gone. Push the live roster in as
    // additionalContext at the start of each session and on every prompt, so god
    // knows the floor all the time instead of only when it remembers to Read.
    // God-only and one line — every other agent is unaffected.
    const wantsRoster = (event === 'SessionStart' || event === 'UserPromptSubmit')
      && !!agentId && !fromSubagent && this.hive.isGod(agentId);
    // Hand the roster the LIVE context-window occupancy (contextById) so each
    // agent line can carry a `ctx NN%` — god then sees whose context is nearly
    // full when it routes work, instead of guessing from cumulative token spend.
    const roster = wantsRoster
      ? this.hive.rosterContext((id) => this.contextFor(id))
      : null;

    // Standing goal (hire Briefing) — durable roster field, re-read every cycle so
    // an Edit Agent save is picked up on the next SessionStart / UserPromptSubmit
    // without restarting the worker. Kept out of --append-system-prompt (volatile-
    // free cache invariant); lives on the live hook channel instead.
    const wantsGoal = (event === 'SessionStart' || event === 'UserPromptSubmit') && !!agentId && !fromSubagent;
    const goalRaw = wantsGoal ? (this.getStandingGoal?.(agentId) ?? null) : null;
    const goal = goalRaw
      ? `<goal>\n${goalRaw}\n</goal>`
      : null;

    if (steer || roster || goal) {
      this.emit(agentId, event, p);
      return {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: [roster, goal, steer].filter(Boolean).join('\n\n')
        }
      };
    }

    // A Notification hook that means "the agent is blocked waiting for the user"
    // (idle prompt) deserves a desktop toast too — distinct from a permission
    // request, which surfaces natively in the agent's own Claude Code session
    // (approvable remotely via /remote-control).
    if (
      event === 'Notification' &&
      (p.notification_type === 'idle' ||
        (p.message ?? '').toLowerCase().includes('waiting for your input'))
    ) {
      this.notify(agentId ?? 'Agent', p.message ?? 'needs your attention');
    }

    // Forward everything else to the renderer so avatars reflect real activity.
    this.emit(agentId, event, p);
    return {};
  }

  /** Fire a native desktop notification — gated on the user's `notifications`
   *  setting. Only the OS toast is gated; the hive:hookEvent emit is always sent
   *  so avatars/UI stay live regardless. Best-effort: never throw into the hook. */
  private notify(title: string, body: string): void {
    if (!this.getConfig().notifications) return;
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch { /* notifications unsupported on this platform — ignore */ }
  }

  /** Tell the renderer a tool call was gated/denied (#7C.1) so it can surface it
   *  (toast / control strip) — distinct from the avatar hook stream. */
  private emitControl(agentId: string, tool: string | undefined, reason: string | undefined): void {
    this.getWebContents()?.send('control:approvalRequest', { agentId, tool, reason });
  }

  private emit(agentId: string | undefined, event: string, p: HookPayload, blocked = false): void {
    this.getWebContents()?.send('hive:hookEvent', {
      agentId,
      event,
      tool: p.tool_name,
      notificationType: p.notification_type,
      source: p.source,
      message: p.message,
      blocked
    });
  }
}
