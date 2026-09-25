/**
 * MemoryManager — semantic memory for the hive, backed by the MemPalace CLI.
 *
 * CLI-only (no MCP): the harness keeps a single shared palace under harnessHome,
 * points every agent's `MEMPALACE_PALACE_PATH` at it, and mines each agent's
 * `memory.md` into its own wing so the whole team can recall by meaning via
 * `mempalace search` / `mempalace wake-up`. Degrades silently to no-op when the
 * `mempalace` CLI isn't installed — the markdown memory still works.
 *
 *   init    : mempalace init <home> --yes --no-llm        (heuristics-only, no LLM)
 *   store   : mempalace mine <agentDir> --wing <id> --agent <id>
 *   recall  : mempalace search "<q>" --results N   /   mempalace wake-up
 *
 * Runs in the Electron main process.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { constants as osConstants, setPriority } from 'node:os';
import { ensureKilled } from './procKill';
import { quarantineDirsToReap, quarantineStampMs, nextMineDelayMs } from './palaceReap';
import {
  archivedAgentIds, fingerprintMemory, loadMineState, queueChangedMemory,
  readyMineIds, sameFingerprint, saveMineState, type MineState, type PendingMine
} from './incrementalMiner';
import { dataLevel0Bytes, rebuildNeeded, repairStatusEmbeddingCount, swapStagedPalace } from './palaceRebuild';

/** Non-memory files `mempalace mine` must not ingest: the Claude Code hooks
 *  config (a large JSON blob that swamps the wake-up digest), the cursor, raw
 *  inbox/outbox message JSON, and a Codex worker's private CODEX_HOME. `mempalace
 *  mine` honors .gitignore, so we drop one in each agent dir rather than touch the
 *  mine command.
 *
 *  MUST STAY IN SYNC with MINE_IGNORE_LINES in hive.ts — that copy is written when
 *  an agent spawns, this one on every mine cycle, and only this one reaches agents
 *  that are not currently running. See hive.ts for why `.codex/` matters beyond
 *  mempalace: it is also what stopped the hive's git repo from versioning every
 *  Codex transcript and sqlite log into a 7.5GB history. */
const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Writes only the missing lines (append-only) so it's safe to call every cycle. */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return; // already covered — don't rewrite every cycle
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

export type EmbeddingModel = 'minilm' | 'embeddinggemma';

export interface MemorySettings {
  enabled: boolean;
  model: EmbeddingModel;
}

export interface MemoryStatus {
  available: boolean;        // mempalace CLI found on PATH
  enabled: boolean;          // user setting
  active: boolean;           // available && enabled && have a home
  initialized: boolean;      // palace directory exists
  palacePath: string | null;
  model: EmbeddingModel;
  bin: string | null;
  /** Null until the first daemon attempt; false means reads still work but
   * background mining is intentionally unavailable on this CLI version. */
  miningAvailable: boolean | null;
  miningError: string | null;
}

// Scan cheaply every 30s, but give each changed memory.md a full quiet minute
// before submitting exactly one job to MemPalace's resident daemon. This keeps
// rapid note updates out of the Python/index hot path without delaying ordinary
// memory discovery for the old ten-minute interval.
const MINE_INTERVAL_MS = 30_000;
const MINE_DEBOUNCE_MS = 60_000;
/** A changed drawer can still require a vector replacement; cap that churn. */
const MINE_PER_AGENT_MIN_MS = 600_000;
// Ceiling for the quarantine backoff below. Low on purpose: a memory is not
// searchable until it has been mined, and the reaper already handles the disk,
// so there is nothing here worth making recall half an hour stale for.
const MINE_BACKOFF_MAX_MS = 1_800_000;
const MINE_WATCHDOG_MS = 60_000;
const MINE_RETRY_MS = 120_000;
/** First daemon boot may load/download an embedding model before it can emit a
 * job-progress line, so it gets a deliberately separate, generous cap. */
