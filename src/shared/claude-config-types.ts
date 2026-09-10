import type { ClaudeConfigDirs, ClaudeConfigScope, ClaudeFileKind } from './claude-config';

/**
 * The wire shapes the Claude Config page and the main process exchange.
 *
 * Kept beside the pure path model rather than in it, because these describe
 * an IPC contract while `claude-config.ts` describes paths.
 */

/**
 * A file's identity at the moment it was read, used to detect a change made
 * outside Fleet before a write lands.
 *
 * Three fields rather than a bare mtime: creation and deletion both have to be
 * distinguishable, and a restored backup can carry an equal or older timestamp
 * with different content, which a `newer than` comparison would wave through.
 */
export type ClaudeFileRevision = {
  exists: boolean;
  /** Zero when the file did not exist. */
  mtimeMs: number;
  /** Zero when the file did not exist. */
  size: number;
};

export type ClaudeReadResult = {
  /** File contents, or `{}` for a missing or empty settings file. */
  text: string;
  revision: ClaudeFileRevision;
  /** Whether a file was actually there. Distinct from `text` being empty. */
  exists: boolean;
  /** Present but could not be read - a permission problem, say. */
  unreadable?: boolean;
};

/** Why a write was refused. Each maps to a different thing to tell the user. */
export type ClaudeWriteRefusal =
  /** The file changed on disk since it was read. */
  | 'modified'
  /** It existed when read and is now gone. */
  | 'deleted'
  /** It did not exist when read and now does. */
  | 'created'
  /** The parent directory could not be created. */
  | 'missingDir'
  /** The document is not a JSON object. */
  | 'invalidJson'
  /** Not one of the five files this page may touch. */
  | 'refused'
  /** The write itself threw. */
  | 'failed';

export type ClaudeWriteResult =
  | {
      ok: true;
      /** The revision to hold from now on. */
      revision: ClaudeFileRevision;
      /**
       * The document carried a `hooks` value differing from the one on disk,
       * and the disk value was used instead. The page tells the user their
       * hooks edit did not apply.
       */
      hooksDiscarded?: boolean;
    }
  | {
      ok: false;
      reason: ClaudeWriteRefusal;
      /** What is on disk now, so the page can offer a reload. */
      revision: ClaudeFileRevision;
      message?: string;
    };

export type ClaudeReadRequest = {
  scope: ClaudeConfigScope;
  kind: ClaudeFileKind;
  dirs: ClaudeConfigDirs;
};

export type ClaudeWriteRequest = ClaudeReadRequest & {
  text: string;
  expected: ClaudeFileRevision;
};

/** Where `settings.local.json` goes for a given session directory, and why. */
export type LocalSettingsRootResult = {
  root: string;
  /** Which rule produced it, so the page can say so instead of just asserting a path. */
  rule: 'worktreeMainCheckout' | 'repositoryRoot' | 'sessionDirectory';
};
