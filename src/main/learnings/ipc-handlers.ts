// src/main/learnings/ipc-handlers.ts
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFileSync } from 'fs';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import {
  learningToMarkdown,
  slugifyTitle,
  type Learning,
  type CreateLearningInput,
  type UpdateLearningInput,
  type LearningSearchFilter,
  type DistillRequest,
  type DistillResult,
  type TagCount
} from '../../shared/learnings';
import { pathMessagesToNode } from '../../shared/sessions';
import type { LearningsStore } from './learnings-store';
import type { SessionsService } from '../sessions/service';
import { distillLearning } from './distiller';

/** `YYYY-MM-DD` in local time, for default export filenames. */
function dateStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// IPC args come from the renderer and are untrusted: a malformed payload must
// produce a clean rejected promise, not a TypeError/SqliteError crash in main.
function reqString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateCreateInput(input: CreateLearningInput): CreateLearningInput {
  if (!input || typeof input !== 'object') throw new Error('learning input is required');
  reqString(input.title, 'title');
  if (typeof input.body !== 'string') throw new Error('body must be a string');
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new Error('tags must be an array');
  }
  return input;
}

export function registerLearningsIpcHandlers(
  store: LearningsStore,
  sessions: SessionsService
): void {
  ipcMain.handle(IPC_CHANNELS.LEARNINGS_SEARCH, (_e, filter?: LearningSearchFilter): Learning[] =>
    store.search(filter ?? {})
  );
  ipcMain.handle(IPC_CHANNELS.LEARNINGS_GET, (_e, id: string): Learning | null =>
    store.get(reqString(id, 'id'))
  );
  ipcMain.handle(
    IPC_CHANNELS.LEARNINGS_CREATE,
    (_e, input: CreateLearningInput): Learning => store.create(validateCreateInput(input))
  );
  ipcMain.handle(
    IPC_CHANNELS.LEARNINGS_UPDATE,
    (_e, id: string, fields: UpdateLearningInput): Learning | null => {
      reqString(id, 'id');
      if (!fields || typeof fields !== 'object') throw new Error('update fields are required');
      return store.update(id, fields);
    }
  );
  ipcMain.handle(IPC_CHANNELS.LEARNINGS_DELETE, (_e, id: string): void =>
    store.delete(reqString(id, 'id'))
  );
  ipcMain.handle(
    IPC_CHANNELS.LEARNINGS_DISTILL,
    async (_e, req: DistillRequest): Promise<DistillResult> => {
      if (!req || typeof req !== 'object') return { status: 'error', message: 'invalid request' };
      reqString(req.agent, 'agent');
      reqString(req.id, 'id');
      reqString(req.cwd, 'cwd');
      const transcript = await sessions.read(req.agent, req.id, req.cwd);
      if (!transcript) return { status: 'error', message: 'Session transcript not found' };
      // Scope to a single Rune branch path when a node is requested.
      const scoped =
        req.nodeId && transcript.tree
          ? { ...transcript, messages: pathMessagesToNode(transcript.tree, req.nodeId) }
          : transcript;
      return distillLearning(scoped);
    }
  );
  ipcMain.handle(IPC_CHANNELS.LEARNINGS_SIMILAR, (_e, text: string, limit?: number): Learning[] =>
    store.findSimilar(reqString(text, 'text'), limit)
  );
  ipcMain.handle(IPC_CHANNELS.LEARNINGS_TAGS, (): TagCount[] => store.allTags());
  ipcMain.handle(IPC_CHANNELS.LEARNINGS_EXPORT, async (e, id: string): Promise<void> => {
    const learning = store.get(reqString(id, 'id'));
    if (!learning) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const defaultPath = `${dateStamp(learning.createdAt)}-${slugifyTitle(learning.title)}.md`;
    const res = await dialog.showSaveDialog(win, { defaultPath });
    if (res.canceled || !res.filePath) return;
    writeFileSync(res.filePath, learningToMarkdown(learning), 'utf8');
  });
}
