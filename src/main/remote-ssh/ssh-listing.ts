// src/main/remote-ssh/ssh-listing.ts

import type {
  RemoteCapabilities,
  RemoteDirEntry,
  RemoteEntryKind,
  RemoteListResult
} from '../../shared/remote-ssh-types';
import type { RemoteHost } from '../../shared/remote-ssh-types';
import { execSsh, describeSshFailure, hostKey } from './ssh-control';
import { posixShellQuote, remoteJoin } from './ssh-quote';

/**
 * Directory listing over ssh.
 *
 * GNU `find -printf` is the preferred source because it is the only widely
 * available tool that yields **exact** mtimes (`%T@` carries sub-second
 * precision) and can delimit records with NUL, so a filename containing a
 * newline cannot corrupt the listing. Both matter: mtime precision is what makes
 * the local cache's freshness check correct, and newline safety is a real
 * correctness issue, not a hypothetical one.
 *
 * `sftp`'s own `ls -l` is deliberately *not* used as the primary path - it
 * renders timestamps without a year or seconds and splits newline-containing
 * names across lines, both of which are unrecoverable at the parse step.
 *
 * A POSIX `ls -l` fallback covers BSD/macOS remotes, accepting the reduced
 * mtime precision there (the cache falls back to comparing size + whole minutes).
 */

const NUL = '\0';
const FIELD = '\t';

/** `%y` type letter -> our entry kind. */
function kindFromTypeLetter(letter: string): RemoteEntryKind {
  switch (letter) {
    case 'd':
      return 'dir';
    case 'f':
      return 'file';
    case 'l':
      return 'symlink';
    default:
      return 'other';
  }
}

/**
 * Parse NUL-delimited `find -printf '%y\t%s\t%T@\t%f\0'` output.
 * Pure: no I/O, so the hostile-filename cases are unit-testable.
 */
export function parseFindPrintf(stdout: string, dirPath: string): RemoteDirEntry[] {
  const entries: RemoteDirEntry[] = [];
  for (const record of stdout.split(NUL)) {
    if (!record) continue;
    // Split only on the first three tabs - a filename may legally contain tabs.
    const first = record.indexOf(FIELD);
    if (first < 0) continue;
    const second = record.indexOf(FIELD, first + 1);
    if (second < 0) continue;
    const third = record.indexOf(FIELD, second + 1);
    if (third < 0) continue;

    const typeLetter = record.slice(0, first);
    const sizeRaw = record.slice(first + 1, second);
    const mtimeRaw = record.slice(second + 1, third);
    const name = record.slice(third + 1);
    if (!name || name === '.' || name === '..') continue;

    const size = Number.parseInt(sizeRaw, 10);
    const mtimeSeconds = Number.parseFloat(mtimeRaw);
    entries.push({
      name,
      path: remoteJoin(dirPath, name),
      kind: kindFromTypeLetter(typeLetter),
      size: Number.isFinite(size) ? size : 0,
      mtimeMs: Number.isFinite(mtimeSeconds) ? Math.round(mtimeSeconds * 1000) : 0
    });
  }
  return entries;
}

/**
 * Parse POSIX `ls -lA` output for remotes without GNU find. Lossy by nature:
 * `ls` gives no year for recent files and no sub-second precision, and a name
 * containing a newline is unparseable - such entries are dropped rather than
 * guessed at, since a wrong path is worse than a missing row.
 */
export function parseLsLong(stdout: string, dirPath: string, nowMs: number): RemoteDirEntry[] {
  const entries: RemoteDirEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || /^total\s/.test(trimmed)) continue;

    // perms links owner group size <date fields> name
    const match = /^([dlcbps-])(\S{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(.{12})\s(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, typeChar, , sizeRaw, dateRaw, rawName] = match;
    if (!rawName || rawName === '.' || rawName === '..') continue;

    // `ls -l` renders symlinks as "name -> target"; keep only the name.
    const name = typeChar === 'l' ? rawName.split(' -> ')[0] : rawName;

    entries.push({
      name,
      path: remoteJoin(dirPath, name),
      kind:
        typeChar === 'd'
          ? 'dir'
          : typeChar === 'l'
            ? 'symlink'
            : typeChar === '-'
              ? 'file'
              : 'other',
      size: Number.parseInt(sizeRaw, 10) || 0,
      mtimeMs: parseLsDate(dateRaw.trim(), nowMs)
    });
  }
  return entries;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `ls -l` dates are either "Mon DD HH:MM" (within ~6 months, year omitted) or
 * "Mon DD  YYYY". Returns 0 when unparseable - callers treat 0 as "unknown"
 * rather than as the epoch.
 */
export function parseLsDate(dateStr: string, nowMs: number): number {
  const parts = dateStr.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return 0;
  const monthIdx = MONTHS.indexOf(parts[0]);
  if (monthIdx < 0) return 0;
  const day = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(day)) return 0;

  const now = new Date(nowMs);
  if (parts[2].includes(':')) {
    const [h, m] = parts[2].split(':').map((v) => Number.parseInt(v, 10));
    // No year in this form: assume the most recent occurrence, i.e. if the date
    // lands in the future it belongs to last year.
    let year = now.getUTCFullYear();
    let ts = Date.UTC(year, monthIdx, day, h || 0, m || 0);
    if (ts > nowMs + 24 * 60 * 60 * 1000) {
      year -= 1;
      ts = Date.UTC(year, monthIdx, day, h || 0, m || 0);
    }
    return ts;
  }
  const year = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(year)) return 0;
  return Date.UTC(year, monthIdx, day);
}

