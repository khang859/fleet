import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  agentChatHandle,
  postsLeft,
  type BoardItem,
  type RunAgent,
  type WorkflowRun
} from '../../../../shared/workflows';
import { callWorkflows, isRunActive, useWorkflowsStore } from '../../store/workflows-store';
import { collectPaneIds, useWorkspaceStore } from '../../store/workspace-store';
import { useToastStore } from '../../store/toast-store';
import { AgentMarkdown } from '../agent/AgentMarkdown';
import { Overlay } from '../Overlay';
import { AgentBadge, Badge, Button, RunBadge, SectionTitle } from './parts';
import { formatSpan } from './workflow-format';
import { SaveReportDialog } from './SaveReportDialog';

function openPane(paneId: string): void {
  const ws = useWorkspaceStore.getState();
  const tab = ws.workspace.tabs.find((candidate) =>
    collectPaneIds(candidate.splitRoot).includes(paneId)
  );
  if (!tab) return;
  ws.setActiveTab(tab.id);
  ws.setActivePane(paneId);
}

async function openAgent(run: WorkflowRun, agent: RunAgent): Promise<void> {
  const reply = await callWorkflows('openAgent', run.id, agent.id);
  if (reply.ok) openPane(reply.paneId);
  else useToastStore.getState().show(reply.reason);
}

function canOpenAgent(run: WorkflowRun, agent: RunAgent): boolean {
  return !isRunActive(run) && run.state !== 'cut-off' && agentChatHandle(agent) !== null;
}

/** Whether a run still holds anything that Close run would close. */
function holdsAnything(run: WorkflowRun): boolean {
  const pane = run.postPaneId ?? run.agents.find((agent) => agent.paneId)?.paneId;
  return pane != null || run.keptPanes.length > 0 || run.worktreePath !== null;
}

function AgentActions({ run, agent }: { run: WorkflowRun; agent: RunAgent }): React.JSX.Element {
  const { pendingPermission, state, silent } = agent;
  const paneId = agent.paneId ?? agent.keptPaneId;
  const canAct = isRunActive(run);
  const stuck = state === 'failed' || agent.needsPerson || silent;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {pendingPermission && (
        <>
          <Button
            tone="primary"
            onClick={() =>
              void callWorkflows('answerPermission', pendingPermission.toolUseId, 'allow')
            }
          >
            Allow
          </Button>
          <Button
            onClick={() =>
              void callWorkflows('answerPermission', pendingPermission.toolUseId, 'deny')
            }
          >
            Deny
          </Button>
        </>
      )}
      {paneId && <Button onClick={() => openPane(paneId)}>Open pane</Button>}
      {!paneId && canOpenAgent(run, agent) && (
        <Button onClick={() => void openAgent(run, agent)}>Open agent</Button>
      )}
      {canAct && silent && (
        <Button onClick={() => void callWorkflows('keepWaiting', run.id, agent.id)}>
          Keep waiting
        </Button>
      )}
      {canAct && stuck && (
        <Button onClick={() => void callWorkflows('retry', run.id, agent.id)}>
          {silent ? 'Restart' : agent.isLast ? 'Try again' : 'Retry'}
        </Button>
      )}
      {canAct && stuck && (
        <Button onClick={() => void callWorkflows('skip', run.id, agent.id)}>
          {agent.isLast ? 'Use them as they are' : 'Skip'}
        </Button>
      )}
    </div>
  );
}

function AgentRow({ run, agent }: { run: WorkflowRun; agent: RunAgent }): React.JSX.Element {
  const line = agent.pendingPermission
    ? `Asks to use ${agent.pendingPermission.tool}.`
    : (agent.note ?? agent.summary?.replaceAll('`', ''));
  return (
    <div className="flex items-start gap-3 border-b border-fleet-border px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-fleet-text">{agent.role}</span>
          {run.state === 'stopped' && agent.state === 'failed' ? (
            <Badge tone="gray">Stopped</Badge>
          ) : (
            <AgentBadge state={agent.state} />
          )}
          {agent.needsPerson && <Badge tone="amber">Needs you</Badge>}
          {agent.silent && <Badge tone="amber">Quiet for 5 min</Badge>}
        </div>
        {line && <p className="mt-0.5 text-[11px] text-fleet-text-subtle">{line}</p>}
      </div>
      <AgentActions run={run} agent={agent} />
    </div>
  );
}

const POST_LABEL: Record<NonNullable<BoardItem['post']>, string> = {
  posting: 'Posting',
  posted: 'Posted',
  failed: 'Not posted'
};

