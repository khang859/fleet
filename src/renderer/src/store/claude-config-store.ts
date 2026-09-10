import { create } from 'zustand';
import { createLogger } from '../logger';
import type {
  ClaudeConfigScope,
  ClaudeFileKind,
  ClaudeConfigDirs
} from '../../../shared/claude-config';
import type { ClaudeFileRevision, ClaudeWriteResult } from '../../../shared/claude-config-types';

const log = createLogger('store:claude-config');

/**
 * State for Settings > Claude Config.
 *
 * In a store rather than in the section component because `SettingsTab` swaps
 * `SectionComponent` on navigation, destroying component state. The page's own
 * hooks panel links to the Copilot page, so "leave and come back" is a path the
 * design puts in front of the user - and an unsaved edit must survive it.
 *
 * Documents are keyed by *resolved absolute path*, not by scope. Two scopes can
 * resolve to the same file (a project whose local-settings root is its own
 * session directory), and keying by path makes them one document instead of two
 * that silently diverge. It also means switching the session directory away and
 * back finds the draft still there.
 */

export type ClaudeDocument = {
  path: string;
  kind: ClaudeFileKind;
  /** Current editor text. `{}` for a settings file that is not on disk. */
  text: string;
  /** Text as last read or written, for the dirty comparison. */
  savedText: string;
  /** What disk looked like when this text was loaded. */
  revision: ClaudeFileRevision;
  exists: boolean;
  loading: boolean;
  /** Set when a save was refused, so the page can offer reload or overwrite. */
  conflict?: { reason: string; message?: string };
  /** Set when a save landed but the document's `hooks` value was not used. */
  hooksDiscarded?: boolean;
};

/** Which rule produced the local-settings root, for the page to disclose. */
export type LocalRootRule = 'worktreeMainCheckout' | 'repositoryRoot' | 'sessionDirectory';

type ClaudeConfigState = {
  scope: ClaudeConfigScope;
  kind: ClaudeFileKind;
  /** The user config folder, resolved from the active workspace's assignment. */
  configDir: string;
  /** The session's working directory. Empty until a pane or a picker supplies one. */
  sessionDir: string;
  localSettingsRoot: string;
  localRootRule: LocalRootRule;
  /** True once the user picked a directory by hand, so nothing auto-overwrites it. */
  sessionDirPinned: boolean;
  localRootPinned: boolean;
  /** Keyed by resolved absolute path. */
  documents: Record<string, ClaudeDocument | undefined>;
  /**
   * Paths whose disk content moved on while a draft was open. Kept apart from
   * the document so a refresh never has to choose between telling the user and
   * keeping their edit - it does both.
   */
  staleOnDisk: Record<string, boolean>;

  setScope: (scope: ClaudeConfigScope) => void;
  setKind: (kind: ClaudeFileKind) => void;
  setConfigDir: (dir: string) => void;
  /** Adopt a session directory and re-derive the local root, unless pinned. */
  adoptSessionDir: (dir: string, pinned: boolean) => Promise<void>;
  pinLocalRoot: (dir: string) => void;

  dirs: () => ClaudeConfigDirs;
  load: (
    scope: ClaudeConfigScope,
    kind: ClaudeFileKind,
    path: string,
    opts?: { force?: boolean }
  ) => Promise<void>;
  edit: (path: string, text: string) => void;
  save: (
    scope: ClaudeConfigScope,
    kind: ClaudeFileKind,
    path: string,
    opts?: { overwrite?: boolean }
  ) => Promise<ClaudeWriteResult | null>;
  /** Adopt what is on disk, discarding the draft. */
  reload: (scope: ClaudeConfigScope, kind: ClaudeFileKind, path: string) => Promise<void>;
  /**
   * Re-read on window focus. A clean document adopts the disk content; a dirty
   * one keeps its draft and is flagged stale instead.
   */
  refreshFromDisk: (scope: ClaudeConfigScope, kind: ClaudeFileKind, path: string) => Promise<void>;
  dismissNotice: (path: string) => void;
};

export const isDirty = (doc: ClaudeDocument | undefined): boolean =>
  doc !== undefined && doc.text !== doc.savedText;

