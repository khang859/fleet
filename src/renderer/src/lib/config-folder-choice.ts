import type { EnsureConfigDirResult, SetWorkspaceOverrideResult } from '../../../shared/ipc-api';

export type ConfigFolderChoiceDeps = {
  /** Make the folder exist. Slow enough that the user can change their mind during it. */
  ensureConfigDir: (dir: string) => Promise<EnsureConfigDirResult>;
  /** Persist the choice. Reports whether it changed anything, judged where the settings live. */
  setWorkspaceOverride: (
    workspaceId: string,
    claudeConfigDir: string | null
  ) => Promise<SetWorkspaceOverrideResult>;
  /** Pull the new settings into the renderer. Only called for a change that landed. */
  reload: () => Promise<void>;
  /** Tell the user the change applies to new terminals. Only for a real change. */
  announce: () => void;
  /** Report a folder that could not be created. */
  onError: (message: string) => void;
};

export type ConfigFolderChoice = {
  /** Apply one committed choice. `null` puts the workspace back on the default folder. */
  apply: (workspaceId: string, dir: string | null) => Promise<void>;
};

/**
 * Applies a workspace's Claude config folder choice, cancelling any older one.
 *
 * Lives outside the component for two reasons. It is the part with the race -
 * a folder can take long enough to create that the user picks something else
 * first - and it is the part worth testing with hand-held promises, which a
 * component's event handlers do not let you do.
 *
 * Every committed choice goes through `apply`, including choices that turn out
 * to change nothing. Claiming the newest request is what cancels an older one,
 * and that has to happen whether or not this choice writes anything.
 *
 * What it deliberately does *not* do is decide "this is already saved" itself.
 * The renderer's copy of the settings is stale for as long as any write is in
 * flight, so that comparison belongs to whoever owns the file - which is why
 * `setWorkspaceOverride` reports `changed` instead of being asked.
 */
export function createConfigFolderChoice(deps: ConfigFolderChoiceDeps): ConfigFolderChoice {
  const latest = new Map<string, number>();

  return {
    apply: async (workspaceId, dir) => {
      const seq = (latest.get(workspaceId) ?? 0) + 1;
      latest.set(workspaceId, seq);
      const superseded = (): boolean => latest.get(workspaceId) !== seq;

      if (dir) {
        const created = await deps.ensureConfigDir(dir);
        if (superseded()) return;
        if (!created.ok) {
          deps.onError(`Could not create ${dir}: ${created.error}`);
          return;
        }
      }

      const result = await deps.setWorkspaceOverride(workspaceId, dir);
      if (superseded()) return;
      // Reload on the way out of every request that is still current, even one
      // that changed nothing on disk. An earlier request for this workspace may
      // have been cancelled after its write but before its reload, which leaves
      // the renderer behind the file - and "nothing changed" says the file is
      // right, not that the screen is.
      await deps.reload();
      if (superseded()) return;
      // The toast is the one thing that really is about a change.
      if (result.changed) deps.announce();
    }
  };
}
