import { app, BrowserWindow, ipcMain, Notification, nativeImage } from 'electron'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { PtyManager } from './pty-manager'
import { LayoutStore } from './layout-store'
import { EventBus } from './event-bus'
import { NotificationDetector } from './notification-detector'
import { NotificationStateManager } from './notification-state'
import { registerIpcHandlers } from './ipc-handlers'
import { GitService } from './git-service'
import { SettingsStore } from './settings-store'
import { IPC_CHANNELS, SOCKET_PATH } from '../shared/constants'
import { SocketApi } from './socket-api'
import { FleetCommandHandler } from './socket-command-handler'
import { AgentStateTracker } from './agent-state-tracker'
import { JsonlWatcher } from './jsonl-watcher'
import { CwdPoller } from './cwd-poller'
import { CLAUDE_PROJECTS_DIR } from '../shared/constants'
import { StarbaseDB } from './starbase/db'
import { SectorService } from './starbase/sector-service'
import { ConfigService } from './starbase/config-service'
import { MissionService } from './starbase/mission-service'
import { WorktreeManager } from './starbase/worktree-manager'
import { CrewService } from './starbase/crew-service'
import { CommsService } from './starbase/comms-service'
import { Admiral } from './starbase/admiral'
import { Sentinel } from './starbase/sentinel'
import { runReconciliation } from './starbase/reconciliation'
import { Lockfile } from './starbase/lockfile'
import { SupplyRouteService } from './starbase/supply-route-service'
import { CargoService } from './starbase/cargo-service'
import { RetentionService } from './starbase/retention-service'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

let mainWindow: BrowserWindow | null = null
let sentinel: Sentinel | null = null
let lockfile: Lockfile | null = null
const ptyManager = new PtyManager()
const layoutStore = new LayoutStore()
const eventBus = new EventBus()
const settingsStore = new SettingsStore()
const notificationDetector = new NotificationDetector(eventBus)
const notificationState = new NotificationStateManager(eventBus)
const commandHandler = new FleetCommandHandler(ptyManager, layoutStore, eventBus, notificationState)
const socketApi = new SocketApi(SOCKET_PATH, commandHandler)
const cwdPoller = new CwdPoller(eventBus, ptyManager)
const agentTracker = new AgentStateTracker(eventBus)
const jsonlWatcher = new JsonlWatcher(CLAUDE_PROJECTS_DIR)

function createWindow(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const iconPath = join(__dirname, '../../build/icon.png')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.mjs', import.meta.url)),
      sandbox: false
    },
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: '#0a0a0a', symbolColor: '#a3a3a3', height: 36 } }
    )
  })

  // Log renderer console messages and errors to main process stdout
  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[renderer] ${message}`)
  })

  mainWindow.on('close', () => {
    ptyManager.killAll()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[renderer] Failed to load: ${errorCode} ${errorDescription}`)
  })

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })

    // Debug: log DOM state after page loads
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        mainWindow!.webContents
          .executeJavaScript(
            `
          const root = document.getElementById('root');
          const xterm = document.querySelector('.xterm');
          const container = document.querySelector('[class*="h-full"][class*="w-full"]');
          const main = document.querySelector('main');
          JSON.stringify({
            mainHTML: main?.innerHTML.substring(0, 500),
            mainChildren: main?.children.length,
            mainDims: main ? { w: main.clientWidth, h: main.clientHeight } : null,
          })
        `
          )
          .then((r) => console.log('[debug DOM]', r))
          .catch((e) => console.log('[debug err]', e))
      }, 3000)
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  }
}

app.setName('Fleet')