function BoardRow({ item }: { item: BoardItem }): React.JSX.Element {
  const place = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : (item.source ?? '');
  return (
    <div className="border-b border-fleet-border px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2 text-[11px] text-fleet-text-subtle">
        <span className="text-fleet-text-muted">{item.kind}</span>
        <span>{item.agent}</span>
        {place && <span className="truncate font-mono">{place}</span>}
        {item.post && (
          <Badge tone={item.post === 'posted' ? 'green' : 'gray'}>{POST_LABEL[item.post]}</Badge>
        )}
      </div>
      <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-fleet-text-secondary">
        {item.text}
      </p>
    </div>
  );
}

function SharedBoard({ run }: { run: WorkflowRun }): React.JSX.Element {
  const items = run.board.filter((item) => item.mergedInto === undefined);
  const folded = run.board.length - items.length;
  return (
    <section>
      <SectionTitle
        right={
          folded > 0 ? (
            <span className="text-[11px] text-fleet-text-subtle">{folded} merged</span>
          ) : undefined
        }
      >
        Shared board
      </SectionTitle>
      <div className="rounded-md border border-fleet-border">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-fleet-text-subtle">
            Nothing on the board yet.
          </p>
        ) : (
          items.map((item) => <BoardRow key={item.id} item={item} />)
        )}
      </div>
    </section>
  );
}

/** A report sits in a page section, so its headings stay small. */
const REPORT_CLASS =
  'text-xs leading-relaxed [&_code]:text-[11px] [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs';

function ReportSection({
  run,
  onSave,
  onPost
}: {
  run: WorkflowRun;
  onSave: () => void;
  onPost: () => void;
}): React.JSX.Element | null {
  const { report, finish } = run;
  if (!report) return null;
  return (
    <section>
      <SectionTitle
        right={
          <div className="flex gap-1.5">
            <Button
              tone={report.savedTo || finish?.action === 'post-pr' ? 'plain' : 'primary'}
              onClick={onSave}
            >
              {report.savedTo ? 'Save again' : 'Save report'}
            </Button>
            {run.pr && postsLeft(run).length > 0 && (
              <Button tone={finish?.action === 'post-pr' ? 'primary' : 'plain'} onClick={onPost}>
                Post
              </Button>
            )}
          </div>
        }
      >
        Report {report.incomplete && <Badge tone="amber">Incomplete</Badge>}
      </SectionTitle>
      {report.missing.length > 0 && (
        <p className="pb-2 text-[11px] text-amber-200">
          No summary from {report.missing.join(', ')}.
        </p>
      )}
      {report.savedTo && (
        <p className="pb-2 text-[11px] text-fleet-text-subtle">Saved to {report.savedTo}</p>
      )}
      <div className="rounded-md border border-fleet-border p-3">
        <AgentMarkdown streaming={false} className={REPORT_CLASS}>
          {report.text}
        </AgentMarkdown>
      </div>
    </section>
  );
}

/** What a post sends, word for word, so a person can read it first. */
function PostPreview({ run }: { run: WorkflowRun }): React.JSX.Element {
  const items = postsLeft(run);
  return (
    <ul className="mt-3 max-h-60 space-y-2 overflow-y-auto rounded border border-fleet-border p-2 text-[11px] text-fleet-text-secondary">
      {items.map((item) => (
        <li key={item.id} className="whitespace-pre-wrap break-words">
          <span className="font-medium text-fleet-text">{item.kind}</span> {item.text}
        </li>
      ))}
    </ul>
  );
}

function ConfirmDialog({
  open,
  title,
  detail,
  onClose,
  body,
  children
}: {
  open: boolean;
  title: string;
  detail: string;
  onClose: () => void;
  body?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Overlay
      open={open}
      onClose={onClose}
      panelClassName="w-96 rounded-lg border border-fleet-border-strong bg-fleet-surface p-4"
    >
      <p className="text-xs text-fleet-text">{title}</p>
      <p className="mt-1 text-[11px] text-fleet-text-subtle">{detail}</p>
      {body}
      <div className="mt-4 flex justify-end gap-2">{children}</div>
    </Overlay>
  );
}

function RunNotes({ run }: { run: WorkflowRun }): React.JSX.Element {
  const hitLimit = run.limitReachedAt !== null && isRunActive(run);
  return (
    <>
      {run.problem && (
        <div className="flex items-center justify-between gap-3 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-200">
          <span>{run.problem}</span>
          {isRunActive(run) && (
            <Button onClick={() => void callWorkflows('retryPrepare', run.id)}>Try again</Button>
          )}
        </div>
      )}
      {hitLimit && (
        <div className="flex items-center justify-between gap-3 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          <span>This run reached its time limit after {formatSpan(run.activeMs)}.</span>
          <Button onClick={() => void callWorkflows('addTime', run.id)}>Add 30 min</Button>
        </div>
      )}
      {run.sleptMs > 0 && (
        <p className="text-[11px] text-fleet-text-subtle">
          The computer slept for {formatSpan(run.sleptMs)}. The board stayed safe.
        </p>
      )}
      {run.pr?.movedOn && (
        <p className="text-[11px] text-amber-200">
          The PR has a new commit. These findings are for an old commit.
        </p>
      )}
    </>
  );
}

