import { describe, expect, it } from 'vitest';
import { extractPdfText } from '../extract';

/**
 * Bytes in, words out.
 *
 * The documents here are written by hand rather than checked in as fixtures or
 * produced by whatever converter the machine happens to have: this has to run
 * the same on a laptop and on CI, and a fixture nobody can read is a fixture
 * nobody can change.
 */

/**
 * The smallest document pdfjs will accept - a catalog, one page, one font and a
 * content stream - with the byte offsets in the cross-reference table counted
 * as it is assembled.
 */
function pdfWith(lines: string[]): Uint8Array {
  const content =
    lines.length === 0
      ? ''
      : `BT /F1 12 Tf 72 720 Td 14 TL\n${lines.map((l) => `(${l}) Tj T*`).join('\n')}\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) pdf += `${String(at).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('extractPdfText', () => {
  it('reads the words out of a document', async () => {
    const result = await extractPdfText(pdfWith(['Fleet attachments are read locally.']));

    expect(result.text).toContain('Fleet attachments are read locally.');
    expect(result.pages).toBe(1);
    expect(result.scanned).toBe(false);
  });

  it('says so when there is no text in it at all', async () => {
    const result = await extractPdfText(pdfWith([]));

    expect(result).toMatchObject({ text: '', pages: 1, scanned: true });
  });

  // Better a refusal than half a document read as though it were whole.
  it('refuses something that is not a PDF', async () => {
    await expect(extractPdfText(new TextEncoder().encode('not a pdf at all'))).rejects.toThrow();
  });
});
