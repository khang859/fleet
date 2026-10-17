import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkspaceStore, findAdmiralPane } from '../../store/workspace-store';
import { useSettingsStore } from '../../store/settings-store';
import { useToastStore } from '../../store/toast-store';
import { DEFAULT_SETTINGS } from '../../../../shared/constants';
import type { AdmiralClaimResult, RepoResolution } from '../../../../shared/agency';
import type { Workspace } from '../../../../shared/types';
import { openAdmiral } from '../open-admiral';

const REPO_ID = '0123456789abcdef';
const SUBMODULE_ID = '1111222233334444';

const WS: Workspace = {
  id: 'ws',
  label: 'W',
  tabs: [
    {
      id: 'tab-shell',
      label: 'Shell',
      labelIsCustom: false,
      cwd: '/dev/fleet',
      splitRoot: { type: 'leaf', id: 'pane-shell', cwd: '/dev/fleet' }
    }
  ]
};

const inRepo = (extra: Partial<Extract<RepoResolution, { ok: true }>> = {}): RepoResolution => ({
  ok: true,
  repoId: REPO_ID,
  root: '/dev/fleet',
  name: 'fleet',
  gitCommonDir: '/dev/fleet/.git',
  superprojectRoot: null,
  superprojectRepoId: null,
  ...extra
});

const agency = {
  resolveRepo: vi.fn(async (): Promise<RepoResolution> => Promise.resolve(inRepo())),
  claimAdmiral: vi.fn(async (): Promise<AdmiralClaimResult> => Promise.resolve({ ok: true })),
  ensureLobby: vi.fn(async () => Promise.resolve('lobby-1')),
  releaseAdmiral: vi.fn(async () => Promise.resolve())
};
const toasts: string[] = [];

function enable(enabled: boolean): void {
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, agency: { ...DEFAULT_SETTINGS.agency, enabled } }
  });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  for (const fn of Object.values(agency)) fn.mockClear();
  agency.resolveRepo.mockImplementation(async () => Promise.resolve(inRepo()));
  agency.claimAdmiral.mockImplementation(async () => Promise.resolve({ ok: true as const }));
  (window.fleet as { agency: unknown }).agency = agency;
  (window.fleet as { settings: unknown }).settings = {
    set: async () => Promise.resolve(undefined)
  };
  toasts.length = 0;
  useToastStore.setState({ show: (message: string) => void toasts.push(message) });
  useWorkspaceStore.setState({
    workspace: WS,
    backgroundWorkspaces: new Map(),
    activeTabId: 'tab-shell',
    activePaneId: 'pane-shell',
    recentFolders: []
  });
  enable(true);
});

describe('openAdmiral', () => {
  it('claims the repository, makes its lobby and opens the pane on the claimed id', async () => {
    await expect(openAdmiral('/dev/fleet/src')).resolves.toBe('opened');

    const paneId = findAdmiralPane(useWorkspaceStore.getState(), REPO_ID);
    expect(paneId).not.toBeNull();
    expect(agency.claimAdmiral).toHaveBeenCalledWith({ repoId: REPO_ID, paneId });
    expect(agency.ensureLobby).toHaveBeenCalledWith({
      repoId: REPO_ID,
      root: '/dev/fleet',
      name: 'fleet'
    });
    expect(useWorkspaceStore.getState().activePaneId).toBe(paneId);
  });

  it('brings forward the Admiral already open for the repository, from a worktree too', async () => {
    await openAdmiral('/dev/fleet');
    const first = findAdmiralPane(useWorkspaceStore.getState(), REPO_ID);
    useWorkspaceStore.setState({ activeTabId: 'tab-shell', activePaneId: 'pane-shell' });
    agency.claimAdmiral.mockClear();
    // A linked worktree resolves to the main checkout's repository.
    await expect(openAdmiral('/wt/fleet-bold')).resolves.toBe('focused');
    expect(useWorkspaceStore.getState().activePaneId).toBe(first);
    expect(agency.claimAdmiral).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspace.tabs).toHaveLength(2);
  });

  it("brings forward the superproject's Admiral from inside a submodule", async () => {
    await openAdmiral('/dev/fleet');
    const parent = findAdmiralPane(useWorkspaceStore.getState(), REPO_ID);
    useWorkspaceStore.setState({ activeTabId: 'tab-shell', activePaneId: 'pane-shell' });
    agency.resolveRepo.mockImplementation(async () =>
      Promise.resolve(
        inRepo({
          repoId: SUBMODULE_ID,
          root: '/dev/fleet/vendor/lib',
          name: 'lib',
          superprojectRoot: '/dev/fleet',
          superprojectRepoId: REPO_ID
        })
      )
    );

    await expect(openAdmiral('/dev/fleet/vendor/lib')).resolves.toBe('focused');
    expect(useWorkspaceStore.getState().activePaneId).toBe(parent);
  });

  it('refuses a folder outside any repository with a toast', async () => {
    agency.resolveRepo.mockImplementation(async () =>
      Promise.resolve({ ok: false as const, reason: 'not-a-repo' as const })
    );
    await expect(openAdmiral('/tmp')).resolves.toBe('refused');
    expect(toasts).toEqual([
      'An Admiral needs a git repository. Open it from a folder inside one.'
    ]);
    expect(agency.claimAdmiral).not.toHaveBeenCalled();
  });

  it('refuses a remote folder with a toast', async () => {
    agency.resolveRepo.mockImplementation(async () =>
      Promise.resolve({ ok: false as const, reason: 'remote' as const })
    );
    await expect(openAdmiral('/srv/app', { remote: true })).resolves.toBe('refused');
    expect(agency.resolveRepo).toHaveBeenCalledWith('/srv/app', { remote: true });
    expect(toasts[0]).toMatch(/remote folder/);
  });

  it('shows the owning pane when main has the repository claimed already', async () => {
    agency.claimAdmiral.mockImplementation(async () =>
      Promise.resolve({ ok: false as const, ownerPaneId: 'pane-shell' })
    );
    useWorkspaceStore.setState({ activeTabId: null, activePaneId: null });
    await expect(openAdmiral('/dev/fleet')).resolves.toBe('focused');
    expect(useWorkspaceStore.getState().activePaneId).toBe('pane-shell');
    expect(agency.ensureLobby).not.toHaveBeenCalled();
  });

  it('says so when the owning pane is in another window', async () => {
    agency.claimAdmiral.mockImplementation(async () =>
      Promise.resolve({ ok: false as const, ownerPaneId: 'pane-elsewhere' })
    );
    await expect(openAdmiral('/dev/fleet')).resolves.toBe('refused');
    expect(toasts).toEqual(['The Admiral for fleet is open in another window']);
    expect(useWorkspaceStore.getState().workspace.tabs).toHaveLength(1);
  });

  it('does nothing but point at Settings while Admiral is turned off', async () => {
    enable(false);
    await expect(openAdmiral('/dev/fleet')).resolves.toBe('refused');
    expect(toasts).toEqual(['Turn on Admiral in Settings > Agency first']);
    expect(agency.resolveRepo).not.toHaveBeenCalled();
  });
});
