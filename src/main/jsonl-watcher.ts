import {
  watch, watchFile, unwatchFile, FSWatcher,
  openSync, readSync, closeSync,
  existsSync, readdirSync, statSync,
} from 'fs';
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

type WatchedFile = {
  filePath: string;
  offset: number;
  lineBuffer: string;
};

const POLL_INTERVAL_MS = 1000;
const SCAN_INTERVAL_MS = 1000;

export class JsonlWatcher {
  private dirWatchers: FSWatcher[] = [];
  private parentWatcher: FSWatcher | null = null;
  private callbacks: RecordCallback[] = [];
  private watchedFiles = new Map<string, WatchedFile>();
  private watchedDirs = new Set<string>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private existingAtStart = new Set<string>();

  constructor(private watchDir: string) {}

  onRecord(callback: RecordCallback): void {
    this.callbacks.push(callback);
  }

  start(): void {
    if (!existsSync(this.watchDir)) return;

    // Initial scan of all subdirectories (mark files as pre-existing)
    this.scanSubdirs(true);

    // Watch parent for new project subdirectories
    try {
      this.parentWatcher = watch(this.watchDir, { persistent: false }, () => {
        this.scanSubdirs();
      });
    } catch {}

    // Periodic scan as fallback (fs.watch is unreliable on macOS)
    this.scanTimer = setInterval(() => {
      this.scanSubdirs();
      // Poll all watched files for changes
      for (const watched of this.watchedFiles.values()) {
        this.readNewLines(watched);
      }
    }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    this.parentWatcher?.close();
    this.parentWatcher = null;
    for (const w of this.dirWatchers) {
      w.close();
    }
    this.dirWatchers = [];
    // Unwatch all files
    for (const watched of this.watchedFiles.values()) {
      try { unwatchFile(watched.filePath); } catch {}
    }
    this.watchedFiles.clear();
    this.watchedDirs.clear();
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private scanSubdirs(isInitialScan = false): void {
    try {
      const entries = readdirSync(this.watchDir);
      for (const entry of entries) {
        const subDir = join(this.watchDir, entry);
        try {
          if (!this.watchedDirs.has(subDir) && statSync(subDir).isDirectory()) {
            this.watchDir_sub(subDir, isInitialScan);
          }
          // Scan for new JSONL files in existing subdirs too
          if (this.watchedDirs.has(subDir)) {
            this.scanJsonlFiles(subDir);
          }
        } catch {}
      }
    } catch {}
  }

  private watchDir_sub(subDir: string, isInitialScan = false): void {
    this.watchedDirs.add(subDir);

    // Scan existing files — mark as pre-existing during initial scan
    this.scanJsonlFiles(subDir, isInitialScan);

    // fs.watch on the subdir (event-driven, but unreliable on macOS)
    try {
      const watcher = watch(subDir, { persistent: false }, (_eventType, filename) => {
        if (!filename || extname(filename) !== '.jsonl') return;
        const filePath = join(subDir, filename);
        this.ensureFileWatched(filePath);
        const watched = this.watchedFiles.get(filePath);
        if (watched) this.readNewLines(watched);
      });
      this.dirWatchers.push(watcher);
    } catch {}
  }

  private scanJsonlFiles(dir: string, markExisting = false): void {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (extname(file) === '.jsonl') {
          const filePath = join(dir, file);
          if (markExisting) this.existingAtStart.add(filePath);
          this.ensureFileWatched(filePath);
        }
      }
    } catch {}
  }

  private ensureFileWatched(filePath: string): void {
    if (this.watchedFiles.has(filePath)) return;

    try {
      const stat = statSync(filePath);
      // Files that existed at startup: skip to end (no ghost agents).
      // Files created after startup: read from beginning (new sessions).
      const isNew = !this.existingAtStart.has(filePath);
      const watched: WatchedFile = {
        filePath,
        offset: isNew ? 0 : stat.size,
        lineBuffer: '',
      };
      this.watchedFiles.set(filePath, watched);

      // fs.watchFile (stat-based polling, more reliable on macOS than fs.watch)
      watchFile(filePath, { interval: POLL_INTERVAL_MS }, () => {
        this.readNewLines(watched);
      });
    } catch {}
  }

  private readNewLines(watched: WatchedFile): void {
    try {
      const stat = statSync(watched.filePath);
      if (stat.size <= watched.offset) return; // No new data

      // Read only new bytes since last read
      const bytesToRead = stat.size - watched.offset;
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(watched.filePath, 'r');
      readSync(fd, buf, 0, bytesToRead, watched.offset);
      closeSync(fd);
      watched.offset = stat.size;

      // Buffer partial lines
      const text = watched.lineBuffer + buf.toString('utf-8');
      const lines = text.split('\n');
      watched.lineBuffer = lines.pop() || ''; // Keep incomplete line

      const sessionId = basename(watched.filePath, '.jsonl');

      for (const line of lines) {
        if (!line.trim()) continue;
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
