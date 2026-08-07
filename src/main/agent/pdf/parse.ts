import { Worker } from 'worker_threads';
import { z } from 'zod';
import type { PdfText } from './extract';

/**
 * Read a PDF without stopping the app.
 *
 * pdfjs turns its own worker off under Node, so parsing runs wherever it is
 * called from - and the main thread is where every window's IPC is answered.
 * A three-hundred-page document read there does not slow the agent down, it
 * freezes the terminal, the file tree and the window chrome along with it.
 *
 * So the parse gets a thread of its own, which is also what makes the deadline
 * below possible: a document that never finishes can be dropped, rather than
 * being something the user has to quit the app to get out of.
 */

/**
 * How long a document gets. Well past what a real one needs at the twenty-
 * megabyte ceiling, and short enough that a file crafted to spin forever costs
 * one thread for half a minute rather than one thread for the whole session.
 */
const DEADLINE_MS = 30_000;

const ReplySchema = z.union([
  z.object({
    ok: z.literal(true),
    result: z.object({ text: z.string(), pages: z.number(), scanned: z.boolean() })
  }),
  z.object({ ok: z.literal(false), error: z.string() })
]);

export async function parsePdf(bytes: Uint8Array): Promise<PdfText> {
  return new Promise<PdfText>((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.mjs', import.meta.url), { workerData: bytes });

    let done = false;

    /**
     * Whichever answer arrives first is the only one, and it takes the thread
     * with it. Terminating makes the worker exit non-zero, so without the flag
     * every success would be followed by its own failure.
     */
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      void worker.terminate();
      settle();
    };

    // Unref'd rather than cleared: a deadline should not be a reason the app
    // stays open, and once an answer is in it fires into the flag above.
    setTimeout(() => {
      finish(() => reject(new Error('this PDF took too long to read')));
    }, DEADLINE_MS).unref();

    worker.on('message', (reply: unknown) => {
      const parsed = ReplySchema.safeParse(reply);
      if (!parsed.success) {
        finish(() => reject(new Error('the PDF reader said something unexpected')));
        return;
      }
      const answer = parsed.data;
      finish(() => {
        if (answer.ok) resolve(answer.result);
        else reject(new Error(`this PDF could not be read: ${answer.error}`));
      });
    });

    // A thread that dies without answering - out of memory on a document built
    // to cause it, or a worker file that is not there at all.
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`the PDF reader stopped (code ${code})`)));
    });
  });
}
