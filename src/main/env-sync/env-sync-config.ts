import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, parse as parsePath } from 'node:path';
import { EnvSyncConfigSchema, type EnvSyncConfig, type EnvSyncTarget } from '../../shared/env-sync-types';
import { createLogger } from '../logger';

const log = createLogger('env-sync-config');
const CONFIG_REL = join('.fleet', 'env-sync.json');

// Per-directory resolution cache. Maps a cwd to its nearest repoDir (or null).
const nearestCache = new Map<string, { repoDir: string; config: EnvSyncConfig } | null>();

export function invalidateConfigCache(): void {
  nearestCache.clear();
}

export function configPath(repoDir: string): string {
  return join(repoDir, CONFIG_REL);
}

export function readConfig(repoDir: string): EnvSyncConfig | null {
  const p = configPath(repoDir);
  if (!existsSync(p)) return null;
  try {
    return EnvSyncConfigSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
  } catch (err) {
    log.warn('Invalid .fleet/env-sync.json', { repoDir, error: err instanceof Error ? err.message : String(err) });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function writeConfig(repoDir: string, config: EnvSyncConfig): void {
  const parsed = EnvSyncConfigSchema.parse(config);
  const p = configPath(repoDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  invalidateConfigCache();
}

export function resolveObjectKey(config: EnvSyncConfig, target: EnvSyncTarget): string {
  return target.objectKey ?? `${config.id}/${target.envFile}.enc`;
}

export function resolveBucketRegion(
  config: EnvSyncConfig,
  target: EnvSyncTarget
): { bucket: string; region: string } {
  return { bucket: target.bucket ?? config.bucket, region: target.region ?? config.region };
}

/** Walk up from cwd to the nearest dir containing .fleet/env-sync.json. */
export function findNearestConfig(cwd: string): { repoDir: string; config: EnvSyncConfig } | null {
  if (nearestCache.has(cwd)) return nearestCache.get(cwd) ?? null;
  const root = parsePath(cwd).root;
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, CONFIG_REL))) {
      let result: { repoDir: string; config: EnvSyncConfig } | null = null;
      try {
        const config = readConfig(dir);
        if (config) result = { repoDir: dir, config };
      } catch {
        result = null;
      }
      nearestCache.set(cwd, result);
      return result;
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  nearestCache.set(cwd, null);
  return null;
}

/** Among inject targets, return the one whose envFile dir is the longest prefix of cwd. */
export function mostSpecificInjectTarget(
  repoDir: string,
  config: EnvSyncConfig,
  cwd: string
): EnvSyncTarget | null {
  let best: EnvSyncTarget | null = null;
  let bestLen = -1;
  for (const t of config.targets) {
    if (t.delivery !== 'inject') continue;
    const targetDir = join(repoDir, dirname(t.envFile));
    const prefix = targetDir.endsWith('/') ? targetDir : targetDir + '/';
    const cwdNorm = cwd.endsWith('/') ? cwd : cwd + '/';
    if (cwdNorm === prefix || cwdNorm.startsWith(prefix)) {
      if (targetDir.length > bestLen) {
        best = t;
        bestLen = targetDir.length;
      }
    }
  }
  return best;
}