export const useClaudeConfigStore = create<ClaudeConfigState>((set, get) => {
  const patch = (path: string, next: Partial<ClaudeDocument>): void => {
    set((s) => {
      const current = s.documents[path];
      if (!current) return s;
      return { documents: { ...s.documents, [path]: { ...current, ...next } } };
    });
  };

  return {
    scope: 'user',
    kind: 'settings',
    configDir: '',
    sessionDir: '',
    localSettingsRoot: '',
    localRootRule: 'sessionDirectory',
    sessionDirPinned: false,
    localRootPinned: false,
    documents: {},
    staleOnDisk: {},

    setScope: (scope) => set({ scope }),
    setKind: (kind) => set({ kind }),
    setConfigDir: (configDir) => set({ configDir }),

    adoptSessionDir: async (dir, pinned) => {
      // A pinned directory is the user's explicit choice; an automatic update
      // from the active pane must not silently move them somewhere else.
      if (!pinned && get().sessionDirPinned) return;
      if (!dir) return;
      set({ sessionDir: dir, sessionDirPinned: pinned || get().sessionDirPinned });

      if (get().localRootPinned) return;
      try {
        const result = await window.fleet.claudeConfig.resolveLocalRoot(dir);
        // The session directory may have changed again while this was in
        // flight; only apply an answer that still matches.
        if (get().sessionDir !== dir) return;
        set({ localSettingsRoot: result.root, localRootRule: result.rule });
      } catch (err) {
        log.error('could not resolve local settings root', { dir, error: String(err) });
        set({ localSettingsRoot: dir, localRootRule: 'sessionDirectory' });
      }
    },

    pinLocalRoot: (dir) =>
      set({ localSettingsRoot: dir, localRootPinned: true, localRootRule: 'sessionDirectory' }),

    dirs: () => {
      const s = get();
      return {
        configDir: s.configDir,
        sessionDir: s.sessionDir || undefined,
        localSettingsRoot: s.localSettingsRoot || undefined
      };
    },

    load: async (scope, kind, path, opts) => {
      const existing = get().documents[path];
      // A draft is never replaced by a background load. The page shows a
      // "changed on disk" banner instead, so an edit is not lost to a refresh
      // the user did not ask for.
      if (existing && isDirty(existing) && !opts?.force) return;
      if (existing?.loading) return;

      set((s) => ({
        documents: {
          ...s.documents,
          [path]: existing
            ? { ...existing, loading: true }
            : {
                path,
                kind,
                text: kind === 'settings' ? '{}' : '',
                savedText: kind === 'settings' ? '{}' : '',
                revision: { exists: false, mtimeMs: 0, size: 0 },
                exists: false,
                loading: true
              }
        }
      }));

      // The editors stay usable while a read is in flight, so the draft has to
      // be rechecked after the await as well as before it. Without this, typing
      // during a load is overwritten by the disk text that arrives a moment
      // later, and the document is marked clean on top of it.
      const textAtRequest = get().documents[path]?.text;

      try {
        const result = await window.fleet.claudeConfig.read({ scope, kind, dirs: get().dirs() });
        const now = get().documents[path];
        const typedWhileLoading = now !== undefined && now.text !== textAtRequest;

        // A forced reload is the user asking for the disk version, so it still
        // wins. An ordinary background load never takes an edit away.
        if (typedWhileLoading && !opts?.force) {
          // The revision is the write's optimistic lock, and it belongs to the
          // text this draft was based on. Taking the one just read would let
          // the next ordinary Save pass the lock and silently overwrite the
          // change that landed while the user was typing - the stale banner
          // alone does not guard the write. So the token only moves when disk
          // still matches the draft's baseline; otherwise it stays behind and
          // the write is refused into the conflict flow.
          const sameOnDisk = result.text === now.savedText;
          patch(path, {
            ...(sameOnDisk ? { revision: result.revision } : {}),
            exists: result.exists,
            loading: false
          });
          if (!sameOnDisk) {
            set((s) => ({ staleOnDisk: { ...s.staleOnDisk, [path]: true } }));
          }
          return;
        }

        patch(path, {
          text: result.text,
          savedText: result.text,
          revision: result.revision,
          exists: result.exists,
          loading: false,
          conflict: undefined
        });
      } catch (err) {
        log.error('could not read Claude config file', { path, error: String(err) });
        patch(path, { loading: false });
      }
    },

    edit: (path, text) => patch(path, { text, conflict: undefined, hooksDiscarded: undefined }),

    save: async (scope, kind, path, opts) => {
      const doc = get().documents[path];
      if (!doc) return null;

      // Overwrite re-issues the write against what disk looks like *now*. The
      // hooks substitution in main still applies, so an overwrite after a hook
      // installation carries the installed hooks rather than the stale ones.
      const expected = opts?.overwrite ? undefined : doc.revision;
      let revision = expected ?? doc.revision;
      if (opts?.overwrite) {
        try {
          const fresh = await window.fleet.claudeConfig.read({ scope, kind, dirs: get().dirs() });
          revision = fresh.revision;
        } catch (err) {
          log.error('could not re-read before overwrite', { path, error: String(err) });
          return null;
        }
      }

      try {
        const result = await window.fleet.claudeConfig.write({
          scope,
          kind,
          dirs: get().dirs(),
          text: doc.text,
          expected: revision
        });
        if (result.ok) {
          set((s) => ({ staleOnDisk: { ...s.staleOnDisk, [path]: false } }));
          patch(path, {
            savedText: doc.text,
            revision: result.revision,
            exists: true,
            conflict: undefined,
            hooksDiscarded: result.hooksDiscarded
          });
        } else {
          patch(path, { conflict: { reason: result.reason, message: result.message } });
        }
        return result;
      } catch (err) {
        log.error('could not write Claude config file', { path, error: String(err) });
        patch(path, { conflict: { reason: 'failed', message: String(err) } });
        return null;
      }
    },

    reload: async (scope, kind, path) => {
      await get().load(scope, kind, path, { force: true });
      set((s) => ({ staleOnDisk: { ...s.staleOnDisk, [path]: false } }));
    },

    refreshFromDisk: async (scope, kind, path) => {
      const doc = get().documents[path];
      if (!doc || doc.loading) return;
      let fresh: Awaited<ReturnType<typeof window.fleet.claudeConfig.read>>;
      try {
        fresh = await window.fleet.claudeConfig.read({ scope, kind, dirs: get().dirs() });
      } catch (err) {
        log.error('could not refresh Claude config file', { path, error: String(err) });
        return;
      }
      if (get().documents[path] !== doc) return;
      if (fresh.text === doc.savedText) return;

      if (!isDirty(doc)) {
        patch(path, {
          text: fresh.text,
          savedText: fresh.text,
          revision: fresh.revision,
          exists: fresh.exists
        });
        set((s) => ({ staleOnDisk: { ...s.staleOnDisk, [path]: false } }));
        return;
      }
      set((s) => ({ staleOnDisk: { ...s.staleOnDisk, [path]: true } }));
    },

    dismissNotice: (path) => patch(path, { conflict: undefined, hooksDiscarded: undefined })
  };
});
