import {
  ATTACHMENT_MAX_PDF_PAGES,
  ATTACHMENT_MAX_PDF_TEXT_CHARS
} from '../../../shared/agent-types';

/**
 * A PDF's words.
 *
 * Pulled out here rather than sent to the provider's own parser, which would
 * re-parse - and re-charge for - the same document on every turn, since Fleet
 * resends the whole conversation each time. Doing it on the machine also means
 * a PDF works on any model rather than only on one that can see.
 *
 * Nothing in this file touches a thread or a message port, so it can be tested
 * as what it is: bytes in, words out. Running it somewhere that is not the main
 * thread is `./parse`'s job.
 */

/** What a document turned out to be. */
export interface PdfText {
  text: string;
  /** Every page the document has, not only the ones that were read. */
  pages: number;
  /** No text anywhere in it: a scan, or a set of images. */
  scanned: boolean;
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  // The legacy build is the one that runs outside a browser. Imported here
  // rather than at the top of the file because it is 800KB of parser that a
  // conversation without a PDF in it should never pay to load.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes,
    // Nothing here has a network or a DOM: this is a document being read for
    // its words, not one being drawn.
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false
  });

  // A document that never opens still built a parser to fail in. Encrypted and
  // truncated PDFs reject here, and nothing on that path takes the parser -
  // or the twenty megabytes it is holding - back down.
  const doc = await task.promise.catch(async (err: unknown) => {
    await task.destroy();
    throw err;
  });

  try {
    const read = Math.min(doc.numPages, ATTACHMENT_MAX_PDF_PAGES);
    let text = '';
    for (let page = 1; page <= read && text.length < ATTACHMENT_MAX_PDF_TEXT_CHARS; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      text += '\n';
    }
    return {
      text: clip(text.trim(), doc.numPages, read),
      pages: doc.numPages,
      // Saying so is the whole of what Fleet can do about a scan, and saying
      // nothing would leave the user with a page count and an agent that had
      // read nothing.
      scanned: text.trim() === ''
    };
  } finally {
    await doc.destroy();
  }
}

/** Cut at the ceiling, with what was left out said out loud rather than implied. */
function clip(text: string, total: number, read: number): string {
  const missing = read < total ? `\n\n… pages ${read + 1}-${total} were not read.` : '';
  if (text.length <= ATTACHMENT_MAX_PDF_TEXT_CHARS) return `${text}${missing}`;
  return `${text.slice(0, ATTACHMENT_MAX_PDF_TEXT_CHARS)}\n\n… the rest of this document was cut.`;
}
