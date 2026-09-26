/**
 * NATIVE-MEMORY section 6: the CLI's text, byte-compatible with MemPalace 3.7.1 `search`
 * (searcher.py, the hybrid path) so agent prompts and habits need no change. `wake-up` follows
 * the section-4 CONTENT contract instead of the legacy layout's contents, but keeps its frame
 * (the "Wake-up text (~N tokens):" header and the L0/L1 headings).
 */
import type { SearchHit } from './store';

export interface SearchFlags {
  wing?: string | null;
  room?: string | null;
  since?: string | null;
  before?: string | null;
}

const base = (p: string): string => p.split('/').pop() ?? p;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Python's str(float) for the scores the legacy CLI prints (`0.436`, `1.347`, `0.0`). */
function py(n: number): string {
  const r = round3(n);
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

export function formatSearch(query: string, flags: SearchFlags, hits: SearchHit[]): string {
  if (!hits.length) return `\n  No results found for: "${query}"\n`;
  const L: string[] = [];
  L.push('', '='.repeat(60), `  Results for: "${query}"`);
  if (flags.wing) L.push(`  Wing: ${flags.wing}`);
  if (flags.room) L.push(`  Room: ${flags.room}`);
  if (flags.since) L.push(`  Since: ${flags.since}`);
  if (flags.before) L.push(`  Before: ${flags.before}`);
  L.push('='.repeat(60), '');
  hits.forEach((h, i) => {
    L.push(`  [${i + 1}] ${h.wing} / ${h.room}`);
    L.push(`      Source: ${base(h.source)}`);
    L.push(`      Match:  cosine_sim=${h.cosineSim === null ? '0.0' : py(h.cosineSim)}  bm25=${h.bm25 === null ? '0.0' : py(h.bm25)}`);
    L.push('');
    for (const line of h.content.trim().split('\n')) L.push(`      ${line}`);
    L.push('');
    L.push(`  ${'-'.repeat(56)}`);
  });
  L.push('');
  return L.join('\n') + '\n';
}

export interface WakeEntry { wing: string; room: string; source: string; content: string }

/** ~800 tokens: the legacy L1 cap was 3200 characters. */
export const WAKE_MAX_CHARS = 3200;
const SNIPPET = 400;

export function formatWakeUp(identity: string | null, entries: WakeEntry[]): string {
  const parts: string[] = [];
  parts.push(identity && identity.trim()
    ? `## L0 — IDENTITY\n${identity.trim().slice(0, 800)}`
    : '## L0 — IDENTITY\nNo identity file for this wing (agents/<id>/identity.md).');
  parts.push('');
  if (!entries.length) {
    parts.push('## L1 — No memories yet.');
  } else {
    const L = ['## L1 — ESSENTIAL STORY'];
    const byRoom = new Map<string, WakeEntry[]>();
    for (const e of entries) { const l = byRoom.get(e.room) ?? []; l.push(e); byRoom.set(e.room, l); }
    const rooms = [...byRoom.keys()].sort((a, b) => (a === 'memory' ? -1 : b === 'memory' ? 1 : a.localeCompare(b)));
    for (const room of rooms) {
      L.push('', `[${room}]`);
      for (const e of byRoom.get(room)!) {
        let s = e.content.trim().replace(/\n+/g, ' ');
        if (s.length > SNIPPET) s = `${s.slice(0, SNIPPET - 3)}...`;
        L.push(`  - ${s}  (${base(e.source)})`);
      }
    }
    parts.push(L.join('\n'));
  }
  const text = parts.join('\n');
  return `Wake-up text (~${Math.floor(text.length / 4)} tokens):\n${'='.repeat(50)}\n${text}\n`;
}

export function formatStatus(s: { sources: number; chunks: number; vectors: number; generation: number; dbBytes: number; perWing: Array<{ wing: string; chunks: number }>; mode: string }): string {
  const L = [`MemPalace (native index, mode ${s.mode}): ${s.sources} sources, ${s.chunks} chunks, ${s.vectors} vectors, ${(s.dbBytes / 1048576).toFixed(1)} MB, generation ${s.generation}`];
  for (const w of s.perWing) L.push(`  WING: ${w.wing}  (${w.chunks} chunks)`);
  return L.join('\n') + '\n';
}
