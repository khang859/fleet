import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, PanelRight, X } from 'lucide-react';
import type { AgencyQuestion, AgencyRepoRef } from '../../../../shared/agency';
import { useSettingsStore } from '../../store/settings-store';
import { openSettings } from '../../store/settings-nav-store';
import { useAgentStore } from '../../store/agent-store';
import { openQuestions, useAgencyStore } from '../../store/agency-store';
import { attachAdmiral, useAdmiralRuntimeStore } from '../../store/admiral-runtime';
import { admiralKey } from '../../store/admiral-thread';
import { useWorkspaceStore } from '../../store/workspace-store';
import { useElementWidth } from '../../hooks/use-element-width';
import { focusPane } from '../../lib/focus-pane';
import { AgentThread } from '../agent/AgentThread';
import { AdmiralThreadContext, type AdmiralThreadContextValue } from './admiral-context';
import { EmptyBrief, EmptyJob } from './EmptyBrief';
import { JOB_SHEET_WIDTH_PX, JobSheet } from './JobSheet';
import { JobTabs } from './JobTabs';
import type { QuestionAnswer } from './QuestionCard';

/** The narrowest the conversation gets beside the sheet before the sheet folds away. */
const MIN_CHAT_WIDTH_PX = 400;

/** Stable empties: an Admiral has no subagents, schedules or background commands of its own. */
const NONE: never[] = [];

/**
 * The Admiral pane: one repository's agency, where the client briefs work,
 * answers questions and follows each job in its own tab.
 *
 * A header with the job tabs, the conversation on the left - the lobby or the
 * job on screen - and the job sheet on the right. Everything that keeps the
 * pane alive when it is not on screen (its claim, its conversations, its
 * wakeups) is the Admiral runtime's; this only draws what that left.
 */
export function AdmiralPane({
  paneId,
  repo,
  activeJob
}: {
  paneId: string;
  repo: AgencyRepoRef | undefined;
  /** The job tab the leaf last showed; null or absent is the lobby. */
  activeJob?: number | null;
}): React.JSX.Element {
  const enabled = useSettingsStore((s) => s.settings?.agency.enabled ?? false);
  const status = useAdmiralRuntimeStore((s) => s.panes[paneId]);

  if (!enabled) {
    return (
      <Notice repo={repo}>
        <p className="max-w-sm text-sm text-fleet-text-muted">
          Admiral is turned off. Turn it on in Settings to brief work here.
        </p>
        <NoticeButton onClick={() => openSettings('agencyAdmiral')}>
          Open Admiral settings
        </NoticeButton>
      </Notice>
    );
  }
  if (!repo) {
    return (
      <Notice repo={repo}>
        <p className="max-w-sm text-sm text-fleet-text-muted">An Admiral needs a git repository.</p>
      </Notice>
    );
  }
  if (status?.kind === 'refused') {
    return (
      <Notice repo={repo}>
        <p className="max-w-sm text-sm text-fleet-text-muted">
          The Admiral for {repo.name} is open in another pane.
        </p>
        <NoticeButton onClick={() => void focusPane(status.ownerPaneId)}>Show it</NoticeButton>
      </Notice>
    );
  }
  if (status?.kind === 'failed') {
    return (
      <Notice repo={repo}>
        <p className="max-w-sm text-sm text-fleet-text-muted">
          The Admiral could not start: {status.message}
        </p>
        <NoticeButton onClick={() => void attachAdmiral(paneId, repo)}>Try again</NoticeButton>
      </Notice>
    );
  }
  return (
    <AdmiralWorkspace
      paneId={paneId}
      repo={repo}
      activeJob={activeJob ?? null}
      ready={status?.kind === 'ready'}
    />
  );
}

