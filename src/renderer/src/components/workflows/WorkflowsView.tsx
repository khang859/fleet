import { useEffect, useState } from 'react';
import { MessageSquare, Pencil, Play, Sparkles, Trash2 } from 'lucide-react';
import {
  agentsOf,
  type WorkflowEntry,
  type WorkflowRun,
  type WorkflowScope,
  type WorkflowStarter
} from '../../../../shared/workflows';
import { callWorkflows, showWorkflowError, useWorkflowsStore } from '../../store/workflows-store';
import { useToastStore } from '../../store/toast-store';
import { Overlay } from '../Overlay';
import { ApprovalBadge, Badge, Button, Empty } from './parts';
import { formatAgo } from './workflow-format';
import { BuilderStart } from './BuilderStart';
import { RunSheet } from './RunSheet';
import { WorkflowEditor, type EditorSource } from './WorkflowEditor';
import { AwayPanel } from './AwayPanel';

function lastRunOf(entry: WorkflowEntry, runs: WorkflowRun[]): number | null {
  const own = runs.filter((run) => run.workflowPath === entry.path);
  return own.length > 0 ? Math.max(...own.map((run) => run.createdAt)) : null;
}

function WorkflowRow({
  entry,
  lastRun,
  onRun,
  onEdit,
  onDelete,
  onTalk
}: {
  entry: WorkflowEntry;
  lastRun: number | null;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Go back to the agent that made this file, when there is one. */
  onTalk?: () => void;
}): React.JSX.Element {
  const { def } = entry;
  const agents = def ? agentsOf(def).length : 0;
  return (
    <div className="group flex items-center gap-3 border-b border-fleet-border px-4 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-fleet-text">
            {def?.name ?? entry.id}
          </span>
          {entry.scope === 'personal' && <Badge tone="gray">Personal</Badge>}
        </div>
        {entry.error ? (
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-red-300">
            {entry.error}
          </pre>
        ) : (
          <div className="truncate text-[11px] text-fleet-text-subtle">
            {entry.replacesPersonal
              ? 'This project file replaces your personal file of the same name.'
              : `${entry.id}.toml`}
          </div>
        )}
      </div>
      <div className="w-16 text-[11px] tabular-nums text-fleet-text-muted">
        {def ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''}
      </div>
      <div className="w-20 text-[11px] text-fleet-text-muted">{formatAgo(lastRun)}</div>
      <div className="flex w-24 items-center">
        {entry.error ? (
          <Badge tone="red">Bad file</Badge>
        ) : (
          <ApprovalBadge approval={entry.approval} />
        )}
      </div>
      <div className="flex w-36 items-center justify-end gap-1">
        {onTalk && (
          <button
            aria-label="Edit with the agent"
            onClick={onTalk}
            className="rounded p-1 text-fleet-text-subtle opacity-0 hover:bg-fleet-surface-2 hover:text-fleet-text focus:opacity-100 group-hover:opacity-100"
          >
            <MessageSquare size={13} />
          </button>
        )}
        <button
          aria-label="Edit"
          onClick={onEdit}
          className="rounded p-1 text-fleet-text-subtle opacity-0 hover:bg-fleet-surface-2 hover:text-fleet-text focus:opacity-100 group-hover:opacity-100"
        >
          <Pencil size={13} />
        </button>
        <button
          aria-label="Delete"
          onClick={onDelete}
          className="rounded p-1 text-fleet-text-subtle opacity-0 hover:bg-fleet-surface-2 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
        >
          <Trash2 size={13} />
        </button>
        {def && (
          <Button tone="primary" onClick={onRun}>
            {entry.approval === 'approved' ? (
              <>
                <Play size={11} /> Run
              </>
            ) : (
              'Review'
            )}
          </Button>
        )}
      </div>
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
  // Ids, not copies: the entries change live, and a dialog must show the file as it is now.
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditorSource | null>(null);
  const [making, setMaking] = useState(false);
  const [drafts, setDrafts] = useState<string[]>([]);
  const sheet = entries.find((entry) => entry.id === sheetId) ?? null;
  const deleting = entries.find((entry) => entry.id === deletingId) ?? null;
  const isRepo = projects.find((project) => project.path === projectPath)?.isRepo ?? true;
  const cutOff = runs.filter((run) => run.state === 'cut-off' && run.projectPath === projectPath);

  useEffect(() => {
    callWorkflows('draftsWithBuilder', projectPath).then(setDrafts).catch(showWorkflowError);
  }, [projectPath, entries]);

  const talk = async (entry: WorkflowEntry): Promise<void> => {
    const reply = await callWorkflows('reopenBuilder', projectPath, entry.id);
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
    await callWorkflows('remove', projectPath, deleting.id);
    useToastStore.getState().show(`Deleted ${deleting.def?.name ?? deleting.id}.`);
    setDeletingId(null);
  };

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
          {entries.map((entry) => (
            <WorkflowRow
              key={entry.path}
              entry={entry}
              lastRun={lastRunOf(entry, runs)}
              onRun={() => setSheetId(entry.id)}
              onEdit={() => void edit(entry).catch(showWorkflowError)}
              onDelete={() => setDeletingId(entry.id)}
              onTalk={drafts.includes(entry.id) ? () => void talk(entry) : undefined}
            />
          ))}
        </div>
      )}
      <RunSheet projectPath={projectPath} entry={sheet} onClose={() => setSheetId(null)} />
      <BuilderStart open={making} projectPath={projectPath} onClose={() => setMaking(false)} />
      <DeleteDialog entry={deleting} onCancel={() => setDeletingId(null)} onConfirm={remove} />
    </div>
  );
}
