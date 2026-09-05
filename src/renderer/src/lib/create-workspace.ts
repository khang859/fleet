import type { Workspace } from '../../../shared/types';

export type NewWorkspaceDraft = {
  /**
   * Generated once per submission and reused on retry, so a save that failed
   * halfway cannot leave a second workspace behind when the user tries again.
   */
  id: string;
  /** Already trimmed and non-empty; the form refuses to submit otherwise. */
  name: string;
  /** A custom Claude config folder, or `null` to inherit the default. */
  claudeConfigDir: string | null;
};

export type CreateWorkspaceResult =
  | { ok: true; workspace: Workspace }
  /**
   * `savedLayout` separates the two failures. False means nothing exists and a
   * plain retry is right. True means the workspace is on disk but its folder
   * choice is not, which the form has to say out loud rather than silently
   * handing back a workspace configured differently from what was asked for.
   */
  | { ok: false; error: string; savedLayout: boolean };

/**
 * Write a new workspace and its optional config-folder override, and say
 * whether that worked.
 *
 * Deliberately separate from *activating* it. The sidebar creates a workspace
 * and switches to it; Settings creates one and stays where it is. Sharing the
 * persistence but not the activation is what lets the same form serve both
 * without Settings interrupting the user's current work.
 *
 * The override is written before anything can spawn a terminal, so the first
 * terminal in the new workspace already gets the folder that was chosen for it.
 *
 * A custom folder is created first, before anything is written. A workspace
 * pointed at a folder that does not exist looks configured but behaves like a
 * fresh Claude install, and Fleet hooks have nowhere to go - so a folder that
 * cannot be created fails the whole creation rather than half of it.
 */
export async function persistNewWorkspace(
  draft: NewWorkspaceDraft
): Promise<CreateWorkspaceResult> {
  // Empty on purpose: the tools and the first terminal are seeded by the
  // activation path, which is the only side that owns pane construction.
  const workspace: Workspace = { id: draft.id, label: draft.name, tabs: [] };

  if (draft.claudeConfigDir) {
    const dir = await window.fleet.settings.ensureConfigDir(draft.claudeConfigDir);
    if (!dir.ok) {
      return { ok: false, error: `folder could not be created: ${dir.error}`, savedLayout: false };
    }
  }

  const saved = await window.fleet.layout.save({ workspace });
  if (!saved.ok) return { ok: false, error: saved.error, savedLayout: false };

  if (draft.claudeConfigDir) {
    try {
      await window.fleet.settings.setWorkspaceOverride(draft.id, draft.claudeConfigDir);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        savedLayout: true
      };
    }
  }

  return { ok: true, workspace };
}
