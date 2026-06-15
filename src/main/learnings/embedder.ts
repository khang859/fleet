// src/main/learnings/embedder.ts
// The embedding seam. Production uses WorkerEmbedder (transformers.js in a worker
// thread); tests use FakeEmbedder; NullEmbedder is the FTS-only degraded fallback.
import type { EmbedderState } from '../../shared/learnings';

/** Dimensionality of the all-MiniLM-L6-v2 model. */
export const EMBED_DIM = 384;

export interface Embedder {
  /**
   * Embed a text into a unit-normalized vector, or `null` when embeddings are
   * unavailable (model not downloaded, offline, worker crashed). Callers fall
   * back to FTS-only search/storage on null — never throw. May resolve sync or async
   * (stateless embedders compute inline; the worker-backed one is async).
   */
  embed(text: string): Promise<Float32Array | null> | Float32Array | null;
  /** Vector dimensionality this embedder produces. */
  readonly dim: number;
  /**
   * Whether the embedder can still produce vectors. Lets callers distinguish a
   * permanent failure (model can't load → stop) from a one-off `embed` returning
   * null for a single input (skip that input, keep going).
   */
  available(): boolean;
  /** Lifecycle for the UI indicator. */
  state(): EmbedderState;
  /** Eagerly start loading the model (so first use isn't penalized). Optional. */
  warmUp?(): void;
  /**
   * Permanently release resources (e.g. terminate the worker) for app shutdown.
   * After close() the embedder stays down. Optional for stateless embedders.
   */
  close?(): Promise<void> | void;
  /**
   * Tear the worker down but return to a usable idle state, so the next embed/warmUp
   * re-spawns it. Used when clearing the model cache: it releases the model files'
   * handles (so they can be deleted) and clears a prior failure so a re-download is
   * retried. Optional for stateless embedders.
   */
  reset?(): Promise<void> | void;
}

/** Always-null embedder: forces the FTS-only path. Used when the model can't load. */
export class NullEmbedder implements Embedder {
  readonly dim = EMBED_DIM;
  embed(): null {
    return null;
  }
  available(): boolean {
    return false;
  }
  state(): EmbedderState {
    return 'failed';
  }
}

/**
 * Deterministic embedder for unit tests — no model, no worker. Hashes tokens into
 * a normalized bag-of-words vector so semantically-overlapping texts land near each
 * other (enough to exercise vector search + RRF without onnxruntime).
 */
export class FakeEmbedder implements Embedder {
  constructor(readonly dim: number = EMBED_DIM) {}

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const tok of text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[(h >>> 0) % this.dim] += 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }

  available(): boolean {
    return true;
  }

  state(): EmbedderState {
    return 'ready';
  }
}
