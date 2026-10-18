import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type {
  CrewCatalog,
  CrewPlaybook,
  CrewRole,
  CrewRuntimeView,
  CrewSource,
  RoleDraft
} from '../../../../../shared/agency-crew';
import { draftOf, RUNTIME_LABEL } from '../../../../../shared/agency-crew';
import type { AgencyProjectSummary } from '../../../../../shared/agency-projects';
import { AskAdmiralButton } from '../AskAdmiral';
import { openCrewFile } from './open-file';
import { RoleEditor } from './RoleEditor';
import { PlaybookView } from './PlaybookView';
import { NEW_ROLE, playbookLine, roleTitle, sameDraft, SOURCE_LABEL } from './role-draft';

const FIELD =
  'min-w-0 rounded border border-fleet-border-strong bg-fleet-surface-3 px-2 py-1 text-sm text-fleet-text';
const LABEL = 'text-[11px] font-semibold tracking-wider text-fleet-text-muted';
const SOURCES: CrewSource[] = ['project', 'user', 'bundled'];

type Selection = { kind: 'role'; name: string } | { kind: 'playbook'; name: string };

/**
 * Settings › Agency › Crew: the roles and playbooks a project's Admiral can
 * hire from, where each one's file is, the files that did not load, and the
 * role editor. Drafts are kept per role until saved or discarded, so moving
 * between roles loses nothing.
 */
