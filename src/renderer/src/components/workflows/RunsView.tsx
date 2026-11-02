import type { WorkflowRun } from '../../../../shared/workflows';
import { useWorkflowsStore } from '../../store/workflows-store';
import { Empty, RunBadge } from './parts';
import { formatAgo, formatSpan } from './workflow-format';
import { RunDetail } from './RunDetail';

const ORIGIN_LABEL: Record<WorkflowRun['origin'], string> = {
  manual: 'You',
  agent: 'An agent',
  automatic: 'Automatic'
};

function RunRow({ run, onOpen }: { run: WorkflowRun; onOpen: () => void }): React.JSX.Element {
  const found = run.board.filter((item) => item.mergedInto === undefined).length;
  const target = run.pr ?? run.issue;
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-b border-fleet-border px-4 py-2.5 text-left last:border-b-0 hover:bg-fleet-surface-2/40"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-fleet-text">
          {run.workflowName}
        </span>
        <span className="block truncate text-[11px] text-fleet-text-subtle">
          {target ? `#${target.number} ${target.title}` : run.target || formatAgo(run.createdAt)}
        </span>
      </span>
      <span className="w-20 text-[11px] text-fleet-text-muted">{ORIGIN_LABEL[run.origin]}</span>
      <span className="w-16 text-[11px] tabular-nums text-fleet-text-muted">{found} found</span>
      <span className="w-24">
        <RunBadge state={run.state} />
      </span>
      <span className="w-16 text-right text-[11px] tabular-nums text-fleet-text-muted">
        {formatSpan(run.activeMs)}
      </span>
    </button>
  );
}

export function RunsView({ projectPath }: { projectPath: string }): React.JSX.Element {
  const allRuns = useWorkflowsStore((s) => s.state.runs);
  const openRunId = useWorkflowsStore((s) => s.openRunId);
  const openRun = useWorkflowsStore((s) => s.openRun);
  const open = allRuns.find((run) => run.id === openRunId);

  if (open) return <RunDetail run={open} onBack={() => openRun(null)} />;

  const runs = allRuns
    .filter((run) => run.projectPath === projectPath)
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="mx-auto max-w-4xl p-4">
      {runs.length === 0 ? (
        <Empty title="No runs in this project." />
      ) : (
        <div className="rounded-md border border-fleet-border">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} onOpen={() => openRun(run.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
