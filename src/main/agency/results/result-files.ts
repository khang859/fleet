import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import type { ResultFile } from '../../../shared/agency-jobs';
import { MEDIA_MIME_TYPES } from '../../../shared/file-open';

/** The largest file a result may hand back. */
export const RESULT_FILE_MAX_BYTES = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ...MEDIA_MIME_TYPES,
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

/** An env file holds secrets, and a job record never holds an env file's values. */
const ENV_FILE = /^\.env(\..+)?$/i;

/** The folder a job's delivered files are copied into, outside every worktree. */
export function resultsDir(home: string, jobId: number): string {
  return join(home, 'jobs', String(jobId), 'results');
}

/** Why a path may not be handed back, or null when it may. */
async function refusal(path: string, roots: string[]): Promise<string | null> {
  if (!isAbsolute(path)) return `${path} is not an absolute path`;
  if (ENV_FILE.test(basename(path))) return `${basename(path)} is an env file`;
  const real = await realpath(path).catch(() => null);
  if (real === null) return `${path} does not exist`;
  if (!roots.some((root) => real === root || real.startsWith(root + sep))) {
    return `${path} is outside the project and the job folder`;
  }
  const stat = await lstat(real);
  if (!stat.isFile()) return `${path} is not a file`;
  if (stat.size > RESULT_FILE_MAX_BYTES) return `${path} is over 200 MB`;
  return null;
}

/**
 * Copy the files a result hands back into a new folder under `dest`, so they
 * outlive the worktree they were made in. Every path must resolve inside one
 * of `roots`, so a result cannot carry a file from anywhere else on the disk.
 */
export async function copyResultFiles(
  paths: string[],
  roots: string[],
  dest: string,
  prefix: string
): Promise<{ ok: true; files: ResultFile[] } | { ok: false; reason: string }> {
  const realRoots = (
    await Promise.all(roots.map(async (r) => realpath(r).catch(() => null)))
  ).filter((r): r is string => r !== null);
  for (const path of paths) {
    const why = await refusal(path, realRoots);
    if (why !== null) return { ok: false, reason: why };
  }
  await mkdir(dest, { recursive: true });
  const folder = await mkdtemp(join(dest, `${prefix}-`));
  const files: ResultFile[] = [];
  for (const [i, path] of paths.entries()) {
    const name = files.some((f) => f.name === basename(path))
      ? `${i + 1}-${basename(path)}`
      : basename(path);
    const target = join(folder, name);
    await copyFile(path, target, constants.COPYFILE_EXCL);
    const { size } = await lstat(target);
    const type = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
    files.push({ name, path: target, type, size });
  }
  return { ok: true, files };
}
