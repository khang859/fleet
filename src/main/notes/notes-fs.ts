import { createHash } from 'node:crypto';
import {
  mkdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  realpathSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { isWslContext, type PathContext } from '../../shared/shell-profiles';
import type { NoteReadResult, NoteWriteResult } from '../../shared/notes-types';

/**
 * Project notes are stored centrally under `~/.fleet/notes/` as `<key>.md`,
 * where the key is a hash of the note's scope path (repo root, or the folder
 * itself when not a repo). A sibling `index.json` maps key → { path, updatedAt }
 * so the original path is recoverable (future "all notes" view / repo moves).
 *
 * Hashing the path (rather than using it as a filename) avoids `/`-in-name and
 * length limits, and keeps user repos pristine — nothing is written into them.
 */

const NoteIndexSchema = z.record(z.string(), z.object({ path: z.string(), updatedAt: z.number() }));
type NoteIndex = z.infer<typeof NoteIndexSchema>;

let tmpCounter = 0;

/** A short discriminator so the same string path under different coordinate
 *  systems (native vs a WSL distro) can't collide on the same key. */
function contextTag(ctx?: PathContext): string {
  if (!ctx || ctx === 'posix' || ctx === 'win32') return 'native';
  return `wsl:${ctx.distro}`;
}

/**
 * Canonicalize a scope path into a stable key input. Native host paths are
 * symlink-collapsed (via realpath) so opening a project through a symlink still
 * resolves to the same note; WSL paths aren't reachable on the host, so they're
 * normalized by string only.
 */
function normalizeScope(scopePath: string, ctx?: PathContext): string {
  const isWsl = isWslContext(ctx);
  if (!isWsl) {
    try {
      return realpathSync.native(scopePath);
    } catch {
      return resolve(scopePath);
    }
  }
  return scopePath.replace(/\/+$/, '') || '/';
}

/** Stable per-project key for a scope path. */
export function noteKey(scopePath: string, ctx?: PathContext): string {
  const input = `${contextTag(ctx)}\0${normalizeScope(scopePath, ctx)}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function noteFile(baseDir: string, key: string): string {
  return join(baseDir, `${key}.md`);
}

export function readNote(baseDir: string, key: string): NoteReadResult {
  const file = noteFile(baseDir, key);
  try {
    const mtimeMs = statSync(file).mtimeMs;
    return { text: readFileSync(file, 'utf8'), mtimeMs };
  } catch {
    return { text: '', mtimeMs: 0 };
  }
}

function readIndex(baseDir: string): NoteIndex {
  try {
    const parsed = NoteIndexSchema.safeParse(
      JSON.parse(readFileSync(join(baseDir, 'index.json'), 'utf8'))
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.fleet-tmp-${process.pid}-${Date.now()}-${tmpCounter++}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
}

function saveIndex(baseDir: string, index: NoteIndex): void {
  writeAtomic(join(baseDir, 'index.json'), JSON.stringify(index, null, 2));
}

/**
 * Write a note atomically. An empty (whitespace-only) note deletes the file and
 * its index entry rather than leaving an empty husk. When `expectedMtimeMs` is
 * given and the file on disk is newer, the write is refused as an external change.
 */
export function writeNote(
  baseDir: string,
  key: string,
  text: string,
  scopePath: string,
  expectedMtimeMs?: number
): NoteWriteResult {
  mkdirSync(baseDir, { recursive: true });
  const file = noteFile(baseDir, key);

  if (expectedMtimeMs !== undefined && existsSync(file)) {
    const current = statSync(file).mtimeMs;
    if (current > expectedMtimeMs) {
      return { ok: false, externalChange: true, mtimeMs: current };
    }
  }

  if (text.trim() === '') {
    try {
      unlinkSync(file);
    } catch {
      /* already absent */
    }
    const index = readIndex(baseDir);
    if (key in index) {
      delete index[key];
      saveIndex(baseDir, index);
    }
    return { ok: true, mtimeMs: 0 };
  }

  writeAtomic(file, text);
  const index = readIndex(baseDir);
  index[key] = { path: scopePath, updatedAt: Date.now() };
  saveIndex(baseDir, index);
  return { ok: true, mtimeMs: statSync(file).mtimeMs };
}
