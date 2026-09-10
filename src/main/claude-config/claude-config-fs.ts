import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  renameSync,
  unlinkSync
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  ClaudeConfigDirs,
  ClaudeConfigScope,
  ClaudeFileKind
} from '../../shared/claude-config';
import { resolveClaudeFilePath, isAllowedClaudeFilePath } from '../../shared/claude-config';
import type {
  ClaudeFileRevision,
  ClaudeReadResult,
  ClaudeWriteResult
} from '../../shared/claude-config-types';
import { isRecord } from '../../shared/is-record';
import { readHooks, mergeHooks, hooksDiffer } from '../../shared/claude-hooks';

/**
 * Reading and writing the five Claude Code config files the Settings page owns.
 *
 * Structurally this is `env-editor-fs.ts`: temp file, rename, typed results.
 * The conflict guard is deliberately stronger. `writeEnvFile` refuses only a
 * *strictly newer* mtime and skips the check entirely once a file is deleted,
 * which is fine for a `.env` the user alone edits. These files have a second
 * writer - Fleet's own copilot hook installer - and a restored backup or a
 * fast rewrite can land with an equal or older timestamp, so the guard here
 * compares a revision token instead.
 */

let tmpCounter = 0;

/** A file's identity at the moment it was read. */
function revisionOf(absPath: string): ClaudeFileRevision {
  if (!existsSync(absPath)) return { exists: false, mtimeMs: 0, size: 0 };
  const stat = statSync(absPath);
  return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
}

function revisionsMatch(a: ClaudeFileRevision, b: ClaudeFileRevision): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * The text a scope's editor opens with.
 *
 * A settings file that is missing, empty, or only whitespace becomes `{}` so
 * the Form view always has a parseable document to render - an empty string
 * would make every fresh file look like a syntax error. A missing memory file
 * is genuinely empty text. `exists` is reported separately so the page can
 * label the file and so the write guard knows the file was absent.
 */
export function readClaudeFile(absPath: string, kind: ClaudeFileKind): ClaudeReadResult {
  const revision = revisionOf(absPath);
  const fallback = kind === 'settings' ? '{}' : '';

  if (!revision.exists) return { text: fallback, revision, exists: false };

  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    // Present but unreadable - a permission problem, or a directory sitting
    // where a file should be. Treated as absent content rather than crashing
    // the page; the write guard still sees `exists: true`.
    return { text: fallback, revision, exists: true, unreadable: true };
  }

  if (kind === 'settings' && text.trim() === '') {
    return { text: fallback, revision, exists: true };
  }
  return { text, revision, exists: true };
}

/**
 * Write a file, refusing when disk no longer matches the revision that was read.
 *
 * The five outcomes, in the order they are checked:
 *
 * - absent at read, absent now -> create.
 * - absent at read, present now -> refuse (`created`).
 * - present at read, absent now -> refuse (`deleted`).
 * - present in both, revision equal -> write.
 * - present in both, revision differs -> refuse (`modified`).
 *
 * Equal mtime *and* equal size is not proof of identical content. Same-size,
 * same-timestamp, different-content is a deliberate adversary rather than an
 * accident, and closing it would mean hashing the file on every read; if that
 * ever matters, a hash is a drop-in third revision field.
 */
