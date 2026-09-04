import { describe, it, expect } from 'vitest';
import { nextStaged } from '../update-staging';
import type { StagedUpdate, UpdateStatus } from '../../shared/types';

const READY: UpdateStatus = { state: 'ready', version: '2.113.0', releaseNotes: '- something' };
const STAGED: StagedUpdate = { version: '2.113.0', releaseNotes: '- something' };

const downloading = (version: string, percent = 0): UpdateStatus => ({
  state: 'downloading',
  version,
  releaseNotes: '',
  percent
});

describe('nextStaged', () => {
  it('stages what a ready status carries', () => {
    expect(nextStaged(null, downloading('2.113.0', 100), READY)).toEqual(STAGED);
  });

  /**
   * The reason this is not derived from the last status. A check runs every
   * four hours now, so there is always a next one; the first to fail offline
   * would otherwise take the pill, the sidebar dot and the install button with
   * it, leaving an update sitting on disk that the user cannot install.
   */
  it('survives a check that fails offline', () => {
    const status: UpdateStatus = { state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' };
    expect(nextStaged(STAGED, { state: 'checking' }, status)).toEqual(STAGED);
  });

  it('survives a check that finds nothing newer', () => {
    expect(nextStaged(STAGED, { state: 'checking' }, { state: 'not-available' })).toEqual(STAGED);
  });

  it('survives an install that failed to start', () => {
    // `quitAndInstall` throwing does not delete anything.
    const status: UpdateStatus = { state: 'error', message: 'Install failed' };
    expect(nextStaged(STAGED, READY, status)).toEqual(STAGED);
  });

  /**
   * `DownloadedUpdateHelper.getValidCachedUpdateFile` empties the pending
   * directory as soon as it is asked for a build whose checksum differs, so by
   * the time the download of a different version is reported the staged
   * installer is already gone.
   */
  it('drops it when a different version starts downloading', () => {
    expect(nextStaged(STAGED, { state: 'checking' }, downloading('2.114.0'))).toBeNull();
  });

  it('keeps it when the same version downloads again', () => {
    // A re-check of an already-downloaded version reuses the cached file.
    expect(nextStaged(STAGED, { state: 'checking' }, downloading('2.113.0'))).toEqual(STAGED);
  });

  /**
   * `AppUpdater.executeDownload` calls `downloadedUpdateHelper.clear()` when a
   * download throws, which empties the pending directory and nulls the path
   * `quitAndInstall` installs from - so the replacement failing takes the
   * original with it, and the app has to go back to offering a check.
   */
  it('drops it when the replacement download fails', () => {
    const failed: UpdateStatus = { state: 'error', message: 'ENOTFOUND' };
    const afterStart = nextStaged(STAGED, { state: 'checking' }, downloading('2.114.0'));
    expect(nextStaged(afterStart, downloading('2.114.0'), failed)).toBeNull();
  });

  it('replaces it when a newer version becomes ready', () => {
    const newer: UpdateStatus = { state: 'ready', version: '2.114.0', releaseNotes: '- newer' };
    expect(nextStaged(STAGED, downloading('2.114.0', 100), newer)).toEqual({
      version: '2.114.0',
      releaseNotes: '- newer'
    });
  });

  it('stages nothing before an update has been downloaded', () => {
    expect(nextStaged(null, { state: 'idle' }, { state: 'checking' })).toBeNull();
    expect(nextStaged(null, { state: 'checking' }, downloading('2.113.0', 40))).toBeNull();
  });
});
