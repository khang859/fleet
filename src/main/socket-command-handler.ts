import { randomUUID } from 'crypto';
import type { SocketCommand, SocketResponse, SocketCommandHandler } from './socket-api';
import type { PtyManager } from './pty-manager';
import type { LayoutStore } from './layout-store';
import type { EventBus } from './event-bus';
import type { NotificationStateManager } from './notification-state';
import type { Workspace, Tab, PaneLeaf, PaneNode, PaneSplit } from '../shared/types';
import type { SectorService } from './starbase/sector-service';
import type { ConfigService } from './starbase/config-service';
import type { CrewService } from './starbase/crew-service';
import type { MissionService } from './starbase/mission-service';
import type { StarbaseRuntimeClient } from './starbase-runtime-client';

export class FleetCommandHandler implements SocketCommandHandler {
  private workspace: Workspace = { id: 'default', label: 'Default', tabs: [] };
  private tabs = new Map<string, Tab>();

  private getWindow: (() => import('electron').BrowserWindow | null) | null = null;
  private sectorService: SectorService | null = null;
  private configService: ConfigService | null = null;
  private crewService: CrewService | null = null;
  private missionService: MissionService | null = null;
  private runtimeClient: StarbaseRuntimeClient | null = null;

  constructor(
    private ptyManager: PtyManager,
    private layoutStore: LayoutStore,
    private eventBus: EventBus,
    private notificationState: NotificationStateManager,
  ) {}

  setStarbaseServices(sectorService: SectorService, configService: ConfigService): void {
    this.sectorService = sectorService;
    this.configService = configService;
  }

  setPhase2Services(crewService: CrewService, missionService: MissionService): void {
    this.crewService = crewService;
    this.missionService = missionService;
  }

  setRuntimeClient(runtimeClient: StarbaseRuntimeClient): void {
    this.runtimeClient = runtimeClient;
  }

  setWindowGetter(getter: () => import('electron').BrowserWindow | null): void {
    this.getWindow = getter;
  }

