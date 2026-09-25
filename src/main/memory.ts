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
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as osConstants, setPriority } from 'node:os';
import { ensureKilled, hardKillTree } from './procKill';
import { quarantineDirsToReap, quarantineStampMs, nextMineDelayMs } from './palaceReap';
import {
  archivedAgentIds, fingerprintMemory, loadMineState, queueChangedMemory,
  readyMineIds, sameFingerprint, saveMineState, type MineState, type PendingMine
} from './incrementalMiner';
import { carryEmbedderRecord, dataLevel0Bytes, rebuildNeeded, repairStatusCounts, repairStatusEmbeddingCount, sameCollectionCounts, swapStagedPalace } from './palaceRebuild';

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
  /** `one-shot` is compatible but costs more than the resident daemon. */
  miningMode: 'unknown' | 'daemon' | 'one-shot';
  miningWarning: string | null;
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
/** MINE-152 X2: mines are judged by the daemon's job state and wall caps, NEVER by
 *  output silence (a big palace keeps a mine silent for many minutes).
 *  - a short CLI client (submit, jobs, status): */
const JOB_CLIENT_MAX_MS = 2 * 60_000;
/** - one `daemon wait` client's lifetime; a job still running after it is waited again: */
const JOB_WAIT_SLICE_MS = 10 * 60_000;
/** - how long one mine job is waited for in total before the pass moves on (the job is
 *    left running in the daemon; the fingerprint stays unsaved, so it is retried): */
const MINE_JOB_MAX_MS = 60 * 60_000;
/** - the gap between checks when a wait client ends early while the job is alive: */
const JOB_POLL_MIN_MS = 15_000;
/** - a one-shot mine (no daemon on this CLI), wall clock: */
const ONE_SHOT_MAX_MS = 30 * 60_000;
/** - a palace repair (the live 674 MB palace rebuilt in ~64 s; generous on purpose): */
const REPAIR_MAX_MS = 30 * 60_000;

/** A job's state in `mempalace daemon jobs` output (`<id>  <state>  <kind>  <iso>`), or
 *  'missing' when it is not listed. */
export function parseDaemonJobState(output: string, jobId: string): string {
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === jobId && cols[1]) return cols[1].toLowerCase();
  }
  return 'missing';
}
const MINE_RETRY_MS = 120_000;
/** Starvation cap: a memory.md that keeps changing (a note every minute) never goes
 *  quiet for the debounce, so it is mined at most this long after its oldest unmined
 *  change anyway. The per-agent 10-minute churn cap still applies on top. */
const MINE_MAX_WAIT_MS = 600_000;
/** First-boot grace for `mempalace daemon start`: a SUPPORTED daemon may spend minutes
 *  loading (or downloading) its embedding model before it reports ready. Slow is not
 *  unsupported: when this runs out the start is abandoned and retried later, and there
 *  is NO one-shot mining meanwhile (only a usage error means "no daemon"). */
const DAEMON_STARTUP_TIMEOUT_MS = 10 * 60_000;
/** How long quit waits for `mempalace daemon stop`. */
const QUIT_DAEMON_STOP_MS = 5_000;
/** How long a fallback waits for a `daemon stop` before it proceeds. */
const DAEMON_STOP_WAIT_MS = 30_000;
/** Re-probe a compatibility fallback periodically so an in-session CLI upgrade
 * regains the low-cost daemon without requiring an app restart. */