app.whenReady().then(() => {
  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    const dockIconPath = join(dirname(fileURLToPath(import.meta.url)), '../../build/icon.png')
    const dockIcon = nativeImage.createFromPath(dockIconPath)
    if (!dockIcon.isEmpty()) {
      app.dock?.setIcon(dockIcon)
    }
  }

  const gitService = new GitService()

  // Initialize Star Command database
  let starbaseDb: StarbaseDB | null = null
  let sectorService: SectorService | null = null
  let configService: ConfigService | null = null
  let missionService: MissionService | null = null
  let crewService: CrewService | null = null
  let commsService: CommsService | null = null
  let admiral: Admiral | null = null
  let supplyRouteService: SupplyRouteService | null = null
  let cargoService: CargoService | null = null
  let retentionService: RetentionService | null = null

  try {
    const workspacePath = process.cwd()
    starbaseDb = new StarbaseDB(workspacePath)
    starbaseDb.open()
    sectorService = new SectorService(starbaseDb.getDb(), workspacePath)
    configService = new ConfigService(starbaseDb.getDb())

    // Phase 5 services
    supplyRouteService = new SupplyRouteService(starbaseDb.getDb())
    cargoService = new CargoService(starbaseDb.getDb(), supplyRouteService, configService)
    retentionService = new RetentionService(
      starbaseDb.getDb(),
      configService,
      starbaseDb.getDbPath()
    )

    // Acquire lockfile
    const basePath = dirname(starbaseDb.getDbPath())
    lockfile = new Lockfile(basePath, starbaseDb.getStarbaseId())
    const lockResult = lockfile.acquire()
    if (lockResult === 'read-only') {
      console.warn('[starbase] Another Fleet instance manages this Starbase — read-only mode')
    }

    // Phase 2 services
    missionService = new MissionService(starbaseDb.getDb())
    const worktreeBasePath = join(basePath, 'worktrees')
    const worktreeManager = new WorktreeManager(worktreeBasePath)

    // Configure worktree manager with concurrency limits
    const maxConcurrent = configService.get('max_concurrent_worktrees') as number
    worktreeManager.configure(starbaseDb.getDb(), maxConcurrent)

    crewService = new CrewService({
      db: starbaseDb.getDb(),
      starbaseId: starbaseDb.getStarbaseId(),
      sectorService,
      missionService,
      configService,
      worktreeManager
    })

    // Phase 3 services
    commsService = new CommsService(starbaseDb.getDb())
    const commsRateLimit = configService.get('comms_rate_limit_per_min') as number
    commsService.setRateLimit(commsRateLimit)

    const createTab = (label: string, cwd: string): string => {
      const tabId = crypto.randomUUID()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fleet:create-tab', { tabId, label, cwd })
      }
      return tabId
    }

    admiral = new Admiral({
      workspacePath,
      sectorService,
      missionService,
      crewService,
      commsService,
      configService,
      toolDeps: {
        sectorService,
        missionService,
        crewService,
        commsService,
        ptyManager,
        createTab
      }
    })

    // Phase 4: Run reconciliation on startup
    if (lockResult === 'acquired') {
      runReconciliation({
        db: starbaseDb.getDb(),
        starbaseId: starbaseDb.getStarbaseId(),
        worktreeBasePath
      })
        .then((summary) => {
          if (summary.lostCrew.length > 0 || summary.requeuedMissions.length > 0) {
            console.log('[starbase] Reconciliation summary:', JSON.stringify(summary))
          }
        })
        .catch((err) => {
          console.error('[starbase] Reconciliation failed:', err)
        })

      // Start Sentinel watchdog
      sentinel = new Sentinel({ db: starbaseDb.getDb(), configService })
      sentinel.start()

      // Push status updates to renderer every 5 seconds
      setInterval(() => {
        const w = mainWindow
        if (!w || w.isDestroyed()) return
        w.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
          crew: crewService.listCrew(),
          missions: missionService.listMissions(),
          sectors: sectorService.listSectors(),
          unreadCount: commsService.getUnread('admiral').length
        })
      }, 5000)
    }

    // Auto-create Star Command tab on workspace load
    layoutStore.ensureStarCommandTab('default', workspacePath)
  } catch (err) {
    console.error('[starbase] Failed to initialize Star Command database:', err)
  }

  registerIpcHandlers(
    ptyManager,
    layoutStore,
    eventBus,
    notificationDetector,
    notificationState,
    settingsStore,
    cwdPoller,
    gitService,
    () => mainWindow,
    sectorService,
    configService,
    crewService,
    missionService,
    admiral,
    commsService,
    supplyRouteService,
    cargoService,
    retentionService
  )

  // Wire socket command handler to the window
  commandHandler.setWindowGetter(() => mainWindow)

  // Wire starbase services to socket command handler
  if (sectorService && configService) {
    commandHandler.setStarbaseServices(sectorService, configService)
  }

  // Wire Phase 2 services to socket command handler
  if (crewService && missionService) {
    commandHandler.setPhase2Services(crewService, missionService)
  }

  // Prune stale push-pending worktrees from previous sessions
  crewService?.pruneStaleWorktrees();

  // Start socket API
  socketApi.start().catch((err) => {
    console.error('Failed to start socket API:', err)
  })

  // Wire JSONL watcher to agent state tracker
  // Maps JSONL sessionId → Fleet paneId
  const sessionToPaneMap = new Map<string, string>()

  jsonlWatcher.onRecord((sessionId, record) => {
    // Already mapped?
    const existingPane = sessionToPaneMap.get(sessionId)
    if (existingPane) {
      agentTracker.handleJsonlRecord(existingPane, record)
      return
    }

    // Correlate by matching the record's cwd to a pane's cwd
    // Use the most specific (longest) matching pane CWD to avoid
    // parent dirs like ~ matching everything.
    const recordCwd = (record as { cwd?: string }).cwd
    if (recordCwd) {
      const mappedPanes = new Set(sessionToPaneMap.values())
      const activePanes = ptyManager.paneIds()

      let bestPane: string | null = null
      let bestLen = 0

      for (const paneId of activePanes) {
        if (mappedPanes.has(paneId)) continue
        const paneCwd = ptyManager.getCwd(paneId)
        if (paneCwd && recordCwd.startsWith(paneCwd) && paneCwd.length > bestLen) {
          bestPane = paneId
          bestLen = paneCwd.length
        }
      }

      if (bestPane) {
        sessionToPaneMap.set(sessionId, bestPane)
        agentTracker.handleJsonlRecord(bestPane, record)
        return
      }
    }
  })

  jsonlWatcher.start()

  // Forward agent state changes to renderer and socket API
  eventBus.on('agent-state-change', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATE, {
        states: agentTracker.getAllStates()
      })
    }

    socketApi.broadcastEvent('agent-state-change', {
      paneId: event.paneId,
      state: event.state,
      tool: event.tool
    })
  })

  // Clean up session mapping and CWD polling when panes close
  eventBus.on('pane-closed', (event) => {
    cwdPoller.stopPolling(event.paneId)
    for (const [sessionId, paneId] of sessionToPaneMap) {
      if (paneId === event.paneId) {
        sessionToPaneMap.delete(sessionId)
        break
      }
    }
  })

  // Forward CWD changes to renderer and keep ptyManager in sync
  eventBus.on('cwd-changed', (event) => {
    ptyManager.updateCwd(event.paneId, event.cwd)
    cwdPoller.markOsc7Seen(event.paneId)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.PTY_CWD, {
        paneId: event.paneId,
        cwd: event.cwd
      })
    }
  })

  // Forward notification events to renderer
  eventBus.on('notification', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.NOTIFICATION, {
        paneId: event.paneId,
        level: event.level,
        timestamp: event.timestamp
      })
    }
  })

  // Broadcast events to socket subscribers
  eventBus.on('notification', (event) => {
    socketApi.broadcastEvent('notification', {
      paneId: event.paneId,
      level: event.level,
      timestamp: event.timestamp
    })
  })

  eventBus.on('pane-created', (event) => {
    socketApi.broadcastEvent('pane-created', { paneId: event.paneId })
  })

  eventBus.on('pane-closed', (event) => {
    socketApi.broadcastEvent('pane-closed', { paneId: event.paneId })
  })

  eventBus.on('workspace-loaded', (event) => {
    socketApi.broadcastEvent('workspace-loaded', { workspaceId: event.workspaceId })
  })

  // Emit notification on PTY exit
  eventBus.on('pty-exit', (event) => {
    const level = event.exitCode !== 0 ? 'error' : 'subtle'
    eventBus.emit('notification', {
      type: 'notification',
      paneId: event.paneId,
      level,
      timestamp: Date.now()
    })
  })

  // OS notifications — coalesced to prevent burst fatigue (Baymard/NNG)
  let pendingOsNotifications: Array<{ paneId: string; level: string }> = []
  let osNotifTimer: ReturnType<typeof setTimeout> | null = null
  const OS_NOTIF_BATCH_MS = 500 // batch window for coalescing

  function flushOsNotifications(): void {
    if (pendingOsNotifications.length === 0) return

    const batch = pendingOsNotifications
    pendingOsNotifications = []
    osNotifTimer = null

    if (!Notification.isSupported()) return

    const hasPermission = batch.some((n) => n.level === 'permission')
    const hasError = batch.some((n) => n.level === 'error')

    let body: string
    if (batch.length === 1) {
      body = hasPermission
        ? 'An agent needs your permission'
        : hasError
          ? 'A process exited with an error'
          : 'Task completed'
    } else {
      const parts: string[] = []
      const permCount = batch.filter((n) => n.level === 'permission').length
      const errCount = batch.filter((n) => n.level === 'error').length
      const infoCount = batch.length - permCount - errCount
      if (permCount > 0) parts.push(`${permCount} need${permCount > 1 ? '' : 's'} permission`)
      if (errCount > 0) parts.push(`${errCount} error${errCount > 1 ? 's' : ''}`)
      if (infoCount > 0) parts.push(`${infoCount} completed`)
      body = `${batch.length} agents: ${parts.join(', ')}`
    }

    const notif = new Notification({ title: 'Fleet', body })
    notif.on('click', () => {
      mainWindow?.show()
      mainWindow?.focus()
      // Focus the first pane from the batch (most recent high-priority)
      const target =
        batch.find((n) => n.level === 'permission') ??
        batch.find((n) => n.level === 'error') ??
        batch[0]
      mainWindow?.webContents.send('fleet:focus-pane', { paneId: target.paneId })
    })
    notif.show()
  }

  eventBus.on('notification', (event) => {
    const settings = settingsStore.get()

    const settingsKey = {
      permission: 'needsPermission',
      error: 'processExitError',
      info: 'taskComplete',
      subtle: 'processExitClean'
    }[event.level] as keyof typeof settings.notifications

    const config = settings.notifications[settingsKey]

    if (config.os) {
      pendingOsNotifications.push({ paneId: event.paneId, level: event.level })
      if (!osNotifTimer) {
        osNotifTimer = setTimeout(flushOsNotifications, OS_NOTIF_BATCH_MS)
      }
    }
  })

  createWindow()

  // --- Auto-updater: unified status pipeline ---
  // Allow checking for updates in dev mode via dev-app-update.yml
  autoUpdater.forceDevUpdateConfig = true

  let updateState: 'idle' | 'checking' | 'downloading' | 'ready' = 'idle'
  let pendingVersion = ''
  let pendingReleaseNotes = ''

  function normalizeReleaseNotes(
    notes: string | Array<{ note: string }> | null | undefined
  ): string {
    if (!notes) return ''
    if (typeof notes === 'string') return notes
    if (Array.isArray(notes)) return notes.map((n) => n.note).join('\n')
    return ''
  }

  function sendUpdateStatus(status: import('../shared/types').UpdateStatus): void {
    console.log('[auto-updater] status:', status.state)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fleet:update-status', status)
    }
  }

  autoUpdater.on('checking-for-update', () => {
    updateState = 'checking'
    sendUpdateStatus({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    updateState = 'downloading'
    pendingVersion = info.version
    pendingReleaseNotes = normalizeReleaseNotes(
      info.releaseNotes as string | Array<{ note: string }> | null
    )
    sendUpdateStatus({
      state: 'downloading',
      version: pendingVersion,
      releaseNotes: pendingReleaseNotes,
      percent: 0
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      state: 'downloading',
      version: pendingVersion,
      releaseNotes: pendingReleaseNotes,
      percent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', () => {
    updateState = 'ready'
    sendUpdateStatus({
      state: 'ready',
      version: pendingVersion,
      releaseNotes: pendingReleaseNotes
    })
  })

  autoUpdater.on('update-not-available', () => {
    updateState = 'idle'
    sendUpdateStatus({ state: 'not-available' })
  })

  autoUpdater.on('error', (err) => {
    updateState = 'idle'
    sendUpdateStatus({ state: 'error', message: err?.message ?? 'Unknown error' })
  })

  ipcMain.handle('fleet:update-check', async () => {
    if (updateState === 'checking' || updateState === 'downloading') return
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      sendUpdateStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Update check failed'
      })
    }
  })

  ipcMain.handle('fleet:get-version', () => app.getVersion())

  ipcMain.on('fleet:install-update', () => {
    autoUpdater.quitAndInstall()
  })

  // Silent check on launch (packaged builds only)
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Auto-update check failed:', err)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  ptyManager.killAll()
  cwdPoller.stopAll()
  socketApi.stop()
  jsonlWatcher.stop()
  if (sentinel) sentinel.stop()
  if (lockfile) lockfile.release()
  // starbaseDb is scoped inside whenReady — close is handled by process exit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
