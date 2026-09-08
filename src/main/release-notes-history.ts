import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { parseChangelog, type ReleaseNote } from '../shared/release-notes';
import { createLogger } from './logger';

const log = createLogger('release-notes');

/**
 * Where the changelog this build ships sits.
 *
 * Two hops, counted from the *bundle* at `out/main/index.mjs` rather than from
 * this source file, and an `extraResources` copy in packaged builds. Both of
 * those have shipped broken before - see
 * `docs/learnings/2026-08-07-bundled-resource-path-from-the-bundle-not-the-source.md`
 * and `docs/learnings/2026-06-28-chat-skills-missing-from-packaged-app.md` -
 * and both fail the same quiet way, with the read throwing and the feature
 * simply not being offered. Copied from `agent/skills/definitions.ts`; do not
 * recount it.
 */
function changelogPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'CHANGELOG.md')
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CHANGELOG.md');
}

/** Parsed once; the file cannot change under a running build. */
let cached: Promise<ReleaseNote[]> | null = null;

/**
 * Every version this build documents, newest first.
 *
 * Resolves to `[]` rather than rejecting when the file cannot be read: an
 * absent history costs the user the list and nothing else, and Settings >
 * Updates has to keep working - version, check button, install button - when
 * the only thing that failed is a text file. The log line is there because the
 * symptom on screen is an empty section, which is indistinguishable from a
 * changelog that genuinely has nothing in it.
 *
 * `path` is for tests. Nothing in the app passes it.
 */
export async function loadReleaseHistory(path?: string): Promise<ReleaseNote[]> {
  if (path !== undefined) return read(path);
  // The promise is what is cached, so a second caller arriving mid-read waits
  // on the first rather than starting its own.
  cached ??= read(changelogPath());
  return cached;
}

async function read(path: string): Promise<ReleaseNote[]> {
  try {
    return parseChangelog(await readFile(path, 'utf8'));
  } catch (err) {
    log.warn('changelog unreadable', { path, error: err instanceof Error ? err.message : err });
    return [];
  }
}
