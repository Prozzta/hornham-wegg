/**
 * NATIVE-MEMORY: the BERT uncased WordPiece tokenizer of all-MiniLM-L6-v2, from its own
 * `tokenizer.json`, with no Transformers.js. Transformers.js would ship `sharp`, the
 * onnxruntime-web WASM assets and ~48 MB of JS to do exactly this; the spec's packaging
 * section wants all of that pruned. Parity with Transformers.js is a test (token ids equal on
 * the real corpus), not an assumption.
 *
 * The pipeline, as the tokenizer.json declares it:
 *   BertNormalizer   clean_text, handle_chinese_chars, lowercase (strip_accents null +
 *                    lowercase = strip accents)
 *   BertPreTokenizer split on whitespace, and every punctuation character is its own token
 *   WordPiece        greedy longest match, `##` continuation, [UNK] for an unmatched word or
 *                    one longer than max_input_chars_per_word
 *   Template         [CLS] tokens [SEP]
 */

export interface WordPieceConfig {
  vocab: Record<string, number>;
  unkToken: string;
  continuingPrefix: string;
  maxInputCharsPerWord: number;
  clsToken: string;
  sepToken: string;
}

/** Read the parts of a HuggingFace `tokenizer.json` this tokenizer needs; throws on a shape it
 *  does not implement (a different model must not be silently mis-tokenized). */
export function wordPieceConfigFromTokenizerJson(json: unknown): WordPieceConfig {
  const t = json as {
    normalizer?: { type?: string; lowercase?: boolean; strip_accents?: boolean | null; handle_chinese_chars?: boolean; clean_text?: boolean };
    pre_tokenizer?: { type?: string };
    model?: { type?: string; vocab?: Record<string, number>; unk_token?: string; continuing_subword_prefix?: string; max_input_chars_per_word?: number };
  };
  const n = t.normalizer;
  if (n?.type !== 'BertNormalizer' || n.lowercase !== true || n.strip_accents === false || n.handle_chinese_chars !== true || n.clean_text !== true) {
    throw new Error('wordpiece: unsupported normalizer');
  }
  if (t.pre_tokenizer?.type !== 'BertPreTokenizer') throw new Error('wordpiece: unsupported pre-tokenizer');
  const m = t.model;
  if (m?.type !== 'WordPiece' || !m.vocab) throw new Error('wordpiece: unsupported model');
  return {
    vocab: m.vocab,
    unkToken: m.unk_token ?? '[UNK]',
    continuingPrefix: m.continuing_subword_prefix ?? '##',
    maxInputCharsPerWord: m.max_input_chars_per_word ?? 100,
    clsToken: '[CLS]',
    sepToken: '[SEP]'
  };
}

function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false;
  return /^[\p{Cc}\p{Cf}]$/u.test(ch);
}
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || /^\p{Zs}$/u.test(ch);
}
function isChinese(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df)
    || (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}
function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /^\p{P}$/u.test(ch);
}

/** BertNormalizer + BertPreTokenizer: the words WordPiece sees. */
export function basicTokens(text: string): string[] {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
    if (isWhitespace(ch)) { out += ' '; continue; }
    if (isChinese(cp)) { out += ` ${ch} `; continue; }
    out += ch;
  }
  // lowercase, then strip accents (NFD, drop combining marks)
  out = out.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  const words: string[] = [];
  for (const w of out.split(' ')) {
    if (!w) continue;
    let cur = '';
    for (const ch of w) {
      if (isPunctuation(ch)) { if (cur) words.push(cur); words.push(ch); cur = ''; }
      else cur += ch;
    }
    if (cur) words.push(cur);
  }
  return words;
}

export class WordPieceTokenizer {
  private readonly unkId: number;
  readonly clsId: number;
  readonly sepId: number;

  constructor(private readonly cfg: WordPieceConfig) {
    const id = (tok: string): number => {
      const v = cfg.vocab[tok];
      if (typeof v !== 'number') throw new Error(`wordpiece: vocab lacks ${tok}`);
      return v;
    };
    this.unkId = id(cfg.unkToken);
    this.clsId = id(cfg.clsToken);
    this.sepId = id(cfg.sepToken);
  }

  /** WordPiece ids of the text, without [CLS]/[SEP]. */
  wordIds(text: string): number[] {
    const ids: number[] = [];
    const { vocab, continuingPrefix, maxInputCharsPerWord } = this.cfg;
    for (const word of basicTokens(text)) {
      const chars = [...word];
      if (chars.length > maxInputCharsPerWord) { ids.push(this.unkId); continue; }
      const pieces: number[] = [];
      let start = 0;
      let bad = false;
      while (start < chars.length) {
        let end = chars.length;
        let found = -1;
        while (start < end) {
          const sub = (start > 0 ? continuingPrefix : '') + chars.slice(start, end).join('');
          const v = vocab[sub];
          if (typeof v === 'number') { found = v; break; }
          end -= 1;
        }
        if (found < 0) { bad = true; break; }
        pieces.push(found);
        start = end;
      }
      if (bad) ids.push(this.unkId); else ids.push(...pieces);
    }
    return ids;
  }

  /** Model input ids: [CLS] + wordpieces (truncated to maxLength - 2) + [SEP]. */
  encode(text: string, maxLength = 256): number[] {
    const body = this.wordIds(text).slice(0, Math.max(0, maxLength - 2));
    return [this.clsId, ...body, this.sepId];
  }

  /** How many wordpieces the text is (the chunker's size measure). */
  count(text: string): number {
    return this.wordIds(text).length;
  }
}
