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
  ScheduleInput,
  SwarmInput,
  SwarmCreated
} from '../../shared/kanban-types';
import { createSwarm as buildSwarm } from './kanban-swarm';
import { validateSchedule, computeNextRun } from './schedule';
import { createLogger } from '../logger';
import { removeWorktree } from './workspace';
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

    const resolved: SwarmInput = {
      ...input,
      goal,
      workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    };

    const created = this.store.transaction(() => buildSwarm(this.store, resolved));

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
      attachments: this.store.listAttachments(id)
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
