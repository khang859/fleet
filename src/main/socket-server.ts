import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ImageService } from './image-service';
import type { AnnotateService } from './annotate-service';
import type { ImageProviderSettings } from '../shared/types';
import type { KanbanCommands } from './kanban/kanban-commands';
import type { TaskStatus, CreateTaskInput } from '../shared/kanban-types';
import { CodedError } from './errors';

type Request = {
  id?: string;
  command: string;
  args?: Record<string, unknown>;
};

function isRequest(v: unknown): v is Request {
  return (
    v != null &&
    typeof v === 'object' &&
    'command' in v &&
    typeof (v as { command?: unknown }).command === 'string'
  );
}

type SuccessResponse = {
  id?: string;
  ok: true;
  data: unknown;
};

type ErrorResponse = {
  id?: string;
  ok: false;
  error: string;
  code?: string;
};

type Response = SuccessResponse | ErrorResponse;

/**
 * SocketServer — Unix socket server for Fleet CLI command dispatch.
 *
 * Listens on a given socket path, accepts newline-delimited JSON requests,
 * routes commands to service methods, and returns JSON responses.
 * Emits 'state-change' events for mutating commands.
 */
export class SocketServer extends EventEmitter {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private kanbanSubscribers = new Set<Socket>();
  private startTime: number | null = null;

  constructor(
    private socketPath: string,
    private imageService?: ImageService,
    private annotateService?: AnnotateService,
    private getKanban?: () => KanbanCommands | undefined
  ) {
    super();
  }

