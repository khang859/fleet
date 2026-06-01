import {
  openSync,
  fstatSync,
  lstatSync,
  readSync,
  writeSync,
  closeSync,
  readdirSync,
  mkdirSync,
  renameSync,
  rmSync,
  realpathSync,
  constants as FS,
  type Dirent,
  type Stats
} from 'fs';
import { join, resolve, sep, dirname, normalize, isAbsolute } from 'path';
import type { ArtifactKind } from '../../shared/kanban-types';
import { sanitizeFilename, contentTypeFor } from './attachments';

const MAX_BYTES = 25 * 1024 * 1024;

const DOCUMENT_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
  '.html',
  '.htm',
  '.pdf'
]);
const CODE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.css',
  '.scss',
  '.sh',
  '.sql'
]);
const DATA_EXT = new Set(['.csv', '.tsv', '.jsonl', '.ndjson', '.parquet', '.sqlite', '.db']);

/** Map a filename's extension to a coarse artifact kind. Boring and explicit by design. */
export function guessKind(filename: string): ArtifactKind {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  if (DOCUMENT_EXT.has(ext)) return 'document';
  if (CODE_EXT.has(ext)) return 'code';
  if (DATA_EXT.has(ext)) return 'data';
  return 'other';
}

/**
 * v1 secret deny-list (§6). For `dir` tasks the workspace is the user's real project, so an
 * agent could register a credential. This blocks the most damaging foot-guns by basename/glob;
 * the user can still attach such a file deliberately through the file-picker attachment flow.
 */
export function isSecretPath(relPath: string): boolean {
  const parts = relPath.split('/');
  const base = parts[parts.length - 1].toLowerCase();
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === '.npmrc' || base === '.netrc') return true;
  if (base === 'id_rsa') return true;
  if (base.startsWith('id_') && !base.endsWith('.pub')) return true; // private keys
  if (['.pem', '.key', '.p12', '.pfx'].includes(ext)) return true;
  if (base === 'credentials' && parts.includes('.aws')) return true;
  return false;
}

export interface PreparedArtifact {
  filename: string;
  storedPath: string;
  /** Normalized, workspace-relative path the agent registered (persisted for archive checks). */
  sourceRelPath: string;
  kind: ArtifactKind;
  contentType: string | null;
  size: number;
}

/**
 * Prove the opened fd's real path lives inside the canonical workspace root. On Linux we use
 * `/proc/self/fd/<fd>`, which reflects the actual open file even if the path was swapped after
 * `openSync` — closing the TOCTOU window. On other platforms Node exposes no fd→path API, so we
 * fall back to canonicalizing the target's parent dir (documented best-effort limitation, §12a).
 */
function assertContained(fd: number, canonicalRoot: string, targetPath: string): void {
  const rootWithSep = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
  const inside = (p: string): boolean => p === canonicalRoot || p.startsWith(rootWithSep);
  if (process.platform === 'linux') {
    if (!inside(realpathSync(`/proc/self/fd/${fd}`))) {
      throw new Error('artifact path escapes the workspace');
    }
    return;
  }
  if (!inside(realpathSync(dirname(targetPath)))) {
    throw new Error('artifact path escapes the workspace');
  }
}

/** Copy at most `maxBytes` from the open source fd to a fresh temp file. Aborts if the source
 *  grows past the cap mid-copy, so a file that expands after the initial fstat can't slip the cap. */
function copyFromFd(srcFd: number, destPath: string, maxBytes: number): number {
  const out = openSync(destPath, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o600);
  const buf = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  let pos = 0;
  try {
    for (;;) {
      const n = readSync(srcFd, buf, 0, buf.length, pos);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error('artifact grew beyond size cap during capture');
      writeSync(out, buf, 0, n);
      pos += n;
    }
  } catch (err) {
    closeSync(out);
    rmSync(destPath, { force: true });
    throw err;
  }
  closeSync(out);
  return total;
}

/**
 * Validate and snapshot a worker-produced file into
 * artifacts/<boardId>/<taskId>/<artifactId>__<filename>.
 *
 * The adversary is the agent running concurrently in the workspace — it supplies `relPath` and
 * controls the filesystem. So validation and copy operate on one no-follow file handle:
 * open → fstat (regular file? size?) → fd-path containment → bounded copy-from-fd → rename.
 */
