// src/main/learnings/embed-service.ts
import { Worker } from 'worker_threads';
import { createLogger } from '../logger';
import { EMBED_DIM, type Embedder } from './embedder';

const log = createLogger('learnings-embed');

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'result'; id: number; vector: number[] }
  | { type: 'error'; id: number; message: string };

export interface WorkerEmbedderOptions {
  modelCacheDir: string;
  /** Override the worker entry URL (tests). Defaults to the bundled embed-worker.mjs. */
  workerUrl?: URL;
}

/**
 * Embeds text via a transformers.js pipeline running in a worker thread. Any failure
 * (model can't download, worker crash) degrades to returning `null` permanently, so
 * callers fall back to FTS-only — embeddings are an enhancement, never a hard dep.
 */
export class WorkerEmbedder implements Embedder {
  readonly dim = EMBED_DIM;
  private worker: Worker | null = null;
  private failed = false;
  private seq = 0;
  private readonly pending = new Map<number, (vec: Float32Array | null) => void>();
  private readonly modelCacheDir: string;
  private readonly workerUrl: URL;

  constructor(opts: WorkerEmbedderOptions) {
    this.modelCacheDir = opts.modelCacheDir;
    this.workerUrl = opts.workerUrl ?? new URL('./embed-worker.mjs', import.meta.url);
  }

  private ensureWorker(): Worker | null {
    if (this.failed) return null;
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(this.workerUrl, {
        workerData: { modelCacheDir: this.modelCacheDir, model: EMBED_MODEL }
      });
      worker.on('message', (msg: WorkerMessage) => this.onMessage(msg));
      worker.on('error', (err) => this.onFatal(err instanceof Error ? err.message : String(err)));
      worker.on('exit', (code) => {
        if (code !== 0) this.onFatal(`worker exited with code ${code}`);
      });
      this.worker = worker;
      return worker;
    } catch (err) {
      this.onFatal(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private onMessage(msg: WorkerMessage): void {
    if (msg.type === 'ready') {
      log.info('embedding model ready', { model: EMBED_MODEL });
      return;
    }
    if (msg.type === 'init-error') {
      log.warn('embedding model unavailable; falling back to keyword search', {
        error: msg.message
      });
      this.onFatal(msg.message);
      return;
    }
    const resolve = this.pending.get(msg.id);
    if (!resolve) return;
    this.pending.delete(msg.id);
    if (msg.type === 'result') {
      resolve(Float32Array.from(msg.vector));
    } else {
      log.warn('embedding failed', { error: msg.message });
      resolve(null);
    }
  }

  /** A terminal failure: drain pending as null and stop using the worker. */
  private onFatal(message: string): void {
    if (!this.failed) log.warn('embedder disabled', { error: message });
    this.failed = true;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    const w = this.worker;
    this.worker = null;
    void w?.terminate();
  }

  /** False once a terminal failure (model load / worker crash) has disabled the worker. */
  available(): boolean {
    return !this.failed;
  }

  async embed(text: string): Promise<Float32Array | null> {
    const worker = this.ensureWorker();
    if (!worker) return null;
    const id = ++this.seq;
    return new Promise<Float32Array | null>((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ id, text });
    });
  }

  async close(): Promise<void> {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    await this.worker?.terminate();
    this.worker = null;
  }
}
