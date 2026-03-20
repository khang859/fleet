import { ipcMain, BrowserWindow, dialog } from 'electron'
import { readFile, writeFile, stat, readdir } from 'fs/promises'
import { extname, join, relative, resolve } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
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
import { checkDependencies } from './starbase/admiral-process'
import { checkSystemDeps } from './system-checker'
import type { CommsService } from './starbase/comms-service'
import type { SupplyRouteService } from './starbase/supply-route-service'
import type { CargoService } from './starbase/cargo-service'
import type { RetentionService } from './starbase/retention-service'
import type { AdmiralStateDetector } from './starbase/admiral-state-detector'
import type { MemoService } from './starbase/memo-service'

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
  admiralStateDetector?: AdmiralStateDetector | null,
  memoService?: MemoService | null
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

  // Attach to a pre-created PTY: drain its buffered output so the renderer
  // can replay what arrived before the terminal component mounted.
  ipcMain.handle(IPC_CHANNELS.PTY_ATTACH, (_event, { paneId }: { paneId: string }) => {
    const entry = ptyManager.get(paneId)
    if (!entry) return { data: '' }
    const data = entry.outputBuffer
    entry.outputBuffer = ''
    return { data }
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
  ipcMain.on(IPC_CHANNELS.LAYOUT_SAVE, (event, req: LayoutSaveRequest) => {
    layoutStore.save(req.workspace)
    event.returnValue = undefined
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
      return crewService.deployCrew(req)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_RECALL, (_e, { crewId }) => {
      crewService.recallCrew(crewId)
    })

    ipcMain.handle(IPC_CHANNELS.STARBASE_MESSAGE_CREW, (_e, { crewId, message }) => {
      return crewService.messageCrew(crewId, message)
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

  // System-level dependency check (app-wide pre-checks screen)
  ipcMain.handle(IPC_CHANNELS.SYSTEM_CHECK, () => checkSystemDeps())

  // Phase 3: Admiral + Comms handlers
  ipcMain.handle(IPC_CHANNELS.ADMIRAL_CHECK_DEPENDENCIES, () => checkDependencies())

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
    ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_COMMS, (_e, opts?) => {
      return commsService.getRecent(opts)
    })
    ipcMain.handle(IPC_CHANNELS.STARBASE_MARK_COMMS_READ, (_e, { id }) => {
      return commsService.markRead(id)
    })
    ipcMain.handle(IPC_CHANNELS.STARBASE_RESOLVE_COMMS, (_e, { id, response }) => {
      return commsService.resolve(id, response)
    })
    ipcMain.handle(IPC_CHANNELS.STARBASE_DELETE_COMMS, (_e, { id }) => {
      return commsService.delete(id)
    })
    ipcMain.handle(IPC_CHANNELS.STARBASE_MARK_ALL_COMMS_READ, () => {
      return commsService.markAllRead()
    })
    ipcMain.handle(IPC_CHANNELS.STARBASE_CLEAR_COMMS, () => {
      return commsService.clear()
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

  // First Officer: Memo handlers
  if (memoService) {
    ipcMain.handle(IPC_CHANNELS.MEMO_LIST, () => {
      return memoService!.listAll()
    })

    ipcMain.handle(IPC_CHANNELS.MEMO_READ, (_e, id: string) => {
      memoService!.markRead(id)
    })

    ipcMain.handle(IPC_CHANNELS.MEMO_DISMISS, (_e, id: string) => {
      memoService!.dismiss(id)
    })

    ipcMain.handle(IPC_CHANNELS.MEMO_CONTENT, async (_e, filePath: string) => {
      const allowedBase = join(process.env.HOME ?? '~', '.fleet', 'starbases')
      const resolved = resolve(filePath)
      if (!resolved.startsWith(allowedBase) || !resolved.includes('first-officer/memos/')) {
        return null
      }
      try {
        return await readFile(resolved, 'utf-8')
      } catch {
        return null
      }
    })
  }

  // Folder picker
  ipcMain.handle(IPC_CHANNELS.SHOW_FOLDER_PICKER, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Open file dialog — allows multi-select, no type filter, starts in provided dir
  ipcMain.handle(IPC_CHANNELS.FILE_OPEN_DIALOG, async (event, { defaultPath }: { defaultPath?: string } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      defaultPath: defaultPath ?? undefined,
    })
    return result.canceled ? [] : result.filePaths
  })

  // List files recursively in a directory, respecting .gitignore when in a git repo
  ipcMain.handle(IPC_CHANNELS.FILE_LIST, async (_event, { dirPath }: { dirPath: string }) => {
    try {
      // Try git ls-files first (respects .gitignore)
      const { stdout } = await execAsync('git ls-files --cached --others --exclude-standard', {
        cwd: dirPath,
        maxBuffer: 10 * 1024 * 1024,
      })
      const files = stdout.split('\n').filter(Boolean).map((f) => ({
        path: join(dirPath, f),
        relativePath: f,
        name: f.split('/').pop() ?? f,
      }))
      return { success: true, files }
    } catch {
      // Fallback: manual recursive walk with common ignore patterns
      const IGNORE_DIRS = new Set([
        'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
        '__pycache__', '.cache', '.parcel-cache', 'out', '.svelte-kit',
      ])
      const files: { path: string; relativePath: string; name: string }[] = []

      async function walk(dir: string, base: string): Promise<void> {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
              await walk(join(dir, entry.name), base)
            }
          } else if (entry.isFile()) {
            const abs = join(dir, entry.name)
            const rel = relative(base, abs)
            files.push({ path: abs, relativePath: rel, name: entry.name })
          }
        }
      }

      await walk(dirPath, dirPath)
      return { success: true, files }
    }
  })

  // File operations
  ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, filePath: string) => {
    try {
      const stats = await stat(filePath)
      const content = await readFile(filePath, 'utf-8')
      return { success: true, data: { content, size: stats.size, modifiedAt: stats.mtimeMs } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_WRITE, async (_event, { filePath, content }: { filePath: string; content: string }) => {
    try {
      await writeFile(filePath, content, 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_STAT, async (_event, filePath: string) => {
    try {
      const stats = await stat(filePath)
      const ext = extname(filePath).toLowerCase().slice(1)
      const mimeTypes: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        bmp: 'image/bmp', ico: 'image/x-icon',
      }
      const mimeType = mimeTypes[ext] ?? 'application/octet-stream'
      return { success: true, data: { size: stats.size, modifiedAt: stats.mtimeMs, mimeType } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_READ_BINARY, async (_event, filePath: string) => {
    try {
      const ext = extname(filePath).toLowerCase().slice(1)
      const mimeTypes: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        bmp: 'image/bmp', ico: 'image/x-icon',
      }
      const mimeType = mimeTypes[ext] ?? 'application/octet-stream'
      const buffer = await readFile(filePath)
      const base64 = buffer.toString('base64')
      return { success: true, data: { base64, mimeType } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