export function writeClaudeFile(
  absPath: string,
  text: string,
  expected: ClaudeFileRevision
): ClaudeWriteResult {
  const current = revisionOf(absPath);

  if (!expected.exists && current.exists) {
    return { ok: false, reason: 'created', revision: current };
  }
  if (expected.exists && !current.exists) {
    return { ok: false, reason: 'deleted', revision: current };
  }
  if (!revisionsMatch(expected, current)) {
    return { ok: false, reason: 'modified', revision: current };
  }

  const dir = dirname(absPath);
  try {
    // `.claude` may not exist yet - creating a config file is the normal first
    // use of this page, not an error case.
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'missingDir', revision: current, message: String(err) };
  }

  const tmp = `${absPath}.fleet-tmp-${process.pid}-${Date.now()}-${tmpCounter++}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
    return { ok: false, reason: 'failed', revision: current, message: String(err) };
  }

  return { ok: true, revision: revisionOf(absPath) };
}

/**
 * Write a settings file, merging `hooks` against disk instead of trusting the caller.
 *
 * Two writers share that key: Fleet's copilot hook installer owns the entries
 * that invoke its own binary, and the user owns the rest. The merge keeps the
 * user's entries as sent and takes Fleet's from disk, so an Overwrite chosen
 * after a conflict cannot undo an installation that happened in between.
 *
 * Enforcing it here rather than in the form's write set is the whole point: the
 * Raw JSON view edits the entire document, and main is the only place that has
 * both the incoming document and the current disk state at the same moment.
 */
export function writeClaudeSettings(
  absPath: string,
  text: string,
  expected: ClaudeFileRevision
): ClaudeWriteResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalidJson',
      revision: revisionOf(absPath),
      message: String(err)
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: 'invalidJson',
      revision: revisionOf(absPath),
      message: 'Settings must be a JSON object'
    };
  }

  const onDisk = readClaudeFile(absPath, 'settings');
  let diskDocument: Record<string, unknown> = {};
  try {
    const diskParsed: unknown = JSON.parse(onDisk.text);
    if (isRecord(diskParsed)) diskDocument = diskParsed;
  } catch {
    // Unparseable on disk means there is nothing to protect. The user's
    // document replaces it wholesale, which is the only way to recover a file
    // someone else corrupted.
  }

  const incomingHooks = readHooks(parsed);
  const merged = mergeHooks(incomingHooks, readHooks(diskDocument));
  // True only when the merge actually overruled the caller, so the page does
  // not cry "your hooks edit was dropped" on every unrelated save.
  const hooksDiscarded = hooksDiffer(incomingHooks, merged);

  const document = { ...parsed };
  if (Object.keys(merged).length === 0) delete document.hooks;
  else document.hooks = merged;

  const result = writeClaudeFile(absPath, `${JSON.stringify(document, null, 2)}\n`, expected);
  return result.ok ? { ...result, hooksDiscarded } : result;
}

/**
 * Derive the path for a scope and write to it, refusing anything off the allowlist.
 *
 * The path is re-derived here from the directories rather than accepted from
 * the renderer, so the IPC surface cannot be pointed at an arbitrary file.
 * `isAllowedClaudeFilePath` also vets the directories themselves, which is
 * what stops a `sessionDir` full of `..` from deriving a "matching" path.
 */
export function writeClaudeScope(args: {
  scope: ClaudeConfigScope;
  kind: ClaudeFileKind;
  dirs: ClaudeConfigDirs;
  text: string;
  expected: ClaudeFileRevision;
}): ClaudeWriteResult {
  const absPath = resolveClaudeFilePath({ scope: args.scope, kind: args.kind, dirs: args.dirs });
  if (absPath === null || !isAllowedClaudeFilePath(absPath, args.dirs)) {
    return {
      ok: false,
      reason: 'refused',
      revision: { exists: false, mtimeMs: 0, size: 0 },
      message: 'That file is not one the Claude Config page may write.'
    };
  }
  return args.kind === 'settings'
    ? writeClaudeSettings(absPath, args.text, args.expected)
    : writeClaudeFile(absPath, args.text, args.expected);
}

/** Read a scope's file, refusing anything off the allowlist. */
export function readClaudeScope(args: {
  scope: ClaudeConfigScope;
  kind: ClaudeFileKind;
  dirs: ClaudeConfigDirs;
}): ClaudeReadResult & { path: string | null } {
  const absPath = resolveClaudeFilePath({ scope: args.scope, kind: args.kind, dirs: args.dirs });
  if (absPath === null || !isAllowedClaudeFilePath(absPath, args.dirs)) {
    return {
      path: null,
      text: args.kind === 'settings' ? '{}' : '',
      revision: { exists: false, mtimeMs: 0, size: 0 },
      exists: false
    };
  }
  return { path: absPath, ...readClaudeFile(absPath, args.kind) };
}
