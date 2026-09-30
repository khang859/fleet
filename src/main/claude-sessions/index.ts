import type { Socket } from 'net';
import { createLogger } from '../logger';
import { resolveClaudeConfig } from '../../shared/claude-config';
import type { FleetSettings } from '../../shared/types';
import type { HookEvent } from './hook-events';
import * as hookInstaller from './hook-installer';
import { HookServer, PermissionBroker } from './hook-server';
import { registerClaudeSessionsIpc, type IpcRegistrar } from './ipc-handlers';
import { PaneActivityBridge, type SetHookState } from './pane-activity-bridge';
import { PaneResolver, type PaneHost, type WorkspaceLookup } from './pane-resolver';
import { ClaudeSessionRegistry } from './registry';

const log = createLogger('claude-sessions');

/** How often sessions whose Claude process died silently are swept. */
const LIVENESS_INTERVAL_MS = 10_000;

export type ClaudeSessionsDeps = {
  platform: NodeJS.Platform;
  homeDir: string;
  getSettings: () => FleetSettings;
  panes: PaneHost;
  workspaceOf: WorkspaceLookup;
  setHookState: SetHookState;
  ipc: IpcRegistrar;
  socketPath?: string;
  installer?: Pick<typeof hookInstaller, 'ensureHooks' | 'uninstall'>;
};

/** Every Claude config folder Fleet hands to its panes: the default and each workspace's own. */
export function claudeConfigDirs(settings: FleetSettings, homeDir: string): string[] {
  const { claudeConfigDir, workspaceOverrides } = settings.copilot;
  const dirs = [resolveClaudeConfig({ defaultDir: claudeConfigDir, homeDir }).path];
  for (const override of Object.values(workspaceOverrides)) {
    const dir = override?.claudeConfigDir?.trim();
    if (dir) dirs.push(dir);
  }
  return [...new Set(dirs)];
}

/**
 * The composition root for Claude session tracking: installs the hooks, runs
 * the hook socket, and keeps the registry and the pane badges current.
 *
 * Tracking runs on macOS and Linux whenever `claudeSessions.trackSessions` is
 * on, independent of the copilot. Starting, stopping and settings changes are
 * queued, so a quick toggle never interleaves two of them.
 */
export class ClaudeSessionsService {
  readonly registry = new ClaudeSessionRegistry();
  readonly broker: PermissionBroker;
  private readonly server: HookServer;
  private readonly resolver: PaneResolver;
  private readonly bridge: PaneActivityBridge;
  private readonly installer: Pick<typeof hookInstaller, 'ensureHooks' | 'uninstall'>;
  private liveness: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** The setting as last applied, so turning it off can be told from starting with it off. */
  private tracking: boolean | null = null;
  private work: Promise<void> = Promise.resolve();
  /** How many consumers can answer a permission request right now. */
  private answerers = 0;

  constructor(private readonly deps: ClaudeSessionsDeps) {
    this.installer = deps.installer ?? hookInstaller;
    this.resolver = new PaneResolver(deps.panes, deps.workspaceOf);
    this.bridge = new PaneActivityBridge(deps.setHookState);
    this.broker = new PermissionBroker((sessionId, toolUseId) =>
      this.registry.resolvePermission(sessionId, toolUseId)
    );
    this.server = new HookServer(
      (event, client) => this.onHookEvent(event, client),
      deps.socketPath
    );

    this.registry.subscribe((change) => {
      // The badge follows the pane's own session, not a nested run inside it.
      const { session } = change;
      const ownsPane =
        !session ||
        session.phase === 'ended' ||
        this.registry.getByPane(session.paneId)?.sessionId === session.sessionId;
      if (ownsPane) this.bridge.apply(change);
      const pending = change.session?.pendingPermissions ?? [];
      this.broker.retainOnly(change.sessionId, new Set(pending.map((p) => p.toolUseId)));
    });
    registerClaudeSessionsIpc(deps.ipc);
  }

  /** Whether tracking can run on this platform at all. */
  get supported(): boolean {
    return this.deps.platform !== 'win32';
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    return this.enqueue(async () => this.apply());
  }

  /** Re-read the settings: tracking toggled, or the set of config folders changed. */
  async onSettingsChanged(): Promise<void> {
    return this.enqueue(async () => this.apply());
  }

  onPaneClosed(paneId: string): void {
    this.registry.releasePane(paneId);
    this.resolver.forgetPane(paneId);
  }

  /**
   * Declare that a consumer can answer permission requests, until the returned
   * function is called. With none, permission hooks are released at once so
   * Claude Code shows its own prompt: holding one nobody can answer would stall
   * a background subagent, whose dialog waits for the hook.
   */
  addPermissionAnswerer(): () => void {
    this.answerers++;
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.answerers--;
      if (this.answerers === 0) void this.broker.dispose();
    };
  }

  respondToPermission(toolUseId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    return this.broker.respond(toolUseId, decision, reason);
  }

  async stop(): Promise<void> {
    return this.enqueue(async () => this.halt());
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    this.work = this.work.then(task).catch((err: unknown) => {
      log.error('claude sessions task failed', { error: String(err) });
    });
    return this.work;
  }

  private async apply(): Promise<void> {
    const settings = this.deps.getSettings();
    const wanted = settings.claudeSessions.trackSessions;
    const dirs = claudeConfigDirs(settings, this.deps.homeDir);
    const turnedOff = this.tracking === true && !wanted;
    this.tracking = wanted;

    if (!this.supported) return;

    if (!wanted) {
      await this.halt();
      if (turnedOff) {
        for (const dir of dirs) {
          try {
            this.installer.uninstall(dir);
          } catch (err) {
            log.warn('could not remove hooks', { configDir: dir, error: String(err) });
          }
        }
      }
      return;
    }

    // Every time, not only at start: it adds a newly assigned folder and
    // refreshes the binary after an upgrade. Unchanged folders are not written.
    this.installer.ensureHooks(dirs);

    if (this.running) return;
    await this.server.start();
    this.liveness = setInterval(() => this.registry.pruneDead(), LIVENESS_INTERVAL_MS);
    this.liveness.unref();
    this.running = true;
    log.info('claude session tracking started', { configDirs: dirs });
  }

  private async halt(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.liveness) clearInterval(this.liveness);
    this.liveness = null;
    await this.broker.dispose();
    await this.server.stop();
    this.registry.clear();
    log.info('claude session tracking stopped');
  }

  private onHookEvent(event: HookEvent, client: Socket): boolean {
    const placement = this.resolver.resolve(event);
    if (!placement) {
      log.debug('hook event from outside a Fleet pane dropped', { sessionId: event.sessionId });
      return false;
    }
    const recorded = this.registry.ingest(event, placement);
    const toolUseId = recorded?.toolUseId;
    if (event.status !== 'waiting_for_approval' || !toolUseId || this.answerers === 0) return false;
    const pending = this.registry.get(event.sessionId)?.pendingPermissions ?? [];
    if (!pending.some((p) => p.toolUseId === toolUseId)) return false;
    this.broker.hold(event.sessionId, toolUseId, client);
    return true;
  }
}