function AdmiralWorkspace({
  paneId,
  repo,
  activeJob,
  ready
}: {
  paneId: string;
  repo: AgencyRepoRef;
  activeJob: number | null;
  ready: boolean;
}): React.JSX.Element {
  const snapshot = useAgencyStore((s) => s.snapshots[repo.repoId]);
  const loadModels = useAgentStore((s) => s.loadModels);
  const loadKey = useAgentStore((s) => s.loadKey);
  const keyPresent = useAgentStore((s) => s.keyPresent);
  const localModels = useSettingsStore(
    (s) => (s.settings?.ai.agent.localEndpoints.length ?? 0) > 0
  );
  const defaultBudgetUsd = useSettingsStore(
    (s) => s.settings?.agency.admiral.defaultBudgetUsd ?? 10
  );
  const [keyChecked, setKeyChecked] = useState(false);

  // The catalog carries the context limits the pane compacts by; the key is
  // what decides whether there is a model to talk to at all.
  useEffect(() => {
    void loadModels();
    void loadKey().finally(() => setKeyChecked(true));
  }, [loadModels, loadKey]);

  // A job that has closed since the leaf last showed it falls back to the lobby.
  const jobs = snapshot?.jobs;
  const job = activeJob === null ? null : (jobs?.find((j) => j.id === activeJob) ?? null);
  const jobId = job?.id ?? null;
  const key = admiralKey(paneId, jobId);

  const workingIds = useAgentStore((s) =>
    (jobs ?? [])
      .filter((j) => s.threads[admiralKey(paneId, j.id)]?.streamId != null)
      .map((j) => j.id)
      .join(',')
  );
  const working = useMemo(
    () => new Set<number>(workingIds === '' ? [] : workingIds.split(',').map(Number)),
    [workingIds]
  );

  const frameRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(frameRef);
  const wide = width === null || width >= MIN_CHAT_WIDTH_PX + JOB_SHEET_WIDTH_PX;
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    if (wide) setSheetOpen(false);
  }, [wide]);
  // What the sheet would show if opened: other jobs' questions are on their tabs' dots.
  const waiting = openQuestions(snapshot, jobId).length;

  const selectJob = (id: number | null): void => {
    useWorkspaceStore.getState().setAdmiralActiveJob(paneId, id);
  };
  const context = useMemo<AdmiralThreadContextValue>(
    () => ({
      repoId: repo.repoId,
      onOpenJob: (id) => useWorkspaceStore.getState().setAdmiralActiveJob(paneId, id)
    }),
    [repo.repoId, paneId]
  );
  const answer = async (question: AgencyQuestion, req: QuestionAnswer): Promise<boolean> =>
    (await useAgencyStore.getState().answer({ id: question.id, ...req })) !== null;

  const hasModel = keyPresent || localModels;
  const sheet = (className: string): React.JSX.Element => (
    <JobSheet
      snapshot={snapshot}
      jobId={jobId}
      working={jobId !== null && working.has(jobId)}
      defaultBudgetUsd={defaultBudgetUsd}
      onAnswer={answer}
      onOpenSettings={() => openSettings('agencyAdmiral')}
      className={className}
    />
  );

  return (
    <div ref={frameRef} className="relative flex h-full w-full flex-col bg-fleet-bg">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-fleet-border bg-fleet-surface px-3">
        <Compass size={15} className="shrink-0 text-blue-500 dark:text-blue-400" />
        <span className="shrink-0 text-[13px] font-semibold text-fleet-text">Admiral</span>
        <span
          title={repo.root}
          className="max-w-[160px] shrink-0 truncate rounded bg-fleet-surface-2 px-1.5 py-px font-mono text-[11px] text-fleet-text-muted"
        >
          {repo.name}
        </span>
        <div className="mx-1 h-4 w-px shrink-0 bg-fleet-border" />
        <JobTabs snapshot={snapshot} activeJobId={jobId} working={working} onSelect={selectJob} />
        {!wide && (
          <button
            type="button"
            onClick={() => setSheetOpen(!sheetOpen)}
            aria-label={sheetOpen ? 'Hide the job sheet' : 'Show the job sheet'}
            aria-expanded={sheetOpen}
            title="Job sheet"
            className={`relative flex size-7 shrink-0 items-center justify-center rounded-md transition-colors focus-ring ${
              sheetOpen
                ? 'bg-fleet-surface-2 text-fleet-text'
                : 'text-fleet-text-muted hover:bg-fleet-surface-2/60 hover:text-fleet-text'
            }`}
          >
            <PanelRight size={14} />
            {waiting > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-400 px-0.5 text-[9px] font-semibold text-black">
                {waiting}
              </span>
            )}
          </button>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1">
          {!ready ? null : keyChecked && !hasModel ? (
            <NoModelKey />
          ) : (
            <AdmiralThreadContext.Provider value={context}>
              <AgentThread
                key={key}
                paneId={key}
                cwd={repo.root}
                variant="admiral"
                empty={job === null ? <EmptyBrief /> : <EmptyJob title={job.title} />}
                placeholder={job === null ? 'Brief the Admiral…' : 'Message the Admiral…'}
                todosInPanel={false}
                running={NONE}
                subagentsInPanel={false}
                schedules={NONE}
                schedulesInPanel={false}
                background={NONE}
                backgroundInPanel={false}
              />
            </AdmiralThreadContext.Provider>
          )}
        </div>
        {wide && sheet('')}
        {!wide && sheetOpen && (
          <>
            {/* A click beside the sheet closes it; the keyboard has the X. */}
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              onClick={() => setSheetOpen(false)}
              className="absolute inset-0 z-10 cursor-default bg-black/30"
            />
            <div className="absolute inset-y-0 right-0 z-20 flex max-w-full shadow-2xl shadow-black/50">
              {sheet('max-w-full')}
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close the job sheet"
                className="absolute top-3 right-3 flex size-6 items-center justify-center rounded text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
              >
                <X size={13} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** No OpenRouter key and no local model: the Admiral has nothing to think with. */
function NoModelKey(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-medium text-fleet-text">The Admiral needs a model</p>
      <p className="max-w-sm text-[13px] text-fleet-text-muted">
        It runs on the OpenRouter key or local model set up in an Agent pane&apos;s Settings tab.
        Add one there, then pick the Admiral&apos;s model in Settings.
      </p>
      <NoticeButton onClick={() => openSettings('agencyAdmiral')}>
        Open Admiral settings
      </NoticeButton>
    </div>
  );
}

/** The pane when there is nothing to run: off, no repository, or owned elsewhere. */
function Notice({
  repo,
  children
}: {
  repo: AgencyRepoRef | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-fleet-bg px-6 text-center">
      <div className="flex items-center gap-2 text-fleet-text">
        <Compass size={18} className="text-blue-500 dark:text-blue-400" />
        <span className="text-sm font-semibold">Admiral</span>
        {repo && (
          <span className="rounded bg-fleet-surface-2 px-1.5 py-px font-mono text-[11px] text-fleet-text-muted">
            {repo.name}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function NoticeButton({
  onClick,
  children
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-fleet-border-strong px-2.5 py-1 text-xs text-fleet-text-secondary transition hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
    >
      {children}
    </button>
  );
}
