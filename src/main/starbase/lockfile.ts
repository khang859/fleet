import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

type LockData = {
  pid: number;
  timestamp: string;
};

type AcquireResult = 'acquired' | 'read-only';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export class Lockfile {
  private lockPath: string;
  private acquired = false;

  constructor(basePath: string, starbaseId: string) {
    this.lockPath = join(basePath, `starbase-${starbaseId}.lock`);
  }

  acquire(): AcquireResult {
    if (existsSync(this.lockPath)) {
      try {
        const data: LockData = JSON.parse(readFileSync(this.lockPath, 'utf-8'));
        const lockAge = Date.now() - new Date(data.timestamp).getTime();

        // Stale if older than 24 hours (guards against PID reuse)
        if (lockAge < STALE_THRESHOLD_MS && this.isPidAlive(data.pid)) {
          // Another live instance holds the lock
          return 'read-only';
        }
        // Dead PID or stale lock — overwrite
      } catch {
        // Corrupt lock file — overwrite
      }
    }

    this.writeLock();
    this.acquired = true;
    return 'acquired';
  }

  release(): void {
    if (!this.acquired) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Lock file already removed
    }
    this.acquired = false;
  }

  private writeLock(): void {
    const data: LockData = {
      pid: process.pid,
      timestamp: new Date().toISOString()
    };
    writeFileSync(this.lockPath, JSON.stringify(data));
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
