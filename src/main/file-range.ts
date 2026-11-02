import { open } from 'fs/promises';
import { toCodedError } from './errors';

/** The size and change time of a file when a reader first looked at it. */
export type FileVersion = { size: number; modifiedAt: number };

/**
 * Reads bytes `begin` (included) to `end` (not included) of a file. The PDF pane
 * uses it so that pdf.js reads only the parts of a file it needs, and a large
 * PDF never sits in memory whole. A range past the end of the file is cut short.
 *
 * Returns null when the file is gone or no longer matches `version`: bytes from
 * a rewritten file would not fit the parts the reader already has.
 */
export async function readFileRange(
  path: string,
  begin: number,
  end: number,
  version: FileVersion
): Promise<Buffer | null> {
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin) {
    throw new Error(`Invalid byte range ${begin}-${end}`);
  }

  const file = await open(path, 'r').catch((err: unknown) => {
    if (toCodedError(err).code === 'ENOENT') return null;
    throw err;
  });
  if (!file) return null;

  try {
    const { size, mtimeMs } = await file.stat();
    if (size !== version.size || mtimeMs !== version.modifiedAt) return null;

    const length = Math.max(0, Math.min(end, size) - begin);
    const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, begin);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
