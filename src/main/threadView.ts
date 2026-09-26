import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

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
  consumed?: boolean;
}

const SEGMENT_BYTES = 1 * 1024 * 1024;
export const PER_AGENT_CAP = 8 * 1024 * 1024;
export const GLOBAL_CAP = 128 * 1024 * 1024;
const MAX_EVENT_TEXT_BYTES = 64 * 1024;
const RECEIPT_TTL_MS = 2 * 60_000;
const RECEIPT_LIMIT = 200;

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
  private totalBytes = 0;
  private ledgerDirty = false;
  private ledgerTimer: NodeJS.Timeout | undefined;

  constructor(private readonly root: string) {}
  private agentDir(agentId: string): string { return join(this.root, safeId(agentId)); }
  private manifest(agentId: string): string { return join(this.agentDir(agentId), 'manifest-v1.json'); }
  private ledger(): string { return join(this.root, 'ledger-v1.json'); }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
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

  recordReceipt(agentId: string, text: string, kind: ThreadReceipt['kind']): ThreadReceipt {
    const now = Date.now();
    const list = (this.receipts.get(agentId) ?? []).filter((r) => now - r.at <= RECEIPT_TTL_MS).slice(-RECEIPT_LIMIT + 1);
    const receipt = { id: randomUUID(), agentId, textHash: hash(text), at: now, kind };
    list.push(receipt); this.receipts.set(agentId, list); return receipt;
  }

  /** Matches only a one-time Human receipt. A same-window machine receipt wins. */
  consumeHumanReceipt(agentId: string, text: string, at = Date.now()): ThreadReceipt | undefined {
    const list = this.receipts.get(agentId) ?? [];
    const matching = list.filter((r) => !r.consumed && r.textHash === hash(text) && Math.abs(at - r.at) <= RECEIPT_TTL_MS);
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
    if (this.totalBytes + Buffer.byteLength(line) > GLOBAL_CAP) await this.pruneGlobal(Buffer.byteLength(line));
    const active = join(dir, 'active.jsonl');
    if ((await stat(active).catch(() => ({ size: 0 }))).size + Buffer.byteLength(line) > SEGMENT_BYTES) {
      await rename(active, join(dir, `closed-${Date.now()}.jsonl`)).catch(() => undefined);
    }
    await appendFile(active, line, 'utf8');
    this.totalBytes += Buffer.byteLength(line);
    await this.writeManifest(agentId);
    this.scheduleLedger();
    return row;
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
    this.receipts.delete(agentId); await this.init();
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
}

export function threadRoot(userData: string): string { return resolve(userData, 'threads'); }
export function isPrivateThreadPath(path: string, root: string): boolean { return resolve(path).startsWith(resolve(root) + sep) || resolve(path) === resolve(root); }
