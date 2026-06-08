import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger';
import type { RuneStatus, RuneInstallResult } from '../shared/rune';
import { RUNE_INSTALL_COMMAND } from '../shared/rune';

const execFileAsync = promisify(execFile);
const log = createLogger('rune-manager');

const VERSION_TIMEOUT_MS = 5000;
/** The install script downloads a release binary, so give it room over a slow connection. */
const INSTALL_TIMEOUT_MS = 120_000;
/**
 * Where the button installs rune. install.sh honors RUNE_INSTALL_DIR; left to its own devices it
 * prefers /usr/local/bin when writable, which isn't on a Homebrew-on-arm64 user's PATH — the binary
 * lands but `rune` is "command not found". ~/.fleet/bin is the one directory Fleet guarantees is on
 * PATH (index.ts prepends it; install-fleet-cli.ts adds it to shell profiles), so installing here
 * keeps the version probe, the Kanban dispatcher's spawn, and the user's terminal in agreement.
 */
const RUNE_INSTALL_DIR = join(homedir(), '.fleet', 'bin');

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

  /**
   * Install (or update) Rune by running the same `curl … | sh` one-liner we show the user. Install
   * and update are one operation — re-running install.sh replaces the binary in place. Returns the
   * version from before the run alongside a fresh probe so the renderer can report install vs.
   * update and whether the version changed. Throws (with the script's stderr) if the script fails.
   */
  async installOrUpdate(): Promise<RuneInstallResult> {
    const before = await this.getVersion();
    const previousVersion = before.installed ? before.version : null;

    try {
      // The command is a pipe (`curl … | sh`), so it needs a shell — execFile alone won't run it.
      // RUNE_INSTALL_DIR pins the target to a dir Fleet keeps on PATH (see the constant above).
      await execFileAsync('sh', ['-c', RUNE_INSTALL_COMMAND], {
        timeout: INSTALL_TIMEOUT_MS,
        env: { ...process.env, RUNE_INSTALL_DIR }
      });
    } catch (err) {
      const stderr =
        err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim() : '';
      const message = stderr || (err instanceof Error ? err.message : String(err));
      log.warn('rune install script failed', { error: message });
      throw new Error(`Rune install failed: ${message}`);
    }

    const status = await this.getVersion();
    log.info('rune install/update complete', {
      previousVersion,
      installed: status.installed,
      version: status.installed ? status.version : null
    });
    return { previousVersion, status };
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
