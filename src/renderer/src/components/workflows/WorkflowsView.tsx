import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { MessageSquare, Pencil, Play, Power, Sparkles, Trash2 } from 'lucide-react';
import {
  agentsOf,
  otherScope,
  type WorkflowEntry,
  type WorkflowRun,
  type WorkflowScope,
  type WorkflowStarter
} from '../../../../shared/workflows';
import { callWorkflows, showWorkflowError, useWorkflowsStore } from '../../store/workflows-store';
import { useToastStore } from '../../store/toast-store';
import { Overlay } from '../Overlay';
import { ApprovalBadge, Badge, Button, Empty, ReplaceNotice, ScopeSwitch } from './parts';
import { formatAgo } from './workflow-format';
import { BuilderStart } from './BuilderStart';
import { RunSheet } from './RunSheet';
import { WorkflowEditor, type EditorSource } from './WorkflowEditor';
import { AwayPanel } from './AwayPanel';

function lastRunOf(entry: WorkflowEntry, runs: WorkflowRun[]): number | null {
  const own = runs.filter((run) => run.workflowPath === entry.path);
  return own.length > 0 ? Math.max(...own.map((run) => run.createdAt)) : null;
}

type RowActions = {
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: () => void;
  onToggle: () => void;
  /** Go back to the agent that made this file, when there is one. */
  onTalk?: () => void;
};

const ICON_BUTTON =
  'rounded p-1 text-fleet-text-subtle opacity-0 hover:bg-fleet-surface-2 hover:text-fleet-text focus:opacity-100 group-hover:opacity-100';

const SCOPE_HINT: Record<WorkflowScope, string> = {
  project: 'Shared with the repo',
  personal: 'Only on this machine'
};

