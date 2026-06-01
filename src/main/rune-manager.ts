import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger';
import type { RuneStatus } from '../shared/rune';

const execFileAsync = promisify(execFile);
const log = createLogger('rune-manager');

const VERSION_TIMEOUT_MS = 5000;

/**
 * Probes for the user-installed `rune` binary on PATH. Rune is a critical dependency for the
 * Kanban dispatcher (every worker/orchestrator run is `spawn('rune', …)`), but Fleet does not
 * manage its install — it lives on the user's PATH. This manager answers "is rune available?"
 * for the Settings status row, the Kanban pre-flight banner, and the dispatcher's spawn guard.
 *
 * `getVersion()` runs `rune --version` and caches the outcome. `isInstalledCached()` returns
 * that cache synchronously so the spawn guard can fail fast with a clear reason instead of
 * letting the worker die and surface as a cryptic "pid not alive" reclaim.
 */
export class RuneManager {
  /** null = never probed; true/false = last known result. */
  private cached: boolean | null = null;

  constructor() {
    // Warm the cache so the spawn guard has an answer before the user opens Settings.
    void this.getVersion();
  }

  async getVersion(): Promise<RuneStatus> {
    try {
      const { stdout } = await execFileAsync('rune', ['--version'], {
        timeout: VERSION_TIMEOUT_MS
      });
      this.cached = true;
      return { installed: true, version: parseVersion(stdout) };
    } catch (err) {
      this.cached = false;
      log.info('rune --version failed; treating as not installed', {
        error: err instanceof Error ? err.message : String(err)
      });
      return { installed: false };
    }
  }

  /** Synchronous best-effort: null when never probed, else the last known install state. */
  isInstalledCached(): boolean | null {
    return this.cached;
  }

  /** Called from the async spawn error handler when ENOENT proves rune vanished from PATH. */
  markMissing(): void {
    this.cached = false;
  }
}

/** Extract a version token from `rune --version` output, falling back to the trimmed line. */
function parseVersion(stdout: string): string {
  const trimmed = stdout.trim();
  const match = trimmed.match(/\d+\.\d+\.\d+\S*/);
  return match ? match[0] : trimmed || 'unknown';
}