  async start(): Promise<void> {
    // Ensure parent directory exists
    mkdirSync(dirname(this.socketPath), { recursive: true });

    // Clean up stale socket file
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Ignore — file may not exist
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket);
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            void this.handleLine(socket, line);
          }
        });

        socket.on('close', () => {
          this.clients.delete(socket);
          this.kanbanSubscribers.delete(socket);
        });

        socket.on('error', () => {
          this.clients.delete(socket);
          this.kanbanSubscribers.delete(socket);
        });
      });

      this.server.on('close', () => {
        this.emit('server-close');
      });

      // Use once for startup error — detaches after first fire so it doesn't linger
      this.server.once('error', reject);

      this.server.listen(this.socketPath, () => {
        // Remove startup error handler and attach permanent one for post-startup errors
        this.server?.off('error', reject);
        this.server?.on('error', (err) => {
          this.emit('server-error', err);
        });
        this.startTime = Date.now();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.kanbanSubscribers.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            unlinkSync(this.socketPath);
          } catch {
            // Ignore — file may already be gone
          }
          resolve();
        });
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let req: Request;

    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRequest(parsed)) {
        this.sendResponse(socket, { ok: false, error: 'Invalid request' });
        return;
      }
      req = parsed;
    } catch {
      this.sendResponse(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    // kanban.watch is a streaming subscription, not a one-shot command.
    // Keep the socket open and forward future events via broadcastKanbanEvent.
    if (req.command === 'kanban.watch') {
      if (!this.getKanban?.()) {
        this.sendResponse(socket, {
          id: req.id,
          ok: false,
          error: 'Kanban not available',
          code: 'UNAVAILABLE'
        });
        return;
      }
      this.kanbanSubscribers.add(socket);
      this.sendResponse(socket, { id: req.id, ok: true, data: { watching: true } });
      return;
    }

    try {
      const data = await this.dispatch(req.command, req.args ?? {});
      this.sendResponse(socket, { id: req.id, ok: true, data });
    } catch (err) {
      const coded =
        err instanceof CodedError
          ? err
          : err instanceof Error
            ? new CodedError(err.message, 'UNKNOWN')
            : new CodedError(String(err), 'UNKNOWN');
      this.sendResponse(socket, { id: req.id, ok: false, error: coded.message, code: coded.code });
    }
  }

  private sendResponse(socket: Socket, response: Response): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + '\n');
    }
  }

  broadcastKanbanEvent(event: unknown): void {
    const line = JSON.stringify({ kanbanEvent: event }) + '\n';
    for (const socket of this.kanbanSubscribers) {
      if (!socket.destroyed) {
        socket.write(line);
      }
    }
  }

  private requireKanban(): KanbanCommands {
    const k = this.getKanban?.();
    if (!k) throw new CodedError('Kanban not available', 'UNAVAILABLE');
    return k;
  }

  private async dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'ping':
        return { pong: true, uptime: this.startTime ? (Date.now() - this.startTime) / 1000 : 0 };

      // ── File Open ──────────────────────────────────────────────────────────────
      case 'file.open': {
        if (!Array.isArray(args.files) || args.files.length === 0) {
          throw new CodedError('file.open requires a non-empty files array', 'BAD_REQUEST');
        }
        const files = args.files.filter(
          (f): f is Record<string, unknown> => f != null && typeof f === 'object'
        );
        const payload = {
          files: files.map((f) => {
            const filePath = typeof f.path === 'string' ? f.path : '';
            const paneType: 'file' | 'image' | 'markdown' =
              f.paneType === 'image' ? 'image' : f.paneType === 'markdown' ? 'markdown' : 'file';
            return {
              path: filePath,
              paneType,
              label: filePath.split('/').pop() ?? filePath
            };
          })
        };
        this.emit('file-open', payload);
        return { fileCount: files.length };
      }

      // ── Images ──────────────────────────────────────────────────────────────
      case 'image.generate': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
        if (!prompt) throw new CodedError('image.generate requires a prompt', 'BAD_REQUEST');
        const result = this.imageService.generate({
          prompt,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          aspectRatio:
            typeof args.aspectRatio === 'string'
              ? args.aspectRatio
              : typeof args['aspect-ratio'] === 'string'
                ? String(args['aspect-ratio'])
                : undefined,
          outputFormat: typeof args.format === 'string' ? args.format : undefined,
          numImages: typeof args['num-images'] === 'string' ? Number(args['num-images']) : undefined
        });
        this.emit('state-change', 'image:changed', { id: result.id });
        return result;
      }

      case 'image.edit': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const editPrompt = typeof args.prompt === 'string' ? args.prompt : undefined;
        if (!editPrompt) throw new CodedError('image.edit requires a prompt', 'BAD_REQUEST');
        const rawImages = args.images;
        const images = Array.isArray(rawImages)
          ? rawImages.filter((x): x is string => typeof x === 'string')
          : typeof rawImages === 'string'
            ? [rawImages]
            : [];
        if (images.length === 0)
          throw new CodedError('image.edit requires --images', 'BAD_REQUEST');
        const editResult = this.imageService.edit({
          prompt: editPrompt,
          images,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          aspectRatio:
            typeof args.aspectRatio === 'string'
              ? args.aspectRatio
              : typeof args['aspect-ratio'] === 'string'
                ? String(args['aspect-ratio'])
                : undefined,
          outputFormat: typeof args.format === 'string' ? args.format : undefined,
          numImages: typeof args['num-images'] === 'string' ? Number(args['num-images']) : undefined
        });
        this.emit('state-change', 'image:changed', { id: editResult.id });
        return editResult;
      }

      case 'image.status': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const statusId = typeof args.id === 'string' ? args.id : undefined;
        if (!statusId) throw new CodedError('image.status requires an id', 'BAD_REQUEST');
        const meta = this.imageService.getStatus(statusId);
        if (!meta) throw new CodedError(`Generation not found: ${statusId}`, 'NOT_FOUND');
        return meta;
      }

      case 'image.list': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        return this.imageService.list();
      }

      case 'image.retry': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const retryId = typeof args.id === 'string' ? args.id : undefined;
        if (!retryId) throw new CodedError('image.retry requires an id', 'BAD_REQUEST');
        const retryResult = this.imageService.retry(retryId);
        this.emit('state-change', 'image:changed', { id: retryResult.id });
        return retryResult;
      }

      case 'image.delete': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const deleteId = typeof args.id === 'string' ? args.id : undefined;
        if (!deleteId) throw new CodedError('image.delete requires an id', 'BAD_REQUEST');
        this.imageService.delete(deleteId);
        this.emit('state-change', 'image:changed', { id: deleteId });
        return { deleted: true };
      }

      case 'image.config.get': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const settings = this.imageService.getSettings();
        const redacted = { ...settings, providers: { ...settings.providers } };
        for (const [key, val] of Object.entries(redacted.providers)) {
          redacted.providers[key] = {
            ...val,
            apiKey: val.apiKey ? `${val.apiKey.slice(0, 4)}***` : ''
          };
        }
        return redacted;
      }

      case 'image.config.set': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const providerId = typeof args.provider === 'string' ? args.provider : undefined;
        const providerKey = providerId ?? this.imageService.getSettings().defaultProvider;
        const providerUpdate: Partial<ImageProviderSettings> = {};
        if (typeof args['api-key'] === 'string') providerUpdate.apiKey = args['api-key'];
        if (typeof args['default-model'] === 'string')
          providerUpdate.defaultModel = args['default-model'];
        if (typeof args['default-resolution'] === 'string')
          providerUpdate.defaultResolution = args['default-resolution'];
        if (typeof args['default-output-format'] === 'string')
          providerUpdate.defaultOutputFormat = args['default-output-format'];
        if (typeof args['default-aspect-ratio'] === 'string')
          providerUpdate.defaultAspectRatio = args['default-aspect-ratio'];
        // Action-level model override: --action remove-background --model fal-ai/birefnet/v2
        if (typeof args.action === 'string' && typeof args.model === 'string') {
          const currentSettings = this.imageService.getSettings();
          const currentProvider = currentSettings.providers[providerKey];
          const existingActions = currentProvider.actions ?? {};
          providerUpdate.actions = {
            ...existingActions,
            [args.action]: { model: args.model }
          };
        }
        if (Object.keys(providerUpdate).length > 0) {
          this.imageService.updateSettings({ providers: { [providerKey]: providerUpdate } });
        }
        this.emit('state-change', 'image:changed', {});
        return { updated: true };
      }

      case 'image.action': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const actionType =
          typeof args.action === 'string'
            ? args.action
            : typeof args.id === 'string'
              ? args.id
              : undefined;
        if (!actionType)
          throw new CodedError('image.action requires an action type', 'BAD_REQUEST');
        const source = typeof args.source === 'string' ? args.source : undefined;
        if (!source) throw new CodedError('image.action requires a source image', 'BAD_REQUEST');
        const actionResult = this.imageService.runAction({
          actionType,
          source,
          provider: typeof args.provider === 'string' ? args.provider : undefined
        });
        this.emit('state-change', 'image:changed', { id: actionResult.id });
        return actionResult;
      }

      case 'image.actions.list': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        return this.imageService.listActions(
          typeof args.provider === 'string' ? args.provider : undefined
        );
      }

      // ── Annotate ──────────────────────────────────────────────────────────────
      case 'annotate.start': {
        if (!this.annotateService)
          throw new CodedError('Annotate service not available', 'UNAVAILABLE');
        const url = typeof args.url === 'string' ? args.url : undefined;
        const timeout =
          typeof args.timeout === 'number'
            ? args.timeout
            : typeof args.timeout === 'string'
              ? Number(args.timeout)
              : undefined;
        const resultPath = await this.annotateService.start({ url, timeout });
        return { resultPath };
      }

      case 'pi.open': {
        const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
        if (!cwd) throw new CodedError('pi.open requires a cwd', 'BAD_REQUEST');
        this.emit('pi-open', { cwd });
        return { ok: true };
      }

      case 'pi.plan_open': {
        const planPath = typeof args.path === 'string' ? args.path : undefined;
        if (!planPath) throw new CodedError('pi.plan_open requires a path', 'BAD_REQUEST');
        this.emit('pi-plan-open', { path: planPath });
        return { ok: true };
      }

      // ── Kanban ──────────────────────────────────────────────────────────────
      case 'kanban.create': {
        const k = this.requireKanban();
        const title = typeof args.title === 'string' ? args.title : undefined;
        if (!title) throw new CodedError('kanban create requires --title', 'BAD_REQUEST');
        const input: CreateTaskInput = { title };
        if (typeof args.body === 'string') input.body = args.body;
        if (typeof args.assignee === 'string') input.assignee = args.assignee;
        if (typeof args.priority === 'string') {
          const p = Number(args.priority);
          if (!Number.isNaN(p)) input.priority = p;
        }
        const task = k.create(input);
        this.emit('state-change', 'kanban:changed', { id: task.id });
        return task;
      }
      case 'kanban.list': {
        const k = this.requireKanban();
        const status = typeof args.status === 'string' ? (args.status as TaskStatus) : undefined;
        return k.list(status ? { status } : {});
      }
      case 'kanban.show': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        if (!id) throw new CodedError('kanban show requires a task id', 'BAD_REQUEST');
        const detail = k.show(id);
        if (!detail) throw new CodedError(`task not found: ${id}`, 'NOT_FOUND');
        return detail;
      }
      case 'kanban.assign': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        const profile = typeof args.profile === 'string' ? args.profile : undefined;
        if (!id) throw new CodedError('kanban assign requires a task id', 'BAD_REQUEST');
        if (!profile) throw new CodedError('kanban assign requires --profile', 'BAD_REQUEST');
        k.assign(id, profile);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }
      case 'kanban.ready':
      case 'kanban.unblock':
      case 'kanban.archive': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        if (!id) throw new CodedError(`${command} requires a task id`, 'BAD_REQUEST');
        if (command === 'kanban.ready') k.ready(id);
        else if (command === 'kanban.unblock') k.unblock(id);
        else k.archive(id);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }
      case 'kanban.block': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        if (!id) throw new CodedError('kanban block requires a task id', 'BAD_REQUEST');
        if (!reason) throw new CodedError('kanban block requires --reason', 'BAD_REQUEST');
        k.block(id, reason);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }
      case 'kanban.complete': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        const result = typeof args.result === 'string' ? args.result : undefined;
        if (!id) throw new CodedError('kanban complete requires a task id', 'BAD_REQUEST');
        if (!result) throw new CodedError('kanban complete requires --result', 'BAD_REQUEST');
        k.complete(id, result);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }
      case 'kanban.comment': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        const body = typeof args.body === 'string' ? args.body : undefined;
        if (!id) throw new CodedError('kanban comment requires a task id', 'BAD_REQUEST');
        if (!body) throw new CodedError('kanban comment requires a comment body', 'BAD_REQUEST');
        const comment = k.comment(id, body);
        this.emit('state-change', 'kanban:changed', { id });
        return comment;
      }
      case 'kanban.link':
      case 'kanban.unlink': {
        const k = this.requireKanban();
        const parentId = typeof args.parentId === 'string' ? args.parentId : undefined;
        const childId = typeof args.childId === 'string' ? args.childId : undefined;
        if (!parentId || !childId) {
          throw new CodedError(`${command} requires parentId and childId`, 'BAD_REQUEST');
        }
        if (command === 'kanban.link') k.link(parentId, childId);
        else k.unlink(parentId, childId);
        this.emit('state-change', 'kanban:changed', { id: childId });
        return { ok: true };
      }
      case 'kanban.log': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        if (!id) throw new CodedError('kanban log requires a task id', 'BAD_REQUEST');
        return k.log(id);
      }
      case 'kanban.dispatch': {
        const k = this.requireKanban();
        k.dispatch();
        return { ok: true };
      }
      case 'kanban.decompose':
      case 'kanban.specify': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        if (!id)
          throw new CodedError(`kanban ${command.split('.')[1]} requires a task id`, 'BAD_REQUEST');
        if (command === 'kanban.decompose') k.requestDecompose(id);
        else k.requestSpecify(id);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }

      default: {
        throw new CodedError(`Unknown command: ${command}`, 'NOT_FOUND');
      }
    }
  }
}
