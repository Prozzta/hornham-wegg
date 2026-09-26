/**
 * NATIVE-MEMORY section 2: deterministic, content-anchored chunks.
 *
 * Chunk-diff ingestion (Jim R7) only works if an edit moves as few chunk boundaries as possible.
 * So boundaries are anchored to the text's own structure, never to a running offset:
 *   - a Markdown heading starts a SECTION; each section is chunked on its own, so an append to
 *     the last section of `memory.md` can change only that section's last chunk;
 *   - inside a section, paragraphs (blank-line separated) are packed greedily up to the token
 *     budget; a paragraph over the budget is split by lines, then by words;
 *   - every chunk of a section carries the section's heading line, so a chunk read alone (a
 *     search hit) still says what it is about.
 * The budget is below MiniLM's 256-wordpiece window (spec section 2), so no chunk's tail is
 * invisible to the vector index.
 */
import { sha256 } from './sources';

export const CHUNKER_VERSION = 1;
/** Wordpieces per chunk, heading included. 256 minus [CLS]/[SEP] minus headroom. */
export const CHUNK_MAX_TOKENS = 200;

export interface Chunk {
  ordinal: number;
  content: string;
  contentSha: string;
}

export type TokenCounter = (text: string) => number;

const HEADING = /^#{1,6}\s+\S/;

interface Section { heading: string; paragraphs: string[] }

function sections(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: '', paragraphs: [] };
  let para: string[] = [];
  let inFence = false;
  const flush = (): void => { const p = para.join('\n').trim(); if (p) cur.paragraphs.push(p); para = []; };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    if (!inFence && HEADING.test(line)) {
      flush();
      if (cur.heading || cur.paragraphs.length) out.push(cur);
      cur = { heading: line.trim(), paragraphs: [] };
      continue;
    }
    if (!inFence && line.trim() === '') { flush(); continue; }
    para.push(line);
  }
  flush();
  if (cur.heading || cur.paragraphs.length) out.push(cur);
  return out;
}

/** Split one over-budget piece: by lines first, then by words. Never returns an empty piece. */
function splitPiece(piece: string, budget: number, count: TokenCounter): string[] {
  if (count(piece) <= budget) return [piece];
  const lines = piece.split('\n');
  if (lines.length > 1) return pack(lines, budget, count, '\n');
  const words = piece.split(/\s+/).filter(Boolean);
  if (words.length > 1) return pack(words, budget, count, ' ');
  // One unbreakable token run (a hash, a long URL): cut by characters.
  const out: string[] = [];
  let s = piece;
  while (s.length) {
    let n = Math.min(s.length, budget * 2);
    while (n > 1 && count(s.slice(0, n)) > budget) n = Math.floor(n * 0.75);
    out.push(s.slice(0, n));
    s = s.slice(n);
  }
  return out;
}

/** Greedy pack of pieces (each already <= budget after splitting) joined by `sep`. */
function pack(pieces: string[], budget: number, count: TokenCounter, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p0 of pieces) {
    for (const p of splitPiece(p0, budget, count)) {
      const next = cur ? cur + sep + p : p;
      if (cur && count(next) > budget) { out.push(cur); cur = p; }
      else cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The chunks of one Markdown file, in order. Deterministic for the same text and counter. */
export function chunkMarkdown(text: string, count: TokenCounter, maxTokens = CHUNK_MAX_TOKENS): Chunk[] {
  const chunks: Chunk[] = [];
  for (const s of sections(text)) {
    const headingCost = s.heading ? count(s.heading) + 1 : 0;
    const budget = Math.max(16, maxTokens - headingCost);
    const bodies = s.paragraphs.length ? pack(s.paragraphs, budget, count, '\n\n') : [];
    if (!bodies.length) continue;   // a heading with no body of its own (a parent of subsections)
    for (const b of bodies) chunks.push({ ordinal: 0, content: s.heading ? `${s.heading}\n${b}` : b, contentSha: '' });
  }
  return chunks.map((c, i) => ({ ordinal: i, content: c.content, contentSha: sha256(c.content) }));
}
