import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type { ProjectFolder } from '../../../../shared/agency-projects';
import type { Workspace } from '../../../../shared/types';
import { openAdmiral } from '../../lib/open-admiral';
import { useAgencyStore } from '../../store/agency-store';
import { useAdmiralOnboardingStore } from '../../store/admiral-onboarding-store';
import { collectPaneLeafs, findAdmiralPane, useWorkspaceStore } from '../../store/workspace-store';
import { CloneDialog } from './CloneDialog';
import { OnboardingButton, SectionLabel, textInputCls } from './onboarding-ui';
import { folderBadges, homePath, type FolderBadge } from './onboarding-view';

type RepoFolder = Extract<ProjectFolder, { kind: 'repo' }>;

const BADGE_TONE: Record<FolderBadge['tone'], string> = {
  green: 'bg-green-500/10 text-green-600 dark:text-green-400',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  plain: 'bg-fleet-surface-2 text-fleet-text-muted'
};

function initials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const two = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
  return two.toUpperCase();
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** One folder in the picker: a repository to pick, or a folder that cannot be one. */
export function ProjectRow({
  folder,
  selected,
  admiralOpen,
  home,
  onSelect
}: {
  folder: ProjectFolder;
  selected: boolean;
  admiralOpen: boolean;
  home: string;
  onSelect: () => void;
}): React.JSX.Element {
  const repo = folder.kind === 'repo' ? folder : null;
  const name = repo?.repo.name ?? basename(folder.path);
  const meta = repo
    ? [homePath(folder.path, home), repo.branch, repo.remote ?? 'no remote'].filter(
        (p): p is string => p !== null
      )
    : [homePath(folder.path, home)];
  return (
    <button
      type="button"
      disabled={repo === null}
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition focus-ring ${
        selected
          ? 'border-blue-500/60 bg-fleet-surface'
          : 'border-fleet-border bg-fleet-surface hover:border-fleet-border-strong'
      } disabled:cursor-default disabled:bg-transparent disabled:hover:border-fleet-border`}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-md bg-fleet-surface-2 text-[11px] font-semibold ${
          repo ? 'text-fleet-text' : 'text-fleet-text-subtle'
        }`}
      >
        {initials(name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`truncate text-[13px] font-medium ${repo ? 'text-fleet-text' : 'text-fleet-text-muted'}`}
        >
          {name}
        </span>
        <span className="truncate font-mono text-[11px] text-fleet-text-subtle">
          {meta.join(' · ')}
        </span>
      </span>
      {repo === null ? (
        <span className="shrink-0 text-[11px] text-fleet-text-subtle">Not a git repository</span>
      ) : (
        <span className="flex shrink-0 flex-wrap justify-end gap-1">
          {folderBadges(folder, admiralOpen).map((b) => (
            <span
              key={b.label}
              className={`rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap ${BADGE_TONE[b.tone]}`}
            >
              {b.label}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** Every folder the open and saved workspaces work in, on this machine. */
function workspaceFolders(saved: Workspace[]): string[] {
  const { workspace, backgroundWorkspaces } = useWorkspaceStore.getState();
  const out: string[] = [];
  for (const ws of [workspace, ...backgroundWorkspaces.values(), ...saved]) {
    for (const tab of ws.tabs) {
      if (tab.cwd) out.push(tab.cwd);
      for (const leaf of collectPaneLeafs(tab.splitRoot)) {
        if (leaf.remoteHost === undefined && leaf.cwd) out.push(leaf.cwd);
      }
    }
  }
  return out;
}

type Lists = { workspaces: ProjectFolder[]; recent: ProjectFolder[] };

/**
 * Which project the Admiral should run: the repositories in Fleet's
 * workspaces and recent folders, any other folder, or a fresh clone. A
 * project is one git repository; a folder that is not one is shown but
 * cannot be picked.
 */
export function ProjectPicker({
  paneId,
  current,
  wide
}: {
  paneId: string;
  /** The repository this Admiral pane is bound to. */
  current: AgencyRepoRef;
  /** Room for the selected project beside the list rather than under it. */
  wide: boolean;
}): React.JSX.Element {
  const home = window.fleet.homeDir;
  const recentFolders = useWorkspaceStore((s) => s.recentFolders);
  const setPicking = useAdmiralOnboardingStore((s) => s.setPicking);
  const currentSnapshot = useAgencyStore((s) => s.snapshots[current.repoId]);
  const [lists, setLists] = useState<Lists | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const saved = await window.fleet.layout
      .list()
      .then((r) => r.workspaces)
      .catch(() => []);
    const [workspaces, recent] = await Promise.all([
      window.fleet.agency.projects.probeFolders([current.root, ...workspaceFolders(saved)]),
      window.fleet.agency.projects.probeFolders([...extra, ...recentFolders])
    ]);
    const inWorkspaces = new Set(
      workspaces.flatMap((f) => (f.kind === 'repo' ? [f.repo.repoId] : []))
    );
    setLists({
      // A workspace folder that is not a repository is not worth a row: it is
      // a terminal somewhere, not a project someone meant.
      workspaces: workspaces.filter((f) => f.kind === 'repo'),
      recent: recent.filter((f) => f.kind === 'not-a-repo' || !inWorkspaces.has(f.repo.repoId))
    });
  }, [current.root, extra, recentFolders]);

  // Read on open and whenever the window comes back, so a clone finished in
  // its terminal shows up without a click.
  useEffect(() => {
    void load();
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const all = useMemo(() => (lists ? [...lists.workspaces, ...lists.recent] : []), [lists]);
  const repos = all.filter((f): f is RepoFolder => f.kind === 'repo');
  const selected =
    repos.find((f) => f.path === selectedPath) ??
    repos.find((f) => f.repo.repoId === current.repoId) ??
    repos.at(0) ??
    null;

  // Joined into a string so the picker redraws when an Admiral opens or closes, not on every store write.
  const openIds = useWorkspaceStore((s) =>
    repos
      .filter((f) => findAdmiralPane(s, f.repo.repoId) !== null)
      .map((f) => f.repo.repoId)
      .join(',')
  );
  const admiralOpen = (f: ProjectFolder): boolean =>
    f.kind === 'repo' &&
    f.repo.repoId !== current.repoId &&
    openIds.split(',').includes(f.repo.repoId);

  const matches = (f: ProjectFolder): boolean => {
    const q = query.trim().toLowerCase();
    if (q === '') return true;
    const name = f.kind === 'repo' ? f.repo.name : basename(f.path);
    return name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
  };

  const openFolder = async (): Promise<void> => {
    const path = await window.fleet.showFolderPicker();
    if (path === null) return;
    const folder = (await window.fleet.agency.projects.probeFolders([path])).at(0);
    if (folder === undefined || folder.kind === 'not-a-repo') {
      setError(
        `${basename(path)} is not a git repository. An Admiral runs one repository: pick a folder inside one, or clone one from GitHub.`
      );
      return;
    }
    setError(null);
    useWorkspaceStore.getState().addRecentFolder(folder.path);
    setExtra((e) => [folder.path, ...e]);
    setSelectedPath(folder.path);
  };

  const go = async (): Promise<void> => {
    if (selected === null || busy) return;
    if (selected.repo.repoId === current.repoId) {
      setPicking(paneId, false);
      return;
    }
    setBusy(true);
    try {
      const outcome = await openAdmiral(selected.repo.root);
      if (outcome === 'refused') return;
      setPicking(paneId, false);
      // An Admiral opened only to reach this picker, for a repository that was
      // never set up and has no jobs, would be an empty tab left behind.
      const onboarding = currentSnapshot?.onboarding;
      if (onboarding?.setupDoneAt === null && (currentSnapshot?.jobs.length ?? 0) === 0) {
        useWorkspaceStore.getState().closePane(paneId);
      }
    } finally {
      setBusy(false);
    }
  };

  const shown = (list: ProjectFolder[]): ProjectFolder[] => list.filter(matches);
  const canClose = currentSnapshot?.onboarding.setupDoneAt != null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={`flex min-h-0 flex-1 ${wide ? 'flex-row' : 'flex-col overflow-y-auto'}`}>
        <div
          className={`flex min-w-0 flex-col gap-4 px-5 py-5 ${wide ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}
        >
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 className="text-lg font-semibold text-fleet-text">
                Which project should the Admiral run?
              </h2>
              <p className="text-[13px] leading-relaxed text-fleet-text-muted">
                A project is one git repository. Each project gets its own Admiral, its own jobs and
                its own settings.
              </p>
            </div>
            {canClose && (
              <button
                type="button"
                onClick={() => setPicking(paneId, false)}
                aria-label="Back to the Admiral"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <label className="relative flex min-w-[180px] flex-1 items-center">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 text-fleet-text-subtle"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects"
                aria-label="Search projects"
                className={`${textInputCls} w-full pl-8`}
              />
            </label>
            <div className="flex gap-2">
              <OnboardingButton onClick={() => void openFolder()}>Open folder…</OnboardingButton>
              <OnboardingButton onClick={() => setCloneOpen(true)}>
                Clone from GitHub…
              </OnboardingButton>
            </div>
          </div>

          {error !== null && (
            <p
              role="alert"
              className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              {error}
            </p>
          )}

          {lists === null ? (
            <p className="text-xs text-fleet-text-muted">Looking at your folders…</p>
          ) : (
            <>
              <FolderSection
                label="IN YOUR FLEET WORKSPACES"
                folders={shown(lists.workspaces)}
                empty="No repositories in your workspaces yet."
                selected={selected}
                admiralOpen={admiralOpen}
                home={home}
                onSelect={setSelectedPath}
              />
              <FolderSection
                label="RECENT FOLDERS"
                folders={shown(lists.recent)}
                empty="No other recent folders."
                selected={selected}
                admiralOpen={admiralOpen}
                home={home}
                onSelect={setSelectedPath}
              />
            </>
          )}
        </div>

        <aside
          className={`flex shrink-0 flex-col gap-4 border-fleet-border bg-fleet-surface px-5 py-5 ${
            wide ? 'w-[380px] border-l' : 'border-t'
          }`}
        >
          {selected === null ? (
            <p className="text-xs text-fleet-text-muted">
              Pick a repository to see what happens next.
            </p>
          ) : (
            <SelectedProject
              folder={selected}
              isCurrent={selected.repo.repoId === current.repoId}
              admiralOpen={admiralOpen(selected)}
              busy={busy}
              onGo={() => void go()}
            />
          )}
        </aside>
      </div>
      <CloneDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        onStarted={(dest) => setExtra((e) => [dest, ...e])}
      />
    </div>
  );
}

function FolderSection({
  label,
  folders,
  empty,
  selected,
  admiralOpen,
  home,
  onSelect
}: {
  label: string;
  folders: ProjectFolder[];
  empty: string;
  selected: RepoFolder | null;
  admiralOpen: (f: ProjectFolder) => boolean;
  home: string;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      {folders.length === 0 ? (
        <p className="text-xs text-fleet-text-subtle">{empty}</p>
      ) : (
        folders.map((f) => (
          <ProjectRow
            key={f.path}
            folder={f}
            selected={selected?.path === f.path}
            admiralOpen={admiralOpen(f)}
            home={home}
            onSelect={() => onSelect(f.path)}
          />
        ))
      )}
    </section>
  );
}

const NEXT_STEPS = [
  'The Admiral reads the repository to learn how it builds and tests. It only reads. Nothing runs and nothing changes.',
  'You check what it found and fix anything it got wrong.',
  'It asks you a few questions about how you like to work.',
  'Then you give it a first brief.'
];

function selectedNote(folder: RepoFolder): string {
  if (folder.setupDone) return 'Set up already. Its Admiral knows how it builds and tests.';
  if (folder.teamFiles) {
    return 'A teammate shared Admiral files in .fleet/. Setup shows them, and you pick what to import.';
  }
  if (folder.remote === null) {
    return 'One git repository with no remote. Crew leave local branches for you to push.';
  }
  return `One git repository on ${folder.remote}. Each job delivers one PR.`;
}

function SelectedProject({
  folder,
  isCurrent,
  admiralOpen,
  busy,
  onGo
}: {
  folder: RepoFolder;
  isCurrent: boolean;
  admiralOpen: boolean;
  busy: boolean;
  onGo: () => void;
}): React.JSX.Element {
  const name = folder.repo.name;
  const action = folder.setupDone
    ? admiralOpen
      ? `Go to ${name}`
      : `Open ${name}`
    : isCurrent || !admiralOpen
      ? `Set up ${name}`
      : `Go to ${name}`;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <SectionLabel>SELECTED</SectionLabel>
        <span className="truncate text-[15px] font-semibold text-fleet-text">{name}</span>
        <p className="text-xs leading-relaxed text-fleet-text-muted">{selectedNote(folder)}</p>
      </div>
      {!folder.setupDone && (
        <>
          <div className="flex flex-col gap-2.5">
            <SectionLabel>WHAT HAPPENS NEXT</SectionLabel>
            <ol className="flex flex-col gap-2.5">
              {NEXT_STEPS.map((step, i) => (
                <li key={i} className="flex gap-2.5 text-[13px] text-fleet-text-secondary">
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-fleet-surface-2 text-[11px] text-fleet-text">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-col gap-1 rounded-md border border-fleet-border bg-fleet-bg px-3 py-2.5 text-xs text-fleet-text-muted">
            <span>Takes a few seconds and uses no model time.</span>
            <span>No crew starts during setup.</span>
          </div>
        </>
      )}
      <div className="mt-auto pt-2">
        <OnboardingButton
          kind="primary"
          size="lg"
          className="w-full"
          disabled={busy}
          onClick={onGo}
        >
          {action}
        </OnboardingButton>
      </div>
    </>
  );
}