export function prepareArtifactFile(input: {
  artifactsRoot: string;
  boardId: string;
  taskId: string;
  artifactId: string;
  workspaceRoot: string;
  relPath: string;
  kind?: ArtifactKind;
}): PreparedArtifact {
  if (isAbsolute(input.relPath)) {
    throw new Error('artifact path must be workspace-relative');
  }
  const segments = normalize(input.relPath).split(/[/\\]+/);
  if (segments.some((s) => s === '..')) {
    throw new Error('artifact path must not escape the workspace');
  }
  const normalizedRel = segments.filter((s) => s && s !== '.').join('/');
  if (!normalizedRel) throw new Error('artifact path is empty');
  if (isSecretPath(normalizedRel)) {
    throw new Error(`refusing to register a sensitive file: ${normalizedRel}`);
  }

  const canonicalRoot = realpathSync(input.workspaceRoot);
  const targetPath = join(input.workspaceRoot, normalizedRel);

  let flags = FS.O_RDONLY;
  if (typeof FS.O_NOFOLLOW === 'number') flags |= FS.O_NOFOLLOW; // symlink leaf -> ELOOP
  if (typeof FS.O_NONBLOCK === 'number') flags |= FS.O_NONBLOCK; // FIFO/device can't hang us

  let fd: number;
  try {
    fd = openSync(targetPath, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new Error('artifact path is a symlink');
    if (code === 'ENOENT') throw new Error(`artifact file not found: ${normalizedRel}`);
    throw err;
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('artifact must be a regular file');
    if (st.size > MAX_BYTES) throw new Error(`artifact exceeds 25 MB (${st.size} bytes)`);
    assertContained(fd, canonicalRoot, targetPath);

    const filename = sanitizeFilename(normalizedRel);
    const kind = input.kind ?? guessKind(filename);
    const taskDir = join(input.artifactsRoot, input.boardId, input.taskId);
    const storedPath = join(taskDir, `${input.artifactId}__${filename}`);
    if (!resolve(storedPath).startsWith(resolve(taskDir) + sep)) {
      throw new Error('artifact stored path escapes the task directory');
    }
    mkdirSync(taskDir, { recursive: true });
    const tmp = join(taskDir, `.tmp-${input.artifactId}`);
    const copied = copyFromFd(fd, tmp, st.size);
    try {
      if (fstatSync(fd).size !== st.size) {
        throw new Error('artifact changed during capture');
      }
      renameSync(tmp, storedPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return {
      filename,
      storedPath,
      sourceRelPath: normalizedRel,
      kind,
      contentType: contentTypeFor(filename),
      size: copied
    };
  } finally {
    closeSync(fd);
  }
}

export function removeArtifactFile(storedPath: string): void {
  rmSync(storedPath, { force: true });
}

export interface ArtifactPreview {
  previewable: boolean;
  text?: string;
  truncated?: boolean;
  reason?: string;
}

/**
 * Read a bounded text preview from a stored artifact. Reads at most `maxBytes` from the source
 * (never the full file), sniffs for binary content, and returns `{ previewable: false }` for
 * binary/unreadable files rather than mojibake.
 */
export function readArtifactPreview(storedPath: string, maxBytes = 200 * 1024): ArtifactPreview {
  let flags = FS.O_RDONLY;
  if (typeof FS.O_NOFOLLOW === 'number') flags |= FS.O_NOFOLLOW; // stored copy is never a symlink
  let fd: number;
  try {
    fd = openSync(storedPath, flags);
  } catch {
    return { previewable: false, reason: 'Preview unavailable' };
  }
  try {
    const size = fstatSync(fd).size;
    const cap = Math.min(maxBytes, size);
    const buf = Buffer.allocUnsafe(cap);
    let read = 0;
    while (read < cap) {
      const n = readSync(fd, buf, read, cap - read, read);
      if (n === 0) break;
      read += n;
    }
    const slice = buf.subarray(0, read);
    // Binary sniff: any NUL byte, or a high density of non-text control bytes, disqualifies it.
    let controls = 0;
    for (const b of slice) {
      if (b === 0) return { previewable: false, reason: 'Binary file' };
      if (b < 9 || (b > 13 && b < 32)) controls += 1;
    }
    if (slice.length > 0 && controls / slice.length > 0.3) {
      return { previewable: false, reason: 'Binary file' };
    }
    return { previewable: true, text: slice.toString('utf-8'), truncated: size > read };
  } finally {
    closeSync(fd);
  }
}

/** Recursively list non-dotfile descendant paths (relative to the scan root) under `dir`.
 *  Never follows symlinks; a symlink or special file counts as an (uncovered) descendant. */
function listFilesRel(dir: string, prefix: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    const rel = `${prefix}/${ent.name}`;
    let st: Stats;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) out.push(rel);
    else if (st.isDirectory()) out.push(...listFilesRel(full, rel));
    else out.push(rel); // regular and special files alike
  }
  return out;
}

/**
 * Top-level non-dotfile entries in a scratch workspace that are NOT already registered as
 * artifacts (§6). A top-level directory is "covered" only when every non-dotfile descendant
 * file is registered; otherwise it is a leftover. Uses lstat and never follows symlinks.
 */
export function listUnregisteredLeftovers(input: {
  workspaceRoot: string;
  registeredRelPaths: string[];
}): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(input.workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const registered = new Set(input.registeredRelPaths.map((p) => p.replace(/\\/g, '/')));
  const leftovers: string[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = join(input.workspaceRoot, ent.name);
    let st: Stats;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      leftovers.push(ent.name); // never follow; treat as a leftover
    } else if (st.isDirectory()) {
      const descendants = listFilesRel(full, ent.name);
      if (descendants.length > 0 && !descendants.every((d) => registered.has(d))) {
        leftovers.push(ent.name);
      }
    } else if (st.isFile()) {
      if (!registered.has(ent.name)) leftovers.push(ent.name);
    } else {
      leftovers.push(ent.name); // fifo/device/socket
    }
  }
  return leftovers;
}
