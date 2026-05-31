import type { KanbanStore } from './kanban-store';
import type { KanbanDispatcher } from './kanban-dispatcher';
import { CodedError } from '../errors';
import type {
  CreateTaskInput,
  TaskStatus,
  TaskDetail,
  BoardCard,
  Task,
  TaskComment,
  TaskEvent,
  UpdateTaskFields,
  WorkspaceKind,
  PendingMode
} from '../../shared/kanban-types';

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

/**
 * KanbanCommands is the single application layer over KanbanStore/KanbanDispatcher.
 * The board IPC, the CLI socket server, and any future front door all call these
 * methods, so validation and event-logging cannot drift between them.
 */
export class KanbanCommands {
  constructor(
    private store: KanbanStore,
    private dispatcher: KanbanDispatcher,
    private getCreateDefaults: () => CreateDefaults
  ) {}

  create(input: CreateTaskInput): Task {
    const d = this.getCreateDefaults();
    const workspaceKind = input.workspaceKind ?? d.workspaceKind;
    if (workspaceKind === 'worktree' && !input.repoPath) {
      throw new CodedError('worktree tasks require a source repo (repoPath)', 'BAD_REQUEST');
    }
    const task = this.store.createTask({
      ...input,
      workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    });
    this.store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  }

  list(filter: { status?: TaskStatus } = {}): BoardCard[] {
    const board = this.store.listBoard();
    return filter.status ? board.filter((c) => c.status === filter.status) : board;
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
        .filter((t): t is Task => t !== null)
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

  dispatch(): void {
    this.dispatcher.tick();
  }
}