export function AgencyCrewSection(): React.JSX.Element {
  const [projects, setProjects] = useState<AgencyProjectSummary[] | null>(null);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [crew, setCrew] = useState<CrewCatalog | null>(null);
  const [runtimes, setRuntimes] = useState<CrewRuntimeView[] | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<string, RoleDraft>>>({});

  useEffect(() => {
    void window.fleet.agency.projects.list().then((list) => {
      setProjects(list);
      setRepoId(list.at(0)?.repo.repoId ?? null);
    });
  }, []);

  const load = useCallback(async (id: string): Promise<CrewCatalog> => {
    const catalog = await window.fleet.agency.crew.list(id);
    setCrew(catalog);
    return catalog;
  }, []);

  useEffect(() => {
    if (repoId === null) return;
    setCrew(null);
    setRuntimes(null);
    setDrafts({});
    void load(repoId).then((catalog) => {
      const first = catalog.roles.at(0);
      setSelected(first ? { kind: 'role', name: first.name } : null);
    });
    void window.fleet.agency.crew.runtimes(repoId).then(setRuntimes);
  }, [repoId, load]);

  const roles = useMemo(() => crew?.roles ?? [], [crew]);
  const role =
    selected?.kind === 'role' ? (roles.find((r) => r.name === selected.name) ?? null) : null;
  const isNew = selected?.kind === 'role' && selected.name === NEW_ROLE;
  /** The key the open role's draft is kept under. */
  const draftKey = isNew ? NEW_ROLE : (role?.name ?? null);
  const playbook =
    selected?.kind === 'playbook'
      ? (crew?.playbooks.find((p) => p.name === selected.name) ?? null)
      : null;

  const unsaved = (r: CrewRole): boolean => {
    const draft = drafts[r.name];
    return draft !== undefined && !sameDraft(draft, draftOf(r));
  };
  /** Every role as its draft has it, for the Model list's "used by" counts. */
  const current = roles.map((r) => drafts[r.name] ?? draftOf(r));

  const setDraft = (key: string, draft: RoleDraft | null): void =>
    setDrafts((all) => {
      const next = { ...all };
      if (draft === null) delete next[key];
      else next[key] = draft;
      return next;
    });

  /** Dropping a draft reads the files again, so a file changed outside Fleet shows as it is now. */
  const discard = (key: string): void => {
    setDraft(key, null);
    if (repoId !== null) void load(repoId);
  };

  const saved = async (key: string, name: string): Promise<void> => {
    if (repoId === null) return;
    setDraft(key, null);
    await load(repoId);
    setSelected({ kind: 'role', name });
  };

  return (
    <div className="@container space-y-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-medium text-fleet-text mb-1">Crew</h2>
          <p className="text-sm text-fleet-text-muted">
            Roles are the workers the Admiral can hire. Playbooks are teams of roles in order. Each
            role is a Markdown file.
          </p>
          <div className="mt-3">
            <AskAdmiralButton page="Settings › Agency › Crew" />
          </div>
        </div>
        {projects !== null && projects.length > 1 && (
          <select
            aria-label="Project"
            value={repoId ?? ''}
            onChange={(e) => setRepoId(e.target.value)}
            className={`${FIELD} w-[220px] shrink-0`}
          >
            {projects.map((p) => (
              <option key={p.repo.repoId} value={p.repo.repoId}>
                {p.repo.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {projects?.length === 0 ? (
        <p className="text-sm text-fleet-text-muted">
          Open an Admiral on a project to see the crew it can hire.
        </p>
      ) : (
        <div className="flex flex-col gap-5 @xl:flex-row @xl:items-start">
          <div className="shrink-0 space-y-5 @xl:w-[190px] @3xl:w-[240px]">
            <Playbooks
              playbooks={crew?.playbooks ?? []}
              selected={playbook?.name ?? null}
              onPick={(name) => setSelected({ kind: 'playbook', name })}
            />
            <Roles
              roles={roles}
              selected={draftKey}
              runtimeOf={(r) => (drafts[r.name] ?? r).runtime}
              unsaved={unsaved}
              onPick={(name) => setSelected({ kind: 'role', name })}
              onNew={() => setSelected({ kind: 'role', name: NEW_ROLE })}
            />
            {crew !== null && crew.errors.length > 0 && <FileErrors errors={crew.errors} />}
          </div>

          <div className="min-w-0 flex-1">
            {repoId !== null && draftKey !== null && (
              <RoleEditor
                key={draftKey}
                repoId={repoId}
                role={role}
                draft={drafts[draftKey]}
                onDraft={(d) => setDraft(draftKey, d)}
                onSaved={(name) => void saved(draftKey, name)}
                onDiscard={() => discard(draftKey)}
                runtimes={runtimes}
                roles={current}
              />
            )}
            {playbook !== null && <PlaybookView playbook={playbook} />}
            {crew !== null && draftKey === null && playbook === null && (
              <p className="pt-2 text-sm text-fleet-text-muted">Pick a role or a playbook.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHead(props: { label: string; onNew?: () => void }): React.JSX.Element {
  return (
    <div className="flex h-6 items-center">
      <span className={`${LABEL} flex-1`}>{props.label}</span>
      {props.onNew && (
        <button
          type="button"
          onClick={props.onNew}
          className="rounded px-1.5 py-0.5 text-[11px] text-blue-500 transition-colors hover:bg-fleet-surface-2 dark:text-blue-400 focus-ring"
        >
          + New
        </button>
      )}
    </div>
  );
}

const rowClass = (on: boolean): string =>
  `w-full rounded-md border text-left transition-colors focus-ring ${
    on
      ? 'border-blue-400/50 bg-fleet-surface-3 text-fleet-text'
      : 'border-transparent text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text'
  }`;

function Playbooks(props: {
  playbooks: CrewPlaybook[];
  selected: string | null;
  onPick: (name: string) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <SectionHead label="PLAYBOOKS" />
      {props.playbooks.length === 0 && (
        <p className="px-2.5 text-xs text-fleet-text-subtle">No playbooks.</p>
      )}
      {props.playbooks.map((p) => (
        <button
          key={p.name}
          type="button"
          onClick={() => props.onPick(p.name)}
          className={`${rowClass(props.selected === p.name)} flex flex-col gap-0.5 px-2.5 py-1.5`}
        >
          <span className="text-sm font-medium text-fleet-text">{roleTitle(p.name)}</span>
          <span className="text-[11px] leading-snug text-fleet-text-muted">{playbookLine(p)}</span>
        </button>
      ))}
    </div>
  );
}

function Roles(props: {
  roles: CrewRole[];
  selected: string | null;
  runtimeOf: (role: CrewRole) => CrewRole['runtime'];
  unsaved: (role: CrewRole) => boolean;
  onPick: (name: string) => void;
  onNew: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <SectionHead label="ROLES" onNew={props.onNew} />
      {props.selected === NEW_ROLE && (
        <div className={`${rowClass(true)} flex h-8 items-center px-2.5 text-sm`}>New role</div>
      )}
      {SOURCES.map((source) => {
        const group = props.roles.filter((r) => r.source === source);
        if (group.length === 0) return null;
        return (
          <div key={source} className="space-y-0.5">
            <div className="px-0.5 pt-1 text-[11px] text-fleet-text-subtle">
              {SOURCE_LABEL[source]}
            </div>
            {group.map((r) => (
              <button
                key={r.name}
                type="button"
                onClick={() => props.onPick(r.name)}
                className={`${rowClass(props.selected === r.name)} flex h-8 items-center gap-2 px-2.5 text-sm`}
              >
                <span className="min-w-0 flex-1 truncate">{roleTitle(r.name)}</span>
                {props.unsaved(r) && (
                  <span
                    aria-label="Unsaved changes"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                  />
                )}
                <span className="shrink-0 text-[11px] text-fleet-text-muted">
                  {RUNTIME_LABEL[props.runtimeOf(r)]}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function FileErrors({ errors }: { errors: CrewCatalog['errors'] }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <SectionHead label="FILES THAT DID NOT LOAD" />
      {errors.map((e) => (
        <div
          key={e.path}
          className="space-y-1 rounded-md border border-red-400/30 bg-red-400/5 px-2.5 py-2"
        >
          <div className="flex items-center gap-1.5">
            <CircleAlert size={12} className="shrink-0 text-red-500 dark:text-red-400" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fleet-text">
              {e.path.split(/[\\/]/).at(-1)}
            </span>
            <button
              type="button"
              onClick={() => openCrewFile(e.path)}
              className="shrink-0 rounded px-1 text-[11px] text-blue-500 hover:underline dark:text-blue-400 focus-ring"
            >
              Open file
            </button>
          </div>
          <p className="text-[11px] leading-snug text-fleet-text-muted">
            {SOURCE_LABEL[e.source]}: {e.why}
          </p>
        </div>
      ))}
    </div>
  );
}