const DAEMON_STARTUP_TIMEOUT_MS = 10 * 60_000;
/** mempalace's device "auto" picks the CoreML execution provider on Apple
 *  Silicon, and CoreML runs the quantized embeddinggemma ONNX graph partially
 *  (330/1647 nodes) with fp16 partitions that overflow → EVERY vector comes
 *  back NaN and chroma rejects every upsert ("Embeddings must not contain NaN
 *  or Infinity values"), so no memory ever gets indexed. Reproduced + verified
 *  2026-08-16: same input is NaN under CoreMLExecutionProvider and clean under
 *  CPU. Pin cpu for BOTH the mine loop and the agents' own `mempalace search`
 *  (a query embedded to NaN breaks recall the same way).
 *
 *  Scope, deliberately macOS-WIDE rather than per-model: the pin costs the
 *  other model nothing. minilm rides chromadb's ONNXMiniLM_L6_V2, whose model
 *  build UNCONDITIONALLY removes CoreMLExecutionProvider ("not as well
 *  optimized as CPU" — chromadb's words), so minilm never runs on CoreML with
 *  or without this pin; embeddinggemma (mempalace's own ONNX class, no such
 *  pruning) is the only path that would reach CoreML, and that path is the NaN
 *  bug. Other platforms keep mempalace's own default ("auto").
 *
 *  A user's OWN device choice wins: if MEMPALACE_EMBEDDING_DEVICE is already
 *  exported we emit nothing, so the inherited value flows through untouched —
 *  which also leaves a one-command way to reproduce the NaN behaviour
 *  (`MEMPALACE_EMBEDDING_DEVICE=coreml`). Exported as a function of
 *  (platform, envOverride) so every branch is reachable from a test on any
 *  platform — same trick as `buildMissingCliScript`. */
export function mempalaceDevice(
  platform: NodeJS.Platform,
  envOverride: string | undefined
): string | undefined {
  if (envOverride) return undefined; // explicit user choice — never override
  return platform === 'darwin' ? 'cpu' : undefined;
}
const MEMPALACE_DEVICE = mempalaceDevice(process.platform, process.env.MEMPALACE_EMBEDDING_DEVICE);

export class MemoryManager {
  private binCache: string | null | undefined;
  private mineTimer: NodeJS.Timeout | null = null;
  private mineStopped = false;
  /** Current gap between mine passes. Widens while the palace is quarantining. */
  private mineDelayMs = MINE_INTERVAL_MS;
  /** Newest quarantine stamp seen so far, so a LATER one means the palace
   *  quarantined again. A count would be useless: the reaper deletes them. */
  private lastQuarantineTs = 0;
  private initStarted = false;
  /** True while a mineNow() pass is in flight — serializes palace writers. */
  private mining = false;
  /** Durable fingerprints survive restart; old mtime-only state did not. */
  private mineState: MineState | null = null;
  /** Changes awaiting their quiet period. One queue serializes all writes. */
  private readonly pendingMines = new Map<string, PendingMine>();
  private daemonStart: Promise<boolean> | null = null;
  private daemonUnavailable: string | null = null;
  private daemonUnavailableLogged = false;
  private rebuilding = false;
  /** Log a stalled job once, then retry after backoff without a log storm. */
  private readonly watchdogLogged = new Set<string>();

  constructor(
    private getHome: () => string | null,
    private getSettings: () => MemorySettings
  ) {}

  palacePath(): string | null {
    const h = this.getHome();
    return h ? join(h, 'palace') : null;
  }

