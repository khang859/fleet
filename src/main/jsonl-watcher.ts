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
  private watchers: FSWatcher[] = [];
  private callbacks: RecordCallback[] = [];
  private fileOffsets = new Map<string, number>();
  private parentWatcher: FSWatcher | null = null;

  constructor(private watchDir: string) {}

  onRecord(callback: RecordCallback): void {
    this.callbacks.push(callback);
  }

  start(): void {
    if (!existsSync(this.watchDir)) return;

    // Watch each existing project subdirectory
    this.scanAndWatchSubdirs();

    // Watch the parent directory for new project subdirectories
    this.parentWatcher = watch(this.watchDir, { persistent: false }, (eventType, filename) => {
      if (!filename) return;
      const subDir = join(this.watchDir, filename);
      try {
        if (existsSync(subDir) && statSync(subDir).isDirectory()) {
          this.watchSubdir(subDir);
        }
      } catch {}
    });
  }

  stop(): void {
    this.parentWatcher?.close();
    this.parentWatcher = null;
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
  }

  private scanAndWatchSubdirs(): void {
    try {
      const entries = readdirSync(this.watchDir);
      for (const entry of entries) {
        const subDir = join(this.watchDir, entry);
        try {
          if (statSync(subDir).isDirectory()) {
            // Scan existing JSONL files to set offsets (skip existing content)
            this.scanExistingFiles(subDir);
            this.watchSubdir(subDir);
          }
        } catch {}
      }
    } catch {}
  }

  private watchSubdir(subDir: string): void {
    try {
      const watcher = watch(subDir, { persistent: false }, (eventType, filename) => {
        if (!filename || extname(filename) !== '.jsonl') return;
        this.processFile(join(subDir, filename));
      });
      this.watchers.push(watcher);
    } catch {}
  }

  private scanExistingFiles(dir: string): void {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (extname(file) === '.jsonl') {
          const filePath = join(dir, file);
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
