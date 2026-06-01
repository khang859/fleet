import type { KanbanStore } from './kanban-store';
import type { KanbanDispatcher } from './kanban-dispatcher';
import { CodedError } from '../errors';
import type {
  CreateTaskInput,
  TaskStatus,
  TaskDetail,
  BoardCard,
  Board,
  Task,
  TaskComment,
  TaskEvent,
  UpdateTaskFields,
  WorkspaceKind,
  PendingMode,
  TaskAttachment,
  TaskArtifact,
  ArtifactListItem,
  ArtifactListFilter,
  ScheduleInput,
  SwarmInput,
  SwarmCreated
} from '../../shared/kanban-types';
import { createSwarm as buildSwarm } from './kanban-swarm';
import { validateSchedule, computeNextRun } from './schedule';
import { createLogger } from '../logger';
import { removeWorktree } from './workspace';
import { removeAttachmentFile } from './attachments';
import { deriveBoardSlug } from './board-slug';

const log = createLogger('kanban-commands');

/** Statuses a human may set manually (everything except dispatcher-owned `running`). */
export const MANUAL_STATUSES: TaskStatus[] = [
  'triage',
  'todo',
  'ready',
  'blocked',
  'done',
  'archived'
];

export interface CreateDefaults {
  workspaceKind: WorkspaceKind;
  maxRuntimeSeconds: number | null;
}

/** Upper bound on workers per swarm — keeps one swarm from monopolizing the global dispatcher. */
export const SWARM_MAX_WORKERS = 20;

/**
 * KanbanCommands is the single application layer over KanbanStore/KanbanDispatcher.
 * The board IPC, the CLI socket server, and any future front door all call these
 * methods, so validation and event-logging cannot drift between them.
 */
export class KanbanCommands {
  constructor(
    private store: KanbanStore,
    private dispatcher: KanbanDispatcher,
    private getCreateDefaults: () => CreateDefaults,
    private getProfiles: () => Array<{ name: string; role: string }> = () => []
  ) {}

  create(input: CreateTaskInput): Task {
    const d = this.getCreateDefaults();
    const workspaceKind = input.workspaceKind ?? d.workspaceKind;
    if (workspaceKind === 'worktree' && !input.repoPath) {
      throw new CodedError('worktree tasks require a source repo (repoPath)', 'BAD_REQUEST');
    }
    if (workspaceKind === 'dir' && !input.workspacePath) {
      throw new CodedError('dir tasks require a workspace path (workspacePath)', 'BAD_REQUEST');
    }
    const task = this.store.createTask({
      ...input,
      workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    });
    this.store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  }

