// src/main/remote-ssh/remote-cache.ts

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { RemoteHost } from '../../shared/remote-ssh-types';
import { createLogger } from '../logger';
import { hostKey } from './ssh-control';
import { getFileExtension } from '../../shared/file-open';

const log = createLogger('remote-ssh:cache');

/**
 * Local mirror of remote files.
 *
 * Its reason to exist is that Fleet's viewer panes reach binary content through
 * the `fleet-image://` / `fleet-pdf://` protocols, which resolve to a path the
 * main process can open with `fs`. By materializing a remote file into a local
 * cache first and handing the viewers that local path, those protocol handlers -
 * and all four viewer panes' rendering logic - stay completely unchanged.
 *
 * Freshness is a poll, not a subscription: SSH gives no change notification, so
 * every open re-stats the remote and re-fetches only on a size/mtime mismatch.
 */

const CACHE_VERSION = 1;
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

const CacheMetaSchema = z.object({
  version: z.number(),
  remotePath: z.string(),
  size: z.number(),
  mtimeMs: z.number()
});

type CacheMeta = z.infer<typeof CacheMetaSchema>;

export function cacheRoot(): string {
  return join(homedir(), '.fleet', 'remote-cache');
}

function hostDir(host: RemoteHost): string {
  const digest = createHash('sha256').update(hostKey(host)).digest('hex').slice(0, 32);
  return join(cacheRoot(), digest);
}

/**
 * Cache path for a remote file. The original extension is preserved because
 * downstream consumers key off it - the `fleet-pdf://` handler checks for a
 * `.pdf` suffix, and image MIME detection reads the extension.
 */
export function cachePathFor(host: RemoteHost, remotePath: string): string {
  const digest = createHash('sha256').update(remotePath).digest('hex').slice(0, 40);
  return join(hostDir(host), `${digest}${getFileExtension(remotePath)}`);
}

function metaPathFor(cachePath: string): string {
  return `${cachePath}.meta.json`;
}

async function readMeta(cachePath: string): Promise<CacheMeta | null> {
  try {
    const raw = await readFile(metaPathFor(cachePath), 'utf-8');
    const parsed = CacheMetaSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.version !== CACHE_VERSION) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

async function writeMeta(cachePath: string, meta: CacheMeta): Promise<void> {
  await writeFile(metaPathFor(cachePath), JSON.stringify(meta), 'utf-8');
}

/**
 * Is the cached copy still good for this remote size/mtime?
 *
 * Exported and pure so the freshness rule is unit-testable. A remote `mtimeMs`
 * of 0 means "unknown" (the `ls -l` fallback path on non-GNU remotes), in which
 * case we cannot prove freshness and must refetch.
 */
export function isCacheFresh(meta: CacheMeta | null, size: number, mtimeMs: number): boolean {
  if (!meta) return false;
  if (mtimeMs === 0) return false;
  return meta.size === size && meta.mtimeMs === mtimeMs;
}

export async function lookupCached(
  host: RemoteHost,
  remotePath: string,
  size: number,
  mtimeMs: number
): Promise<string | null> {
  const cachePath = cachePathFor(host, remotePath);
  if (!existsSync(cachePath)) return null;
  const meta = await readMeta(cachePath);
  if (!isCacheFresh(meta, size, mtimeMs)) return null;
  return cachePath;
}

export async function ensureCacheDir(host: RemoteHost): Promise<string> {
  const dir = hostDir(host);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function commitCached(
  host: RemoteHost,
  remotePath: string,
  size: number,
  mtimeMs: number
): Promise<string> {
  const cachePath = cachePathFor(host, remotePath);
  await writeMeta(cachePath, { version: CACHE_VERSION, remotePath, size, mtimeMs });
  return cachePath;
}

/** Drop a single entry, e.g. after a local save so the next read refetches. */
export async function invalidateCached(host: RemoteHost, remotePath: string): Promise<void> {
  const cachePath = cachePathFor(host, remotePath);
  await rm(cachePath, { force: true });
  await rm(metaPathFor(cachePath), { force: true });
}

/**
 * Evict least-recently-used files until the cache fits under `maxBytes`.
 * Called opportunistically rather than on a timer - there is no background
 * sweeper to keep alive, and the cost is one `readdir`+`stat` pass.
 */
export async function evictIfNeeded(maxBytes: number = DEFAULT_MAX_BYTES): Promise<void> {
  const root = cacheRoot();
  if (!existsSync(root)) return;

  type Entry = { path: string; size: number; atimeMs: number };
  const files: Entry[] = [];
  let total = 0;

  try {
    for (const hostEntry of await readdir(root, { withFileTypes: true })) {
      if (!hostEntry.isDirectory()) continue;
      const dir = join(root, hostEntry.name);
      for (const name of await readdir(dir)) {
        if (name.endsWith('.meta.json')) continue;
        const full = join(dir, name);
        try {
          const st = await stat(full);
          files.push({ path: full, size: st.size, atimeMs: st.atimeMs });
          total += st.size;
        } catch {
          // Raced with another eviction or an external delete - skip it.
        }
      }
    }
  } catch (err) {
    log.debug('eviction scan failed', { err: String(err) });
    return;
  }

  if (total <= maxBytes) return;

  files.sort((a, b) => a.atimeMs - b.atimeMs);
  for (const file of files) {
    if (total <= maxBytes) break;
    await rm(file.path, { force: true });
    await rm(metaPathFor(file.path), { force: true });
    total -= file.size;
  }
  log.debug('evicted cache entries', { remainingBytes: total });
}

/** Remove every cached file for a host. */
export async function clearHostCache(host: RemoteHost): Promise<void> {
  await rm(hostDir(host), { recursive: true, force: true });
}