  async handleCommand(cmd: SocketCommand): Promise<SocketResponse> {
    switch (cmd.type) {
      case 'list-workspaces':
        return { ok: true, workspaces: this.layoutStore.list() };

      case 'load-workspace': {
        const ws = this.layoutStore.load(cmd.workspaceId as string);
        if (!ws) return { ok: false, error: `workspace not found: ${cmd.workspaceId}` };
        this.workspace = ws;
        this.eventBus.emit('workspace-loaded', { type: 'workspace-loaded', workspaceId: ws.id });
        return { ok: true };
      }

      case 'list-tabs':
        return {
          ok: true,
          tabs: this.workspace.tabs.map((t) => ({
            id: t.id,
            label: t.label,
            cwd: t.cwd,
          })),
        };

      case 'new-tab': {
        const paneId = randomUUID();
        const tabId = randomUUID();
        const cwd = (cmd.cwd as string) ?? '/';
        const label = (cmd.label as string) ?? 'Shell';

        const leaf: PaneLeaf = { type: 'leaf', id: paneId, cwd };
        const tab: Tab = { id: tabId, label, labelIsCustom: false, cwd, splitRoot: leaf };

        this.workspace.tabs.push(tab);
        this.tabs.set(tabId, tab);

        // Create PTY
        const ptyResult = this.ptyManager.create({
          paneId,
          cwd,
          cmd: cmd.cmd as string | undefined,
        });

        this.eventBus.emit('pane-created', { type: 'pane-created', paneId });

        return { ok: true, tabId, paneId, pid: ptyResult.pid };
      }

      case 'close-tab': {
        const tabId = cmd.tabId as string;
        const tabIndex = this.workspace.tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return { ok: false, error: `tab not found: ${tabId}` };

        const tab = this.workspace.tabs[tabIndex];
        const paneIds = this.collectPaneIds(tab.splitRoot);
        for (const pid of paneIds) {
          this.ptyManager.kill(pid);
          this.eventBus.emit('pane-closed', { type: 'pane-closed', paneId: pid });
        }
        this.workspace.tabs.splice(tabIndex, 1);
        this.tabs.delete(tabId);
        return { ok: true };
      }

      case 'list-panes': {
        const tabId = cmd.tabId as string;
        const tab = this.workspace.tabs.find((t) => t.id === tabId);
        if (!tab) return { ok: false, error: `tab not found: ${tabId}` };

        const leaves = this.collectPaneLeaves(tab.splitRoot);
        return {
          ok: true,
          panes: leaves.map((leaf) => ({
            id: leaf.id,
            cwd: leaf.cwd,
            shell: leaf.shell,
            hasProcess: this.ptyManager.has(leaf.id),
          })),
        };
      }

      case 'new-pane': {
        const parentPaneId = cmd.paneId as string;
        if (!this.ptyManager.has(parentPaneId)) {
          return { ok: false, error: `pane not found: ${parentPaneId}` };
        }

        const newPaneId = randomUUID();
        const cwd = (cmd.cwd as string) ?? '/';
        const direction = (cmd.direction as 'horizontal' | 'vertical') ?? 'horizontal';

        // Insert new split node into the tab's split tree
        const newLeaf: PaneLeaf = { type: 'leaf', id: newPaneId, cwd };
        for (const tab of this.workspace.tabs) {
          if (this.insertSplit(tab, 'splitRoot', tab.splitRoot, parentPaneId, newLeaf, direction)) {
            break;
          }
        }

        this.ptyManager.create({
          paneId: newPaneId,
          cwd,
          cmd: cmd.cmd as string | undefined,
        });

        this.eventBus.emit('pane-created', { type: 'pane-created', paneId: newPaneId });

        return { ok: true, paneId: newPaneId };
      }

      case 'close-pane': {
        const paneId = cmd.paneId as string;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        this.ptyManager.kill(paneId);
        this.eventBus.emit('pane-closed', { type: 'pane-closed', paneId });
        return { ok: true };
      }

      case 'focus-pane': {
        const paneId = cmd.paneId as string;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        // Send focus command to renderer
        const win = this.getWindow?.();
        if (win) {
          win.show();
          win.focus();
          win.webContents.send('fleet:focus-pane', { paneId });
        }
        return { ok: true };
      }

      case 'send-input': {
        const paneId = cmd.paneId as string;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        this.ptyManager.write(paneId, cmd.data as string);
        return { ok: true };
      }

      case 'get-output': {
        return {
          ok: false,
          error: 'get-output requires renderer IPC round-trip — not yet implemented',
        };
      }

      case 'get-state':
        return {
          ok: true,
          workspace: {
            id: this.workspace.id,
            label: this.workspace.label,
            tabCount: this.workspace.tabs.length,
          },
          panes: this.ptyManager.paneIds(),
          notifications: this.notificationState.getAllStates(),
        };

      // Starbase commands
      case 'sectors':
        if (this.runtimeClient) {
          return { ok: true, sectors: await this.runtimeClient.invoke('sector.listVisible') };
        }
        if (!this.sectorService) return { ok: false, error: 'Star Command not initialized' };
        return { ok: true, sectors: this.sectorService.listVisibleSectors() };

      case 'add-sector':
        if (this.runtimeClient) {
          return { ok: true, sector: await this.runtimeClient.invoke('sector.add', cmd) };
        }
        if (!this.sectorService) return { ok: false, error: 'Star Command not initialized' };
        return { ok: true, sector: this.sectorService.addSector(cmd as any) };

      case 'config-get':
        if (this.runtimeClient) {
          if (cmd.key) {
            return { ok: true, key: cmd.key, value: await this.runtimeClient.invoke('config.get', cmd.key as string) };
          }
          return { ok: true, config: await this.runtimeClient.invoke('config.getAll') };
        }
        if (!this.configService) return { ok: false, error: 'Star Command not initialized' };
        if (cmd.key) {
          return { ok: true, key: cmd.key, value: this.configService.get(cmd.key as string) };
        }
        return { ok: true, config: this.configService.getAll() };

      case 'config-set':
        if (this.runtimeClient) {
          await this.runtimeClient.invoke('config.set', { key: cmd.key as string, value: cmd.value });
          return { ok: true };
        }
        if (!this.configService) return { ok: false, error: 'Star Command not initialized' };
        this.configService.set(cmd.key as string, cmd.value);
        return { ok: true };

      // Phase 2: Deploy/Recall/Crew/Missions
      case 'deploy': {
        if (this.runtimeClient) {
          if (typeof cmd.missionId !== 'number') {
            return { ok: false, error: 'deploy requires missionId' };
          }
          const result = await this.runtimeClient.invoke<Record<string, unknown>>('crew.deploy', {
            sectorId: cmd.sectorId as string,
            prompt: cmd.prompt as string,
            missionId: cmd.missionId,
          });
          return { ok: true, ...result };
        }
        if (!this.crewService) return { ok: false, error: 'Star Command Phase 2 not initialized' };
        if (typeof cmd.missionId !== 'number') {
          return { ok: false, error: 'deploy requires missionId' };
        }
        const result = await this.crewService.deployCrew(
          {
            sectorId: cmd.sectorId as string,
            prompt: cmd.prompt as string,
            missionId: cmd.missionId,
          },
        );
        return { ok: true, ...result };
      }

      case 'recall':
        if (this.runtimeClient) {
          await this.runtimeClient.invoke('crew.recall', cmd.crewId as string);
          return { ok: true };
        }
        if (!this.crewService) return { ok: false, error: 'Star Command Phase 2 not initialized' };
        this.crewService.recallCrew(cmd.crewId as string);
        return { ok: true };

      case 'crew':
        if (this.runtimeClient) {
          return {
            ok: true,
            crew: await this.runtimeClient.invoke('crew.list', cmd.sectorId ? { sectorId: cmd.sectorId as string } : undefined),
          };
        }
        if (!this.crewService) return { ok: false, error: 'Star Command Phase 2 not initialized' };
        return { ok: true, crew: this.crewService.listCrew(cmd.sectorId ? { sectorId: cmd.sectorId as string } : undefined) };

      case 'missions':
        if (this.runtimeClient) {
          return { ok: true, missions: await this.runtimeClient.invoke('mission.list', cmd as any) };
        }
        if (!this.missionService) return { ok: false, error: 'Star Command Phase 2 not initialized' };
        return { ok: true, missions: this.missionService.listMissions(cmd as any) };

      default:
        return { ok: false, error: `Unknown command: ${cmd.type}` };
    }
  }