  createSwarm(input: SwarmInput): SwarmCreated {
    const goal = (input.goal ?? '').trim();
    if (goal === '') throw new CodedError('swarm requires a goal', 'BAD_REQUEST');
    const workers = input.workers ?? [];
    if (workers.length < 1) {
      throw new CodedError('swarm requires at least one worker', 'BAD_REQUEST');
    }
    if (workers.length > SWARM_MAX_WORKERS) {
      throw new CodedError(`swarm supports at most ${SWARM_MAX_WORKERS} workers`, 'BAD_REQUEST');
    }
    if (!(input.verifierAssignee ?? '').trim()) {
      throw new CodedError('swarm requires a verifier', 'BAD_REQUEST');
    }
    if (!(input.synthesizerAssignee ?? '').trim()) {
      throw new CodedError('swarm requires a synthesizer', 'BAD_REQUEST');
    }

    const d = this.getCreateDefaults();
    const workspaceKind = input.workspaceKind ?? d.workspaceKind;
    if (workspaceKind === 'worktree' && !input.repoPath) {
      throw new CodedError('worktree swarms require a source repo (repoPath)', 'BAD_REQUEST');
    }
    if (workspaceKind === 'dir' && !input.workspacePath) {
      throw new CodedError('dir swarms require a workspace path (workspacePath)', 'BAD_REQUEST');
    }

    const profiles = this.getProfiles();
    const workerProfiles = new Set(profiles.filter((p) => p.role === 'worker').map((p) => p.name));
    for (const w of workers) {
      if (!(w.profile ?? '').trim())
        throw new CodedError('each worker requires a profile', 'BAD_REQUEST');
      if (!(w.title ?? '').trim())
        throw new CodedError('each worker requires a title', 'BAD_REQUEST');
      if (workerProfiles.size > 0 && !workerProfiles.has(w.profile)) {
        throw new CodedError(`unknown worker profile: ${w.profile}`, 'BAD_REQUEST');
      }
    }

    if (input.seedArtifactId) {
      const art = this.store.getArtifact(input.seedArtifactId);
      if (!art) throw new CodedError(`artifact not found: ${input.seedArtifactId}`, 'NOT_FOUND');
      if (art.state !== 'kept') {
        throw new CodedError('only kept artifacts can be reused', 'BAD_REQUEST');
      }
    }

    const resolved: SwarmInput = {
      ...input,
      goal,
      workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    };

    // The seeded artifact copy attaches to the root task inside the same transaction; if any
    // step throws, the copied attachment file is removed so a rollback leaves no orphan.
    const copiedFiles: string[] = [];
    let created: SwarmCreated;
    try {
      created = this.store.transaction(() => {
        const c = buildSwarm(this.store, resolved);
        if (resolved.seedArtifactId) {
          const att = this.store.attachArtifactToTask(c.rootId, resolved.seedArtifactId);
          copiedFiles.push(att.storedPath);
        }
        return c;
      });
    } catch (err) {
      for (const p of copiedFiles) removeAttachmentFile(p);
      throw err;
    }

    // Emit after commit so IPC/notifier never fire mid-transaction.
    this.store.appendEvent(created.rootId, null, 'swarm_created', {
      goal,
      workerCount: workers.length
    });
    for (const id of [...created.workerIds, created.verifierId, created.synthesizerId]) {
      const t = this.store.getTask(id);
      this.store.appendEvent(id, null, 'task_created', { title: t?.title ?? '' });
    }
    return created;
  }

  list(filter: { status?: TaskStatus; boardSlug?: string } = {}): BoardCard[] {
    const board = this.store.listBoard(filter.boardSlug);
    return filter.status ? board.filter((c) => c.status === filter.status) : board;
  }

  listBoards(): Board[] {
    return this.store.listBoards();
  }

  createBoard(name: string): Board {
    if (name.trim() === '' || deriveBoardSlug(name) === '') {
      throw new CodedError('invalid board name', 'BAD_REQUEST');
    }
    return this.store.createBoard(name);
  }

  renameBoard(slug: string, name: string): void {
    if (name.trim() === '' || deriveBoardSlug(name) === '') {
      throw new CodedError('invalid board name', 'BAD_REQUEST');
    }
    this.store.renameBoard(slug, name);
  }

  deleteBoard(slug: string): void {
    if (slug === 'default') {
      throw new CodedError('the default board cannot be deleted', 'BAD_REQUEST');
    }
    if (this.store.listBoard(slug).some((c) => c.status === 'running')) {
      throw new CodedError('stop running tasks before deleting this board', 'BAD_REQUEST');
    }
    this.store.deleteBoard(slug);
  }