/** Directories first, then case-insensitive name - matches Fleet's local listing order. */
export function sortEntries(entries: RemoteDirEntry[]): RemoteDirEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'dir';
    const bDir = b.kind === 'dir';
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

const capabilityCache = new Map<string, RemoteCapabilities>();

/** Probe once per host and remember it - `find --version` is a wasted round trip otherwise. */
export async function probeCapabilities(host: RemoteHost): Promise<RemoteCapabilities> {
  const key = hostKey(host);
  const cached = capabilityCache.get(key);
  if (cached) return cached;

  // Probe by behaviour rather than by version string: run the exact -printf we
  // depend on and see whether it works.
  const result = await execSsh(host, `find . -maxdepth 0 -printf '' 2>/dev/null && echo GNU`);
  const caps: RemoteCapabilities = {
    hasGnuFindPrintf: result.code === 0 && result.stdout.toString('utf-8').includes('GNU')
  };
  capabilityCache.set(key, caps);
  return caps;
}

export function clearCapabilityCache(host?: RemoteHost): void {
  if (host) capabilityCache.delete(hostKey(host));
  else capabilityCache.clear();
}

/** Expand `~` and relative paths to an absolute remote path. */
export async function resolveRemotePath(host: RemoteHost, path: string): Promise<string> {
  const target = path && path !== '~' ? path : '$HOME';
  const quoted = target === '$HOME' ? '"$HOME"' : posixShellQuote(path);
  const result = await execSsh(host, `cd ${quoted} && pwd`);
  if (result.code !== 0) throw new Error(describeSshFailure(result));
  return result.stdout.toString('utf-8').trim() || '/';
}

/** List a remote directory, preferring GNU find and falling back to `ls -lA`. */
export async function listRemoteDir(host: RemoteHost, path: string): Promise<RemoteListResult> {
  const resolvedPath = await resolveRemotePath(host, path);
  const caps = await probeCapabilities(host);
  const quotedDir = posixShellQuote(resolvedPath);

  if (caps.hasGnuFindPrintf) {
    const result = await execSsh(
      host,
      `LC_ALL=C find ${quotedDir} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'`
    );
    if (result.code !== 0) throw new Error(describeSshFailure(result));
    return {
      entries: sortEntries(parseFindPrintf(result.stdout.toString('utf-8'), resolvedPath)),
      resolvedPath
    };
  }

  const result = await execSsh(host, `LC_ALL=C ls -lA ${quotedDir}`);
  if (result.code !== 0) throw new Error(describeSshFailure(result));
  return {
    entries: sortEntries(parseLsLong(result.stdout.toString('utf-8'), resolvedPath, Date.now())),
    resolvedPath
  };
}

/** Stat a single remote path. Returns null when it does not exist. */
export async function statRemotePath(
  host: RemoteHost,
  path: string
): Promise<RemoteDirEntry | null> {
  const caps = await probeCapabilities(host);
  const quoted = posixShellQuote(path);

  if (caps.hasGnuFindPrintf) {
    const result = await execSsh(
      host,
      `LC_ALL=C find ${quoted} -maxdepth 0 -printf '%y\\t%s\\t%T@\\t%f\\0'`
    );
    if (result.code !== 0) return null;
    const parsed = parseFindPrintf(result.stdout.toString('utf-8'), '/');
    if (parsed.length === 0) return null;
    return { ...parsed[0], path };
  }

  const result = await execSsh(host, `LC_ALL=C ls -ldA ${quoted}`);
  if (result.code !== 0) return null;
  const parsed = parseLsLong(result.stdout.toString('utf-8'), '/', Date.now());
  if (parsed.length === 0) return null;
  return { ...parsed[0], path };
}
