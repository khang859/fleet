import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { WorkflowNotice } from '../../../../shared/workflows';
import {
  callWorkflows,
  showRun,
  showWorkflowError,
  showWorkflowsPage,
  useWorkflowsStore
} from '../../store/workflows-store';
import { Button } from './parts';

function showWorkflows(projectPath: string | null): void {
  showWorkflowsPage();
  const store = useWorkflowsStore.getState();
  store.setView('workflows');
  if (projectPath) store.setProject(projectPath).catch(showWorkflowError);
}

function NoticeActions({ notice }: { notice: WorkflowNotice }): React.JSX.Element | null {
  const raiseLimit = async (): Promise<void> => {
    const { limits } = useWorkflowsStore.getState().state;
    await callWorkflows('setLimits', { ...limits, maxAgents: limits.maxAgents + 4 });
    await callWorkflows('dismissNotice', notice.id);
  };

  if (notice.ask) {
    return (
      <>
        <Button tone="primary" onClick={async () => callWorkflows('answerAsk', notice.id, true)}>
          Allow
        </Button>
        <Button onClick={async () => callWorkflows('answerAsk', notice.id, false)}>Deny</Button>
      </>
    );
  }
  const { runId } = notice;
  return (
    <>
      {notice.kind === 'limit' && <Button onClick={raiseLimit}>Raise limit</Button>}
      {notice.kind === 'agent-create' && (
        <Button
          onClick={async () => {
            showWorkflows(notice.projectPath);
            return callWorkflows('dismissNotice', notice.id);
          }}
        >
          Review
        </Button>
      )}
      {notice.kind === 'agent-start' && runId && (
        <Button tone="danger" onClick={async () => callWorkflows('stop', runId)}>
          Stop
        </Button>
      )}
      {runId && (
        <Button
          onClick={async () => {
            showRun(runId);
            return callWorkflows('dismissNotice', notice.id);
          }}
        >
          Open run
        </Button>
      )}
    </>
  );
}

/** Notices show on any page, because a run can need a person from anywhere. */
export function WorkflowNotices(): React.JSX.Element | null {
  const connect = useWorkflowsStore((s) => s.connect);
  const notices = useWorkflowsStore((s) => s.state.notices);

  useEffect(() => connect(), [connect]);

  if (notices.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex w-80 flex-col gap-2">
      {notices.slice(-4).map((notice) => (
        <div
          key={notice.id}
          className="rounded-lg border border-fleet-border-strong bg-fleet-surface p-3 shadow-lg shadow-black/30"
        >
          <div className="flex items-start gap-2">
            <p className="flex-1 text-xs leading-relaxed text-fleet-text-secondary">
              {notice.text}
            </p>
            <button
              aria-label="Dismiss"
              className="rounded p-0.5 text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-fleet-text"
              onClick={() =>
                void callWorkflows('dismissNotice', notice.id).catch(showWorkflowError)
              }
            >
              <X size={13} />
            </button>
          </div>
          <div className="mt-2 flex justify-end gap-1.5 empty:hidden">
            <NoticeActions notice={notice} />
          </div>
        </div>
      ))}
    </div>
  );
}