  show(id: string): TaskDetail | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    return {
      task,
      comments: this.store.listComments(id),
      runs: this.store.listRuns(id),
      events: this.store.listEvents(id),
      parents: this.store
        .parentsOf(id)
        .map((pid) => this.store.getTask(pid))
        .filter((t): t is Task => t !== null),
      children: this.store
        .childrenOf(id)
        .map((cid) => this.store.getTask(cid))
        .filter((t): t is Task => t !== null),
      attachments: this.store.listAttachments(id),
      artifacts: this.store.listArtifacts(id)
    };
  }

  private requireTask(id: string): Task {
    const t = this.store.getTask(id);
    if (!t) throw new CodedError(`task not found: ${id}`, 'NOT_FOUND');
    return t;
  }

  update(id: string, fields: UpdateTaskFields): void {
    this.requireTask(id);
    this.store.updateTask(id, fields);
    this.store.appendEvent(id, null, 'task_updated', { fields });
  }

  assign(id: string, profile: string | null): void {
    this.update(id, { assignee: profile });
  }

  setManualStatus(id: string, status: TaskStatus): void {
    const task = this.requireTask(id);
    if (task.status === 'running' || status === 'running') {
      throw new CodedError('cannot manually change a running task', 'BAD_REQUEST');
    }
    if (!MANUAL_STATUSES.includes(status)) {
      throw new CodedError(`invalid status: ${status}`, 'BAD_REQUEST');
    }
    this.store.setStatus(id, status);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: status,
      by: 'user'
    });
    if (task.status === 'scheduled' && status !== 'scheduled') {
      // leaving the scheduled lane unschedules the task (drag or action button)
      this.store.dropSchedule(id);
    }
    // Archiving a worktree task tears down its worktree + branch (best-effort;
    // removeWorktree never throws, but guard archival defensively regardless).
    if (
      status === 'archived' &&
      task.workspaceKind === 'worktree' &&
      task.workspacePath &&
      task.repoPath
    ) {
      try {
        removeWorktree({
          repoPath: task.repoPath,
          workspacePath: task.workspacePath,
          branchName: task.branchName
        });
      } catch (err) {
        log.warn('worktree removal on archive failed', {
          taskId: id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    // Scratch safety net (§6): never warn-then-delete. If unregistered files remain in the
    // ephemeral workspace, preserve it and surface a warning; only delete when nothing is at risk.
    if (status === 'archived' && task.workspaceKind === 'scratch' && task.workspacePath) {
      const leftovers = this.store.scratchLeftovers(id);
      if (leftovers.length > 0) {
        this.store.appendEvent(id, null, 'artifacts_unregistered', { files: leftovers });
      } else {
        this.store.deleteScratchWorkspace(id);
      }
    }
  }

  ready(id: string): void {
    this.setManualStatus(id, 'ready');
  }

  unblock(id: string): void {
    this.setManualStatus(id, 'ready');
  }

  archive(id: string): void {
    this.setManualStatus(id, 'archived');
  }

  block(id: string, reason: string): void {
    const task = this.requireTask(id);
    if (task.status === 'running') {
      throw new CodedError('cannot block a running task', 'BAD_REQUEST');
    }
    this.store.blockTask(id, reason);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: 'blocked',
      by: 'user',
      reason
    });
  }

  complete(id: string, result: string): void {
    const task = this.requireTask(id);
    if (task.status === 'running') {
      throw new CodedError('cannot complete a running task', 'BAD_REQUEST');
    }
    this.store.completeTask(id, result);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: 'done',
      by: 'user',
      result
    });
  }

  comment(id: string, body: string): TaskComment {
    this.requireTask(id);
    const comment = this.store.addComment(id, 'human', body);
    this.store.appendEvent(id, null, 'comment_added', { author: 'human' });
    return comment;
  }

  /**
   * Answer a blocked card and re-queue it in one step. Posts the reply (when
   * non-empty) as a human comment, clears the failure counters, then resumes in
   * the same mode the card last ran: a worker run returns to `ready`, an
   * orchestrator run (`decompose`/`specify`) is re-armed back to `triage`. The
   * dispatcher is ticked immediately so the agent picks up without waiting for
   * the next poll.
   */
  replyAndResume(id: string, body: string): void {
    const task = this.requireTask(id);
    if (task.status !== 'blocked') {
      throw new CodedError('only blocked tasks can be resumed', 'BAD_REQUEST');
    }
    const text = body.trim();
    if (text !== '') this.comment(id, text);
    this.store.clearFailures(id);
    // `current_run_id` is nulled on block, so the last run's mode is the signal
    // for how to resume; listRuns is deterministically ordered newest-first.
    const lastMode = this.store.listRuns(id)[0]?.mode ?? 'work';
    if (lastMode === 'decompose' || lastMode === 'specify') {
      this.store.setStatusCleared(id, 'triage');
      this.store.appendEvent(id, null, 'status_changed', {
        from: 'blocked',
        to: 'triage',
        by: 'user'
      });
      // status is now 'triage', so requestOrchestration's guard passes.
      this.requestOrchestration(id, lastMode);
    } else {
      this.unblock(id);
    }
    this.dispatcher.tick();
  }

  addAttachment(taskId: string, sourcePath: string): TaskAttachment {
    this.requireTask(taskId);
    const att = this.store.addAttachment(taskId, sourcePath);
    this.store.appendEvent(taskId, null, 'attachment_added', {
      id: att.id,
      filename: att.filename
    });
    return att;
  }

  removeAttachment(id: string): void {
    const att = this.store.getAttachment(id);
    if (!att) return;
    this.store.removeAttachment(id);
    this.store.appendEvent(att.taskId, null, 'attachment_removed', {
      id,
      filename: att.filename
    });
  }

  getAttachment(id: string): TaskAttachment | null {
    return this.store.getAttachment(id);
  }

  // ---- Artifacts (durable task outputs) ----

  listArtifacts(taskId: string): TaskArtifact[] {
    this.requireTask(taskId);
    return this.store.listArtifacts(taskId);
  }

  listAllArtifacts(filter: ArtifactListFilter = {}): ArtifactListItem[] {
    return this.store.listAllArtifacts(filter);
  }

  getArtifact(id: string): TaskArtifact | null {
    return this.store.getArtifact(id);
  }

  discardArtifact(id: string): void {
    const art = this.store.getArtifact(id);
    if (art?.state !== 'kept') return;
    this.store.discardArtifact(id);
    this.store.appendEvent(art.taskId, art.runId, 'artifact_discarded', {
      id,
      filename: art.filename
    });
  }

  restoreArtifact(id: string): void {
    const art = this.store.getArtifact(id);
    if (art?.state !== 'discarded') return;
    this.store.restoreArtifact(id);
    this.store.appendEvent(art.taskId, art.runId, 'artifact_restored', {
      id,
      filename: art.filename
    });
  }

  /** Hard delete (row + file). The drawer Discard is soft; this is the explicit Remove action. */
  removeArtifact(id: string): void {
    const art = this.store.getArtifact(id);
    if (!art) return;
    this.store.purgeArtifact(id);
    this.store.appendEvent(art.taskId, art.runId, 'artifact_removed', {
      id,
      filename: art.filename
    });
  }

  /** Reuse a kept artifact as input to an existing task (copy into its attachments). */
  reuseArtifact(artifactId: string, targetTaskId: string): TaskAttachment {
    this.requireTask(targetTaskId);
    const art = this.store.getArtifact(artifactId);
    if (!art) throw new CodedError(`artifact not found: ${artifactId}`, 'NOT_FOUND');
    if (art.state !== 'kept')
      throw new CodedError('only kept artifacts can be reused', 'BAD_REQUEST');
    const att = this.store.attachArtifactToTask(targetTaskId, artifactId);
    this.store.appendEvent(targetTaskId, null, 'attachment_added', {
      id: att.id,
      filename: att.filename,
      fromArtifact: artifactId
    });
    return att;
  }

  /** Atomically create a new task seeded with a kept artifact copy. */
  createTaskFromArtifact(artifactId: string, input: CreateTaskInput): Task {
    const art = this.store.getArtifact(artifactId);
    if (!art) throw new CodedError(`artifact not found: ${artifactId}`, 'NOT_FOUND');
    if (art.state !== 'kept')
      throw new CodedError('only kept artifacts can be reused', 'BAD_REQUEST');
    const task = this.store.createTaskFromArtifact(artifactId, input);
    this.store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  }

  /** Reveal a preserved scratch workspace (path resolved from the task row, never the renderer). */
  revealTaskWorkspace(taskId: string): string | null {
    const task = this.requireTask(taskId);
    if (task.workspaceKind !== 'scratch' || !task.workspacePath) return null;
    return task.workspacePath;
  }

  /** Explicitly delete preserved scratch leftovers after the archive warning. Guarded in the store. */
  discardTaskWorkspaceLeftovers(taskId: string): void {
    const task = this.requireTask(taskId);
    if (task.workspaceKind !== 'scratch') {
      throw new CodedError('only scratch workspaces can be discarded', 'BAD_REQUEST');
    }
    if (task.status !== 'archived') {
      throw new CodedError('only archived tasks can have their workspace discarded', 'BAD_REQUEST');
    }
    const deleted = this.store.deleteScratchWorkspace(taskId);
    if (deleted) {
      this.store.appendEvent(taskId, null, 'artifacts_unregistered_discarded', {});
    }
  }

  link(parentId: string, childId: string): void {
    this.requireTask(parentId);
    this.requireTask(childId);
    this.store.addLink(parentId, childId);
    this.store.appendEvent(childId, null, 'link_added', { parentId });
  }

  unlink(parentId: string, childId: string): void {
    this.requireTask(parentId);
    this.requireTask(childId);
    this.store.removeLink(parentId, childId);
    this.store.appendEvent(childId, null, 'link_removed', { parentId });
  }

  log(id: string): TaskEvent[] {
    this.requireTask(id);
    return this.store.listEvents(id);
  }

  requestDecompose(id: string): void {
    this.requestOrchestration(id, 'decompose');
  }

  requestSpecify(id: string): void {
    this.requestOrchestration(id, 'specify');
  }

  private requestOrchestration(id: string, mode: PendingMode): void {
    const task = this.requireTask(id);
    if (task.status !== 'triage') {
      throw new CodedError('only triage tasks can be decomposed or specified', 'BAD_REQUEST');
    }
    this.store.setPendingMode(id, mode);
    this.store.appendEvent(
      id,
      null,
      mode === 'decompose' ? 'decompose_requested' : 'specify_requested',
      {}
    );
  }

  setSchedule(id: string, input: ScheduleInput): void {
    this.requireTask(id);
    const v = validateSchedule(input);
    if (!v.ok) throw new CodedError(v.error, 'BAD_REQUEST');
    this.store.setSchedule(id, input);
    this.store.appendEvent(id, null, 'schedule_set', {
      kind: input.kind,
      expr: input.kind === 'cron' ? input.expr : undefined,
      everyMs: input.kind === 'interval' ? input.everyMs : undefined,
      at: input.kind === 'once' ? input.at : undefined
    });
  }

  clearSchedule(id: string): void {
    const t = this.requireTask(id);
    if (t.scheduleKind == null) return; // nothing to clear; don't emit a phantom event
    this.store.clearSchedule(id);
    this.store.appendEvent(id, null, 'schedule_cleared', {});
  }

  pauseSchedule(id: string): void {
    const t = this.requireTask(id);
    if (t.scheduleKind == null || t.scheduleKind === 'once') {
      throw new CodedError('only recurring schedules can be paused', 'BAD_REQUEST');
    }
    if (t.schedulePaused) return; // already paused — idempotent no-op
    this.store.pauseSchedule(id);
    this.store.appendEvent(id, null, 'schedule_paused', {});
  }

  resumeSchedule(id: string): void {
    const t = this.requireTask(id);
    if (t.scheduleKind == null || t.scheduleKind === 'once') {
      throw new CodedError('only recurring schedules can be resumed', 'BAD_REQUEST');
    }
    if (!t.schedulePaused) return; // not paused — idempotent no-op
    this.store.resumeSchedule(id);
    this.store.appendEvent(id, null, 'schedule_resumed', {});
  }

  /** Compute the next ~3 fire times for a candidate schedule (drawer live preview). */
  previewSchedule(
    input: ScheduleInput
  ): { ok: true; next: number[] } | { ok: false; error: string } {
    const v = validateSchedule(input);
    if (!v.ok) return { ok: false, error: v.error };
    const next: number[] = [];
    let after = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const n = computeNextRun(input, after);
      next.push(n);
      after = n;
      if (input.kind === 'once') break; // a one-shot fires exactly once
    }
    return { ok: true, next };
  }

  dispatch(): void {
    this.dispatcher.tick();
  }
}
