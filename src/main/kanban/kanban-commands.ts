import type { KanbanStore } from './kanban-store';
import type { KanbanDispatcher } from './kanban-dispatcher';
import type {
  CreateTaskInput,
  TaskStatus,
  TaskDetail,
  BoardCard,
  Task,
  WorkspaceKind
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
    // Retained for Tasks 2-3 (status transitions delegate to the dispatcher).
    protected dispatcher: KanbanDispatcher,
    private getCreateDefaults: () => CreateDefaults
  ) {}

  create(input: CreateTaskInput): Task {
    const d = this.getCreateDefaults();
    const task = this.store.createTask({
      ...input,
      workspaceKind: input.workspaceKind ?? d.workspaceKind,
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
}
