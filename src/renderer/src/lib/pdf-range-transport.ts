import { PDFDataRangeTransport } from 'pdfjs-dist';
import type { PathContext } from '../../../shared/shell-profiles';

/**
 * Gives pdf.js the byte ranges it asks for, read from disk over IPC. pdf.js reads
 * the index at the end of the file first, then only the parts each page needs,
 * so a large PDF never sits in memory whole. Firefox loads a PDF over HTTP
 * ranges in the same way.
 */
export class PdfRangeTransport extends PDFDataRangeTransport {
  #aborted = false;
  readonly #filePath: string;
  readonly #pathContext: PathContext | undefined;
  readonly #onError: () => void;

  constructor(
    length: number,
    filePath: string,
    pathContext: PathContext | undefined,
    onError: () => void
  ) {
    super(length, null);
    this.#filePath = filePath;
    this.#pathContext = pathContext;
    this.#onError = onError;
  }

  override requestDataRange(begin: number, end: number): void {
    void window.fleet.file.readRange(this.#filePath, begin, end, this.#pathContext).then(
      (chunk) => {
        // pdf.js throws on a chunk that arrives after it stopped asking.
        if (!this.#aborted) this.onDataRange(begin, chunk);
      },
      () => {
        if (!this.#aborted) this.#onError();
      }
    );
  }

  override abort(): void {
    this.#aborted = true;
    super.abort();
  }
}
