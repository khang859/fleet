import { lstatSync, copyFileSync, renameSync, rmSync, mkdirSync } from 'fs';
import { join, basename, resolve, sep } from 'path';

const MAX_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip'
};

export function contentTypeFor(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return CONTENT_TYPES[filename.slice(dot).toLowerCase()] ?? null;
}

/** Reduce any input to a safe single-segment filename: basename, no separators or control chars. */
export function sanitizeFilename(name: string): string {
  const base = basename(name);
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f/\\]/g, '').trim();
  return cleaned.length > 0 ? cleaned : 'file';
}

export interface PreparedAttachment {
  filename: string;
  storedPath: string;
  contentType: string | null;
  size: number;
}

/**
 * Validate and copy a source file into attachments/<taskId>/<attachmentId>__<filename>.
 * Throws on a non-regular file or one over the 25 MB cap. Copies to a temp name then
 * renames, so a crash never leaves a partial file at the final path.
 */
export function prepareAttachmentFile(input: {
  attachmentsRoot: string;
  taskId: string;
  attachmentId: string;
  sourcePath: string;
}): PreparedAttachment {
  const st = lstatSync(input.sourcePath);
  if (!st.isFile()) {
    throw new Error('attachment must be a regular file');
  }
  if (st.size > MAX_BYTES) {
    throw new Error(`attachment exceeds 25 MB (${st.size} bytes)`);
  }
  const filename = sanitizeFilename(input.sourcePath);
  const taskDir = join(input.attachmentsRoot, input.taskId);
  const storedPath = join(taskDir, `${input.attachmentId}__${filename}`);
  if (!resolve(storedPath).startsWith(resolve(taskDir) + sep)) {
    throw new Error('attachment path escapes the task directory');
  }
  mkdirSync(taskDir, { recursive: true });
  const tmp = join(taskDir, `.tmp-${input.attachmentId}`);
  try {
    copyFileSync(input.sourcePath, tmp);
    renameSync(tmp, storedPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { filename, storedPath, contentType: contentTypeFor(filename), size: st.size };
}

export function removeAttachmentFile(storedPath: string): void {
  rmSync(storedPath, { force: true });
}