  /** Resolve the mempalace CLI against the user's PATH + common uv/pip spots. */
  bin(): string | null {
    if (this.binCache !== undefined) return this.binCache;
    let found: string | null = null;
    const isWin = process.platform === 'win32';
    // 1) Ask the shell/PATH resolver. Windows has no POSIX shell + uses `where`
    //    and a `.exe` suffix; everything else goes through the login shell.
    try {
      if (isWin) {
        const res = spawnSync('where', ['mempalace'], { encoding: 'utf8', timeout: 3000 });
        const p = res.stdout.trim().split(/\r?\n/)[0]?.trim();
        if (p && existsSync(p)) found = p;
      } else {
        const res = spawnSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', 'which mempalace'], {
          encoding: 'utf8', timeout: 3000
        });
        const p = res.stdout.trim().split('\n').pop();
        if (p && existsSync(p)) found = p;
      }
    } catch { /* fall through */ }
    // 2) Probe common install locations (uv tool / homebrew / pip).
    if (!found) {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const candidates = isWin
        ? [
            join(home, '.local', 'bin', 'mempalace.exe'),
            join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mempalace.exe')
          ]
        : [
            `${home}/.local/bin/mempalace`,
            '/opt/homebrew/bin/mempalace',
            '/usr/local/bin/mempalace'
          ];
      for (const c of candidates) if (c && existsSync(c)) { found = c; break; }
    }
    this.binCache = found;
    return found;
  }
  /** Force re-resolution (e.g. after the user installs mempalace). */
  resetBinCache(): void { this.binCache = undefined; }

  available(): boolean { return this.bin() !== null; }
  enabled(): boolean { return this.getSettings().enabled; }
  active(): boolean { return this.available() && this.enabled() && this.getHome() !== null; }
  model(): EmbeddingModel { return this.getSettings().model === 'embeddinggemma' ? 'embeddinggemma' : 'minilm'; }

  status(): MemoryStatus {
    const palace = this.palacePath();
    return {
      available: this.available(),
      enabled: this.enabled(),
      active: this.active(),
      initialized: !!palace && existsSync(palace),
      palacePath: palace,
      model: this.model(),
      bin: this.bin(),
      miningAvailable: this.daemonUnavailable ? false : null,
      miningError: this.daemonUnavailable
    };
  }

  /** Env merged into each agent's spawn so its `mempalace` CLI hits the shared palace. */
  env(): Record<string, string> {
    const palace = this.palacePath();
    if (!this.active() || !palace) return {};
    return {
      MEMPALACE_PALACE_PATH: palace,
      MEMPALACE_EMBEDDING_MODEL: this.model(),
      ...(MEMPALACE_DEVICE ? { MEMPALACE_EMBEDDING_DEVICE: MEMPALACE_DEVICE } : {})
    };
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MEMPALACE_PALACE_PATH: this.palacePath() ?? '',
      MEMPALACE_EMBEDDING_MODEL: this.model(),
      ...(MEMPALACE_DEVICE ? { MEMPALACE_EMBEDDING_DEVICE: MEMPALACE_DEVICE } : {})
    };
  }

  // — lifecycle —

  /** Start the mine loop. `mempalace mine` auto-creates the palace on first run
   *  (lazily downloading the embedding model, one-time). We deliberately do NOT
   *  run `mempalace init`: it ends in an interactive "Mine now? [Y/n]" prompt
   *  that --yes doesn't cover, so a spawned child would hang forever. */
  start(): void {
    if (!this.active() || this.initStarted) return;
    if (!this.bin() || !this.getHome() || !this.palacePath()) return;
    this.initStarted = true;
    // Sweep once at boot, before the first mine. An app updating into this fix
    // arrives at a palace that has been accumulating copies for as long as it
    // has been running — 357 of them here — and waiting for the first agent to
    // edit its memory.md would leave all of that on disk for an arbitrary
    // while. This is the pass that makes the existing pile go away by itself.
    this.reapPalace();
    // Detached external work: a guarded repair must never block Electron's
    // main loop, and it will only swap a fully verified staged palace.
    void this.maybeRebuildPalace();
    this.startMineLoop();
  }

  stop(): void {
    this.mineStopped = true;
    if (this.mineTimer) { clearTimeout(this.mineTimer); this.mineTimer = null; }
  }

  /**
   * Re-resolve the CLI, arm the mine loop if it is only now possible, and report.
   *
   * `start()` runs once at boot and bails when mempalace isn't on PATH yet. If the
   * user installs it AFTER that — the common case, since the settings panel is
   * where they find out they need it — nothing re-invoked `start()`, so the mine
   * loop never ran. The palace is created by the first `mempalace mine`, so it
   * never appeared either, and `initialized` (existsSync(palace)) stayed false
   * while `available` flipped true: the status pill read "On — getting ready…"
   * forever and only an app restart cleared it.
   *
   * The status poll is the one thing that reliably notices the install, so it is
   * where the re-arm belongs. `start()` is idempotent (initStarted), so repeated
   * polls never start a second loop — and it still deliberately does NOT run
   * `mempalace init`, which ends in an interactive "Mine now? [Y/n]" that `--yes`
   * doesn't cover and that hangs a spawned child.
   */
  refresh(): MemoryStatus {
    this.resetBinCache();
    this.start();
    return this.status();
  }

  /** Self-scheduling rather than `setInterval`, so the gap can widen when the
   *  palace is quarantining and snap back the moment it stops. */
  private startMineLoop(): void {
    if (this.mineTimer) return;
    const tick = () => {
      void this.mineNow().finally(() => {
        if (this.mineStopped) return;
        this.mineTimer = setTimeout(tick, this.mineDelayMs);
        this.mineTimer.unref?.();
      });
    };
    // Armed synchronously. `mineTimer` is the "is the loop running" signal that
    // `refresh()` reports on right after `start()`, and setting it only once the
    // first mine resolves would report the loop as dead for a whole pass —
    // which is exactly the re-arm-after-install case that has its own test.
    this.mineTimer = setTimeout(tick, 0);
    this.mineTimer.unref?.();
  }

  // — mining (store) —

  /** Mine every agent whose memory changed since last time, one at a time.
   *  The palace permits a single writer, so mines MUST be serialized — firing
   *  them concurrently makes all but one fail with "held by another writer".
   *  `mining` guards against a slow pass overlapping the next interval tick. */
  async mineNow(): Promise<void> {
    const home = this.getHome();
    const bin = this.bin();
    if (!this.active() || !home || !bin) return;
    if (this.mining) return; // a previous pass is still running — let it finish
    const agentsDir = join(home, 'hive', 'agents');
    if (!existsSync(agentsDir)) return;
    let ids: string[];
    try { ids = readdirSync(agentsDir); } catch { return; }
    this.mineState ??= loadMineState(home);
    const archived = archivedAgentIds(home);
    const now = Date.now();
    this.mining = true;
    try {
      for (const id of ids) {
        if (archived.has(id)) { this.pendingMines.delete(id); continue; }
        const fingerprint = fingerprintMemory(join(agentsDir, id, 'memory.md'));
        if (!fingerprint) continue;
        if (sameFingerprint(this.mineState.entries[id], fingerprint)) {
          this.pendingMines.delete(id);
          continue; // unchanged across restart too â€” no daemon job
        }
        queueChangedMemory(this.pendingMines, id, fingerprint, now, MINE_DEBOUNCE_MS);
        const pending = this.pendingMines.get(id);
        const last = this.mineState.entries[id]?.minedAt ?? 0;
        if (pending) pending.quietUntil = Math.max(pending.quietUntil, last + MINE_PER_AGENT_MIN_MS);
      }
      for (const id of readyMineIds(this.pendingMines, now)) {
        if (archived.has(id)) { this.pendingMines.delete(id); continue; }
        const pending = this.pendingMines.get(id);
        if (!pending) continue;
        const ok = await this.mineAgent(join(agentsDir, id), id);
        if (ok) {
          this.mineState.entries[id] = { ...pending.fingerprint, minedAt: Date.now() };
          saveMineState(home, this.mineState);
          this.pendingMines.delete(id);
          this.watchdogLogged.delete(id);
        } else {
          pending.quietUntil = Date.now() + MINE_RETRY_MS;
        }
      }
    } finally {
      this.mining = false;
    }
    // Every pass above may have left another copy behind, and whether it did
    // decides how long we wait before the next one.
    const quarantined = this.reapPalace();
    this.mineDelayMs = nextMineDelayMs(
      this.mineDelayMs, MINE_INTERVAL_MS, MINE_BACKOFF_MAX_MS, quarantined
    );
  }

  /**
   * Delete quarantined segment copies MemPalace renamed aside and never removed.
   *
   * Safe to delete: the rename is precisely what takes them OUT of the palace's
   * live set, and Chroma has already rebuilt by the time we see one. They are
   * diagnostic residue. `quarantineDirsToReap` keeps the newest couple so there
   * is still something to look at, and refuses to touch anything recent enough
   * to still be mid-recovery.
   *
   * Best-effort throughout. A palace we cannot read, or a directory we cannot
   * remove, must never take down the mine loop — this is disk hygiene, not a
   * correctness path.
   */
  private reapPalace(): boolean {
    const palace = this.palacePath();
    if (!palace || !existsSync(palace)) return false;
    let names: string[];
    try { names = readdirSync(palace); } catch { return false; }

    let newest = 0;
    for (const name of names) {
      const ts = quarantineStampMs(name);
      if (ts !== null && ts > newest) newest = ts;
    }
    // The boot sweep runs before the first mine precisely so it can seed this:
    // otherwise a palace that arrives with a backlog would read as "just
    // quarantined" and back the loop off before it has mined anything.
    const fresh = this.lastQuarantineTs > 0 && newest > this.lastQuarantineTs;
    if (newest > this.lastQuarantineTs) this.lastQuarantineTs = newest;

    const doomed = quarantineDirsToReap(names.map((name) => ({ name })), Date.now());
    if (!doomed.length) return fresh;
    let removed = 0;
    for (const name of doomed) {
      try { rmSync(join(palace, name), { recursive: true, force: true }); removed += 1; }
      catch { /* locked, gone, or not ours — leave it and try again next pass */ }
    }
    if (removed) console.log(`[memory] reaped ${removed} quarantined palace segment(s)`);
    return fresh;
  }

  /** Repair only a grossly bloated palace. `from-sqlite` reads the live source
   * into a sibling staging directory; it is verified before two reversible
   * renames retain the previous palace as a timestamped backup. */
  private async maybeRebuildPalace(): Promise<void> {
    const palace = this.palacePath();
    const bin = this.bin();
    if (!palace || !bin || this.rebuilding || this.mining || !existsSync(palace)) return;
    this.rebuilding = true;
    try {
      const status = await this.runRaw(bin, ['--palace', palace, 'repair-status']);
      const count = status.ok ? repairStatusEmbeddingCount(status.output) : null;
      if (!count || !rebuildNeeded(dataLevel0Bytes(palace), count)) return;
      const stamp = String(Date.now());
      const staged = `${palace}.mempalace-rebuild-${stamp}`;
      const backup = `${palace}.mempalace-backup-${stamp}`;
      const built = await this.runRaw(bin, ['--palace', staged, 'repair', '--mode', 'from-sqlite', '--source', palace, '--yes', '--no-backup']);
      if (!built.ok) { console.error('[memory] palace rebuild staging failed; live palace left untouched'); return; }
      const verified = await this.runRaw(bin, ['--palace', staged, 'repair-status']);
      if (repairStatusEmbeddingCount(verified.output) !== count) {
        console.error('[memory] palace rebuild verification failed; live palace left untouched');
        return;
      }
      if (swapStagedPalace(palace, staged, backup)) {
        console.log(`[memory] rebuilt bloated palace; previous palace retained at ${backup}`);
      } else console.error('[memory] palace rebuild swap failed; live palace restored/untouched');
    } finally { this.rebuilding = false; }
  }

  private runRaw(bin: string, args: string[]): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      let proc: ReturnType<typeof spawn>;
      try { proc = spawn(bin, args, { env: this.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { resolve({ ok: false, output: '' }); return; }
      let output = '';
      proc.stdout?.on('data', (d) => { output += d.toString(); });
      proc.once('close', (code) => resolve({ ok: code === 0, output }));
      proc.once('error', () => resolve({ ok: false, output }));
    });
  }

  /** Start MemPalace's opt-in daemon once. It owns the model and HNSW writer
   * for all later jobs, avoiding a full Python/index load per changed agent. */
  private ensureDaemon(): Promise<boolean> {
    if (this.daemonStart) return this.daemonStart;
    this.daemonStart = new Promise((resolve) => {
      const bin = this.bin();
      if (!bin) { resolve(false); return; }
      let proc: ReturnType<typeof spawn>;
      let err = '';
      try { proc = spawn(bin, ['daemon', 'start'], { env: this.childEnv(), stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch { resolve(false); return; }
      // The daemon's child inherits this on Windows; on POSIX it keeps model
      // maintenance below Electron and active CLI work. Best-effort only.
      try { if (proc.pid) setPriority(proc.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* platform policy */ }
      proc.stderr?.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } resolve(false); }, DAEMON_STARTUP_TIMEOUT_MS);
      timer.unref?.();
      proc.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) { this.daemonUnavailable = null; resolve(true); return; }
        // argparse uses exit 2 for an unknown `daemon` subcommand. Do not retry
        // that incompatible CLI every two minutes: mining is off, but search
        // remains active and status tells the user precisely why.
        if (code === 2 && /(?:invalid choice|unrecognized arguments|daemon)/i.test(err)) {
          this.daemonUnavailable = 'MemPalace lacks daemon support; upgrade to 3.7 or newer to enable background mining';
          if (!this.daemonUnavailableLogged) {
            this.daemonUnavailableLogged = true;
            console.error(`[memory] ${this.daemonUnavailable}`);
          }
        } else this.daemonStart = null; // transient start failure: bounded retry may recover
        resolve(false);
      });
      proc.once('error', () => { clearTimeout(timer); this.daemonStart = null; resolve(false); });
    });
    return this.daemonStart;
  }

  private stopDaemon(): void {
    const bin = this.bin();
    if (!bin) return;
    try { spawn(bin, ['daemon', 'stop'], { env: this.childEnv(), stdio: 'ignore' }); } catch { /* best effort */ }
    this.daemonStart = null;
  }

  /** Submit to the resident daemon. The short client does not itself load the
   * vector index. A 60s watchdog kills the wait and backs off one retry path. */
  private mineAgent(agentDir: string, id: string): Promise<boolean> {
    return new Promise((resolve) => {
      void this.ensureDaemon().then((daemonReady) => {
        const bin = this.bin();
        if (!bin || !daemonReady) { resolve(false); return; }
        ensureMineIgnore(agentDir);
        let proc: ReturnType<typeof spawn>;
        try {
          proc = spawn(bin, ['mine', agentDir, '--wing', id, '--agent', id, '--daemon'], {
            env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch { resolve(false); return; }
        let err = '';
        let lastProgress = Date.now();
        const progress = () => { lastProgress = Date.now(); };
        proc.stdout?.on('data', progress);
        proc.stderr?.on('data', (d) => { err += d.toString(); progress(); });
        let watchedOut = false;
        const timer = setInterval(() => {
          if (Date.now() - lastProgress < MINE_WATCHDOG_MS) return;
          watchedOut = true;
          clearInterval(timer);
          if (!this.watchdogLogged.has(id)) {
            this.watchdogLogged.add(id);
            console.error(`[memory] mine ${id} made no progress for ${MINE_WATCHDOG_MS / 1000}s; stopping daemon and backing off`);
          }
          try { proc.kill('SIGTERM'); } catch { /* gone */ }
          ensureKilled(proc.pid);
          this.stopDaemon();
        }, 5_000);
        timer.unref?.();
        proc.once('close', (code) => {
          clearTimeout(timer);
          if (code !== 0 || watchedOut) {
            if (!watchedOut) console.error(`[memory] mine ${id} exited ${code}: ${err.slice(-300)}`);
            // A daemon crash/restart presents to its submit client as a
            // non-zero exit. Forget the cached successful start so the bounded
            // retry starts one fresh below-normal daemon.
            if (!watchedOut) this.stopDaemon();
            resolve(false);
          } else resolve(true);
        });
        proc.once('error', () => { clearTimeout(timer); this.stopDaemon(); resolve(false); });
      });
    });
  }

  // — recall (read) —

  /** Run one mempalace read command asynchronously. These used to be spawnSync
   *  with a 120s timeout — on a cold model load that BLOCKED the Electron main
   *  process (renderer IPC, timers, every window) for up to two minutes. Same
   *  contract, but the event loop keeps breathing and a wedged CLI is swept. */
  private runCli(args: string[], label: string): Promise<{ ok: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!this.active() || !bin) { resolve({ ok: false, output: '', error: 'semantic memory not active' }); return; }
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(bin, args, { env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) });
        return;
      }
      let out = '', err = '';
      let settled = false;
      const settle = (r: { ok: boolean; output: string; error?: string }): void => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(r); }
      };
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      proc.stdout?.on('data', (d: string) => { out += d; });
      proc.stderr?.on('data', (d: string) => { err += d; });
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        ensureKilled(proc.pid);
        settle({ ok: false, output: out, error: `${label} timed out` });
      }, 120_000);
      timer.unref?.();
      proc.on('close', (code) => {
        if (code !== 0) settle({ ok: false, output: out, error: (err || `${label} failed`).trim() });
        else settle({ ok: true, output: out });
      });
      proc.on('error', (e) => settle({ ok: false, output: '', error: e.message }));
    });
  }

  /** Semantic search across the shared palace. Returns the CLI's text output. */
  search(query: string, opts: { wing?: string; results?: number } = {}): Promise<{ ok: boolean; output: string; error?: string }> {
    const args = ['search', query, '--results', String(opts.results ?? 5)];
    if (opts.wing) args.push('--wing', opts.wing);
    return this.runCli(args, 'search');
  }

  /** Session-start digest (~600-900 tokens). */
  wakeUp(wing?: string): Promise<{ ok: boolean; output: string; error?: string }> {
    const args = ['wake-up'];
    if (wing) args.push('--wing', wing);
    return this.runCli(args, 'wake-up');
  }
}
