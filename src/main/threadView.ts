import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile, open } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Private, bounded projection for the Human <-> one agent conversation.
 *
 * This deliberately lives beneath Electron userData, never the hive: hive commits
 * and MemPalace mining must not retain user conversation history. The service is
 * intentionally provider-neutral; adapters may append only receipt-admitted text.
 */
export type ThreadSpeaker = 'human' | 'agent';
export interface ThreadEvent {
  id: string;
  at: number;
  speaker: ThreadSpeaker;
  text: string;
  source: 'human-ui' | 'human-terminal' | 'claude' | 'codex' | 'humanQA';
  truncated?: boolean;
}

export interface ThreadReceipt {
  id: string;
  agentId: string;
  textHash: string;
  at: number;
  kind: 'human-ui' | 'human-terminal' | 'machine';
  /** Monotonic, per-agent terminal receipt number.  This is evidence, not UI state. */
  terminalWindow?: number;
  /** UI enqueue is not delivery: its TTL begins only after the owning submission commits. */
  committedAt?: number;
  consumed?: boolean;
}

/** Versioned, per-user view preference. It is deliberately persisted beside,
 * never inside, the private conversation directories so archive may remove the
 * conversation and preference independently and no event payload shares it. */
export interface ThreadLayoutV1 {
  version: 1;
  preferredView: 'talk' | 'terminal';
  split: null | {
    orientation: 'horizontal' | 'vertical';
    talkDock: 'left' | 'right' | 'top' | 'bottom';
    ratio: number;
  };
  lastSelectedAt: number;
}

const SEGMENT_BYTES = 1 * 1024 * 1024;
export const PER_AGENT_CAP = 8 * 1024 * 1024;
export const GLOBAL_CAP = 128 * 1024 * 1024;
const MAX_EVENT_TEXT_BYTES = 64 * 1024;
export const RECEIPT_TTL_MS = 2 * 60_000;
export const TERMINAL_RECEIPT_WINDOW_MS = 10_000;
export const RECEIPT_LIMIT = 200;

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('invalid thread agent id');
  return id;
}
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function byteTrim(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_EVENT_TEXT_BYTES) return { text, truncated: false };
  return { text: bytes.subarray(0, MAX_EVENT_TEXT_BYTES).toString('utf8') + '\n[truncated]', truncated: true };
}

export class ThreadViewStore {
  private receipts = new Map<string, ThreadReceipt[]>();
  private terminalReceiptWindows = new Map<string, number>();
  private admitted = new Set<string>();
  private tails = new Map<string, { offset: number; remainder: string }>();
  private totalBytes = 0;
  private ledgerDirty = false;
  private ledgerTimer: NodeJS.Timeout | undefined;
  private layouts = new Map<string, ThreadLayoutV1>();
  private layoutsLoaded = false;

