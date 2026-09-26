/**
 * NATIVE-MEMORY: all-MiniLM-L6-v2 sentence embeddings through onnxruntime-node directly
 * (N-API, so the same binary loads in Node and in an Electron utility process; no rebuild).
 *
 * What the Transformers.js `feature-extraction` pipeline does with `{ pooling: 'mean',
 * normalize: true }`, and nothing else: tokenize (WordPiece), run the graph, mean-pool the
 * last hidden state over the attention mask, L2-normalise. Parity with that pipeline is a test.
 *
 * Responsiveness (spec section 3, Jim R1): ONNX Runtime's default is one thread per core for a
 * single inference; a backfill would then compete with the renderer, the PTYs and the agents.
 * The session is created with intraOpNumThreads <= 2 and interOpNumThreads = 1.
 *
 * Loaded on the FIRST embed, never at construction (Jim R2), and droppable when idle.
 */
import type { WordPieceTokenizer } from './wordpiece';

export const EMBED_DIM = 384;
/** MiniLM was trained at 256 wordpieces; the chunker keeps every chunk well below this. */
export const EMBED_MAX_TOKENS = 256;

/** The slice of onnxruntime-node this module uses (injected, so tests can pass the real one
 *  or a fake without the module loading a native binary at import time). */
export interface OrtLike {
  InferenceSession: { create(path: string, opts: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => unknown;
}
export interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | ArrayLike<number>; dims: readonly number[] }>>;
  release?(): Promise<void>;
}

export interface EmbedderOptions {
  intraOpNumThreads?: number;
  interOpNumThreads?: number;
  maxTokens?: number;
}

export class OnnxEmbedder {
  private session: OrtSession | null = null;
  private loading: Promise<OrtSession> | null = null;
  /** ms the last model load took (diagnostics). */
  loadMs = 0;

  constructor(
    private readonly modelPath: string,
    private readonly tokenizer: WordPieceTokenizer,
    private readonly ort: OrtLike,
    private readonly opts: EmbedderOptions = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  get loaded(): boolean {
    return this.session !== null;
  }

  private async ensure(): Promise<OrtSession> {
    if (this.session) return this.session;
    if (!this.loading) {
      const t0 = this.now();
      this.loading = this.ort.InferenceSession.create(this.modelPath, {
        intraOpNumThreads: Math.min(2, Math.max(1, this.opts.intraOpNumThreads ?? 2)),
        interOpNumThreads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
        executionProviders: ['cpu']
      }).then((s) => { this.session = s; this.loadMs = this.now() - t0; return s; })
        .finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  /** Drop the model (idle unload). The next embed reloads it. */
  async unload(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s?.release) { try { await s.release(); } catch { /* already gone */ } }
  }

  /** Embed texts as one padded batch: one normalised 384-float vector each. */
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const session = await this.ensure();
    const max = this.opts.maxTokens ?? EMBED_MAX_TOKENS;
    const encoded = texts.map((t) => this.tokenizer.encode(t, max));
    const len = Math.max(...encoded.map((e) => e.length));
    const n = encoded.length;
    const ids = new BigInt64Array(n * len);
    const mask = new BigInt64Array(n * len);
    const types = new BigInt64Array(n * len);
    encoded.forEach((e, i) => {
      for (let j = 0; j < e.length; j++) { ids[i * len + j] = BigInt(e[j]); mask[i * len + j] = 1n; }
    });
    const feeds: Record<string, unknown> = {};
    for (const name of session.inputNames) {
      if (name === 'input_ids') feeds[name] = new this.ort.Tensor('int64', ids, [n, len]);
      else if (name === 'attention_mask') feeds[name] = new this.ort.Tensor('int64', mask, [n, len]);
      else if (name === 'token_type_ids') feeds[name] = new this.ort.Tensor('int64', types, [n, len]);
    }
    const out = await session.run(feeds);
    const hidden = out.last_hidden_state ?? out[Object.keys(out)[0]];
    const dim = hidden.dims[hidden.dims.length - 1];
    if (dim !== EMBED_DIM) throw new Error(`embedder: model width ${dim}, expected ${EMBED_DIM}`);
    const data = hidden.data as Float32Array;
    const result: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      const v = new Float32Array(dim);
      const tokens = encoded[i].length;
      for (let j = 0; j < tokens; j++) {
        const base = (i * len + j) * dim;
        for (let d = 0; d < dim; d++) v[d] += data[base + d];
      }
      let norm = 0;
      for (let d = 0; d < dim; d++) { v[d] /= tokens; norm += v[d] * v[d]; }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d++) v[d] /= norm;
      result.push(v);
    }
    return result;
  }
}
