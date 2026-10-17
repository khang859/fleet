import type { PathContext } from '../../../shared/shell-profiles';
import {
  collectPaneLeafs,
  findAdmiralPane,
  getActivePaneContext,
  useWorkspaceStore
} from '../store/workspace-store';
import { useSettingsStore } from '../store/settings-store';
import { useToastStore } from '../store/toast-store';
import { useRemoteStore } from '../store/remote-store';
import { focusPane } from './focus-pane';

export type OpenAdmiralOutcome = 'opened' | 'focused' | 'refused';

/**
 * Open the Admiral for the repository `cwd` is in, or bring forward the one
 * already open for it.
 *
 * The repository is resolved in main from the git common dir, so a worktree or
 * a crew workspace finds the same Admiral as the main checkout. A submodule is
 * its own repository, but when its superproject already has an Admiral that
 * one is shown instead. The one-per-repo rule is checked here against every
 * open workspace and then again in main, which has the last word.
 */
export async function openAdmiral(
  cwd: string,
  opts: { remote?: boolean; pathContext?: PathContext } = {}
): Promise<OpenAdmiralOutcome> {
  const toast = useToastStore.getState().show;
  if (useSettingsStore.getState().settings?.agency.enabled !== true) {
    toast('Turn on Admiral in Settings > Agency first');
    return 'refused';
  }

  const repo = await window.fleet.agency.resolveRepo(cwd, opts);
  if (!repo.ok) {
    toast(
      repo.reason === 'remote'
        ? 'An Admiral runs on this machine, so it cannot open on a remote folder'
        : 'An Admiral needs a git repository. Open it from a folder inside one.'
    );
    return 'refused';
  }

  const state = useWorkspaceStore.getState();
  const existing =
    findAdmiralPane(state, repo.repoId) ??
    (repo.superprojectRepoId === null ? null : findAdmiralPane(state, repo.superprojectRepoId));
  if (existing !== null && (await focusPane(existing))) return 'focused';

  const paneId = crypto.randomUUID();
  const claim = await window.fleet.agency.claimAdmiral({ repoId: repo.repoId, paneId });
  if (!claim.ok) {
    if (await focusPane(claim.ownerPaneId)) return 'focused';
    toast(`The Admiral for ${repo.name} is open in another window`);
    return 'refused';
  }

  const ref = { repoId: repo.repoId, root: repo.root, name: repo.name };
  try {
    const lobbySessionId = await window.fleet.agency.ensureLobby(ref);
    useWorkspaceStore.getState().openAdmiralPane(ref, { paneId, lobbySessionId });
  } catch (err) {
    // No pane holds the claim, so nothing else would ever give it up.
    await window.fleet.agency.releaseAdmiral(paneId);
    throw err;
  }
  return 'opened';
}

/** Open the Admiral for the folder the focused pane is in. */
export async function openAdmiralHere(): Promise<OpenAdmiralOutcome> {
  const { cwd, pathContext, paneId } = getActivePaneContext();
  const state = useWorkspaceStore.getState();
  const tab = state.workspace.tabs.find((t) => t.id === state.activeTabId);
  const leaf = tab && paneId ? collectPaneLeafs(tab.splitRoot).find((l) => l.id === paneId) : null;
  const remote =
    leaf?.remoteHost !== undefined ||
    (paneId !== null && useRemoteStore.getState().remotes.has(paneId));
  return openAdmiral(cwd || window.fleet.homeDir, { remote, pathContext });
}
