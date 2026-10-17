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
import {
  folderBadges,
  folderProject,
  homePath,
  keptMembers,
  memberStatus,
  type FolderBadge
} from './onboarding-view';

type RepoFolder = Extract<ProjectFolder, { kind: 'repo' }>;
type WorkspaceFolder = Extract<ProjectFolder, { kind: 'workspace' }>;
/** A row that can be picked: a repository or a workspace. */
type PickFolder = RepoFolder | WorkspaceFolder;

const pickable = (f: ProjectFolder): f is PickFolder => f.kind !== 'not-a-repo';
const projectOf = (f: PickFolder): AgencyRepoRef => (f.kind === 'repo' ? f.repo : f.project);

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

function Badge({ badge }: { badge: FolderBadge }): React.JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap ${BADGE_TONE[badge.tone]}`}
    >
      {badge.label}
    </span>
  );
}

/** `3 submodules` or `2 repositories`: a workspace's members, the umbrella not counted. */
function workspaceSize(folder: WorkspaceFolder): string {
  const n = folder.members.filter((m) => !m.umbrella).length;
  if (folder.projectKind === 'submodules') return `${n} ${n === 1 ? 'submodule' : 'submodules'}`;
  return `${n} ${n === 1 ? 'repository' : 'repositories'}`;
}

function rowMeta(folder: ProjectFolder, home: string): string[] {
  const path = homePath(folder.path, home);
  if (folder.kind === 'repo') {
    return [path, folder.branch, folder.remote ?? 'no remote'].filter(
      (p): p is string => p !== null
    );
  }
  return [path];
}

/** One folder in the picker: a repository or workspace to pick, or a folder that cannot be one. */
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
  const repo = folderProject(folder);
  const name = repo?.name ?? basename(folder.path);
  const meta = rowMeta(folder, home);
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
          {folder.kind === 'workspace' && (
            <Badge badge={{ label: workspaceSize(folder), tone: 'plain' }} />
          )}
          {folderBadges(folder, admiralOpen).map((b) => (
            <Badge key={b.label} badge={b} />
          ))}
        </span>
      )}
    </button>
  );
}

/**
 * Members the client left out, by workspace, until the project is chosen.
 * A workspace not touched yet starts from what was left out before.
 */
function useLeftOut(): {
  left: (f: WorkspaceFolder) => string[];
  toggle: (f: WorkspaceFolder, name: string) => void;
} {
  const [leftOut, setLeftOut] = useState<Record<string, string[]>>({});
  const left = (f: WorkspaceFolder): string[] =>
    leftOut[f.path] ?? f.members.filter((m) => m.leftOut).map((m) => m.name);
  const toggle = (f: WorkspaceFolder, name: string): void => {
    const now = left(f);
    setLeftOut({
      ...leftOut,
      [f.path]: now.includes(name) ? now.filter((n) => n !== name) : [...now, name]
    });
  };
  return { left, toggle };
}

/** The project to open: a workspace is saved as one first, so its members find its Admiral. */
async function chosenProject(
  folder: PickFolder,
  left: (f: WorkspaceFolder) => string[]
): Promise<AgencyRepoRef> {
  if (folder.kind === 'repo') return folder.repo;
  return window.fleet.agency.projects.chooseWorkspace({ path: folder.path, leftOut: left(folder) });
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
 * Which project the Admiral should run: the repositories and workspaces in
 * Fleet's workspaces and recent folders, any other folder, or a fresh clone.
 * A project is one git repository, or a workspace of them whose members the
 * client can leave out; a folder that is neither is shown but cannot be
 * picked.
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
  const { left, toggle: toggleMember } = useLeftOut();

  const load = useCallback(async (): Promise<void> => {
    const saved = await window.fleet.layout
      .list()
      .then((r) => r.workspaces)
      .catch(() => []);
    const [workspaces, recent] = await Promise.all([
      window.fleet.agency.projects.probeFolders([current.root, ...workspaceFolders(saved)]),
      window.fleet.agency.projects.probeFolders([...extra, ...recentFolders])
    ]);
    const inWorkspaces = new Set(workspaces.flatMap((f) => folderProject(f)?.repoId ?? []));
    setLists({
      // A workspace folder that is not a repository is not worth a row: it is
      // a terminal somewhere, not a project someone meant.
      workspaces: workspaces.filter(pickable),
      recent: recent.filter((f) => !pickable(f) || !inWorkspaces.has(projectOf(f).repoId))
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
  const repos = all.filter(pickable);
  const selected =
    repos.find((f) => f.path === selectedPath) ??
    repos.find((f) => projectOf(f).repoId === current.repoId) ??
    repos.at(0) ??
    null;

  // Joined into a string so the picker redraws when an Admiral opens or closes, not on every store write.
  const openIds = useWorkspaceStore((s) =>
    repos
      .map((f) => projectOf(f).repoId)
      .filter((id) => findAdmiralPane(s, id) !== null)
      .join(',')
  );
  const admiralOpen = (f: ProjectFolder): boolean => {
    const id = folderProject(f)?.repoId;
    return id !== undefined && id !== current.repoId && openIds.split(',').includes(id);
  };

  const matches = (f: ProjectFolder): boolean => {
    const q = query.trim().toLowerCase();
    if (q === '') return true;
    const name = folderProject(f)?.name ?? basename(f.path);
    return name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
  };

  const openFolder = async (): Promise<void> => {
    const path = await window.fleet.showFolderPicker();
    if (path === null) return;
    const folder = (await window.fleet.agency.projects.probeFolders([path])).at(0);
    if (folder === undefined || folder.kind === 'not-a-repo') {
      setError(
        `${basename(path)} is not a git repository and holds none. An Admiral runs one repository or a folder of them: pick one, or clone one from GitHub.`
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
    setBusy(true);
    setError(null);
    try {
      const project = await chosenProject(selected, left);
      if (project.repoId === current.repoId) {
        setPicking(paneId, false);
        return;
      }
      const outcome = await openAdmiral(project.root);
      if (outcome === 'refused') return;
      setPicking(paneId, false);
      // An Admiral opened only to reach this picker, for a repository that was
      // never set up and has no jobs, would be an empty tab left behind.
      const onboarding = currentSnapshot?.onboarding;
      if (onboarding?.setupDoneAt === null && (currentSnapshot?.jobs.length ?? 0) === 0) {
        useWorkspaceStore.getState().closePane(paneId);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
                A project is one git repository, or a workspace of them. Each project gets its own
                Admiral, its own jobs and its own settings.
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
              Pick a project to see what happens next.
            </p>
          ) : (
            <SelectedProject
              folder={selected}
              isCurrent={projectOf(selected).repoId === current.repoId}
              admiralOpen={admiralOpen(selected)}
              busy={busy}
              left={left}
              onToggleMember={toggleMember}
              home={home}
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
  selected: PickFolder | null;
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
  'The Admiral reads the project to learn how it builds and tests. It only reads. Nothing runs and nothing changes.',
  'You check what it found and fix anything it got wrong.',
  'It asks you a few questions about how you like to work.',
  'Then you give it a first brief.'
];

function selectedNote(folder: PickFolder): string {
  if (folder.setupDone) return 'Set up already. Its Admiral knows how it builds and tests.';
  if (folder.kind === 'workspace') {
    return folder.projectKind === 'submodules'
      ? 'An umbrella repository and its submodules. A job can change several members and delivers one PR for each.'
      : 'A folder of git repositories. A job can change several of them and delivers one PR for each.';
  }
  if (folder.teamFiles) {
    return 'A teammate shared Admiral files in .fleet/. Setup shows them, and you pick what to import.';
  }
  if (folder.remote === null) {
    return 'One git repository with no remote. Crew leave local branches for you to push.';
  }
  return `One git repository on ${folder.remote}. Each job delivers one PR.`;
}

/** A workspace's members, each with a box to leave it out; the umbrella always stays. */
export function MemberList({
  folder,
  leftOut,
  home,
  onToggle
}: {
  folder: WorkspaceFolder;
  leftOut: string[];
  home: string;
  onToggle: (name: string) => void;
}): React.JSX.Element {
  const kept = keptMembers(folder, leftOut).length;
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel note={`${kept} of ${folder.members.length} in the project`}>
        MEMBERS
      </SectionLabel>
      <ul className="flex flex-col gap-1">
        {folder.members.map((m) => {
          const status = memberStatus(m);
          const meta = [
            m.path === '.' ? homePath(folder.path, home) : m.path,
            m.branch,
            m.repo === null ? null : (m.remote ?? 'no remote')
          ].filter((p): p is string => p !== null);
          return (
            <li key={m.name}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors hover:bg-fleet-surface-2 has-[:disabled]:cursor-default has-[:disabled]:hover:bg-transparent">
                <input
                  type="checkbox"
                  checked={!leftOut.includes(m.name)}
                  disabled={m.umbrella}
                  onChange={() => onToggle(m.name)}
                  aria-label={`Keep ${m.name} in the project`}
                  className="size-3.5 shrink-0 accent-blue-500"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-fleet-text">
                    {m.name}
                    {m.umbrella && <span className="text-fleet-text-subtle"> · umbrella</span>}
                  </span>
                  <span className="truncate font-mono text-[11px] text-fleet-text-subtle">
                    {meta.join(' · ')}
                  </span>
                </span>
                {status !== null && <Badge badge={status} />}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SelectedProject({
  folder,
  isCurrent,
  admiralOpen,
  busy,
  left,
  onToggleMember,
  home,
  onGo
}: {
  folder: PickFolder;
  isCurrent: boolean;
  admiralOpen: boolean;
  busy: boolean;
  left: (f: WorkspaceFolder) => string[];
  onToggleMember: (f: WorkspaceFolder, name: string) => void;
  home: string;
  onGo: () => void;
}): React.JSX.Element {
  const name = projectOf(folder).name;
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
      {folder.kind === 'workspace' && (
        <MemberList
          folder={folder}
          leftOut={left(folder)}
          home={home}
          onToggle={(name) => onToggleMember(folder, name)}
        />
      )}
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
