import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type { PtyCreateRequest, PtyDataPayload, PtyExitPayload } from '../shared/ipc-api';
import { toWindowsAccessiblePath } from '../shared/path-platform';
import type { EnvSource } from '../shared/shell-env-types';
import { isWslContext, type PathContext, type ShellProfile } from '../shared/shell-profiles';
import type { ActivityTracker } from './activity-tracker';
import type { CwdPoller } from './cwd-poller';
import type { EnvSyncManager } from './env-sync/env-sync-manager';
import type { EventBus } from './event-bus';
import { createLogger } from './logger';
import type { NotificationDetector } from './notification-detector';
import type { PtyCreateResult, PtyManager } from './pty-manager';
import type { PtyOscBridge } from './remote-ssh/pty-osc-bridge';
import type { SettingsStore } from './settings-store';
import { enrichProcessEnv } from './shell-env';
import type { ShellProfileRegistry } from './shell-profiles';

const log = createLogger('pane-opener');

export type PaneOpenerDeps = {
  ptyManager: PtyManager;
  settingsStore: SettingsStore;
  shellProfileRegistry: ShellProfileRegistry;
  envSyncManager: EnvSyncManager;
  activityTracker: ActivityTracker;
  notificationDetector: NotificationDetector;
  ptyOscBridge: PtyOscBridge;
  cwdPoller: CwdPoller;
  eventBus: EventBus;
  getWindow: () => BrowserWindow | null;
};

/** Make a path from a WSL pane's coordinate system readable by the win32 process. */
function resolveCtxPath(ctx: PathContext | undefined, path: string): string {
  return isWslContext(ctx) ? toWindowsAccessiblePath(path, ctx) : path;
}

/** A pane main opens with no screen yet, as a workflow run does. */
export type OpenPaneRequest = PtyCreateRequest & { retain?: boolean };

/** The one way to open a pane, for the renderer's request and for panes main starts itself. */
export class PaneOpener {
  constructor(private readonly deps: PaneOpenerDeps) {}

  async open(req: OpenPaneRequest): Promise<PtyCreateResult> {
    // A pane restored at launch is created before the login shell environment
    // has been merged into process.env. Wait for it, or the pane inherits
    // launchd's bare environment (no LANG, minimal PATH).
    await enrichProcessEnv();

    const { ptyManager, activityTracker } = this.deps;
    const profile = await this.profileFor(req);
    const { env, envSources } = await this.envFor(req, profile);

    const alreadyExisted = ptyManager.has(req.paneId);
    const result = ptyManager.create({ ...req, profile, env, envSources });

    // Skip re-registering listeners on idempotent path (HMR reloads) to prevent
    // duplicate onExit/onData callbacks stacking up
    if (!alreadyExisted) {
      activityTracker.trackPane(req.paneId);
      this.follow(req.paneId, result.pid, profile);
    }
    return result;
  }

  /** The profile for a pane. A retained pane names its own shell, for a typed line it can trust. */
  private async profileFor(req: OpenPaneRequest): Promise<ShellProfile | undefined> {
    if (req.retain) return undefined;
    const { shellProfileRegistry } = this.deps;
    const profileId = req.shellProfileId ?? (await shellProfileRegistry.getDefaultProfileId());
    const profiles = await shellProfileRegistry.enumerate();
    return profiles.find((candidate) => candidate.id === profileId);
  }

  private async envFor(
    req: PtyCreateRequest,
    profile: ShellProfile | undefined
  ): Promise<{ env?: NodeJS.ProcessEnv; envSources: Record<string, EnvSource> }> {
    // Resolve Claude config: workspace override → global → default
    const { copilot } = this.deps.settingsStore.get();
    const override = req.workspaceId ? copilot.workspaceOverrides[req.workspaceId] : undefined;
    const claudeConfigDir = override?.claudeConfigDir || copilot.claudeConfigDir || '';

    const extraEnv: Record<string, string> = {};
    const envSources: Record<string, EnvSource> = {};
    if (claudeConfigDir) {
      extraEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
      envSources.CLAUDE_CONFIG_DIR = 'fleet-builtin';
    }

    // Env Sync: inject decrypted vars for any inject-delivery target whose dir
    // is an ancestor of this terminal's cwd. Resolves to {} when nothing applies.
    // Translate the cwd through the profile's context so a WSL pane's posix cwd
    // resolves to a Windows-accessible path before findNearestConfig walks it.
    if (req.cwd) {
      try {
        const cwd = resolveCtxPath(profile?.pathContext, req.cwd);
        const syncVars = await this.deps.envSyncManager.getEnvForCwd(cwd);
        Object.assign(extraEnv, syncVars);
        for (const key of Object.keys(syncVars)) envSources[key] = 'env-sync';
      } catch (err) {
        log.warn('env-sync inject failed; continuing without injected vars', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const hasExtra = Object.keys(extraEnv).length > 0;
    return { env: hasExtra ? { ...process.env, ...extraEnv } : undefined, envSources };
  }

  private send(channel: string, payload: PtyDataPayload | PtyExitPayload): void {
    const window = this.deps.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }

  private follow(paneId: string, pid: number, profile: ShellProfile | undefined): void {
    const { ptyManager, notificationDetector, ptyOscBridge, activityTracker } = this.deps;
    const { cwdPoller, eventBus } = this.deps;

    ptyManager.onData(paneId, (data, paused) => {
      notificationDetector.scan(paneId, data);
      ptyOscBridge.scan(paneId, data);
      activityTracker.onData(paneId);
      if (ptyManager.keepForReplay(paneId, data)) return;
      this.send(IPC_CHANNELS.PTY_DATA, { paneId, data, paused });
    });

    ptyManager.onExit(paneId, (exitCode) => {
      cwdPoller.stopPolling(paneId);
      this.send(IPC_CHANNELS.PTY_EXIT, { paneId, exitCode });
      eventBus.emit('pty-exit', { type: 'pty-exit', paneId, exitCode });
    });

    // Start CWD polling fallback. For WSL panes the poller no-ops — Phase 3's
    // OSC 7 hook will drive cwd updates once the shell sources ~/.fleetrc.sh.
    cwdPoller.startPolling(paneId, pid, profile?.pathContext ?? 'posix');

    eventBus.emit('pane-created', { type: 'pane-created', paneId });
  }
}
