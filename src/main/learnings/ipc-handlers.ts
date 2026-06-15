// src/main/learnings/ipc-handlers.ts
import { ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { writeFileSync } from 'fs';
import { createLogger } from '../logger';
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

const log = createLogger('learnings-ipc');

/**
 * An error whose message is safe to surface to the renderer (input validation).
 * Anything else thrown from a handler is logged in main and replaced with a
 * generic message, so SQLite column names / DB & fs paths don't leak out.
 */
class IpcError extends Error {}

/**
 * Register an invoke handler that (a) removes any prior handler first so an
 * electron-vite hot re-eval of index.ts doesn't throw "second handler for X", and
 * (b) sanitizes thrown errors: validation (IpcError) passes through; everything
 * else is logged in main and surfaced as a generic message.
 */
function handle<Args extends unknown[], R>(
  channel: string,
  fn: (e: IpcMainInvokeEvent, ...args: Args) => R | Promise<R>
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (e, ...args): Promise<R> => {
    try {
      return await fn(e, ...(args as Args));
    } catch (err) {
      if (err instanceof IpcError) throw err;
      log.error('learnings IPC handler failed', {
        channel,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err)
      });
      throw new Error('The learnings operation failed. See the app logs for details.');
    }
  });
}

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
    throw new IpcError(`${name} is required`);
  }
  return value;
}

function validateCreateInput(input: CreateLearningInput): CreateLearningInput {
  if (!input || typeof input !== 'object') throw new IpcError('learning input is required');
  reqString(input.title, 'title');
  if (typeof input.body !== 'string') throw new IpcError('body must be a string');
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new IpcError('tags must be an array');
  }
  return input;
}

export function registerLearningsIpcHandlers(
  store: LearningsStore,
  sessions: SessionsService
): void {
  handle(IPC_CHANNELS.LEARNINGS_SEARCH, (_e, filter?: LearningSearchFilter): Learning[] =>
    store.search(filter ?? {})
  );
  handle(IPC_CHANNELS.LEARNINGS_GET, (_e, id: string): Learning | null =>
    store.get(reqString(id, 'id'))
  );
  handle(
    IPC_CHANNELS.LEARNINGS_CREATE,
    (_e, input: CreateLearningInput): Learning => store.create(validateCreateInput(input))
  );
  handle(
    IPC_CHANNELS.LEARNINGS_UPDATE,
    (_e, id: string, fields: UpdateLearningInput): Learning | null => {
      reqString(id, 'id');
      if (!fields || typeof fields !== 'object') throw new IpcError('update fields are required');
      return store.update(id, fields);
    }
  );
  handle(IPC_CHANNELS.LEARNINGS_DELETE, (_e, id: string): void =>
    store.delete(reqString(id, 'id'))
  );
  handle(
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
  handle(IPC_CHANNELS.LEARNINGS_SIMILAR, (_e, text: string, limit?: number): Learning[] =>
    store.findSimilar(reqString(text, 'text'), limit)
  );
  handle(IPC_CHANNELS.LEARNINGS_TAGS, (): TagCount[] => store.allTags());
  handle(IPC_CHANNELS.LEARNINGS_EXPORT, async (e, id: string): Promise<void> => {
    const learning = store.get(reqString(id, 'id'));
    if (!learning) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const defaultPath = `${dateStamp(learning.createdAt)}-${slugifyTitle(learning.title)}.md`;
    // showOverwriteConfirmation is implicit on macOS/Windows but must be requested
    // explicitly on Linux/GTK, else an existing file (e.g. ~/.bashrc) is clobbered
    // silently.
    const res = await dialog.showSaveDialog(win, {
      defaultPath,
      properties: ['showOverwriteConfirmation', 'createDirectory']
    });
    if (res.canceled || !res.filePath) return;
    writeFileSync(res.filePath, learningToMarkdown(learning), 'utf8');
  });
}
