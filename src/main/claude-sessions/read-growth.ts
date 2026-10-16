import { open, type FileHandle } from 'fs/promises';

export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Read what a growing file holds past a point, a bounded chunk at a time.
 * `startAt` sees the file's size and says where to start; `onChunk` gets
 * each chunk in order, in a buffer that is reused for the next one. False
 * when the file does not exist yet.
 */
export async function readGrowth(
  path: string,
  startAt: (size: number) => number,
  onChunk: (bytes: Buffer) => void
): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return false;
  }
  try {
    const { size } = await handle.stat();
    let position = startAt(size);
    if (position >= size) return true;
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
    while (position < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      onChunk(buffer.subarray(0, bytesRead));
    }
    return true;
  } finally {
    await handle.close();
  }
}