function RunHeader({
  run,
  onBack,
  onClose
}: {
  run: WorkflowRun;
  onBack: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const rerun = async (): Promise<void> => {
    const reply = await callWorkflows('start', {
      projectPath: run.projectPath,
      workflowId: run.workflowId,
      inputs: run.inputs,
      trustPr: !run.locked
    });
    if (!reply.ok) useToastStore.getState().show(reply.message);
  };
  const active = isRunActive(run);
  return (
    <div className="flex items-center gap-2">
      <Button tone="quiet" aria-label="Back to Runs" onClick={onBack}>
        <ArrowLeft size={13} />
      </Button>
      <h2 className="min-w-0 truncate text-sm font-medium text-fleet-text">{run.workflowName}</h2>
      <RunBadge state={run.state} />
      {run.locked && <Badge tone="amber">Locked</Badge>}
      {run.pr && (
        <button
          className="flex items-center gap-1 text-[11px] text-fleet-text-subtle hover:text-fleet-text"
          onClick={() => window.open(run.pr?.url)}
        >
          #{run.pr.number} <ExternalLink size={11} />
        </button>
      )}
      <div className="flex-1" />
      <span className="text-[11px] tabular-nums text-fleet-text-subtle">
        {formatSpan(run.activeMs)}
      </span>
      {run.state === 'cut-off' && (
        <Button onClick={() => void callWorkflows('goOn', run.id)}>Go on</Button>
      )}
      {active ? (
        <Button tone="danger" onClick={() => void callWorkflows('stop', run.id)}>
          Stop
        </Button>
      ) : (
        <>
          <Button onClick={() => void rerun()}>Run again</Button>
          {holdsAnything(run) && <Button onClick={onClose}>Close run</Button>}
        </>
      )}
    </div>
  );
}

export function RunDetail({
  run,
  onBack
}: {
  run: WorkflowRun;
  onBack: () => void;
}): React.JSX.Element {
  const notices = useWorkflowsStore((s) => s.state.notices);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [posting, setPosting] = useState<number | null>(null);

  useEffect(() => {
    setSaving(false);
    setClosing(false);
    setPosting(null);
  }, [run.id]);

  // A person looking at the run needs no notice that its report is ready.
  const reportNotice = notices.find(
    (notice) => notice.kind === 'report-ready' && notice.runId === run.id
  );
  useEffect(() => {
    if (reportNotice) void callWorkflows('dismissNotice', reportNotice.id);
  }, [reportNotice]);

  const askPost = async (): Promise<void> => {
    setPosting(await callWorkflows('remainingPosts', run.id));
  };

  const post = async (): Promise<void> => {
    setPosting(null);
    await callWorkflows('post', run.id);
  };

  const close = (removeWorktree: boolean): void => {
    setClosing(false);
    void callWorkflows('close', run.id, removeWorktree);
  };

  const askClose = (): void => {
    if (run.worktreePath) setClosing(true);
    else close(false);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <RunHeader run={run} onBack={onBack} onClose={askClose} />
      <RunNotes run={run} />
      <section>
        <SectionTitle>Agents</SectionTitle>
        <div className="rounded-md border border-fleet-border">
          {run.agents.map((agent) => (
            <AgentRow key={agent.id} run={run} agent={agent} />
          ))}
        </div>
      </section>
      <ReportSection run={run} onSave={() => setSaving(true)} onPost={() => void askPost()} />
      {run.usesBoard && <SharedBoard run={run} />}

      <SaveReportDialog run={run} open={saving} onClose={() => setSaving(false)} />
      <ConfirmDialog
        open={posting !== null}
        title={`Post ${posting === 1 ? '1 finding' : `${posting ?? 0} findings`} to PR #${run.pr?.number ?? ''}?`}
        detail="An agent pane opens. It can post only these stored findings. Anything already posted stays out."
        onClose={() => setPosting(null)}
        body={<PostPreview run={run} />}
      >
        <Button onClick={() => setPosting(null)}>Cancel</Button>
        <Button tone="primary" disabled={posting === 0} onClick={() => void post()}>
          Post
        </Button>
      </ConfirmDialog>
      <ConfirmDialog
        open={closing}
        title="Remove this run's worktree?"
        detail={run.worktreePath ?? ''}
        onClose={() => setClosing(false)}
      >
        <Button onClick={() => close(false)}>Keep it</Button>
        <Button tone="danger" onClick={() => close(true)}>
          Remove
        </Button>
      </ConfirmDialog>
    </div>
  );
}
