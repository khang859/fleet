import { create } from 'zustand';
import { useToastStore } from './toast-store';
import { createLogger } from '../logger';

const log = createLogger('store:hook-status');

/**
 * Four states, not two.
 *
 * A check that is still in flight, and a check that failed, are both "we do not
 * know" - and showing either as "Not installed" invites the user to install
 * hooks that may already be there, or to believe a folder is unconfigured when
 * really the filesystem answer never arrived.
 */
export type HookState = 'checking' | 'installed' | 'missing' | 'error';

type HookEntry = {
  state: HookState;
  /** Bumped per request so a slow answer for an older check is dropped. */
  seq: number;
  /** True while an install or remove is running, so the action cannot double-fire. */
  busy: boolean;
};

type HookStatusState = {
  /**
   * Sparse on purpose: a folder nobody has looked at yet has no entry, and the
   * `?? 'checking'` fallbacks at every read depend on that being visible in the
   * type rather than being an index into a map that claims to be total.
   */
  byFolder: Record<string, HookEntry | undefined>;
  check: (folder: string) => void;
  install: (folder: string) => Promise<void>;
  remove: (folder: string) => Promise<void>;
};

/**
 * Fleet hook installation status, keyed by *folder* rather than by workspace.
 *
 * Hooks live in a Claude config folder, and two workspaces can be pointed at
 * the same one. Keying by workspace made those two rows independent, so
 * installing from one left the other claiming the opposite. Keying by folder
 * makes every consumer of that path one reader of one entry, which is also what
 * lets the default-folder control and an expanded workspace row agree for free.
 */
export const useHookStatusStore = create<HookStatusState>((set, get) => {
  /** Write a result only if it still answers the newest request for that folder. */
  const settle = (folder: string, seq: number, state: HookState): void => {
    const entry = get().byFolder[folder];
    if (entry?.seq !== seq) return;
    set((s) => ({ byFolder: { ...s.byFolder, [folder]: { ...entry, state } } }));
  };

  const setBusy = (folder: string, busy: boolean): void => {
    set((s) => ({
      byFolder: {
        ...s.byFolder,
        [folder]: {
          state: s.byFolder[folder]?.state ?? 'checking',
          seq: s.byFolder[folder]?.seq ?? 0,
          busy
        }
      }
    }));
  };

  const check = (folder: string): void => {
    if (!folder) return;
    const seq = (get().byFolder[folder]?.seq ?? 0) + 1;
    set((s) => ({
      byFolder: {
        ...s.byFolder,
        [folder]: { state: 'checking', seq, busy: s.byFolder[folder]?.busy ?? false }
      }
    }));
    window.fleet.copilot.hookStatusFor(folder).then(
      (installed) => settle(folder, seq, installed ? 'installed' : 'missing'),
      (err: unknown) => {
        log.error('hook status check failed', { folder, error: String(err) });
        settle(folder, seq, 'error');
      }
    );
  };

  /**
   * Shared by install and remove: run the operation, then re-check rather than
   * assume. An optimistic flip would report success for a write that threw.
   */
  const mutate = async (
    folder: string,
    run: (folder: string) => Promise<boolean>,
    failureMessage: string
  ): Promise<void> => {
    if (!folder || get().byFolder[folder]?.busy) return;
    setBusy(folder, true);
    try {
      await run(folder);
    } catch (err) {
      log.error(failureMessage, { folder, error: String(err) });
      useToastStore.getState().show(failureMessage);
    } finally {
      setBusy(folder, false);
      check(folder);
    }
  };

  return {
    byFolder: {},
    check,
    install: async (folder) =>
      mutate(folder, window.fleet.copilot.installHooksTo, 'Could not install Fleet hooks'),
    remove: async (folder) =>
      mutate(folder, window.fleet.copilot.uninstallHooksFrom, 'Could not remove Fleet hooks')
  };
});
