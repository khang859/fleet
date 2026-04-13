import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger';
import { app } from 'electron';

const execFileAsync = promisify(execFile);
const log = createLogger('pi-agent-manager');

const PI_INSTALL_DIR = join(homedir(), '.fleet', 'agents', 'pi');
const PI_PACKAGE = '@mariozechner/pi-coding-agent';
const VERSION_FILE = join(PI_INSTALL_DIR, '.fleet-version');

export class PiAgentManager {
  private installedVersion: string | null = null;
  private installPromise: Promise<void> | null = null;

  constructor() {
    this.loadVersion();
  }

  private loadVersion(): void {
    try {
      if (existsSync(VERSION_FILE)) {
        this.installedVersion = readFileSync(VERSION_FILE, 'utf-8').trim();
      }
    } catch {
      this.installedVersion = null;
    }
  }

  private refreshVersion(): string | null {
    try {
      const scopedPkg = join(
        PI_INSTALL_DIR,
        'node_modules',
        '@mariozechner',
        'pi-coding-agent',
        'package.json'
      );
      const parsed: unknown = JSON.parse(readFileSync(scopedPkg, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
        throw new Error('pi-coding-agent package.json missing version field');
      }
      const version = parsed.version;
      if (typeof version !== 'string') {
        throw new Error('pi-coding-agent version is not a string');
      }
      this.installedVersion = version;
      writeFileSync(VERSION_FILE, version);
      return version;
    } catch (err) {
      log.warn('Could not read pi agent version', {
        error: err instanceof Error ? err.message : String(err)
      });
      return this.installedVersion;
    }
  }

  isInstalled(): boolean {
    return this.installedVersion !== null && existsSync(this.getBinPath());
  }

  getVersion(): string | null {
    return this.installedVersion;
  }

  getBinPath(): string {
    return join(PI_INSTALL_DIR, 'node_modules', '.bin', 'pi');
  }

  getExtensionsDir(): string {
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'pi-extensions')
      : join(app.getAppPath(), 'resources', 'pi-extensions');
    return resourcesPath;
  }

  getExtensionPaths(): string[] {
    const dir = this.getExtensionsDir();
    const extensions = ['fleet-bridge.ts', 'fleet-files.ts', 'fleet-terminal.ts'];
    return extensions.map((e) => join(dir, e));
  }

  buildLaunchCommand(bridgePort: number, bridgeToken: string, paneId: string): string {
    const extensionPaths = this.getExtensionPaths();
    const parts: string[] = [];

    parts.push(`FLEET_BRIDGE_PORT=${bridgePort}`);
    parts.push(`FLEET_BRIDGE_TOKEN=${bridgeToken}`);
    parts.push(`FLEET_PANE_ID=${paneId}`);

    parts.push(this.quoteArg(this.getBinPath()));

    for (const ext of extensionPaths) {
      parts.push('-e', this.quoteArg(ext));
    }

    return parts.join(' ');
  }

  private quoteArg(arg: string): string {
    return arg.includes(' ') ? `"${arg}"` : arg;
  }

  async ensureInstalled(): Promise<void> {
    if (this.isInstalled()) return;

    if (this.installPromise) return this.installPromise;

    this.installPromise = this.install();
    try {
      await this.installPromise;
    } finally {
      this.installPromise = null;
    }
  }

  private async install(): Promise<void> {
    log.info('Installing pi-coding-agent', { dir: PI_INSTALL_DIR });

    if (!existsSync(PI_INSTALL_DIR)) {
      mkdirSync(PI_INSTALL_DIR, { recursive: true });
    }

    const pkgJsonPath = join(PI_INSTALL_DIR, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(
        pkgJsonPath,
        JSON.stringify({ name: 'fleet-pi-agent', private: true }, null, 2)
      );
    }

    const { stdout } = await execFileAsync(
      'npm',
      ['install', PI_PACKAGE, '--prefix', PI_INSTALL_DIR],
      {
        timeout: 120_000
      }
    );
    log.info('Pi agent installed', { output: stdout.slice(0, 200) });

    this.refreshVersion();
    log.info('Pi agent version', { version: this.installedVersion });
  }

  async checkForUpdates(): Promise<PiUpdateResult> {
    if (!this.isInstalled()) {
      return { previousVersion: null, currentVersion: null, updated: false, installed: false };
    }

    const previousVersion = this.installedVersion;
    try {
      log.info('Checking for pi-coding-agent updates');
      await execFileAsync('npm', ['install', `${PI_PACKAGE}@latest`, '--prefix', PI_INSTALL_DIR], {
        timeout: 120_000
      });
      const currentVersion = this.refreshVersion();
      const updated = currentVersion !== null && currentVersion !== previousVersion;
      log.info('Pi agent update check complete', {
        previousVersion,
        currentVersion,
        updated
      });
      return { previousVersion, currentVersion, updated, installed: true };
    } catch (err) {
      log.warn('Pi agent update check failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }
}

export interface PiUpdateResult {
  previousVersion: string | null;
  currentVersion: string | null;
  updated: boolean;
  installed: boolean;
}
