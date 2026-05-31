import { ipcMain, BrowserWindow, dialog } from 'electron';
import { copyFileSync } from 'fs';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { createLogger } from '../logger';
import type { KanbanCommands } from './kanban-commands';
import type { CreateTaskInput, TaskDetail, Task, ScheduleInput, SwarmInput, SwarmCreated } from '../../shared/kanban-types';
import type {
  KanbanUpdateTaskRequest,
  KanbanSetStatusRequest,
  KanbanAddCommentRequest,
  KanbanLinkRequest,
  KanbanAddAttachmentRequest,
  KanbanRenameBoardRequest,
  KanbanSetScheduleRequest
} from '../../shared/ipc-api';

const log = createLogger('kanban-ipc');

export function registerKanbanIpc(commands: KanbanCommands): void {
  ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_BOARD, (_e, boardSlug?: string) =>
    commands.list({ boardSlug })
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_GET_TASK, (_e, taskId: string): TaskDetail | null => {
    return commands.show(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_TASK, (_e, input: CreateTaskInput): Task => {
    return commands.create(input);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_SWARM, (_e, input: SwarmInput): SwarmCreated => {
    return commands.createSwarm(input);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_UPDATE_TASK, (_e, req: KanbanUpdateTaskRequest) => {
    commands.update(req.id, req.fields);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_SET_STATUS, (_e, req: KanbanSetStatusRequest) => {
    // The board only ever offers valid drag targets; preserve the historical
    // silent no-op when a rejected move slips through (running-owned / invalid).
    try {
      commands.setManualStatus(req.id, req.status);
    } catch (err) {
      log.warn('rejected manual status change', {
        id: req.id,
        to: req.status,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_COMMENT, (_e, req: KanbanAddCommentRequest) => {
    commands.comment(req.taskId, req.body);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_LINK, (_e, req: KanbanLinkRequest) => {
    commands.link(req.parentId, req.childId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REMOVE_LINK, (_e, req: KanbanLinkRequest) => {
    commands.unlink(req.parentId, req.childId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_NUDGE, () => {
    commands.dispatch();
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_DECOMPOSE, (_e, taskId: string) => {
    commands.requestDecompose(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_SPECIFY, (_e, taskId: string) => {
    commands.requestSpecify(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_PICK_ATTACHMENT, async (e): Promise<string[]> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return [];
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_ATTACHMENT, (_e, req: KanbanAddAttachmentRequest) => {
    // Errors (oversize / non-regular file) propagate to the renderer's invoke().
    commands.addAttachment(req.taskId, req.sourcePath);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REMOVE_ATTACHMENT, (_e, id: string) => {
    commands.removeAttachment(id);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_SAVE_ATTACHMENT_COPY, async (e, id: string): Promise<void> => {
    const att = commands.getAttachment(id);
    if (!att) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const res = await dialog.showSaveDialog(win, { defaultPath: att.filename });
    if (res.canceled || !res.filePath) return;
    copyFileSync(att.storedPath, res.filePath);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_BOARDS, () => commands.listBoards());
  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_BOARD, (_e, name: string) =>
    commands.createBoard(name)
  );
  ipcMain.handle(IPC_CHANNELS.KANBAN_RENAME_BOARD, (_e, req: KanbanRenameBoardRequest) =>
    commands.renameBoard(req.slug, req.name)
  );
  ipcMain.handle(IPC_CHANNELS.KANBAN_DELETE_BOARD, (_e, slug: string) =>
    commands.deleteBoard(slug)
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_SET_SCHEDULE, (_e, req: KanbanSetScheduleRequest) => {
    // CodedError('BAD_REQUEST') propagates to the renderer's invoke() for inline display.
    commands.setSchedule(req.taskId, req.input);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_CLEAR_SCHEDULE, (_e, taskId: string) => {
    commands.clearSchedule(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_PAUSE_SCHEDULE, (_e, taskId: string) => {
    commands.pauseSchedule(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_RESUME_SCHEDULE, (_e, taskId: string) => {
    commands.resumeSchedule(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_PREVIEW_SCHEDULE, (_e, input: ScheduleInput) => {
    return commands.previewSchedule(input);
  });

  log.info('kanban IPC handlers registered');
}
