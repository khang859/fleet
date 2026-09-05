import type { StagedUpdate, UpdateStatus } from '../shared/types';

/**
 * What can be installed after `status`, given what could be installed before it.
 *
 * Split out of `index.ts` for the same reason `update-scheduler` was: the file
 * is too large to import from a test, and this is the part worth testing.
 *
 * The rules are not "keep the last ready status". `electron-updater` keeps one
 * downloaded artifact, in one pending directory, and later work in that
 * directory destroys it:
 *
 * - starting a download whose checksum differs from the cached one empties the
 *   directory first (`DownloadedUpdateHelper.getValidCachedUpdateFile`), so the
 *   moment a *different* version begins downloading, the old installer is gone;
 * - a download that then fails calls `downloadedUpdateHelper.clear()` on its
 *   way out (`AppUpdater.executeDownload`), which empties the directory again
 *   and nulls the path `quitAndInstall` installs from.
 *
 * Either way the app would otherwise go on advertising a version whose
 * installer no longer exists, and "Restart to Update" would fail with "No
 * update filepath provided" - with no way back to a check, because the pill and
 * the button are what a staged update replaces.
 *
 * A failed *check* is the opposite case and the reason this is not simply
 * derived from the last status: being offline says nothing about a file that is
 * already on disk, so the staged update outlives it.
 */
export function nextStaged(
  staged: StagedUpdate | null,
  previous: UpdateStatus,
  next: UpdateStatus
): StagedUpdate | null {
  switch (next.state) {
    case 'ready':
      return { version: next.version, releaseNotes: next.releaseNotes };
    case 'downloading':
      // Re-downloading the version already staged reuses the cached file and
      // touches nothing; any other version has just cleared it.
      return staged?.version === next.version ? staged : null;
    case 'error':
      return previous.state === 'downloading' ? null : staged;
    case 'idle':
    case 'checking':
    case 'not-available':
      return staged;
  }
}
