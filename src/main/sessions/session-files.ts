// src/main/sessions/session-files.ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type FileState = { mtimeMs: number; size: number };

type FileTail = { readAt: FileState; update(st: FileState): Promise<void> };

/** One tail per session file, each read only when its file changed. */
export class TailCache<T extends FileTail> {
  private readonly tails = new Map<string, T>();

  constructor(private readonly create: (path: string) => T) {}

  /** The tail for a file, brought up to date with it. */
  async at(path: string, st: FileState): Promise<T> {
    let tail = this.tails.get(path);
    if (tail?.readAt.mtimeMs === st.mtimeMs && tail.readAt.size === st.size) return tail;
    if (!tail) {
      tail = this.create(path);
      this.tails.set(path, tail);
    }
    await tail.update(st);
    return tail;
  }

  /** Drop the tails of files that no longer exist. */
  keepOnly(paths: string[]): void {
    const seen = new Set(paths);
    for (const key of this.tails.keys()) {
      if (!seen.has(key)) this.tails.delete(key);
    }
  }

  clear(): void {
    this.tails.clear();
  }
}

/** Every `.jsonl` file in the folders directly under `root`. */
export async function jsonlFilesIn(root: string): Promise<string[]> {
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const folder of folders) {
    const dir = join(root, folder);
    try {
      for (const f of await readdir(dir)) if (f.endsWith('.jsonl')) paths.push(join(dir, f));
    } catch {
      // not a dir, or unreadable
    }
  }
  return paths;
}
