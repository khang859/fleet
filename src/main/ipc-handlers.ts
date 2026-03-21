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
  PaneFocusedPayload,
  StarbaseRuntimeStatus
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

type BootstrapState = {
  envReady: Promise<void>
  cliReady: Promise<string>
  starbaseReady: Promise<void>
  getRuntimeStatus: () => StarbaseRuntimeStatus
  retryStarbaseBootstrap: () => Promise<StarbaseRuntimeStatus>
}

type StarbaseServices = {
  sectorService?: SectorService | null
  configService?: ConfigService | null
  crewService?: CrewService | null
  missionService?: MissionService | null
  admiralProcess?: AdmiralProcess | null
  commsService?: CommsService | null
  supplyRouteService?: SupplyRouteService | null
  cargoService?: CargoService | null
  retentionService?: RetentionService | null
  admiralStateDetector?: AdmiralStateDetector | null
  starbaseDb?: { getDb: () => import('better-sqlite3').Database } | null
}

function requireService<T>(service: T | null | undefined, label: string): T {
  if (!service) {
    throw new Error(`Star Command not ready: missing ${label}`)
  }
  return service
}

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
  getBootstrapState: () => BootstrapState,
  getStarbaseServices: () => StarbaseServices
): void {
  // PTY handlers
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_event, req: PtyCreateRequest) => {
    await getBootstrapState().envReady
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
  ipcMain.handle(IPC_CHANNELS.LAYOUT_SAVE, async (_event, req: LayoutSaveRequest) => {
    try {
      layoutStore.save(req.workspace)
    } catch (err) {
      console.error('[layout-save] Failed to save workspace:', err)
    }
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

  ipcMain.handle(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_GET, () => {
    return getBootstrapState().getRuntimeStatus()
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_RETRY, async () => {
    return getBootstrapState().retryStarbaseBootstrap()
  })

  // Starbase handlers
  ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_SECTORS, async () => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().sectorService, 'sectorService').listVisibleSectors()
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_ADD_SECTOR, async (_e, req) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().sectorService, 'sectorService').addSector(req)
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_REMOVE_SECTOR, async (_e, { sectorId }) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().sectorService, 'sectorService').removeSector(sectorId)
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_UPDATE_SECTOR, async (_e, { sectorId, fields }) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().sectorService, 'sectorService').updateSector(
      sectorId,
      fields
    )
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_GET_CONFIG, async () => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().configService, 'configService').getAll()
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_SET_CONFIG, async (_e, { key, value }) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().configService, 'configService').set(key, value)
  })

  // Phase 2: Deploy/Recall/Crew/Missions handlers
  ipcMain.handle(IPC_CHANNELS.STARBASE_DEPLOY, async (_e, req) => {
    const bootstrap = getBootstrapState()
    await Promise.all([bootstrap.envReady, bootstrap.cliReady, bootstrap.starbaseReady])
    return requireService(getStarbaseServices().crewService, 'crewService').deployCrew(req)
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_RECALL, async (_e, { crewId }) => {
    await getBootstrapState().starbaseReady
    requireService(getStarbaseServices().crewService, 'crewService').recallCrew(crewId)
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_MESSAGE_CREW, async (_e, { crewId, message }) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().crewService, 'crewService').messageCrew(
      crewId,
      message
    )
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_CREW, async (_e, filter?) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().crewService, 'crewService').listCrew(filter)
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_MISSIONS, async (_e, filter?) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().missionService, 'missionService').listMissions(
      filter
    )
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_ADD_MISSION, async (_e, req) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().missionService, 'missionService').addMission(req)
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_OBSERVE, async (_e, { crewId }) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().crewService, 'crewService').observeCrew(crewId)
  })

  // System-level dependency check (app-wide pre-checks screen)
  ipcMain.handle(IPC_CHANNELS.SYSTEM_CHECK, () => checkSystemDeps())

  // Phase 3: Admiral + Comms handlers
  ipcMain.handle(IPC_CHANNELS.ADMIRAL_CHECK_DEPENDENCIES, () => checkDependencies())

  ipcMain.handle(IPC_CHANNELS.ADMIRAL_PANE_ID, async () => {
    await getBootstrapState().starbaseReady
    return getStarbaseServices().admiralProcess?.paneId ?? null
  })

  // Wire PTY data forwarding for a newly started Admiral pane
  const wireAdmiralPty = (paneId: string): void => {
    ptyManager.onData(paneId, (data) => {
      notificationDetector.scan(paneId, data)
      getStarbaseServices().admiralStateDetector?.scan(paneId, data)
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
    const bootstrap = getBootstrapState()
    await Promise.all([bootstrap.envReady, bootstrap.cliReady, bootstrap.starbaseReady])
    const admiralProcess = requireService(getStarbaseServices().admiralProcess, 'admiralProcess')
    const paneId = await admiralProcess.restart()
    getStarbaseServices().admiralStateDetector?.setAdmiralPaneId(paneId)
    wireAdmiralPty(paneId)
    return paneId
  })
  ipcMain.handle(IPC_CHANNELS.ADMIRAL_RESET, async () => {
    const bootstrap = getBootstrapState()
    await Promise.all([bootstrap.envReady, bootstrap.cliReady, bootstrap.starbaseReady])
    const admiralProcess = requireService(getStarbaseServices().admiralProcess, 'admiralProcess')
    const paneId = await admiralProcess.reset()
    getStarbaseServices().admiralStateDetector?.setAdmiralPaneId(paneId)
    wireAdmiralPty(paneId)
    return paneId
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_COMMS_UNREAD, async () => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().commsService, 'commsService').getUnread('admiral')
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_COMMS, async (_e, opts?) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().commsService, 'commsService').getRecent(opts)
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_MARK_COMMS_READ, async (_e, { id }) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().commsService, 'commsService').markRead(id)
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_RESOLVE_COMMS, async (_e, { id, response }) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().commsService, 'commsService').resolve(
      id,
      response
    )
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_DELETE_COMMS, async (_e, { id }) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().commsService, 'commsService').delete(id)
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_MARK_ALL_COMMS_READ, async () => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().commsService, 'commsService').markAllRead()
  })
  ipcMain.handle(IPC_CHANNELS.STARBASE_CLEAR_COMMS, async () => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().commsService, 'commsService').clear()
  })

  // Phase 5: Supply routes, cargo, retention handlers
  ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_SUPPLY_ROUTES, async (_e, opts?) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().supplyRouteService, 'supplyRouteService').listRoutes(
      opts
    )
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_ADD_SUPPLY_ROUTE, async (_e, opts) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().supplyRouteService, 'supplyRouteService').addRoute(
      opts
    )
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_REMOVE_SUPPLY_ROUTE, async (_e, { routeId }) => {
    await getBootstrapState().starbaseReady
    requireService(getStarbaseServices().supplyRouteService, 'supplyRouteService').removeRoute(
      routeId
    )
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_SUPPLY_ROUTE_GRAPH, async () => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().supplyRouteService, 'supplyRouteService').getGraph()
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_CARGO, async (_e, filter?) => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().cargoService, 'cargoService').listCargo(filter)
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_RETENTION_STATS, async () => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().retentionService, 'retentionService').getStats()
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_RETENTION_CLEANUP, async () => {
    await getBootstrapState().starbaseReady
    return requireService(getStarbaseServices().retentionService, 'retentionService').cleanup()
  })

  ipcMain.handle(IPC_CHANNELS.STARBASE_RETENTION_VACUUM, async () => {
    await getBootstrapState().starbaseReady
    requireService(getStarbaseServices().retentionService, 'retentionService').vacuum()
  })

  // Logs: ships_log + comms UNION query
  ipcMain.handle(IPC_CHANNELS.STARBASE_SHIPS_LOG, async (_e, opts?: { limit?: number }) => {
    await getBootstrapState().starbaseReady
    const db = requireService(getStarbaseServices().starbaseDb, 'starbaseDb').getDb()
    const limit = opts?.limit ?? 200
    return db.prepare(`
        SELECT 'ships_log' as source, id, crew_id as actor, NULL as target, event_type as eventType, detail, created_at as timestamp
        FROM ships_log
        UNION ALL
        SELECT 'comms', id, from_crew, to_crew, type, payload, created_at
        FROM comms WHERE type NOT IN ('memo', 'hailing-memo')
        ORDER BY timestamp ASC LIMIT ?
      `).all(limit)
  })

  // First Officer: Memo handlers (backed by comms table)
  ipcMain.handle(IPC_CHANNELS.MEMO_LIST, async () => {
    await getBootstrapState().starbaseReady
    const memoDb = requireService(getStarbaseServices().starbaseDb, 'starbaseDb').getDb()
    return memoDb.prepare(
        "SELECT id, from_crew as crew_id, mission_id, type as event_type, payload, read, created_at FROM comms WHERE type IN ('memo', 'hailing-memo') ORDER BY created_at DESC"
      ).all().map((row: any) => {
        try {
          const p = JSON.parse(row.payload ?? '{}')
          return { ...row, file_path: p.filePath ?? '', status: row.read ? 'read' : 'unread', summary: p.summary ?? '' }
        } catch { return { ...row, file_path: '', status: row.read ? 'read' : 'unread', summary: '' } }
      })
  })

  ipcMain.handle(IPC_CHANNELS.MEMO_READ, async (_e, id: number) => {
    await getBootstrapState().starbaseReady
    const memoDb = requireService(getStarbaseServices().starbaseDb, 'starbaseDb').getDb()
    memoDb.prepare("UPDATE comms SET read = 1 WHERE id = ?").run(id)
    eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  })

  ipcMain.handle(IPC_CHANNELS.MEMO_DISMISS, async (_e, id: number) => {
    await getBootstrapState().starbaseReady
    const memoDb = requireService(getStarbaseServices().starbaseDb, 'starbaseDb').getDb()
    memoDb.prepare("DELETE FROM comms WHERE id = ?").run(id)
    eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
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
