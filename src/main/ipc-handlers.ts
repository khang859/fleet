import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type {
  PtyCreateRequest,
  PtyDataPayload,
  PtyInputPayload,
  PtyResizePayload,
  PtyExitPayload,
  LayoutSaveRequest,
  LayoutListResponse,
  PaneFocusedPayload
} from '../shared/ipc-api'
import type { Workspace } from '../shared/types'
import { PtyManager } from './pty-manager'
import { LayoutStore } from './layout-store'
import { EventBus } from './event-bus'
import { NotificationDetector } from './notification-detector'
import { NotificationStateManager } from './notification-state'
import { SettingsStore } from './settings-store'
import { CwdPoller } from './cwd-poller'
import { GitService } from './git-service'
import type { FleetSettings } from '../shared/types'
import type { SectorService } from './starbase/sector-service'
import type { ConfigService } from './starbase/config-service'
import type { CrewService } from './starbase/crew-service'
import type { MissionService } from './starbase/mission-service'
import type { AdmiralProcess } from './starbase/admiral-process'
import type { CommsService } from './starbase/comms-service'
import type { SupplyRouteService } from './starbase/supply-route-service'
import type { CargoService } from './starbase/cargo-service'
import type { RetentionService } from './starbase/retention-service'
import type { AdmiralStateDetector } from './starbase/admiral-state-detector'