function WorkflowRow({
  entry,
  lastRun,
  inGroup,
  busy,
  actions
}: {
  entry: WorkflowEntry;
  lastRun: number | null;
  /** One of two files with this name: the group above names the file. */
  inGroup: boolean;
  /** A move or a toggle of this file is on its way. */
  busy: boolean;
  actions: RowActions;
}): React.JSX.Element {
  const { def } = entry;
  const agents = def ? agentsOf(def).length : 0;
  const dim = entry.disabled ? 'opacity-50' : '';
  return (
    <div className={`group flex items-center gap-3 py-2.5 pr-4 ${inGroup ? 'pl-9' : 'pl-4'}`}>
      <div className={`min-w-0 flex-1 ${dim}`}>
        <div className="truncate text-xs font-medium text-fleet-text">{def?.name ?? entry.id}</div>
        {entry.error ? (
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-red-300">
            {entry.error}
          </pre>
        ) : (
          <div className="truncate text-[11px] text-fleet-text-subtle">
            {inGroup ? SCOPE_HINT[entry.scope] : `${entry.id}.toml`}
          </div>
        )}
      </div>
      <div className="w-36">
        <ScopeSwitch scope={entry.scope} verb="Move to" busy={busy} onPick={actions.onMove} />
      </div>
      <div className={`w-16 text-[11px] tabular-nums text-fleet-text-muted ${dim}`}>
        {def ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''}
      </div>
      <div className={`w-20 text-[11px] text-fleet-text-muted ${dim}`}>{formatAgo(lastRun)}</div>
      <div className="flex w-24 items-center">
        {entry.disabled ? (
          <Badge tone="gray">Off</Badge>
        ) : entry.error ? (
          <Badge tone="red">Bad file</Badge>
        ) : (
          <ApprovalBadge approval={entry.approval} />
        )}
      </div>
      <div className="flex w-44 items-center justify-end gap-1">
        {actions.onTalk && (
          <button aria-label="Edit with the agent" onClick={actions.onTalk} className={ICON_BUTTON}>
            <MessageSquare size={13} />
          </button>
        )}
        <button aria-label="Edit" onClick={actions.onEdit} className={ICON_BUTTON}>
          <Pencil size={13} />
        </button>
        {/* Always here, so a press never moves Delete under the pointer. */}
        <button
          aria-label={entry.disabled ? 'Turn on' : 'Turn off'}
          onClick={actions.onToggle}
          className={ICON_BUTTON}
        >
          <Power size={13} />
        </button>
        <button
          aria-label="Delete"
          onClick={actions.onDelete}
          className={`${ICON_BUTTON} hover:!text-red-300`}
        >
          <Trash2 size={13} />
        </button>
        <div className="flex w-[4.75rem] justify-end">
          {entry.disabled ? (
            <Button onClick={actions.onToggle}>Turn on</Button>
          ) : (
            def && (
              <Button tone="primary" onClick={actions.onRun}>
                {entry.approval === 'approved' ? (
                  <>
                    <Play size={11} /> Run
                  </>
                ) : (
                  'Review'
                )}
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** The files of a list, with a name in both scopes as one group. */
function groupById(entries: WorkflowEntry[]): WorkflowEntry[][] {
  const groups = new Map<string, WorkflowEntry[]>();
  for (const entry of entries) groups.set(entry.id, [...(groups.get(entry.id) ?? []), entry]);
  return [...groups.values()];
}

function WorkflowGroup({
  entries,
  children
}: {
  entries: WorkflowEntry[];
  children: ReactNode;
}): React.JSX.Element {
  if (entries.length === 1)
    return <div className="border-b border-fleet-border last:border-b-0">{children}</div>;
  return (
    <div className="border-b border-fleet-border pb-1 last:border-b-0">
      <div className="flex items-center gap-2 px-4 pt-2.5">
        <span className="font-mono text-[11px] text-fleet-text-muted">{entries[0].id}.toml</span>
        <Badge tone="gray">{entries.length} copies</Badge>
      </div>
      {children}
    </div>
  );
}

function StarterCards({
  onPick
}: {
  onPick: (starter: WorkflowStarter) => void;
}): React.JSX.Element {
  const [starters, setStarters] = useState<WorkflowStarter[]>([]);

  useEffect(() => {
    callWorkflows('starters')
      .then((reply) => setStarters(reply.starters))
      .catch(showWorkflowError);
  }, []);

  return (
    <div className="mx-auto grid max-w-2xl grid-cols-2 gap-2 text-left">
      {starters.map((starter) => (
        <button
          key={starter.id}
          onClick={() => onPick(starter)}
          className="flex flex-col justify-start rounded-md border border-fleet-border p-3 text-left transition hover:border-fleet-border-strong hover:bg-fleet-surface-2/50"
        >
          <div className="text-xs font-medium text-fleet-text">{starter.label}</div>
          <div className="mt-1 text-[11px] leading-relaxed text-fleet-text-subtle">
            {starter.description}
          </div>
        </button>
      ))}
    </div>
  );
}

function DeleteDialog({
  entry,
  onCancel,
  onConfirm
}: {
  entry: WorkflowEntry | null;
  onCancel: () => void;
  onConfirm: () => unknown;
}): React.JSX.Element {
  return (
    <Overlay
      open={entry !== null}
      onClose={onCancel}
      panelClassName="w-96 rounded-lg border border-fleet-border-strong bg-fleet-surface p-4"
    >
      <p className="text-xs text-fleet-text">Delete {entry?.def?.name ?? entry?.id}?</p>
      <p className="mt-1 text-[11px] text-fleet-text-subtle">
        This removes the file. An automatic rule that uses it pauses.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button tone="danger" onClick={onConfirm}>
          Delete
        </Button>
      </div>
    </Overlay>
  );
}

export function WorkflowsView({ projectPath }: { projectPath: string }): React.JSX.Element {
  const entries = useWorkflowsStore((s) => s.entries);
  const runs = useWorkflowsStore((s) => s.state.runs);
  const projects = useWorkflowsStore((s) => s.projects);
  // Paths, not copies: the entries change live, and a dialog must show the file as it is now.
  // Not ids: a project and a personal file can share an id.
  const [sheetPath, setSheetPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  /** The file whose move waits for Replace, as the other scope has its name. */
  const [replacingPath, setReplacingPath] = useState<string | null>(null);
  /** The file whose move or toggle is on its way, so a second press waits for it. */
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditorSource | null>(null);
  const [making, setMaking] = useState(false);
  const [drafts, setDrafts] = useState<string[]>([]);
  const sheet = entries.find((entry) => entry.path === sheetPath) ?? null;
  const deleting = entries.find((entry) => entry.path === deletingPath) ?? null;
  const isRepo = projects.find((project) => project.path === projectPath)?.isRepo ?? true;
  const cutOff = runs.filter((run) => run.state === 'cut-off' && run.projectPath === projectPath);

  useEffect(() => {
    callWorkflows('draftsWithBuilder', projectPath).then(setDrafts).catch(showWorkflowError);
  }, [projectPath, entries]);

  const talk = async (entry: WorkflowEntry): Promise<void> => {
    const reply = await callWorkflows('reopenBuilder', projectPath, entry.id, entry.scope);
    if (!reply.ok) useToastStore.getState().show(reply.message);
  };

  const startNew = async (): Promise<void> => {
    const { blank } = await callWorkflows('starters');
    setEditing({ text: blank, fileName: 'new-workflow', scope: 'project', baseHash: null });
  };

  const importFile = async (scope: WorkflowScope): Promise<void> => {
    await callWorkflows('importToml', projectPath, scope);
  };

  const useStarter = (starter: WorkflowStarter): void => {
    setEditing({ text: starter.text, fileName: starter.id, scope: 'project', baseHash: null });
  };

  const edit = async (entry: WorkflowEntry): Promise<void> => {
    const text = await callWorkflows('readText', entry.path);
    setEditing({ text, fileName: entry.id, scope: entry.scope, baseHash: entry.hash });
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    await callWorkflows('remove', projectPath, deleting.id, deleting.scope);
    useToastStore.getState().show(`Deleted ${deleting.def?.name ?? deleting.id}.`);
    setDeletingPath(null);
  };

  const move = async (entry: WorkflowEntry, replace: boolean): Promise<void> => {
    const req = { projectPath, id: entry.id, from: entry.scope, replace };
    const reply = await callWorkflows('move', req);
    if (!reply.ok && reply.code === 'exists') {
      setReplacingPath(entry.path);
      return;
    }
    setReplacingPath(null);
    const name = entry.def?.name ?? entry.id;
    const toast = useToastStore.getState();
    toast.show(reply.ok ? `Moved ${name} to ${otherScope(entry.scope)}.` : reply.message);
  };

  const toggle = async (entry: WorkflowEntry): Promise<void> => {
    await callWorkflows('setDisabled', projectPath, entry.id, entry.scope, !entry.disabled);
    const name = entry.def?.name ?? entry.id;
    useToastStore
      .getState()
      .show(entry.disabled ? `Turned on ${name}.` : `Turned off ${name}. Nothing starts it now.`);
  };

  const once = (entry: WorkflowEntry, work: () => Promise<void>): void => {
    if (busyPath !== null) return;
    setBusyPath(entry.path);
    work()
      .catch(showWorkflowError)
      .finally(() => setBusyPath(null));
  };

  const actionsOf = (entry: WorkflowEntry): RowActions => ({
    onRun: () => setSheetPath(entry.path),
    onEdit: () => void edit(entry).catch(showWorkflowError),
    onDelete: () => setDeletingPath(entry.path),
    onMove: () => once(entry, async () => move(entry, false)),
    onToggle: () => once(entry, async () => toggle(entry)),
    onTalk: drafts.includes(entry.path) ? () => void talk(entry) : undefined
  });

  if (editing) {
    return (
      <WorkflowEditor projectPath={projectPath} source={editing} onClose={() => setEditing(null)} />
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4">
      <AwayPanel />
      {!isRepo && (
        <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          This folder is not a Git repo, so workflows that need a repo cannot run here. Pick another
          project at the top.
        </p>
      )}
      {cutOff.length > 0 && (
        <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          A run stopped when Fleet closed. Its findings are safe. Open it in Runs to go on.
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button onClick={async () => importFile('project')}>Import TOML</Button>
        <Button onClick={startNew}>New workflow</Button>
        <Button tone="primary" onClick={() => setMaking(true)}>
          <Sparkles size={12} /> Make with an agent
        </Button>
      </div>
      {entries.length === 0 ? (
        <>
          <Empty title="No workflows in this project">
            A workflow starts many agents with one press. Your team can share it as a file in the
            repo.
          </Empty>
          <p className="pb-1 text-center text-[11px] text-fleet-text-subtle">
            Or start from one of these
          </p>
          <StarterCards onPick={useStarter} />
        </>
      ) : (
        <div className="rounded-md border border-fleet-border">
          {groupById(entries).map((group) => (
            <WorkflowGroup key={group[0].id} entries={group}>
              {group.map((entry) => (
                <Fragment key={entry.path}>
                  <WorkflowRow
                    entry={entry}
                    lastRun={lastRunOf(entry, runs)}
                    inGroup={group.length > 1}
                    busy={busyPath === entry.path}
                    actions={actionsOf(entry)}
                  />
                  {replacingPath === entry.path && (
                    <div className={`pb-2.5 pr-4 ${group.length > 1 ? 'pl-9' : 'pl-4'}`}>
                      <ReplaceNotice
                        text={`Your ${otherScope(entry.scope)} workflows have a ${entry.id}.toml. Moving this one replaces it, and rules that used either one start this one.`}
                        onCancel={() => setReplacingPath(null)}
                        onReplace={() => once(entry, async () => move(entry, true))}
                      />
                    </div>
                  )}
                </Fragment>
              ))}
            </WorkflowGroup>
          ))}
        </div>
      )}
      <RunSheet projectPath={projectPath} entry={sheet} onClose={() => setSheetPath(null)} />
      <BuilderStart open={making} projectPath={projectPath} onClose={() => setMaking(false)} />
      <DeleteDialog entry={deleting} onCancel={() => setDeletingPath(null)} onConfirm={remove} />
    </div>
  );
}
