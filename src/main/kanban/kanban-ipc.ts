import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import { copyFileSync } from 'fs';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { createLogger } from '../logger';
import { readArtifactPreview } from './artifact-files';
import type { KanbanCommands } from './kanban-commands';
import type {
  CreateTaskInput,
  TaskDetail,
  Task,
  ScheduleInput,
  SwarmInput,
  SwarmCreated,
  ArtifactListItem,
  TaskAttachment,
  Feature,
  FeatureDetail
} from '../../shared/kanban-types';
import type {
  KanbanUpdateTaskRequest,
  KanbanListFeaturesRequest,
  KanbanCreateFeatureRequest,
  KanbanUpdateFeatureRequest,
  KanbanAssignTaskToFeatureRequest,
  KanbanSetStatusRequest,
  KanbanAddCommentRequest,
  KanbanReplyAndResumeRequest,
  KanbanLinkRequest,
  KanbanAddAttachmentRequest,
  KanbanRenameBoardRequest,
  KanbanSetScheduleRequest,
  KanbanListArtifactsRequest,
  KanbanReadArtifactPreviewRequest,
  KanbanArtifactPreviewResponse,
  KanbanReuseArtifactRequest,
  KanbanCreateTaskFromArtifactRequest,
  KanbanCreateSwarmFromArtifactRequest
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

  ipcMain.handle(IPC_CHANNELS.KANBAN_REPLY_AND_RESUME, (_e, req: KanbanReplyAndResumeRequest) => {
    // CodedError('BAD_REQUEST') for a non-blocked task propagates to the renderer's invoke().
    commands.replyAndResume(req.taskId, req.body);
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

  ipcMain.handle(IPC_CHANNELS.KANBAN_MERGE_TASK, (_e, taskId: string) =>
    commands.mergeReviewTask(taskId)
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_PR, (_e, taskId: string) =>
    commands.createPrForTask(taskId)
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_ACCEPT_TASK, (_e, taskId: string) =>
    commands.acceptReviewTask(taskId)
  );

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

  // ---- Artifacts ----

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_LIST_ARTIFACTS,
    (_e, filter: KanbanListArtifactsRequest = {}): ArtifactListItem[] =>
      commands.listAllArtifacts(filter)
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_DISCARD_ARTIFACT, (_e, id: string) => {
    commands.discardArtifact(id);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_RESTORE_ARTIFACT, (_e, id: string) => {
    commands.restoreArtifact(id);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REMOVE_ARTIFACT, (_e, id: string) => {
    commands.removeArtifact(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_REUSE_ARTIFACT,
    (_e, req: KanbanReuseArtifactRequest): TaskAttachment =>
      commands.reuseArtifact(req.id, req.targetTaskId)
  );

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_CREATE_TASK_FROM_ARTIFACT,
    (_e, req: KanbanCreateTaskFromArtifactRequest): Task =>
      commands.createTaskFromArtifact(req.artifactId, req.input)
  );

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_CREATE_SWARM_FROM_ARTIFACT,
    (_e, req: KanbanCreateSwarmFromArtifactRequest): SwarmCreated =>
      commands.createSwarm({ ...req.input, seedArtifactId: req.artifactId })
  );

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_READ_ARTIFACT_PREVIEW,
    (_e, req: KanbanReadArtifactPreviewRequest): KanbanArtifactPreviewResponse => {
      const art = commands.getArtifact(req.id);
      if (!art) return { previewable: false, reason: 'Artifact not found' };
      const preview = readArtifactPreview(art.storedPath, req.maxBytes);
      if (!preview.previewable) {
        return { previewable: false, reason: preview.reason ?? 'Preview unavailable' };
      }
      return {
        previewable: true,
        text: preview.text ?? '',
        truncated: preview.truncated ?? false,
        contentType: art.contentType,
        size: art.size
      };
    }
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_SAVE_ARTIFACT_COPY, async (e, id: string): Promise<void> => {
    const art = commands.getArtifact(id);
    if (!art) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const res = await dialog.showSaveDialog(win, { defaultPath: art.filename });
    if (res.canceled || !res.filePath) return;
    copyFileSync(art.storedPath, res.filePath);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REVEAL_ARTIFACT, (_e, id: string) => {
    const art = commands.getArtifact(id);
    if (art) shell.showItemInFolder(art.storedPath);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REVEAL_TASK_WORKSPACE, (_e, taskId: string) => {
    const path = commands.revealTaskWorkspace(taskId);
    if (path) shell.showItemInFolder(path);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_DISCARD_TASK_WORKSPACE_LEFTOVERS, (_e, taskId: string) => {
    commands.discardTaskWorkspaceLeftovers(taskId);
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

  // ---- Features ----

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_LIST_FEATURES,
    (_e, filter: KanbanListFeaturesRequest = {}): Feature[] => commands.listFeatures(filter)
  );

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_GET_FEATURE,
    (_e, id: string): FeatureDetail | null => commands.showFeature(id)
  );

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_CREATE_FEATURE,
    (_e, req: KanbanCreateFeatureRequest): Feature => commands.createFeature(req)
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_UPDATE_FEATURE, (_e, req: KanbanUpdateFeatureRequest) => {
    commands.updateFeature(req.id, req.fields);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ARCHIVE_FEATURE, (_e, id: string) => {
    commands.archiveFeature(id);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_DELETE_FEATURE, (_e, id: string) => {
    commands.deleteFeature(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_ASSIGN_TASK_TO_FEATURE,
    (_e, req: KanbanAssignTaskToFeatureRequest) => {
      commands.assignTaskToFeature(req.taskId, req.featureId);
    }
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_REDECOMPOSE, (_e, featureId: string): Task =>
    commands.redecompose(featureId)
  );

  log.info('kanban IPC handlers registered');
}