export function registerIpcHandlers(
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  eventBus: EventBus,
  notificationDetector: NotificationDetector,
  notificationState: NotificationStateManager,
  settingsStore: SettingsStore,
  cwdPoller: CwdPoller,
  gitService: GitService,
  getWindow: () => BrowserWindow | null,
  sectorService?: SectorService | null,
  configService?: ConfigService | null,
  crewService?: CrewService | null,
  missionService?: MissionService | null,
  admiralProcess?: AdmiralProcess | null,
  commsService?: CommsService | null,
  supplyRouteService?: SupplyRouteService | null,
  cargoService?: CargoService | null,
  retentionService?: RetentionService | null,
  admiralStateDetector?: AdmiralStateDetector | null
): void {
  // PTY handlers
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, (_event, req: PtyCreateRequest) => {
    const result = ptyManager.create(req)

    ptyManager.onData(req.paneId, (data) => {
      notificationDetector.scan(req.paneId, data)
      const w = getWindow()
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.PTY_DATA, {
          paneId: req.paneId,
          data
        } satisfies PtyDataPayload)
      }
    })

    ptyManager.onExit(req.paneId, (exitCode) => {
      cwdPoller.stopPolling(req.paneId)
      const w = getWindow()
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.PTY_EXIT, {
          paneId: req.paneId,
          exitCode
        } satisfies PtyExitPayload)
      }
      eventBus.emit('pty-exit', { type: 'pty-exit', paneId: req.paneId, exitCode })
    })

    // Start CWD polling fallback for shells that don't emit OSC 7
    cwdPoller.startPolling(req.paneId, result.pid)

    eventBus.emit('pane-created', { type: 'pane-created', paneId: req.paneId })
    return result
  })

  ipcMain.on(IPC_CHANNELS.PTY_INPUT, (_event, payload: PtyInputPayload) => {
    ptyManager.write(payload.paneId, payload.data)
  })

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
    ptyManager.resize(payload.paneId, payload.cols, payload.rows)
  })

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, paneId: string) => {
    ptyManager.kill(paneId)
    eventBus.emit('pane-closed', { type: 'pane-closed', paneId })
  })

  // PTY drain — renderer signals it has consumed a batch; resume the PTY
  ipcMain.on(IPC_CHANNELS.PTY_DRAIN, (_event, { paneId }: { paneId: string }) => {
    ptyManager.resume(paneId)
  })

  // Garbage-collect orphaned PTYs: renderer sends list of active pane IDs,
  // main kills any PTY not in that list.
  ipcMain.on(IPC_CHANNELS.PTY_GC, (_event, activePaneIds: string[]) => {
    const killed = ptyManager.gc(new Set(activePaneIds))
    if (killed.length > 0) {
      console.log(`[pty-gc] killed ${killed.length} orphaned PTY(s):`, killed)
      for (const paneId of killed) {
        eventBus.emit('pane-closed', { type: 'pane-closed', paneId })
      }
    }
  })

  // Layout handlers
  ipcMain.handle(IPC_CHANNELS.LAYOUT_SAVE, (_event, req: LayoutSaveRequest) => {
    layoutStore.save(req.workspace)
  })

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LOAD, (_event, workspaceId: string): Workspace | undefined => {
    return layoutStore.load(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LIST, (): LayoutListResponse => {
    return { workspaces: layoutStore.list() }
  })

  ipcMain.handle(IPC_CHANNELS.LAYOUT_DELETE, (_event, workspaceId: string) => {
    layoutStore.delete(workspaceId)
  })

  // Notification handlers
  ipcMain.on(IPC_CHANNELS.PANE_FOCUSED, (_event, payload: PaneFocusedPayload) => {
    notificationState.clearPane(payload.paneId)
  })

  // Settings handlers
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return settingsStore.get()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, settings: Partial<FleetSettings>) => {
    settingsStore.set(settings)
  })

  // Git handlers
  ipcMain.handle(IPC_CHANNELS.GIT_IS_REPO, (_event, cwd: string) => {
    return gitService.checkIsRepo(cwd)
  })

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, (_event, cwd: string) => {
    return gitService.getFullStatus(cwd)
  })

  // Starbase handlers
  if (sectorService && configService) {
    ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_SECTORS, () => sectorService.listSectors())
    ipcMain.handle(IPC_CHANNELS.STARBASE_ADD_SECTOR, (_e, req) => sectorService.addSector(req))
    ipcMain.handle(IPC_CHANNELS.STARBASE_REMOVE_SECTOR, (_e, { sectorId }) =>
      sectorService.removeSector(sectorId)
    )
    ipcMain.handle(IPC_CHANNELS.STARBASE_UPDATE_SECTOR, (_e, { sectorId, fields }) =>
      sectorService.updateSector(sectorId, fields)
    )
    ipcMain.handle(IPC_CHANNELS.STARBASE_GET_CONFIG, () => configService.getAll())
    ipcMain.handle(IPC_CHANNELS.STARBASE_SET_CONFIG, (_e, { key, value }) =>
      configService.set(key, value)
    )
  }

  // Phase 2: Deploy/Recall/Crew/Missions handlers
  if (crewService && missionService) {
    ipcMain.handle(IPC_CHANNELS.STARBASE_DEPLOY, async (_e, req) => {
      const createTab = (label: string, cwd: string): string => {
        const tabId = crypto.randomUUID()
        const w = getWindow()
        if (w && !w.isDestroyed()) {
          w.webContents.send('fleet:create-tab', { tabId, label, cwd })
        }
        return tabId
      }
      return crewService.deployCrew(req, ptyManager, createTab)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_RECALL, (_e, { crewId }) => {
      crewService.recallCrew(crewId, ptyManager)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_CREW, (_e, filter?) => {
      return crewService.listCrew(filter)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_MISSIONS, (_e, filter?) => {
      return missionService.listMissions(filter)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_ADD_MISSION, (_e, req) => {
      return missionService.addMission(req)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_OBSERVE, (_e, { crewId }) => {
      return crewService.observeCrew(crewId)
    })
  }

  // Phase 3: Admiral + Comms handlers
  if (admiralProcess) {
    ipcMain.handle(IPC_CHANNELS.ADMIRAL_PANE_ID, () => admiralProcess.paneId)

    // Wire PTY data forwarding for a newly started Admiral pane
    const wireAdmiralPty = (paneId: string): void => {
      ptyManager.onData(paneId, (data) => {
        notificationDetector.scan(paneId, data)
        admiralStateDetector?.scan(paneId, data)
        const w = getWindow()
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId, data })
        }
      })
      ptyManager.onExit(paneId, (exitCode) => {
        const w = getWindow()
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.PTY_EXIT, { paneId, exitCode })
        }
        eventBus.emit('pty-exit', { type: 'pty-exit', paneId, exitCode })
      })
      cwdPoller.startPolling(paneId, ptyManager.getPid(paneId) ?? 0)
    }

    ipcMain.handle(IPC_CHANNELS.ADMIRAL_RESTART, async () => {
      const paneId = await admiralProcess.restart()
      admiralStateDetector?.setAdmiralPaneId(paneId)
      wireAdmiralPty(paneId)
      return paneId
    })
    ipcMain.handle(IPC_CHANNELS.ADMIRAL_RESET, async () => {
      const paneId = await admiralProcess.reset()
      admiralStateDetector?.setAdmiralPaneId(paneId)
      wireAdmiralPty(paneId)
      return paneId
    })
  }

  if (commsService) {
    ipcMain.handle(IPC_CHANNELS.STARBASE_COMMS_UNREAD, () => {
      return commsService.getUnread('admiral')
    })
  }

  // Phase 5: Supply routes, cargo, retention handlers
  if (supplyRouteService) {
    ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_SUPPLY_ROUTES, (_e, opts?) => {
      return supplyRouteService.listRoutes(opts)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_ADD_SUPPLY_ROUTE, (_e, opts) => {
      return supplyRouteService.addRoute(opts)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_REMOVE_SUPPLY_ROUTE, (_e, { routeId }) => {
      supplyRouteService.removeRoute(routeId)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_SUPPLY_ROUTE_GRAPH, () => {
      return supplyRouteService.getGraph()
    })
  }

  if (cargoService) {
    ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_CARGO, (_e, filter?) => {
      return cargoService.listCargo(filter)
    })
  }

  if (retentionService) {
    ipcMain.handle(IPC_CHANNELS.STARBASE_RETENTION_STATS, () => {
      return retentionService.getStats()
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_RETENTION_CLEANUP, () => {
      return retentionService.cleanup()
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_RETENTION_VACUUM, () => {
      retentionService.vacuum()
    })
  }
}