  constructor(
    private readonly root: string,
    private readonly onAppend?: (agentId: string, event: ThreadEvent) => void
  ) {}
  private agentDir(agentId: string): string { return join(this.root, safeId(agentId)); }
  private manifest(agentId: string): string { return join(this.agentDir(agentId), 'manifest-v1.json'); }
  private ledger(): string { return join(this.root, 'ledger-v1.json'); }
  private layoutFile(): string { return join(dirname(this.root), 'thread-layout-v1.json'); }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.loadLayouts();
    // One startup accounting pass is intentionally allowed; append paths use memory.
    let total = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.root, entry.name);
      for (const file of await readdir(dir).catch(() => [] as string[])) {
        if (file.endsWith('.jsonl') || file === 'index-v1.json') total += (await stat(join(dir, file)).catch(() => ({ size: 0 }))).size;
      }
    }
    this.totalBytes = total;
    await this.flushLedger();
  }

  async layout(agentId: string, fallback: 'talk' | 'terminal'): Promise<ThreadLayoutV1> {
    safeId(agentId); await this.loadLayouts();
    return this.layouts.get(agentId) ?? defaultLayout(fallback);
  }

  async setLayout(agentId: string, candidate: unknown, fallback: 'talk' | 'terminal'): Promise<ThreadLayoutV1> {
    safeId(agentId); await this.loadLayouts();
    const layout = normalizeLayout(candidate, fallback);
    this.layouts.set(agentId, layout);
    await this.writeLayouts();
    return layout;
  }

  recordReceipt(agentId: string, text: string, kind: ThreadReceipt['kind']): ThreadReceipt {
    const now = Date.now();
    const list = (this.receipts.get(agentId) ?? []).filter((r) => !receiptExpired(r, now)).slice(-RECEIPT_LIMIT + 1);
    // Terminal input has a deliberately short, numbered evidence window.  A later
    // provider echo cannot accidentally promote a stale terminal line into Talk.
    const terminalWindow = kind === 'human-terminal'
      ? (this.terminalReceiptWindows.get(agentId) ?? 0) + 1
      : undefined;
    if (terminalWindow !== undefined) this.terminalReceiptWindows.set(agentId, terminalWindow);
    const receipt = {
      id: randomUUID(), agentId, textHash: hash(text), at: now, kind, terminalWindow,
      ...(kind === 'human-ui' ? {} : { committedAt: now })
    };
    list.push(receipt); this.receipts.set(agentId, list); return receipt;
  }

  /** Called only after AutomaticSubmitOwner has sent Enter.  A queued Human receipt
   * is promoted at this exact edge; otherwise this committed text is machine-origin. */
  commitSubmission(agentId: string, text: string): 'human-ui' | 'machine' {
    const now = Date.now();
    const list = this.receipts.get(agentId) ?? [];
    const pending = list.find((r) => !r.consumed && r.kind === 'human-ui'
      && r.committedAt === undefined && r.textHash === hash(text));
    if (pending) {
      pending.committedAt = now;
      pending.at = now;
      return 'human-ui';
    }
    this.recordReceipt(agentId, text, 'machine');
    return 'machine';
  }

  /** Matches only a one-time Human receipt. A same-window machine receipt wins. */
  consumeHumanReceipt(agentId: string, text: string, at = Date.now()): ThreadReceipt | undefined {
    const list = this.receipts.get(agentId) ?? [];
    const matching = list.filter((r) => !r.consumed && r.textHash === hash(text)
      && Math.abs(at - r.at) <= receiptWindowMs(r));
    if (matching.some((r) => r.kind === 'machine')) return undefined;
    const receipt = matching.find((r) => r.kind === 'human-ui') ?? matching.find((r) => r.kind === 'human-terminal');
    if (receipt) receipt.consumed = true;
    return receipt;
  }

  async append(agentId: string, event: Omit<ThreadEvent, 'id' | 'at' | 'truncated'>): Promise<ThreadEvent> {
    const dir = this.agentDir(agentId); await mkdir(dir, { recursive: true });
    const trimmed = byteTrim(event.text);
    const row: ThreadEvent = { ...event, text: trimmed.text, id: randomUUID(), at: Date.now(), ...(trimmed.truncated ? { truncated: true } : {}) };
    const line = JSON.stringify(row) + '\n';
    await this.pruneAgent(agentId, Buffer.byteLength(line));
    if (this.totalBytes + Buffer.byteLength(line) > GLOBAL_CAP) await this.pruneGlobal(Buffer.byteLength(line));
    const active = join(dir, 'active.jsonl');
    if ((await stat(active).catch(() => ({ size: 0 }))).size + Buffer.byteLength(line) > SEGMENT_BYTES) {
      await rename(active, join(dir, `closed-${Date.now()}.jsonl`)).catch(() => undefined);
    }
    await appendFile(active, line, 'utf8');
    this.totalBytes += Buffer.byteLength(line);
    await this.writeManifest(agentId);
    this.scheduleLedger();
    // Emit only the normalized, already-persisted projection; raw provider rows
    // never leave this store. The renderer merges by stable event id.
    this.onAppend?.(agentId, row);
    return row;
  }

  /** Provider adapters intentionally display one source only: Claude transcript
   * message text and Codex event_msg. response_item/tool records never reach Talk. */
  async ingestClaudeLine(agentId: string, line: string): Promise<void> {
    let row: any; try { row = JSON.parse(line); } catch { return; }
    const text = textOf(row?.message?.content ?? row?.content);
    if (!text) return;
    if (row?.type === 'user') {
      if (this.consumeHumanReceipt(agentId, text, Number(row?.timestamp) || Date.now())) this.admitted.add(agentId);
      return;
    }
    if (row?.type === 'assistant' && this.admitted.has(agentId)) await this.append(agentId, { speaker: 'agent', text, source: 'claude' });
  }

  async ingestCodexLine(agentId: string, line: string): Promise<void> {
    let row: any; try { row = JSON.parse(line); } catch { return; }
    if (row?.type !== 'event_msg') return; // response_item duplicates messages; never display it.
    const kind = row?.payload?.type;
    const text = textOf(row?.payload?.message ?? row?.payload?.text ?? row?.payload?.content);
    if (!text) return;
    if (kind === 'user_message') {
      if (this.consumeHumanReceipt(agentId, text, Date.parse(row?.timestamp) || Date.now())) this.admitted.add(agentId);
    } else if (kind === 'agent_message' && this.admitted.has(agentId)) {
      await this.append(agentId, { speaker: 'agent', text, source: 'codex' });
    }
  }

  /** Incremental, complete-line tail: never loads a rollout/transcript whole. */
  async tail(file: string, consume: (line: string) => Promise<void>): Promise<void> {
    const previous = this.tails.get(file) ?? { offset: 0, remainder: '' };
    const size = (await stat(file).catch(() => undefined))?.size;
    if (size === undefined) return;
    const offset = size < previous.offset ? 0 : previous.offset;
    const length = Math.min(64 * 1024, Math.max(0, size - offset));
    if (!length) return;
    const handle = await open(file, 'r'); const buffer = Buffer.alloc(length);
    try { await handle.read(buffer, 0, length, offset); } finally { await handle.close(); }
    const all = previous.remainder + buffer.toString('utf8'); const lines = all.split('\n');
    const remainder = lines.pop() ?? '';
    this.tails.set(file, { offset: offset + length, remainder });
    for (const line of lines) if (line) await consume(line);
  }

  async list(agentId: string, limit = 500): Promise<ThreadEvent[]> {
    const dir = this.agentDir(agentId);
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl')).sort();
    const rows: ThreadEvent[] = [];
    for (const name of names) {
      const raw = await readFile(join(dir, name), 'utf8').catch(() => '');
      for (const line of raw.split('\n')) { if (!line) continue; try { rows.push(JSON.parse(line) as ThreadEvent); } catch { /* torn line: retry on next read */ } }
    }
    return rows.sort((a, b) => a.at - b.at).slice(-Math.max(1, Math.min(limit, 1000)));
  }

  async archive(agentId: string): Promise<void> {
    const dir = this.agentDir(agentId);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    this.receipts.delete(agentId); this.terminalReceiptWindows.delete(agentId);
    await this.loadLayouts();
    if (this.layouts.delete(agentId)) await this.writeLayouts();
    await this.init();
  }

  /** Conservative maintenance only. The caller supplies a live registry probe so
   * each candidate is checked again immediately before deletion; inactive but
   * registered agents are never candidates. */
  async sweepOrphans(isRegistered: (agentId: string) => boolean, sweepStartedAt = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const entry of entries) {
      // Direct real directories only: never recurse or follow a junction/symlink.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let agentId: string;
      try { agentId = safeId(entry.name); } catch { continue; }
      if (isRegistered(agentId)) continue;
      const dir = join(this.root, entry.name);
      const dirInfo = await stat(dir).catch(() => undefined);
      if (!dirInfo || dirInfo.mtimeMs >= sweepStartedAt) continue;
      const manifest = await stat(join(dir, 'manifest-v1.json')).catch(() => undefined);
      if (!manifest?.isFile()) continue;
      // Registry must be read at the deletion edge, not only at scan start.
      if (isRegistered(agentId)) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      this.receipts.delete(agentId); this.terminalReceiptWindows.delete(agentId);
      if (this.layouts.delete(agentId)) await this.writeLayouts();
      removed.push(agentId);
    }
    if (removed.length) await this.init();
    return removed;
  }

  private async loadLayouts(): Promise<void> {
    if (this.layoutsLoaded) return;
    this.layoutsLoaded = true;
    const raw = await readFile(this.layoutFile(), 'utf8').catch(() => '');
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return; }
    const rows = parsed && typeof parsed === 'object' ? (parsed as any).layouts : undefined;
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return;
    for (const [agentId, candidate] of Object.entries(rows)) {
      try { this.layouts.set(safeId(agentId), normalizeLayout(candidate, 'terminal')); } catch { /* malformed row is ignored */ }
    }
  }

  private async writeLayouts(): Promise<void> {
    await mkdir(dirname(this.layoutFile()), { recursive: true });
    const layouts = Object.fromEntries(this.layouts);
    const tmp = `${this.layoutFile()}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, layouts }), 'utf8');
    await rename(tmp, this.layoutFile());
  }

  private async writeManifest(agentId: string): Promise<void> {
    const dir = this.agentDir(agentId);
    const body = JSON.stringify({ version: 1, agentId, updatedAt: Date.now() });
    const tmp = join(dir, 'manifest-v1.tmp'); await writeFile(tmp, body, 'utf8'); await rename(tmp, this.manifest(agentId));
  }
  private scheduleLedger(): void {
    if (this.ledgerDirty) return;
    this.ledgerDirty = true;
    this.ledgerTimer = setTimeout(() => { void this.flushLedger(); }, 1000);
  }
  private async flushLedger(): Promise<void> {
    if (this.ledgerTimer) clearTimeout(this.ledgerTimer);
    this.ledgerTimer = undefined; this.ledgerDirty = false;
    await mkdir(this.root, { recursive: true });
    const tmp = `${this.ledger()}.tmp`; await writeFile(tmp, JSON.stringify({ version: 1, totalBytes: this.totalBytes, updatedAt: Date.now() }), 'utf8'); await rename(tmp, this.ledger());
  }
  private async pruneGlobal(required: number): Promise<void> {
    const closed: Array<{ path: string; mtimeMs: number; size: number }> = [];
    for (const agent of await readdir(this.root, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      for (const file of await readdir(join(this.root, agent.name)).catch(() => [] as string[])) {
        if (!file.startsWith('closed-') || !file.endsWith('.jsonl')) continue;
        const path = join(this.root, agent.name, file); const s = await stat(path).catch(() => undefined);
        if (s) closed.push({ path, mtimeMs: s.mtimeMs, size: s.size });
      }
    }
    for (const item of closed.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (this.totalBytes + required <= GLOBAL_CAP) break;
      await rm(item.path, { force: true }); this.totalBytes = Math.max(0, this.totalBytes - item.size);
    }
  }

  /** Preserve the active segment and evict this agent's oldest completed history first. */
  private async pruneAgent(agentId: string, required: number): Promise<void> {
    const dir = this.agentDir(agentId);
    const closed: Array<{ path: string; mtimeMs: number; size: number }> = [];
    let bytes = 0;
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(dir, file); const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      bytes += info.size;
      if (file.startsWith('closed-')) closed.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    }
    for (const item of closed.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (bytes + required <= PER_AGENT_CAP) break;
      await rm(item.path, { force: true });
      bytes -= item.size;
      this.totalBytes = Math.max(0, this.totalBytes - item.size);
    }
  }
}

function receiptWindowMs(receipt: ThreadReceipt): number {
  return receipt.kind === 'human-terminal' || receipt.kind === 'machine'
    ? TERMINAL_RECEIPT_WINDOW_MS
    : RECEIPT_TTL_MS;
}

function defaultLayout(preferredView: 'talk' | 'terminal'): ThreadLayoutV1 {
  return { version: 1, preferredView, split: null, lastSelectedAt: Date.now() };
}

function normalizeLayout(candidate: unknown, fallback: 'talk' | 'terminal'): ThreadLayoutV1 {
  const value = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
  const preferredView = value.preferredView === 'talk' || value.preferredView === 'terminal'
    ? value.preferredView : fallback;
  const sourceSplit = value.split && typeof value.split === 'object' ? value.split as Record<string, unknown> : undefined;
  const split = sourceSplit
    && (sourceSplit.orientation === 'horizontal' || sourceSplit.orientation === 'vertical')
    && (sourceSplit.talkDock === 'left' || sourceSplit.talkDock === 'right' || sourceSplit.talkDock === 'top' || sourceSplit.talkDock === 'bottom')
    && typeof sourceSplit.ratio === 'number' && Number.isFinite(sourceSplit.ratio)
    ? { orientation: sourceSplit.orientation, talkDock: sourceSplit.talkDock, ratio: Math.max(0.25, Math.min(0.75, sourceSplit.ratio)) } as ThreadLayoutV1['split']
    : null;
  return {
    version: 1,
    preferredView,
    split,
    lastSelectedAt: typeof value.lastSelectedAt === 'number' && Number.isFinite(value.lastSelectedAt) ? value.lastSelectedAt : Date.now()
  };
}

function receiptExpired(receipt: ThreadReceipt, now: number): boolean {
  // Pending UI work is bounded by count, rather than an arbitrary timeout while the
  // agent is busy or a Human-resolved INTERFERED hold is still awaiting delivery.
  if (receipt.kind === 'human-ui' && receipt.committedAt === undefined) return false;
  return now - (receipt.committedAt ?? receipt.at) > receiptWindowMs(receipt);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((block: any) => block?.type === 'text' && typeof block.text === 'string' ? block.text : block?.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
}

export function threadRoot(userData: string): string { return resolve(userData, 'threads'); }
export function isPrivateThreadPath(path: string, root: string): boolean { return resolve(path).startsWith(resolve(root) + sep) || resolve(path) === resolve(root); }
