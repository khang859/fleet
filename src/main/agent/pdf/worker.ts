import { parentPort, workerData } from 'worker_threads';
import { z } from 'zod';
import { extractPdfText } from './extract';

/**
 * One PDF, read on a thread of its own, then gone.
 *
 * Message protocol (see ./parse):
 *   in:  the bytes, as workerData
 *   out: { ok: true, result: PdfText } | { ok: false, error: string }
 *
 * A worker per document rather than one kept warm: a parser this size is worth
 * handing back when the document is done with, and a thread that can be thrown
 * away is a thread that can be killed when a malformed file never finishes.
 */

const port = parentPort;
if (!port) throw new Error('the pdf worker has to run as a worker thread');

const bytes = z.instanceof(Uint8Array).parse(workerData);

extractPdfText(bytes).then(
  (result) => port.postMessage({ ok: true, result }),
  (err: unknown) =>
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
);
