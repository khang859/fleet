import { watch, FSWatcher, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';

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

type RecordCallback = (sessionId: string, record: JsonlRecord) => void;

export class JsonlWatcher {
  private watcher: FSWatcher | null = null;
  private callbacks: RecordCallback[] = [];
  private fileOffsets = new Map<string, number>();

  constructor(private watchDir: string) {}

  onRecord(callback: RecordCallback): void {
    this.callbacks.push(callback);
  }

  start(): void {
    if (!existsSync(this.watchDir)) return;

    // Read existing files
    this.scanExistingFiles();

    // Watch for changes
    this.watcher = watch(this.watchDir, { persistent: false }, (eventType, filename) => {
      if (!filename || extname(filename) !== '.jsonl') return;
      this.processFile(join(this.watchDir, filename));
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private scanExistingFiles(): void {
    try {
      const files = readdirSync(this.watchDir);
      for (const file of files) {
        if (extname(file) === '.jsonl') {
          const filePath = join(this.watchDir, file);
          // Set offset to end of file — only process new records
          const stat = statSync(filePath);
          this.fileOffsets.set(filePath, stat.size);
        }
      }
    } catch {}
  }

  private processFile(filePath: string): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const offset = this.fileOffsets.get(filePath) ?? 0;
      const newContent = content.slice(offset);
      this.fileOffsets.set(filePath, content.length);

      if (!newContent.trim()) return;

      const sessionId = basename(filePath, '.jsonl');
      const lines = newContent.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as JsonlRecord;
          for (const cb of this.callbacks) {
            cb(sessionId, record);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {}
  }
}
