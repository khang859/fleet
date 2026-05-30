import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { KanbanDispatcher } from './kanban-dispatcher';
import type {
  CreateTaskInput,
  TaskStatus,
  TaskDetail,
  Task,
  WorkspaceKind
} from '../../shared/kanban-types';
import type {
  KanbanUpdateTaskRequest,
  KanbanSetStatusRequest,
  KanbanAddCommentRequest,
  KanbanLinkRequest
} from '../../shared/ipc-api';

const log = createLogger('kanban-ipc');

const MANUAL_STATUSES: TaskStatus[] = [
  'triage',
  'todo',
  'ready',
  'blocked',
  'done',
  'archived'
];

export function registerKanbanIpc(
  store: KanbanStore,
  dispatcher: KanbanDispatcher,
  getCreateDefaults: () => { workspaceKind: WorkspaceKind; maxRuntimeSeconds: number | null }
): void {
  ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_BOARD, () => store.listBoard());

  ipcMain.handle(IPC_CHANNELS.KANBAN_GET_TASK, (_e, taskId: string): TaskDetail | null => {
    const task = store.getTask(taskId);
    if (!task) return null;
    return {
      task,
      comments: store.listComments(taskId),
      runs: store.listRuns(taskId),
      events: store.listEvents(taskId),
      parents: store
        .parentsOf(taskId)
        .map((id) => store.getTask(id))
        .filter((t): t is Task => t !== null),
      children: store
        .childrenOf(taskId)
        .map((id) => store.getTask(id))
        .filter((t): t is Task => t !== null)
    };
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_TASK, (_e, input: CreateTaskInput): Task => {
    const d = getCreateDefaults();
    const task = store.createTask({
      ...input,
      workspaceKind: input.workspaceKind ?? d.workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    });
    store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_UPDATE_TASK, (_e, req: KanbanUpdateTaskRequest) => {
    store.updateTask(req.id, req.fields);
    store.appendEvent(req.id, null, 'task_updated', {});
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_SET_STATUS, (_e, req: KanbanSetStatusRequest) => {
    const task = store.getTask(req.id);
    if (!task) return;
    // Running is dispatcher-owned: reject manual moves into or out of it.
    if (task.status === 'running' || req.status === 'running') {
      log.warn('rejected manual status change involving running', {
        id: req.id,
        from: task.status,
        to: req.status
      });
      return;
    }
    if (!MANUAL_STATUSES.includes(req.status)) return;
    store.setStatus(req.id, req.status);
    store.appendEvent(req.id, null, 'status_changed', {
      from: task.status,
      to: req.status,
      by: 'user'
    });
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_COMMENT, (_e, req: KanbanAddCommentRequest) => {
    store.addComment(req.taskId, 'human', req.body);
    store.appendEvent(req.taskId, null, 'comment_added', { author: 'human' });
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_LINK, (_e, req: KanbanLinkRequest) => {
    store.addLink(req.parentId, req.childId);
    store.appendEvent(req.childId, null, 'link_added', { parentId: req.parentId });
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REMOVE_LINK, (_e, req: KanbanLinkRequest) => {
    store.removeLink(req.parentId, req.childId);
    store.appendEvent(req.childId, null, 'link_removed', { parentId: req.parentId });
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_NUDGE, () => {
    dispatcher.tick();
  });

  log.info('kanban IPC handlers registered');
}
