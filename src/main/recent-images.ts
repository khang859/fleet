import { spawn } from 'child_process';
import { stat, realpath, readdir } from 'fs/promises';
import { basename, dirname, extname, join } from 'path';
import { homedir } from 'os';
import { nativeImage } from 'electron';
import type { RecentImageResult, RecentImagesResponse } from '../shared/ipc-api';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB — skip large files for thumbnail safety
const RESULT_LIMIT = 5;
const STAT_LIMIT = 200; // stat at most this many candidates before sorting

type FileCandidate = {
  path: string;
  name: string;
  parentDir: string;
  modifiedAt: number;
  size: number;
};

function generateThumbnail(filePath: string): string {
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return '';
    const thumb = img.resize({ height: 80 });
    return thumb.toDataURL();
  } catch {
    return '';
  }
}

async function statCandidate(filePath: string): Promise<FileCandidate | null> {
  try {
    const resolved = await realpath(filePath);
    const s = await stat(resolved);
    if (!s.isFile() || s.size > MAX_FILE_SIZE) return null;
    return {
      path: resolved,
      name: basename(resolved),
      parentDir: dirname(resolved),
      modifiedAt: s.mtimeMs,
      size: s.size
    };
  } catch {
    return null;
  }
}

async function spawnMdfind(home: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('mdfind', ['-onlyin', home, 'kMDItemContentTypeTree == "public.image"']);

    let stdout = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, 3000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('close', () => {
      clearTimeout(timer);
      resolve(stdout.split('\n').filter(Boolean));
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

async function spawnSearch(): Promise<string[]> {
  const home = homedir();

  if (process.platform === 'darwin') {
    // Scan known directories directly first so new files appear immediately
    // (mdfind depends on Spotlight indexing which can lag minutes behind)
    const [dirPaths, mdfindPaths] = await Promise.all([scanKnownDirs(), spawnMdfind(home)]);

    // Deduplicate: direct-scan results first (guaranteed fresh), then mdfind
    const seen = new Set(dirPaths);
    for (const p of mdfindPaths) {
      if (!seen.has(p)) {
        seen.add(p);
        dirPaths.push(p);
      }
    }
    return dirPaths;
  }

  // Linux/Windows: scan known directories
  return scanKnownDirs();
}

async function scanKnownDirs(): Promise<string[]> {
  const home = homedir();
  const dirs = [join(home, 'Desktop'), join(home, 'Downloads'), join(home, 'Pictures')];

  const results: string[] = [];

  for (const dir of dirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true, recursive: true });
      for (const entry of entries) {
        if (entry.isFile() && IMAGE_EXTS.has(extname(entry.name).toLowerCase())) {
          const fullPath = entry.parentPath
            ? join(entry.parentPath, entry.name)
            : join(dir, entry.name);
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — skip
    }
  }

  return results;
}

export async function searchRecentImages(): Promise<RecentImagesResponse> {
  try {
    const paths = await spawnSearch();

    // Stat candidates and collect metadata
    const seen = new Set<string>();
    const candidates: FileCandidate[] = [];

    for (const p of paths) {
      if (candidates.length >= STAT_LIMIT) break;
      const candidate = await statCandidate(p);
      if (candidate && !seen.has(candidate.path)) {
        seen.add(candidate.path);
        candidates.push(candidate);
      }
    }

    // Sort by modification time (newest first), take top 5
    candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
    const top = candidates.slice(0, RESULT_LIMIT);

    // Generate thumbnails
    const results: RecentImageResult[] = top.map((c) => ({
      ...c,
      thumbnailDataUrl: generateThumbnail(c.path)
    }));

    return { success: true, results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: `Recent images search failed: ${msg}` };
  }
}
