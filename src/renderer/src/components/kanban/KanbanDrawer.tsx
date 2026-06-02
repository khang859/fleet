import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  X,
  Paperclip,
  Download,
  Clock,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  Check,
  AlertTriangle
} from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { useSettingsStore } from '../../store/settings-store';
import { CommentThread } from './CommentThread';
import { OutputsSection } from './KanbanArtifacts';
import { GitChangesModal } from '../GitChangesModal';
import { PrStatusBadge } from './PrStatusBadge';
import {
  relativeTime,
  formatDuration,
  formatBytes,
  scheduleSummary,
  formatNextRun
} from './kanban-utils';
import type { TaskStatus, ScheduleInput } from '../../../../shared/kanban-types';

const ACTIONS: Array<{ status: TaskStatus; label: string }> = [
  { status: 'ready', label: '→ Ready' },
  { status: 'blocked', label: 'Block' },
  { status: 'todo', label: 'Unblock' },
  { status: 'done', label: 'Complete' },
  { status: 'archived', label: 'Archive' }
];

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

export function KanbanDrawer(): React.JSX.Element | null {
  const {
    detail,
    closeTask,
    updateTask,
    setStatus,
    addComment,
    replyAndResume,
    addLink,
    removeLink,
    mergeTask,
    createPr,
    acceptTask,
    checkConflicts,
    decompose,
    specify,
    features,
    assignFeature,
    redecompose,
    uploadAttachments,
    removeAttachment,
    saveAttachmentCopy,
    setSchedule,
    clearSchedule,
    pauseSchedule,
    resumeSchedule
  } = useKanbanStore();
  const profiles = useSettingsStore((s) => s.settings?.kanban.profiles ?? []);
  const settingsLoaded = useSettingsStore((s) => s.settings !== null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState(0);
  const [tenant, setTenant] = useState('');
  const [linkId, setLinkId] = useState('');
  const [dragging, setDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<'merge' | 'pr' | 'accept' | null>(null);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const dragCounter = useRef(0);
  const seededIdRef = useRef<string | null>(null);
  const [schedKind, setSchedKind] = useState<'once' | 'interval' | 'cron'>('interval');
  const [schedAt, setSchedAt] = useState(''); // datetime-local string
  const [schedEveryN, setSchedEveryN] = useState(1);
  const [schedUnit, setSchedUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const [schedCron, setSchedCron] = useState('0 9 * * *');
  const [schedPreview, setSchedPreview] = useState<number[]>([]);
  const [schedError, setSchedError] = useState<string | null>(null);

  useEffect(() => {
    if (detail && detail.task.id !== seededIdRef.current) {
      seededIdRef.current = detail.task.id;
      setTitle(detail.task.title);
      setBody(detail.task.body);
      setAssignee(detail.task.assignee ?? '');
      setPriority(detail.task.priority);
      setTenant(detail.task.tenant ?? '');
      setShowDiff(false);
      setReviewBusy(null);
      setReviewMsg(null);
      setReviewErr(null);
      setConflictBusy(false);
      setSchedKind('interval');
      setSchedAt('');
      setSchedEveryN(1);
      setSchedUnit('hours');
      setSchedCron('0 9 * * *');
      setSchedPreview([]);
      setSchedError(null);
    }
  }, [detail]);

  if (!detail) return null;
  const t = detail.task;
  const running = t.status === 'running';

  function save(): void {
    void updateTask(t.id, {
      title,
      body,
      assignee: assignee.trim() === '' ? null : assignee.trim(),
      priority,
      tenant: tenant.trim() === '' ? null : tenant.trim()
    });
  }

  async function runReview(action: 'merge' | 'pr' | 'accept'): Promise<void> {
    setReviewBusy(action);
    setReviewErr(null);
    setReviewMsg(null);
    try {
      const res =
        action === 'merge'
          ? await mergeTask(t.id)
          : action === 'pr'
            ? await createPr(t.id)
            : await acceptTask(t.id);
      if (res.ok) setReviewMsg(res.prUrl ?? res.message ?? 'Done');
      else setReviewErr(res.error ?? 'Action failed');
    } catch (err) {
      setReviewErr(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setReviewBusy(null);
    }
  }

  async function recheckConflicts(): Promise<void> {
    setConflictBusy(true);
    try {
      await checkConflicts(t.id);
    } finally {
      setConflictBusy(false);
    }
  }

  function buildScheduleInput(): ScheduleInput | null {
    if (schedKind === 'once') {
      const ms = Date.parse(schedAt);
      if (Number.isNaN(ms)) return null;
      return { kind: 'once', at: ms };
    }
    if (schedKind === 'interval') {
      return { kind: 'interval', everyMs: Math.max(1, schedEveryN) * UNIT_MS[schedUnit] };
    }
    return { kind: 'cron', expr: schedCron.trim() };
  }

  async function refreshPreview(): Promise<void> {
    const input = buildScheduleInput();
    if (!input) {
      setSchedPreview([]);
      setSchedError('enter a valid date/time');
      return;
    }
    const res = await window.fleet.kanban.previewSchedule(input);
    if (res.ok) {
      setSchedPreview(res.next);
      setSchedError(null);
    } else {
      setSchedPreview([]);
      setSchedError(res.error);
    }
  }

  async function applySchedule(): Promise<void> {
    const input = buildScheduleInput();
    if (!input) {
      setSchedError('enter a valid date/time');
      return;
    }
    try {
      await setSchedule(t.id, input);
      setSchedError(null);
    } catch (err) {
      setSchedError(err instanceof Error ? err.message : 'could not set schedule');
    }
  }

  async function pickAndUpload(): Promise<void> {
    const paths = await window.fleet.kanban.pickAttachment();
    if (paths.length === 0) return;
    setAttachError(null);
    try {
      await uploadAttachments(t.id, paths);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Failed to attach file');
    }
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = window.fleet.utils.getFilePath(f);
      if (p) paths.push(p);
    }
    if (paths.length === 0) return;
    setAttachError(null);
    uploadAttachments(t.id, paths).catch((err) => {
      setAttachError(err instanceof Error ? err.message : 'Failed to attach file');
    });
  }

  return (
    <div className="fixed bottom-0 right-0 top-9 z-40 flex w-[420px] flex-col border-l border-neutral-800 bg-neutral-900 shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="font-mono text-xs text-neutral-500">
          {t.id} · {t.status}
        </span>
        <button onClick={closeTask} className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs">
        {/* Editable fields */}
        <div className="space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={save}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm font-medium outline-none focus:border-blue-500"
          />
          <div className="flex gap-2">
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              onBlur={save}
              title="assignee"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            >
              <option value="">Unassigned</option>
              {settingsLoaded && assignee !== '' && !profiles.some((p) => p.name === assignee) && (
                <option value={assignee}>{assignee} (unregistered)</option>
              )}
              {profiles.map((p, i) => (
                <option key={`${p.name}-${i}`} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              onBlur={save}
              title="priority"
              className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            />
            <input
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              onBlur={save}
              placeholder="tenant"
              className="w-24 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={save}
            rows={5}
            placeholder="Body (markdown)…"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
          />
        </div>

        {/* Status actions */}
        <div className="flex flex-wrap gap-1.5">
          {ACTIONS.map((a) => (
            <button
              key={a.label}
              disabled={running}
              onClick={() => void setStatus(t.id, a.status)}
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {a.label}
            </button>
          ))}
        </div>
        {running && (
          <p className="text-[10px] text-amber-400">
            Running tasks are dispatcher-controlled; status actions are disabled.
          </p>
        )}
        {t.status === 'triage' && !running && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => void decompose(t.id)}
              className="rounded border border-purple-700 px-2 py-1 text-purple-300 hover:bg-neutral-800"
            >
              ⚗ Decompose
            </button>
            <button
              onClick={() => void specify(t.id)}
              className="rounded border border-sky-700 px-2 py-1 text-sky-300 hover:bg-neutral-800"
            >
              ✨ Specify
            </button>
            {/* Re-run decompose for the whole feature when the orchestrator only created some tasks. */}
            {t.featureId && detail.children.length > 0 && (
              <button
                onClick={() => t.featureId && void redecompose(t.featureId)}
                className="rounded border border-purple-700 px-2 py-1 text-purple-300 hover:bg-neutral-800"
                title="Re-run decompose to fill in missing tasks for this feature"
              >
                ⟳ Decompose again
              </button>
            )}
          </div>
        )}
        {t.pendingMode && (
          <p className="text-[10px] text-purple-400">
            Queued for {t.pendingMode}… the dispatcher will pick this up shortly.
          </p>
        )}

        {/* Workspace */}
        <section>
          <h3 className="mb-1 flex items-center gap-1 font-semibold text-neutral-400">
            <FolderGit2 size={12} /> Workspace
          </h3>
          <div className="rounded border border-neutral-800 bg-neutral-950 p-2">
            {t.workspaceKind === 'scratch' ? (
              <span className="text-neutral-400">Scratch (ephemeral)</span>
            ) : t.workspaceKind === 'worktree' ? (
              <div className="space-y-1">
                <span className="text-neutral-300">
                  Worktree ·{' '}
                  <span className="font-mono text-[11px] text-neutral-400">
                    {t.repoPath ?? '(repo unset)'}
                  </span>
                  {t.branchName && (
                    <>
                      {' @ '}
                      <span className="font-mono text-[11px] text-emerald-400">{t.branchName}</span>
                    </>
                  )}
                  {t.baseBranch && (
                    <span className="text-[10px] text-neutral-500"> → {t.baseBranch}</span>
                  )}
                </span>
                {t.workspacePath && t.branchName && (
                  <button
                    onClick={() => setShowDiff(true)}
                    className="block rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
                  >
                    View changes
                  </button>
                )}
              </div>
            ) : (
              <span className="text-neutral-300">
                Dir ·{' '}
                <span className="font-mono text-[11px] text-neutral-400">
                  {t.workspacePath ?? '(path unset)'}
                </span>
              </span>
            )}
          </div>
        </section>

        {/* Pull request status (polled from gh) */}
        {t.prInfo && (
          <section>
            <h3 className="mb-1 flex items-center gap-1 font-semibold text-neutral-400">
              <GitPullRequest size={12} /> Pull request
            </h3>
            <div className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-950 p-2">
              <PrStatusBadge pr={t.prInfo} />
              {t.prInfo.url && (
                <a
                  href={t.prInfo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-[11px] text-sky-400 underline"
                >
                  {t.prInfo.url}
                </a>
              )}
              {t.prInfo.mergeState && (
                <span className="text-[10px] text-neutral-500" title="gh mergeStateStatus">
                  {t.prInfo.mergeState.toLowerCase()}
                </span>
              )}
              {t.prInfo.syncedAt && (
                <span className="ml-auto text-[10px] text-neutral-600">
                  synced {relativeTime(t.prInfo.syncedAt)}
                </span>
              )}
            </div>
          </section>
        )}

        {/* Feature membership */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Feature</h3>
          <select
            value={t.featureId ?? ''}
            disabled={running}
            onChange={(e) =>
              void assignFeature(t.id, e.target.value === '' ? null : e.target.value)
            }
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500 disabled:opacity-50"
          >
            <option value="">No feature</option>
            {/* Keep the current feature selectable even if archived (so it isn't silently dropped). */}
            {features
              .filter((f) => f.status === 'active' || f.id === t.featureId)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.status !== 'active' ? ` (${f.status})` : ''}
                </option>
              ))}
          </select>
        </section>

        {/* Review actions — integrate a finished worktree task */}
        {t.status === 'review' && (
          <section>
            <h3 className="mb-1 font-semibold text-neutral-400">Review &amp; integrate</h3>
            <div className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-2">
              <p className="text-[10px] text-neutral-500">
                Work is committed on{' '}
                <span className="font-mono text-emerald-400">
                  {t.branchName ?? '(unknown branch)'}
                </span>
                . Pick how to integrate it.
              </p>
              {/* Pre-merge conflict prediction against the base (integration) branch. */}
              {t.workspaceKind === 'worktree' && t.branchName && t.baseBranch && (
                <div className="text-[10px]">
                  {t.conflictState === 'conflicts' ? (
                    <div className="rounded border border-red-900/60 bg-red-950/30 p-1.5 text-red-300">
                      <span className="inline-flex items-center gap-1 font-medium">
                        <AlertTriangle size={11} /> Conflicts with {t.baseBranch}
                      </span>
                      {t.conflictFiles.length > 0 && (
                        <ul className="mt-1 max-h-20 overflow-y-auto font-mono text-[10px] text-red-400">
                          {t.conflictFiles.map((f) => (
                            <li key={f} className="truncate" title={f}>
                              {f}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : t.conflictState === 'clean' ? (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <Check size={11} /> Merges cleanly into {t.baseBranch}
                    </span>
                  ) : t.conflictState === 'error' ? (
                    <span className="text-neutral-500">Conflict check unavailable</span>
                  ) : null}
                  <button
                    onClick={() => void recheckConflicts()}
                    disabled={conflictBusy}
                    className="ml-2 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {conflictBusy ? 'Checking…' : 'Re-check'}
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {/* Merge / PR need a worktree branch + base; otherwise only "Do Nothing" applies. */}
                {t.workspaceKind === 'worktree' && t.branchName && t.baseBranch && (
                  <>
                    <button
                      onClick={() => void runReview('merge')}
                      disabled={reviewBusy !== null}
                      className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <GitMerge size={12} />
                      {reviewBusy === 'merge' ? 'Merging…' : `Merge to ${t.baseBranch}`}
                    </button>
                    <button
                      onClick={() => void runReview('pr')}
                      disabled={reviewBusy !== null}
                      className="inline-flex items-center gap-1 rounded border border-sky-700 px-2 py-1 text-sky-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <GitPullRequest size={12} />
                      {reviewBusy === 'pr' ? 'Opening…' : 'Make Pull Request'}
                    </button>
                  </>
                )}
                <button
                  onClick={() => void runReview('accept')}
                  disabled={reviewBusy !== null}
                  className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Check size={12} />
                  {reviewBusy === 'accept' ? 'Accepting…' : 'Do Nothing'}
                </button>
              </div>
              {reviewMsg && (
                <p className="break-all text-[10px] text-emerald-400">
                  {reviewMsg.startsWith('http') ? (
                    <a href={reviewMsg} target="_blank" rel="noreferrer" className="underline">
                      {reviewMsg}
                    </a>
                  ) : (
                    reviewMsg
                  )}
                </p>
              )}
              {reviewErr && <p className="text-[10px] text-red-400">{reviewErr}</p>}
            </div>
          </section>
        )}

        {/* Result / body preview (for blocked cards this holds the agent's question) */}
        {t.result && (
          <section>
            <h3 className="mb-1 font-semibold text-neutral-400">
              {t.status === 'blocked' ? 'Question' : 'Result'}
            </h3>
            <div className="markdown-preview rounded border border-neutral-800 bg-neutral-950 p-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {t.result}
              </ReactMarkdown>
            </div>
          </section>
        )}

        {/* Reply & resume — answer a blocked agent and re-queue it in one step */}
        {t.status === 'blocked' && (
          <BlockedReply
            onResume={(b) => void replyAndResume(t.id, b)}
            onComment={(b) => void addComment(t.id, b)}
          />
        )}

        {/* Dependencies */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Dependencies</h3>
          {detail.parents.length > 0 && (
            <div className="mb-1">
              <span className="text-[10px] text-neutral-500">Parents: </span>
              {detail.parents.map((p) => (
                <span
                  key={p.id}
                  className="mr-1 inline-flex items-center gap-1 rounded bg-neutral-800 px-1 font-mono text-[10px]"
                >
                  {p.id}
                  <button
                    onClick={() => void removeLink(p.id, t.id)}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {detail.children.length > 0 && (
            <div className="mb-1">
              <span className="text-[10px] text-neutral-500">Children: </span>
              {detail.children.map((c) => (
                <span
                  key={c.id}
                  className="mr-1 inline-flex items-center gap-1 rounded bg-neutral-800 px-1 font-mono text-[10px]"
                >
                  {c.id} ({c.status})
                  <button
                    onClick={() => void removeLink(t.id, c.id)}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 flex gap-1">
            <input
              value={linkId}
              onChange={(e) => setLinkId(e.target.value)}
              placeholder="child task id"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono outline-none focus:border-blue-500"
            />
            <button
              onClick={() => {
                const id = linkId.trim();
                if (id && id !== t.id) {
                  void addLink(t.id, id);
                  setLinkId('');
                }
              }}
              className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
            >
              Add child
            </button>
          </div>
        </section>

        {/* Attachments */}
        <section>
          <h3 className="mb-1 flex items-center gap-1 font-semibold text-neutral-400">
            <Paperclip size={12} /> Attachments
          </h3>
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              dragCounter.current += 1;
              if (dragCounter.current === 1) setDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => {
              dragCounter.current -= 1;
              if (dragCounter.current === 0) setDragging(false);
            }}
            onDrop={onDrop}
            className={`rounded border border-dashed p-2 ${
              dragging ? 'border-blue-500 bg-blue-950/30' : 'border-neutral-700'
            }`}
          >
            {detail.attachments.length === 0 && (
              <p className="text-neutral-500">Drop files here, or use the button below.</p>
            )}
            {detail.attachments.map((a) => (
              <div
                key={a.id}
                className="mb-1 flex items-center justify-between gap-2 rounded bg-neutral-950 px-2 py-1"
              >
                <span className="truncate" title={a.filename}>
                  {a.filename}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[10px] text-neutral-500">
                  {formatBytes(a.size)}
                  <button
                    onClick={() => void saveAttachmentCopy(a.id)}
                    title="Save a copy…"
                    className="text-neutral-400 hover:text-blue-400"
                  >
                    <Download size={12} />
                  </button>
                  <button
                    onClick={() => void removeAttachment(a.id)}
                    title="Remove"
                    className="text-neutral-400 hover:text-red-400"
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
          <button
            onClick={() => void pickAndUpload()}
            className="mt-1 rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
          >
            Attach file
          </button>
          {attachError && <p className="mt-1 text-[10px] text-red-400">{attachError}</p>}
          {running && (
            <p className="mt-1 text-[10px] text-amber-400">
              Files added now reach the worker on its next run.
            </p>
          )}
        </section>

        {/* Outputs (artifacts) */}
        <OutputsSection detail={detail} />

        {/* Schedule */}
        {!running && (
          <section>
            <h3 className="mb-1 flex items-center gap-1 font-semibold text-neutral-400">
              <Clock size={12} /> Schedule
            </h3>
            {t.scheduleKind ? (
              <div className="rounded border border-neutral-800 bg-neutral-950 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-indigo-300">{scheduleSummary(t)}</span>
                  {t.nextRunAt != null && (
                    <span className="text-[10px] text-neutral-500">
                      next {formatNextRun(t.nextRunAt)}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.scheduleKind !== 'once' &&
                    (t.schedulePaused ? (
                      <button
                        onClick={() => void resumeSchedule(t.id)}
                        className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        onClick={() => void pauseSchedule(t.id)}
                        className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                      >
                        Pause
                      </button>
                    ))}
                  <button
                    onClick={() => void clearSchedule(t.id)}
                    className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                  >
                    Clear schedule
                  </button>
                </div>
                {t.schedulePaused && (
                  <p className="mt-1 text-[10px] text-amber-400">Paused — will not fire.</p>
                )}
              </div>
            ) : (
              <div className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-2">
                <select
                  value={schedKind}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'once' || v === 'interval' || v === 'cron') setSchedKind(v);
                    setSchedPreview([]);
                    setSchedError(null);
                  }}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
                >
                  <option value="once">Once (at a time)</option>
                  <option value="interval">Repeat every…</option>
                  <option value="cron">Cron expression</option>
                </select>

                {schedKind === 'once' && (
                  <input
                    type="datetime-local"
                    value={schedAt}
                    onChange={(e) => setSchedAt(e.target.value)}
                    className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
                  />
                )}
                {schedKind === 'interval' && (
                  <div className="flex gap-1">
                    <input
                      type="number"
                      min={1}
                      value={schedEveryN}
                      onChange={(e) => setSchedEveryN(Math.max(1, Number(e.target.value)))}
                      className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
                    />
                    <select
                      value={schedUnit}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === 'minutes' || v === 'hours' || v === 'days') setSchedUnit(v);
                      }}
                      className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                  </div>
                )}
                {schedKind === 'cron' && (
                  <input
                    value={schedCron}
                    onChange={(e) => setSchedCron(e.target.value)}
                    placeholder="0 9 * * *"
                    className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono outline-none focus:border-blue-500"
                  />
                )}

                <div className="flex gap-1.5">
                  <button
                    onClick={() => void refreshPreview()}
                    className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                  >
                    Preview
                  </button>
                  <button
                    onClick={() => void applySchedule()}
                    className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-500"
                  >
                    Set schedule
                  </button>
                </div>

                {schedPreview.length > 0 && (
                  <div className="text-[10px] text-neutral-500">
                    Next: {schedPreview.map((n) => formatNextRun(n)).join(' · ')}
                  </div>
                )}
                {schedError && <p className="text-[10px] text-red-400">{schedError}</p>}
              </div>
            )}
          </section>
        )}

        {/* Run history */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Runs</h3>
          {detail.runs.length === 0 && <p className="text-neutral-500">No runs yet.</p>}
          {detail.runs.map((r) => (
            <div key={r.id} className="mb-1 rounded border border-neutral-800 bg-neutral-950 p-2">
              <div className="flex items-center justify-between text-[10px] text-neutral-500">
                <span>
                  {r.profile ?? 'no-profile'} · {r.outcome ?? r.status}
                </span>
                <span>{formatDuration(r.startedAt, r.endedAt)}</span>
              </div>
              {r.summary && <p className="mt-1 text-neutral-300">{r.summary}</p>}
              {r.error && <p className="mt-1 text-red-400">{r.error}</p>}
            </div>
          ))}
        </section>

        {/* Comments */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Comments</h3>
          <CommentThread
            comments={detail.comments}
            onPost={(b) => void addComment(t.id, b)}
            readOnly={t.status === 'blocked'}
          />
        </section>

        <p className="text-[10px] text-neutral-600">
          Created {relativeTime(t.createdAt)} · Updated {relativeTime(t.updatedAt)}
        </p>
      </div>

      <GitChangesModal
        isOpen={showDiff}
        onClose={() => setShowDiff(false)}
        cwd={t.workspacePath ?? undefined}
        compareRef={t.baseBranch}
      />
    </div>
  );
}

/**
 * Compose box shown on a blocked card. The primary action posts the reply (if any)
 * and re-queues the agent in one step; the secondary action only records a note.
 */
function BlockedReply({
  onResume,
  onComment
}: {
  onResume: (body: string) => void;
  onComment: (body: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [resuming, setResuming] = useState(false);
  // The card leaves the blocked state on resume, so this component unmounts —
  // `resuming` only needs to guard against a double-submit in the interim.
  const resume = (): void => {
    setResuming(true);
    onResume(draft.trim());
  };
  return (
    <section>
      <h3 className="mb-1 font-semibold text-neutral-400">Reply &amp; resume</h3>
      <div className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter is the power-user accelerator for the primary action.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              resume();
            }
          }}
          rows={3}
          placeholder="Answer the agent's question… (⌘/Ctrl+Enter to resume)"
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
        />
        <div className="flex gap-1.5">
          <button
            onClick={resume}
            disabled={resuming}
            className="rounded bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resuming ? 'Resuming…' : 'Reply & Resume ▶'}
          </button>
          <button
            onClick={() => {
              const body = draft.trim();
              if (!body) return;
              onComment(body);
              setDraft('');
            }}
            disabled={resuming}
            className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            Add comment
          </button>
        </div>
      </div>
    </section>
  );
}