  private collectPaneIds(node: PaneNode): string[] {
    if (node.type === 'leaf') return [node.id];
    return [
      ...this.collectPaneIds(node.children[0]),
      ...this.collectPaneIds(node.children[1]),
    ];
  }

  private collectPaneLeaves(node: PaneNode): PaneLeaf[] {
    if (node.type === 'leaf') return [node];
    return [
      ...this.collectPaneLeaves(node.children[0]),
      ...this.collectPaneLeaves(node.children[1]),
    ];
  }

  private insertSplit(
    tab: Tab,
    _key: string,
    node: PaneNode,
    targetPaneId: string,
    newLeaf: PaneLeaf,
    direction: 'horizontal' | 'vertical',
  ): boolean {
    if (node.type === 'leaf' && node.id === targetPaneId) {
      tab.splitRoot = this.replaceNode(tab.splitRoot, targetPaneId, {
        type: 'split',
        direction,
        ratio: 0.5,
        children: [node, newLeaf],
      } as PaneSplit);
      return true;
    }
    if (node.type === 'split') {
      return (
        this.insertSplit(tab, 'left', node.children[0], targetPaneId, newLeaf, direction) ||
        this.insertSplit(tab, 'right', node.children[1], targetPaneId, newLeaf, direction)
      );
    }
    return false;
  }

  private replaceNode(
    node: PaneNode,
    targetId: string,
    replacement: PaneNode,
  ): PaneNode {
    if (node.type === 'leaf') {
      return node.id === targetId ? replacement : node;
    }
    return {
      ...node,
      children: [
        this.replaceNode(node.children[0], targetId, replacement),
        this.replaceNode(node.children[1], targetId, replacement),
      ],
    };
  }
}
