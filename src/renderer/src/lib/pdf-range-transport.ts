import { PDFDataRangeTransport } from 'pdfjs-dist';
import type { PathContext } from '../../../shared/shell-profiles';

export type PdfSource = {
  path: string;
  pathContext: PathContext | undefined;
  /** From `stat` when the pane opened the file. A read fails if it changes. */
  version: { size: number; modifiedAt: number };
};

/** `changed`: the file was deleted or rewritten after the pane opened it. */
export type PdfReadError = 'changed' | 'failed';

/**
 * Gives pdf.js the byte ranges it asks for, read from disk over IPC. pdf.js reads
 * the index at the end of the file first, then only the parts each page needs,
 * so a large PDF never sits in memory whole. Firefox loads a PDF over HTTP
 * ranges in the same way.
 */
export class PdfRangeTransport extends PDFDataRangeTransport {
  #aborted = false;
  readonly #source: PdfSource;
  readonly #onError: (error: PdfReadError) => void;

  constructor(source: PdfSource, onError: (error: PdfReadError) => void) {
    super(source.version.size, null);
    this.#source = source;
    this.#onError = onError;
  }

  override requestDataRange(begin: number, end: number): void {
    const { path, pathContext, version } = this.#source;
    void window.fleet.file.readRange(path, begin, end, version, pathContext).then(
      (chunk) => {
        // pdf.js throws on a chunk that arrives after it stopped asking.
        if (this.#aborted) return;
        if (chunk) this.onDataRange(begin, chunk);
        else this.#onError('changed');
      },
      () => {
        if (!this.#aborted) this.#onError('failed');
      }
    );
  }

  override abort(): void {
    this.#aborted = true;
    super.abort();
  }
}
