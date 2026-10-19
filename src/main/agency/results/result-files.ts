import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import type { ResultFile } from '../../../shared/agency-jobs';
import { MEDIA_MIME_TYPES } from '../../../shared/file-open';
import { ENV_FILE } from '../projects/env-files';
import { jobDir } from '../projects/paths';

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

/** The folder a job's delivered files are copied into, outside every worktree. */
export function resultsDir(home: string, jobId: number): string {
  return join(jobDir(home, jobId), 'results');
}

/** Whether a path is a file Fleet copied into the job's results folder. */
export function insideResults(home: string, jobId: number, path: string): boolean {
  return path.startsWith(resultsDir(home, jobId) + sep);
}

/** The most of one text result Fleet reads, so a huge file never fills memory. */
const RESULT_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** Whether a result file is text a model can read. */
export function isTextResultFile(file: ResultFile): boolean {
  return file.type.startsWith('text/') || file.type === 'application/json';
}

/**
 * The text of a delivered file, from the start up to Fleet's read limit. Null
 * for anything but a regular file in the job's results folder: a row naming
 * another path, or a link, is never followed.
 */
export async function readResultText(
  home: string,
  jobId: number,
  path: string
): Promise<string | null> {
  if (!insideResults(home, jobId, path)) return null;
  const stat = await lstat(path).catch(() => null);
  if (stat?.isFile() !== true) return null;
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, RESULT_TEXT_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Where a step that reads another's worktree writes the files it hands
 * back. It is in the job's folder, so `job_deliver` takes paths in it.
 */
export function handbackDir(home: string, jobId: number, stepId: string): string {
  return join(jobDir(home, jobId), 'handback', stepId);
}

/** Why a path may not be handed back, or null when it may. */
async function refusal(path: string, roots: string[]): Promise<string | null> {
  if (!isAbsolute(path)) return `${path} is not an absolute path`;
  // An env file holds secrets, and a job record never holds an env file's values.
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
