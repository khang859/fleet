// src/main/learnings/embed-worker.ts
// Runs in a worker_threads worker. Owns the transformers.js feature-extraction
// pipeline so onnxruntime inference never blocks the Electron main thread.
// Message protocol (see embed-service.ts):
//   in:  { id: number, text: string }
//   out: { type: 'ready' } | { type: 'result', id, vector: number[] }
//        | { type: 'error', id, message } | { type: 'init-error', message }
import { parentPort, workerData } from 'worker_threads';
import { z } from 'zod';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

const { modelCacheDir, model } = z
  .object({ modelCacheDir: z.string(), model: z.string() })
  .parse(workerData);

const port = parentPort;
if (!port) throw new Error('embed-worker must run as a worker thread');

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Keep model files under Fleet's own dir so they survive app updates and are
    // easy to locate/clear. transformers.js downloads here on first use.
    env.cacheDir = modelCacheDir;
    return pipeline('feature-extraction', model, { dtype: 'fp32' });
  })();
  return extractorPromise;
}

// Eagerly warm up so the first real request isn't penalized by the model download.
getExtractor().then(
  () => port.postMessage({ type: 'ready' }),
  (err: unknown) =>
    port.postMessage({
      type: 'init-error',
      message: err instanceof Error ? err.message : String(err)
    })
);

port.on('message', (msg: { id: number; text: string }) => {
  void (async () => {
    try {
      const extractor = await getExtractor();
      const out = await extractor(msg.text, { pooling: 'mean', normalize: true });
      port.postMessage({ type: 'result', id: msg.id, vector: Array.from(out.data) });
    } catch (err) {
      port.postMessage({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  })();
});