const DAEMON_RETRY_MS = 30 * 60_000;
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
  private daemonRetryAt = 0;
  private rebuilding = false;
  /** Log a stalled job once, then retry after backoff without a log storm. */
  private readonly watchdogLogged = new Set<string>();
  /** Every mempalace child this manager started and that is still running (mines,
   *  the daemon start/stop clients, repairs, reads), so stop() can kill their trees. */
  private readonly children = new Set<ChildProcess>();
  /** A `daemon start` was issued since the last completed `daemon stop`: a resident
   *  daemon may be running and quit must stop it. */
  private daemonMayRun = false;
  private slowDaemonLogged = false;
  /** Instance copy so a test can shorten the first-boot grace. */
  private daemonStartupTimeoutMs = DAEMON_STARTUP_TIMEOUT_MS;

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
      miningMode: this.daemonUnavailable ? 'one-shot' : this.daemonStart ? 'daemon' : 'unknown',
      miningWarning: this.daemonUnavailable
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

  /**
   * Stop mining, and leave nothing behind. Every mempalace child still running (a mine,
   * a repair, the daemon start/stop clients) is killed with its whole process tree:
   * mempalace is a launcher around python, and killing only the launcher orphans the
   * python child. A daemon this manager may have started is stopped with
   * `mempalace daemon stop`: synchronously and bounded when quitting (nothing async
   * survives quit), fire-and-forget otherwise (home change, reset).
   */
  stop(opts: { quitting?: boolean } = {}): void {
    this.mineStopped = true;
    if (this.mineTimer) { clearTimeout(this.mineTimer); this.mineTimer = null; }
    for (const child of [...this.children]) {
      if (child.pid) hardKillTree(child.pid);
    }
    this.children.clear();
    if (!this.daemonMayRun) return;
    this.daemonMayRun = false;
    this.daemonStart = null;
    const bin = this.bin();
    if (!bin) return;
    if (opts.quitting) {
      try { spawnSync(bin, ['daemon', 'stop'], { env: this.childEnv(), stdio: 'ignore', timeout: QUIT_DAEMON_STOP_MS, windowsHide: true }); }
      catch { /* best effort: quit goes ahead */ }
    } else {
      void this.stopDaemon();
    }
  }

  /** spawn + remember the child until it exits, so stop() can reap it. */
  private spawnTracked(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
    const proc = spawn(bin, args, opts);
    this.children.add(proc);
    const forget = (): void => { this.children.delete(proc); };
    proc.once('close', forget);
    proc.once('error', forget);
    return proc;
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
    if (!this.active() || !home || !bin || this.mineStopped) return;
    if (this.mining) return; // a previous pass is still running — let it finish
    // Mines and a palace rebuild are mutually exclusive (both flags are set before
    // their first await, so this is a real exclusion on the one main thread). A mine
    // that landed in the live palace after the rebuild's staging read would be dropped
    // by the swap while its fingerprint said "mined". Deferred, not lost: the next tick.
    if (this.rebuilding) return;
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
        queueChangedMemory(this.pendingMines, id, fingerprint, now, MINE_DEBOUNCE_MS, MINE_MAX_WAIT_MS);
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
    if (!palace || !bin || this.rebuilding || this.mining || this.mineStopped || !existsSync(palace)) return;
    this.rebuilding = true;
    try {
      // Anything mined into the LIVE palace from here on is not in the staged copy.
      const stagingReadAt = Date.now();
      const status = await this.runRaw(bin, ['--palace', palace, 'repair-status']);
      // Per collection (MemPalace 3.7.1 prints `[drawers] sqlite count: N`, `[closets] ...`).
      const counts = status.ok ? repairStatusCounts(status.output) : null;
      const count = status.ok ? repairStatusEmbeddingCount(status.output) : null;
      if (!counts || !count || !rebuildNeeded(dataLevel0Bytes(palace), count)) return;
      const stamp = String(Date.now());
      const staged = `${palace}.mempalace-rebuild-${stamp}`;
      const backup = `${palace}.mempalace-backup-${stamp}`;
      const discardStaged = (): void => { try { rmSync(staged, { recursive: true, force: true }); } catch { /* retried by nothing; harmless */ } };
      const built = await this.runRaw(bin, ['--palace', staged, 'repair', '--mode', 'from-sqlite', '--source', palace, '--yes', '--no-backup']);
      if (this.mineStopped) { discardStaged(); return; }
      if (!built.ok) { discardStaged(); console.error('[memory] palace rebuild staging failed; live palace left untouched'); return; }
      const verified = await this.runRaw(bin, ['--palace', staged, 'repair-status']);
      if (!sameCollectionCounts(counts, repairStatusCounts(verified.output))) {
        discardStaged();
        console.error('[memory] palace rebuild verification failed; live palace left untouched');
        return;
      }
      // A from-sqlite rebuild does not write mempalace_embedder.json, and without it every
      // later open warns and assumes the current model. The rebuild embedded with THIS
      // model, so the old record is carried over only when it names the same model.
      carryEmbedderRecord(palace, staged, this.model());
      // Windows cannot rename a directory whose files a process holds open: a resident
      // daemon (from this or an earlier session) would make the swap fail. Stop it first.
      await this.stopDaemon();
      if (swapStagedPalace(palace, staged, backup)) {
        console.log(`[memory] rebuilt bloated palace; previous palace retained at ${backup}`);
        this.invalidateMinedSince(stagingReadAt);
      } else console.error('[memory] palace rebuild swap failed; live palace restored/untouched');
    } finally { this.rebuilding = false; }
  }

  /** After a swap, forget every fingerprint recorded since the staging read: that
   *  content went into the OLD palace, not the staged one now live, so it must be mined
   *  again. The mine exclusion means there should be none; this is the backstop. */
  private invalidateMinedSince(stagingReadAt: number): void {
    const home = this.getHome();
    if (!home) return;
    this.mineState ??= loadMineState(home);
    let dropped = 0;
    for (const [id, entry] of Object.entries(this.mineState.entries)) {
      if ((entry.minedAt ?? 0) >= stagingReadAt) { delete this.mineState.entries[id]; dropped += 1; }
    }
    if (dropped) {
      saveMineState(home, this.mineState);
      console.warn(`[memory] ${dropped} memory file(s) mined during the rebuild will be mined again`);
    }
  }

  private runRaw(bin: string, args: string[]): Promise<{ ok: boolean; output: string }> {
    return this.runCapture(bin, args, REPAIR_MAX_MS).then((r) => ({ ok: r.ok, output: r.output }));
  }

  /** One mempalace CLI call at below-normal priority, output captured, with a WALL cap
   *  (never a silence cap: a busy index writes nothing for minutes). At the cap the
   *  client's whole tree is killed. Killing a client never touches the daemon. */
  private runCapture(bin: string, args: string[], capMs: number): Promise<{ ok: boolean; code: number | null; output: string; error: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try { proc = this.spawnTracked(bin, args, { env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { resolve({ ok: false, code: null, output: '', error: String(e), timedOut: false }); return; }
      try { if (proc.pid) setPriority(proc.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* platform policy */ }
      let output = '', error = '', timedOut = false, settled = false;
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0 && !timedOut, code, output, error, timedOut });
      };
      proc.stdout?.on('data', (d) => { output += d.toString(); });
      proc.stderr?.on('data', (d) => { error += d.toString(); });
      const timer = setTimeout(() => { timedOut = true; if (proc.pid) hardKillTree(proc.pid); finish(null); }, capMs);
      timer.unref?.();
      proc.once('close', (code) => finish(code));
      proc.once('error', () => finish(null));
    });
  }

  /** Start MemPalace's opt-in daemon once. It owns the model and HNSW writer
   * for all later jobs, avoiding a full Python/index load per changed agent. */
  private ensureDaemon(): Promise<boolean> {
    // An old CLI or a timed-out launch takes the compatible one-shot route for
    // a while.  Retrying every mine would recreate the very process churn this
    // daemon was introduced to remove; retrying after an upgrade window is
    // enough to recover without an app restart.
    if (this.daemonUnavailable) {
      if (Date.now() < this.daemonRetryAt) return Promise.resolve(false);
      this.daemonUnavailable = null;
      this.daemonStart = null;
    }
    if (this.daemonStart) return this.daemonStart;
    this.daemonStart = new Promise((resolve) => {
      const bin = this.bin();
      if (!bin) { resolve(false); return; }
      let proc: ReturnType<typeof spawn>;
      let err = '';
      let settled = false;
      const settle = (ready: boolean): void => {
        if (!settled) { settled = true; resolve(ready); }
      };
      try { proc = this.spawnTracked(bin, ['daemon', 'start'], { env: this.childEnv(), stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch { this.daemonStart = null; settle(false); return; }
      this.daemonMayRun = true;
      // The daemon's child inherits this on Windows; on POSIX it keeps model
      // maintenance below Electron and active CLI work. Best-effort only.
      try { if (proc.pid) setPriority(proc.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* platform policy */ }
      proc.stderr?.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => {
        // SLOW, not unsupported: no usage error came back. Never a reason for one-shot
        // mining. Abandon this start (the client's whole tree, then `daemon stop`, so no
        // half-started daemon is left running), and let the normal retry try again.
        if (proc.pid) hardKillTree(proc.pid);
        this.daemonStart = null;
        if (!this.slowDaemonLogged) {
          this.slowDaemonLogged = true;
          console.error(`[memory] MemPalace daemon did not become ready in ${this.daemonStartupTimeoutMs / 1000}s; mining deferred, will retry`);
        }
        void this.stopDaemon().then(() => settle(false));
      }, this.daemonStartupTimeoutMs);
      timer.unref?.();
      proc.once('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        if (code === 0) { this.daemonUnavailable = null; settle(true); return; }
        // argparse exits 2 for an unknown `daemon` subcommand: THIS CLI has no daemon.
        // Mining falls back to one-shot runs (search is unaffected), and the daemon is
        // re-probed after DAEMON_RETRY_MS so an in-session upgrade recovers. Before the
        // fallback, `daemon stop` makes sure no daemon runs beside the one-shot mines.
        if (code === 2 && /(?:invalid choice|unrecognized arguments|daemon)/i.test(err)) {
          void this.stopDaemon().then(() => {
            this.markDaemonUnavailable('MemPalace has no daemon: using one-shot mining; upgrade to 3.7.1 or newer for the low-cost daemon');
            settle(false);
          });
          return;
        }
        this.daemonStart = null; // transient start failure: bounded retry may recover
        settle(false);
      });
      proc.once('error', () => { clearTimeout(timer); this.daemonStart = null; settle(false); });
    });
    return this.daemonStart;
  }

  private markDaemonUnavailable(message: string): void {
    this.daemonUnavailable = message;
    this.daemonRetryAt = Date.now() + DAEMON_RETRY_MS;
    if (!this.daemonUnavailableLogged) {
      this.daemonUnavailableLogged = true;
      console.error(`[memory] ${message}`);
    }
  }

  /** `mempalace daemon stop`. Resolves when it exits, or after DAEMON_STOP_WAIT_MS. */
  private stopDaemon(): Promise<void> {
    this.daemonStart = null;
    const bin = this.bin();
    if (!bin) return Promise.resolve();
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try { proc = this.spawnTracked(bin, ['daemon', 'stop'], { env: this.childEnv(), stdio: 'ignore' }); }
      catch { resolve(); return; }
      const timer = setTimeout(() => { if (proc.pid) hardKillTree(proc.pid); resolve(); }, DAEMON_STOP_WAIT_MS);
      timer.unref?.();
      proc.once('close', () => { clearTimeout(timer); this.daemonMayRun = false; resolve(); });
      proc.once('error', () => { clearTimeout(timer); resolve(); });
    });
  }

  /** Submit a daemon or compatible one-shot job. Both use the same single
   * queue, debounce, durable fingerprint, priority, and watchdog safeguards. */
  private mineAgent(agentDir: string, id: string): Promise<boolean> {
    return this.ensureDaemon().then((daemonReady) => {
      if (daemonReady) return this.submitMine(agentDir, id, true);
      // A supported daemon can still have a transient launch failure; retain
      // the regular retry path.  Only the explicitly diagnosed old/hung mode
      // takes the bounded compatibility route.
      return this.daemonUnavailable ? this.mineOneShot(agentDir, id) : false;
    });
  }

  private mineOneShot(agentDir: string, id: string): Promise<boolean> {
    return this.submitMine(agentDir, id, false);
  }

  /**
   * Run one mine job to completion (true) or failure (false).
   *
   * MINE-152 X2: a mine on a large palace is SILENT for many minutes while it embeds and
   * writes; judging it by stdout silence killed every mine and, worse, stopped the daemon
   * (an ~850 MB model reload) each time: a loop in which nothing was ever mined. Now:
   *   - daemon: submit with `--background` (returns a job id at once), then `daemon wait`
   *     on it. Liveness is the daemon's own job state: a job that is still `running` or
   *     `queued` is alive and is waited for (in slices, up to MINE_JOB_MAX_MS), however
   *     quiet it is. A client that times out is only a client: the daemon is NEVER
   *     stopped for it. The daemon start is forgotten only when the daemon is unreachable
   *     (and `daemon start` is idempotent, so a live daemon is never reloaded).
   *   - one-shot (no daemon on this CLI): a plain wall cap, ONE_SHOT_MAX_MS.
   */
  private async submitMine(agentDir: string, id: string, daemon: boolean): Promise<boolean> {
    const bin = this.bin();
    if (!bin || this.mineStopped) return false;
    ensureMineIgnore(agentDir);
    const args = ['mine', agentDir, '--wing', id, '--agent', id];
    if (!daemon) {
      const r = await this.runCapture(bin, args, ONE_SHOT_MAX_MS);
      if (!r.ok) this.logMineOnce(id, r.timedOut ? `one-shot mine ${id} still running after ${ONE_SHOT_MAX_MS / 60_000} min; stopped it, will retry` : `mine ${id} exited ${r.code}: ${r.error.slice(-300)}`);
      return r.ok;
    }
    const submitted = await this.runCapture(bin, [...args, '--daemon', '--background'], JOB_CLIENT_MAX_MS);
    if (this.mineStopped) return false;   // quit killed the client: start nothing more
    const jobId = /Submitted daemon job ([0-9a-f]{8,})/i.exec(submitted.output)?.[1];
    if (!submitted.ok || !jobId) {
      this.logMineOnce(id, `mine ${id}: the daemon did not accept the job (${submitted.timedOut ? 'timed out' : `exit ${submitted.code}`})`);
      await this.forgetDaemonIfDead(bin);
      return false;
    }
    const startedAt = Date.now();
    while (!this.mineStopped) {
      const sliceStart = Date.now();
      const waited = await this.runCapture(bin, ['daemon', 'wait', jobId], JOB_WAIT_SLICE_MS);
      if (this.mineStopped) return false;
      if (waited.ok) { this.watchdogLogged.delete(id); return true; }
      const state = await this.daemonJobState(bin, jobId);
      if (state === 'succeeded') { this.watchdogLogged.delete(id); return true; }
      if (state === 'running' || state === 'queued' || state === 'pending') {
        if (Date.now() - startedAt >= MINE_JOB_MAX_MS) {
          this.logMineOnce(id, `mine ${id} is still ${state} in the daemon after ${MINE_JOB_MAX_MS / 60_000} min; leaving it to finish, will check again later`);
          return false;
        }
        // Alive: wait again. A wait client that failed fast must not spin.
        if (Date.now() - sliceStart < JOB_POLL_MIN_MS) await this.sleep(JOB_POLL_MIN_MS);
        continue;
      }
      if (state === null) await this.forgetDaemonIfDead(bin);
      this.logMineOnce(id, `mine ${id}: daemon job ${jobId} ended ${state ?? 'with the daemon unreachable'}`);
      return false;
    }
    return false;
  }

  /** The daemon's recorded state of a job ('running', 'succeeded', ...), 'missing' when
   *  the daemon does not list it, or null when the daemon cannot be reached. */
  private async daemonJobState(bin: string, jobId: string): Promise<string | null> {
    const r = await this.runCapture(bin, ['daemon', 'jobs', '--limit', '100'], JOB_CLIENT_MAX_MS);
    if (!r.ok) return null;
    return parseDaemonJobState(r.output, jobId);
  }

  /** Forget the cached daemon start ONLY when the daemon is actually not running, so the
   *  next mine starts one. A slow or busy daemon is left alone. */
  private async forgetDaemonIfDead(bin: string): Promise<void> {
    const s = await this.runCapture(bin, ['daemon', 'status'], JOB_CLIENT_MAX_MS);
    if (!/daemon is running/i.test(s.output)) this.daemonStart = null;
  }

  private logMineOnce(id: string, line: string): void {
    if (this.watchdogLogged.has(id)) return;
    this.watchdogLogged.add(id);
    console.error(`[memory] ${line}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
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
        proc = this.spawnTracked(bin, args, { env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
