import { open } from 'fs/promises';

/**
 * Reads bytes `begin` (included) to `end` (not included) of a file. The PDF pane
 * uses it so that pdf.js reads only the parts of a file it needs, and a large
 * PDF never sits in memory whole. A range past the end of the file is cut short.
 */
export async function readFileRange(path: string, begin: number, end: number): Promise<Buffer> {
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin) {
    throw new Error(`Invalid byte range ${begin}-${end}`);
  }

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.max(0, Math.min(end, size) - begin);
    const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, begin);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
