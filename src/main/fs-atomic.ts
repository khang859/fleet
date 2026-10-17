import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

let tmpCounter = 0;

/**
 * Write a text file so a crash halfway leaves the old one, never half of the
 * new. Each write has its own temp file, so two writes racing to the same path
 * cannot interleave inside one temp file; the later rename wins.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${tmpCounter++}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** `writeAtomic` for a caller that has to know the file is written before it goes on. */
export function writeAtomicSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${tmpCounter++}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
