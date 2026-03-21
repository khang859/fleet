import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync } from 'fs';
import { open, stat } from 'fs/promises';
import { basename, extname } from 'path';

export type JsonlRecord = {
  type: string;
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      input?: unknown;
    }>;
  };
  data?: {
    type?: string;
    parentToolUseID?: string;
  };
  [key: string]: unknown;
};

function isJsonlRecord(v: unknown): v is JsonlRecord {
  if (v == null || typeof v !== 'object') return false;
  return 'type' in v && typeof v.type === 'string';
}

type RecordCallback = (sessionId: string, record: JsonlRecord) => void;

type WatchedFile = {
  filePath: string;
  offset: number;
  lineBuffer: string;
};

export class JsonlWatcher {
  private watcher: FSWatcher | null = null;
  private callbacks: RecordCallback[] = [];
  private watchedFiles = new Map<string, WatchedFile>();
  private queuedReads = new Set<string>();
  private pendingReads = new Set<string>();
  private isReady = false;

  constructor(private watchDir: string) {}

  onRecord(callback: RecordCallback): void {
    this.callbacks.push(callback);
  }

  start(): void {
    if (!existsSync(this.watchDir)) return;
    this.isReady = false;

    this.watcher = chokidar.watch(this.watchDir, {
      persistent: false,
      depth: 1,
      ignoreInitial: false,
      ignored: (_path, stats) => stats?.isFile() === true && extname(_path) !== '.jsonl',
      awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 }
    });

    this.watcher.on('add', (filePath: string) => {
      void this.handleAdd(filePath);
    });

    this.watcher.on('change', (filePath: string) => {
      if (extname(filePath) !== '.jsonl') return;
      if (!this.watchedFiles.has(filePath)) {
        this.watchedFiles.set(filePath, { filePath, offset: 0, lineBuffer: '' });
      }
      this.scheduleRead(filePath);
    });

    this.watcher.on('unlink', (filePath: string) => {
      this.watchedFiles.delete(filePath);
    });

    this.watcher.on('ready', () => {
      this.isReady = true;
    });
  }

  stop(): void {
    void this.watcher?.close();
    this.watcher = null;
    this.isReady = false;
    this.watchedFiles.clear();
    this.queuedReads.clear();
    this.pendingReads.clear();
  }

  private async handleAdd(filePath: string): Promise<void> {
    if (extname(filePath) !== '.jsonl') return;
    const isReadyAtEvent = this.isReady;

    try {
      const fileStat = await stat(filePath);
      if (!isReadyAtEvent) {
        this.watchedFiles.set(filePath, {
          filePath,
          offset: fileStat.size,
          lineBuffer: ''
        });
        return;
      }

      const watched = this.watchedFiles.get(filePath) ?? {
        filePath,
        offset: 0,
        lineBuffer: ''
      };
      this.watchedFiles.set(filePath, watched);

      if (fileStat.size > 0) {
        this.scheduleRead(filePath);
      }
    } catch {
      // Ignore files that disappear before the stat/read path completes.
    }
  }

  private scheduleRead(filePath: string): void {
    if (this.pendingReads.has(filePath)) {
      this.queuedReads.add(filePath);
      return;
    }
    this.pendingReads.add(filePath);
    void this.readNewLines(filePath).finally(() => {
      this.pendingReads.delete(filePath);
      if (this.queuedReads.delete(filePath) && this.watchedFiles.has(filePath)) {
        this.scheduleRead(filePath);
      }
    });
  }

  private async readNewLines(filePath: string): Promise<void> {
    const watched = this.watchedFiles.get(filePath);
    if (!watched) return;

    try {
      const fileStat = await stat(watched.filePath);
      if (fileStat.size < watched.offset) {
        watched.offset = 0;
        watched.lineBuffer = '';
      }
      if (fileStat.size <= watched.offset) return;

      const bytesToRead = fileStat.size - watched.offset;
      const buf = Buffer.alloc(bytesToRead);
      const fileHandle = await open(watched.filePath, 'r');
      try {
        await fileHandle.read(buf, 0, bytesToRead, watched.offset);
      } finally {
        await fileHandle.close();
      }
      watched.offset = fileStat.size;

      const text = watched.lineBuffer + buf.toString('utf-8');
      const lines = text.split('\n');
      watched.lineBuffer = lines.pop() || '';

      const sessionId = basename(watched.filePath, '.jsonl');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isJsonlRecord(parsed)) continue;
          const record = parsed;
          for (const cb of this.callbacks) {
            cb(sessionId, record);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // intentional
    }
  }
}
