import { app, BrowserWindow, ipcMain, Notification, nativeImage } from 'electron'
import { fileURLToPath } from 'url'
import { join, dirname, basename } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'
import { PtyManager } from './pty-manager'
import { LayoutStore } from './layout-store'
import { EventBus } from './event-bus'
import { NotificationDetector } from './notification-detector'
import { NotificationStateManager } from './notification-state'
import { registerIpcHandlers } from './ipc-handlers'
import { GitService } from './git-service'
import { SettingsStore } from './settings-store'
import { IPC_CHANNELS, SOCKET_PATH } from '../shared/constants'
import { SocketSupervisor } from './socket-supervisor'
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
import { AdmiralProcess } from './starbase/admiral-process'
import { AdmiralStateDetector } from './starbase/admiral-state-detector'
import { ShipsLog } from './starbase/ships-log'
import { Sentinel } from './starbase/sentinel'
import { runReconciliation } from './starbase/reconciliation'
import { FirstOfficer } from './starbase/first-officer'
import { Navigator } from './starbase/navigator'
import { Lockfile } from './starbase/lockfile'
import { SupplyRouteService } from './starbase/supply-route-service'
import { CargoService } from './starbase/cargo-service'
import { RetentionService } from './starbase/retention-service'
import { ProtocolService } from './starbase/protocol-service'
import { installFleetCLI } from './install-fleet-cli'
import { enrichProcessEnv } from './shell-env'
import type { StarbaseRuntimeStatus } from '../shared/ipc-api'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

let mainWindow: BrowserWindow | null = null
let sentinel: Sentinel | null = null
let lastUnreadCommsCount = 0
let lastUnreadMemosCount = 0
let lockfile: Lockfile | null = null
let socketSupervisor: SocketSupervisor | null = null
let admiralProcess: AdmiralProcess | null = null
let crewServiceRef: CrewService | null = null
let firstOfficerRef: FirstOfficer | null = null
let navigatorRef: Navigator | null = null
const ptyManager = new PtyManager()
const layoutStore = new LayoutStore()
const eventBus = new EventBus()
const settingsStore = new SettingsStore()
const notificationDetector = new NotificationDetector(eventBus)
const notificationState = new NotificationStateManager(eventBus)
const commandHandler = new FleetCommandHandler(ptyManager, layoutStore, eventBus, notificationState)
const cwdPoller = new CwdPoller(eventBus, ptyManager)
const agentTracker = new AgentStateTracker(eventBus)
const jsonlWatcher = new JsonlWatcher(CLAUDE_PROJECTS_DIR)
const admiralStateDetector = new AdmiralStateDetector(eventBus)

type StarbaseServiceRefs = {
  starbaseDb: StarbaseDB | null
  sectorService: SectorService | null
  configService: ConfigService | null
  missionService: MissionService | null
  crewService: CrewService | null
  commsService: CommsService | null
  supplyRouteService: SupplyRouteService | null
  cargoService: CargoService | null
  retentionService: RetentionService | null
  protocolService: ProtocolService | null
  admiralProcess: AdmiralProcess | null
  firstOfficer: FirstOfficer | null
  navigator: Navigator | null
}

const starbaseServices: StarbaseServiceRefs = {
  starbaseDb: null,
  sectorService: null,
  configService: null,
  missionService: null,
  crewService: null,
  commsService: null,
  supplyRouteService: null,
  cargoService: null,
  retentionService: null,
  protocolService: null,
  admiralProcess: null,
  firstOfficer: null,
  navigator: null,
}

let runtimeStatus: StarbaseRuntimeStatus = { state: 'starting' }

function setRuntimeStatus(status: StarbaseRuntimeStatus): void {
  runtimeStatus = status
  const windowRef = mainWindow
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.webContents.send(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_CHANGED, status)
  }
}

let starbaseSnapshotTimer: ReturnType<typeof setTimeout> | null = null

function getUnreadMemoCount(): number {
  const db = starbaseServices.starbaseDb?.getDb()
  if (!db) return 0
  return (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM comms WHERE type IN ('memo', 'hailing-memo') AND to_crew = 'admiral' AND read = 0"
      )
      .get() as { cnt: number }
  ).cnt
}

function flushStarbaseSnapshot(): void {
  starbaseSnapshotTimer = null

  const windowRef = mainWindow
  const { crewService, missionService, sectorService, commsService, firstOfficer, starbaseDb } =
    starbaseServices
  if (
    !windowRef ||
    windowRef.isDestroyed() ||
    !crewService ||
    !missionService ||
    !sectorService ||
    !commsService ||
    !firstOfficer
  ) {
    return
  }

  const unreadComms = commsService.getUnread('admiral')
  const unreadMemosCount = getUnreadMemoCount()

  windowRef.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
    crew: crewService.listCrew(),
    missions: missionService.listMissions(),
    sectors: sectorService.listVisibleSectors(),
    unreadCount: unreadComms.length,
    firstOfficer: {
      status: firstOfficer.getStatus(),
      statusText: firstOfficer.getStatusText(),
      unreadMemos: unreadMemosCount,
    },
  })

  if (starbaseDb) {
    const recentEntry = starbaseDb
      .getDb()
      .prepare(`
        SELECT 'ships_log' as source, id, crew_id as actor, NULL as target, event_type as eventType, detail, created_at as timestamp FROM ships_log
        UNION ALL
        SELECT 'comms', id, from_crew, to_crew, type, payload, created_at FROM comms WHERE type NOT IN ('memo', 'hailing-memo')
        ORDER BY timestamp DESC LIMIT 1
      `)
      .get()
    if (recentEntry) {
      windowRef.webContents.send(IPC_CHANNELS.STARBASE_LOG_ENTRY, recentEntry)
    }
  }

  if (unreadComms.length > lastUnreadCommsCount && Notification.isSupported()) {
    const settings = settingsStore.get()
    if (settings.notifications.comms.os) {
      const newComms = unreadComms.slice(lastUnreadCommsCount)
      const body =
        newComms.length === 1
          ? `New transmission from ${newComms[0].from_crew ?? 'crew'}`
          : `${newComms.length} new transmissions`
      const notif = new Notification({ title: 'Fleet', body })
      notif.on('click', () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send(IPC_CHANNELS.FOCUS_COMMS)
      })
      notif.show()
    }
  }
  lastUnreadCommsCount = unreadComms.length

  if (unreadMemosCount > lastUnreadMemosCount && Notification.isSupported()) {
    const settings = settingsStore.get()
    if (settings.notifications.memos.os) {
      const notif = new Notification({
        title: 'Fleet — First Officer',
        body: 'New memo requires review',
      })
      notif.on('click', () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send(IPC_CHANNELS.FOCUS_FIRST_OFFICER)
      })
      notif.show()
    }
  }
  lastUnreadMemosCount = unreadMemosCount
}

function scheduleStarbaseSnapshot(): void {
  if (starbaseSnapshotTimer) return
  starbaseSnapshotTimer = setTimeout(() => flushStarbaseSnapshot(), 25)
}

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

app.whenReady().then(async () => {
  createWindow()

  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    const dockIconPath = join(dirname(fileURLToPath(import.meta.url)), '../../build/icon.png')
    const dockIcon = nativeImage.createFromPath(dockIconPath)
    if (!dockIcon.isEmpty()) {
      app.dock?.setIcon(dockIcon)
    }
  }

  const gitService = new GitService()
  const workspacePath = process.cwd()
  const envReady = enrichProcessEnv()
  const cliReady = installFleetCLI()
    .catch((err) => {
      console.error('[fleet-cli] Failed to install CLI binary:', err)
      return join(homedir(), '.fleet', 'bin')
    })
    .then((fleetBinPath) => {
      const pathDirs = (process.env.PATH ?? '').split(':')
      if (!pathDirs.includes(fleetBinPath)) {
        process.env.PATH = fleetBinPath + ':' + (process.env.PATH ?? '')
      }
      return fleetBinPath
    })

  let starbaseReadyPromise: Promise<void> = Promise.resolve()
  let starbaseBootstrapInFlight: Promise<void> | null = null

  const bootstrapStarbase = async (): Promise<void> => {
    if (runtimeStatus.state === 'ready') return
    if (starbaseBootstrapInFlight) return starbaseBootstrapInFlight

    setRuntimeStatus({ state: 'starting' })
    starbaseBootstrapInFlight = (async () => {
      let localStarbaseDb: StarbaseDB | null = null
      let localLockfile: Lockfile | null = null
      let localSocketSupervisor: SocketSupervisor | null = null
      let localAdmiralProcess: AdmiralProcess | null = null
      let localFirstOfficer: FirstOfficer | null = null
      let localNavigator: Navigator | null = null
      let localSentinel: Sentinel | null = null

      try {
        await Promise.all([envReady, cliReady])
        const fleetBinPath = await cliReady

        localStarbaseDb = new StarbaseDB(workspacePath)
        localStarbaseDb.open()
        const sectorService = new SectorService(localStarbaseDb.getDb(), workspacePath, eventBus)
        const configService = new ConfigService(localStarbaseDb.getDb())
        const supplyRouteService = new SupplyRouteService(localStarbaseDb.getDb())
        const cargoService = new CargoService(localStarbaseDb.getDb(), supplyRouteService, configService)
        const retentionService = new RetentionService(
          localStarbaseDb.getDb(),
          configService,
          localStarbaseDb.getDbPath()
        )

        const basePath = dirname(localStarbaseDb.getDbPath())
        localLockfile = new Lockfile(basePath, localStarbaseDb.getStarbaseId())
        const lockResult = localLockfile.acquire()
        if (lockResult === 'read-only') {
          console.warn('[starbase] Another Fleet instance manages this Starbase — read-only mode')
        }

        const missionService = new MissionService(localStarbaseDb.getDb(), eventBus)
        const worktreeBasePath = join(basePath, 'worktrees')
        const worktreeManager = new WorktreeManager(worktreeBasePath)
        const maxConcurrent = configService.get('max_concurrent_worktrees') as number
        worktreeManager.configure(localStarbaseDb.getDb(), maxConcurrent)

        const crewEnv: Record<string, string> = {
          ...(process.env as Record<string, string>),
        }

        const crewService = new CrewService({
          db: localStarbaseDb.getDb(),
          starbaseId: localStarbaseDb.getStarbaseId(),
          sectorService,
          missionService,
          configService,
          worktreeManager,
          eventBus,
          crewEnv,
        })

        const commsService = new CommsService(localStarbaseDb.getDb(), eventBus)
        const commsRateLimit = configService.get('comms_rate_limit_per_min') as number
        commsService.setRateLimit(commsRateLimit)

        const protocolService = new ProtocolService(localStarbaseDb.getDb())
        localFirstOfficer = new FirstOfficer({
          db: localStarbaseDb.getDb(),
          configService,
          missionService,
          crewService,
          cargoService,
          eventBus,
          starbaseId: localStarbaseDb.getStarbaseId(),
          crewEnv,
          fleetBinDir: fleetBinPath,
        })

        localNavigator = new Navigator({
          db: localStarbaseDb.getDb(),
          configService,
          eventBus,
          starbaseId: localStarbaseDb.getStarbaseId(),
          crewEnv,
          fleetBinDir: fleetBinPath,
        })

        const shipsLog = new ShipsLog(localStarbaseDb.getDb())
        localSocketSupervisor = new SocketSupervisor(SOCKET_PATH, {
          crewService,
          missionService,
          commsService,
          sectorService,
          cargoService,
          supplyRouteService,
          configService,
          shipsLog,
          protocolService,
        })

        localSocketSupervisor.on('state-change', (event: string, data: unknown) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, { event, data })
          }
        })

        localSocketSupervisor.on('restarted', () => {
          console.log('[socket-supervisor] Socket server restarted')
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
              event: 'socket:restarted',
              data: {},
            })
          }
        })

        localSocketSupervisor.on('failed', () => {
          console.error('[socket-supervisor] Socket server permanently failed')
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
              event: 'socket:failed',
              data: {},
            })
          }
        })

        localSocketSupervisor.on('file-open', (payload: unknown) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.FILE_OPEN_IN_TAB, payload)
          }
        })

        localSocketSupervisor.start().catch((err) => {
          console.error('[socket-supervisor] Failed to start:', err)
        })

        const starbaseId = localStarbaseDb.getStarbaseId()
        const admiralWorkspace = join(
          homedir(),
          '.fleet',
          'starbases',
          `starbase-${starbaseId}`,
          'admiral'
        )
        const starbaseName =
          (configService.get('starbase_name') as string | undefined) ?? basename(workspacePath)

        localAdmiralProcess = new AdmiralProcess({
          workspace: admiralWorkspace,
          starbaseName,
          sectors: sectorService.listVisibleSectors().map((s) => ({
            name: s.name,
            root_path: s.root_path,
            stack: s.stack ?? undefined,
            base_branch: s.base_branch ?? undefined,
          })),
          ptyManager,
          fleetBinPath,
        })

        localAdmiralProcess.setOnStatusChange((status, error, exitCode) => {
          if (status === 'stopped') {
            admiralStateDetector.reset()
            admiralStateDetector.setAdmiralPaneId(null)
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, {
              status,
              paneId: localAdmiralProcess!.paneId,
              error,
              exitCode,
            })
          }
        })

        if (lockResult === 'acquired') {
          runReconciliation({
            db: localStarbaseDb.getDb(),
            starbaseId: localStarbaseDb.getStarbaseId(),
            worktreeBasePath,
          })
            .then((summary) => {
              if (summary.lostCrew.length > 0 || summary.requeuedMissions.length > 0) {
                console.log('[starbase] Reconciliation summary:', JSON.stringify(summary))
              }
            })
            .catch((err) => {
              console.error('[starbase] Reconciliation failed:', err)
            })

          localFirstOfficer.reconcile()
          localNavigator.reconcile()

          const foWorkspace = join(
            process.env.HOME ?? '~',
            '.fleet',
            'starbases',
            `starbase-${localStarbaseDb.getStarbaseId()}`,
            'first-officer'
          )
          mkdirSync(join(foWorkspace, 'memos'), { recursive: true })

          localSentinel = new Sentinel({
            db: localStarbaseDb.getDb(),
            configService,
            eventBus,
            supervisor: localSocketSupervisor ?? undefined,
            socketPath: SOCKET_PATH,
            firstOfficer: localFirstOfficer,
            crewService,
            settingsStore,
            navigator: localNavigator,
            onNudgeClick: () => {
              mainWindow?.show()
              mainWindow?.focus()
              mainWindow?.webContents.send(IPC_CHANNELS.FOCUS_COMMS)
            },
          })
          localSentinel.start()
        }

        starbaseServices.starbaseDb = localStarbaseDb
        starbaseServices.sectorService = sectorService
        starbaseServices.configService = configService
        starbaseServices.missionService = missionService
        starbaseServices.crewService = crewService
        starbaseServices.commsService = commsService
        starbaseServices.supplyRouteService = supplyRouteService
        starbaseServices.cargoService = cargoService
        starbaseServices.retentionService = retentionService
        starbaseServices.protocolService = protocolService
        starbaseServices.admiralProcess = localAdmiralProcess
        starbaseServices.firstOfficer = localFirstOfficer
        starbaseServices.navigator = localNavigator

        lockfile = localLockfile
        socketSupervisor = localSocketSupervisor
        admiralProcess = localAdmiralProcess
        crewServiceRef = crewService
        firstOfficerRef = localFirstOfficer
        navigatorRef = localNavigator
        sentinel = localSentinel

        commandHandler.setStarbaseServices(sectorService, configService)
        commandHandler.setPhase2Services(crewService, missionService)

        lastUnreadCommsCount = commsService.getUnread('admiral').length
        lastUnreadMemosCount = getUnreadMemoCount()
        layoutStore.ensureStarCommandTab('default', workspacePath)
        scheduleStarbaseSnapshot()
        setRuntimeStatus({ state: 'ready' })
      } catch (err) {
        localSentinel?.stop()
        localFirstOfficer?.shutdown()
        localNavigator?.shutdown()
        localSocketSupervisor?.stop().catch(() => {})
        localAdmiralProcess?.stop().catch(() => {})
        localLockfile?.release()
        localStarbaseDb?.close()
        const message = err instanceof Error ? err.message : String(err)
        console.error('[starbase] Failed to initialize Star Command database:', err)
        setRuntimeStatus({ state: 'error', error: message })
        throw err
      } finally {
        starbaseBootstrapInFlight = null
      }
    })()

    starbaseReadyPromise = starbaseBootstrapInFlight
    return starbaseReadyPromise
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
    () => ({
      envReady,
      cliReady,
      starbaseReady: starbaseReadyPromise,
      getRuntimeStatus: () => runtimeStatus,
      retryStarbaseBootstrap: async () => {
        try {
          await bootstrapStarbase()
        } catch {
          // status is already updated for renderer consumption
        }
        return runtimeStatus
      },
    }),
    () => ({
      sectorService: starbaseServices.sectorService,
      configService: starbaseServices.configService,
      crewService: starbaseServices.crewService,
      missionService: starbaseServices.missionService,
      admiralProcess: starbaseServices.admiralProcess,
      commsService: starbaseServices.commsService,
      supplyRouteService: starbaseServices.supplyRouteService,
      cargoService: starbaseServices.cargoService,
      retentionService: starbaseServices.retentionService,
      admiralStateDetector,
      starbaseDb: starbaseServices.starbaseDb,
    })
  )

  // Wire socket command handler to the window
  commandHandler.setWindowGetter(() => mainWindow)

  const startAdmiralAndWire = async (): Promise<string | null> => {
    const admiralProcessRef = starbaseServices.admiralProcess
    if (!admiralProcessRef) return null
    try {
      const paneId = await admiralProcessRef.start()
      admiralStateDetector.setAdmiralPaneId(paneId)
      ptyManager.onData(paneId, (data) => {
        notificationDetector.scan(paneId, data)
        admiralStateDetector.scan(paneId, data)
        const w = mainWindow
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId, data })
        }
      })
      ptyManager.onExit(paneId, (exitCode) => {
        const w = mainWindow
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.PTY_EXIT, { paneId, exitCode })
        }
        eventBus.emit('pty-exit', { type: 'pty-exit', paneId, exitCode })
      })
      cwdPoller.startPolling(paneId, ptyManager.getPid(paneId) ?? 0)
      return paneId
    } catch (err) {
      console.error('[admiral] Failed to start:', err)
      return null
    }
  }

  ipcMain.handle('admiral:ensure-started', async () => {
    await Promise.all([envReady, cliReady])
    await bootstrapStarbase()
    const admiralProcessRef = starbaseServices.admiralProcess
    if (!admiralProcessRef) return null
    if (admiralProcessRef.paneId) return admiralProcessRef.paneId
    if (admiralProcessRef.status === 'starting') return null
    return startAdmiralAndWire()
  })

  eventBus.on('starbase-changed', () => {
    scheduleStarbaseSnapshot()
  })

  void bootstrapStarbase()


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

  // Forward admiral state detail changes to renderer
  eventBus.on('admiral-state-change', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, {
        state: event.state,
        statusText: event.statusText,
      })
    }
  })

  // Forward agent state changes to renderer
  eventBus.on('agent-state-change', (_event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATE, {
        states: agentTracker.getAllStates()
      })
    }
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

function shutdownAll(): void {
  crewServiceRef?.shutdown()
  firstOfficerRef?.shutdown()
  navigatorRef?.shutdown()
  ptyManager.killAll()
  cwdPoller.stopAll()
  socketSupervisor?.stop().catch((err) => console.error('[socket-supervisor] stop error:', err))
  admiralProcess?.stop().catch((err) => console.error('[admiral] stop error:', err))
  admiralStateDetector.dispose()
  jsonlWatcher.stop()
  if (sentinel) sentinel.stop()
  if (lockfile) lockfile.release()
}

app.on('window-all-closed', () => {
  shutdownAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Ensure child processes are cleaned up on unexpected termination
process.on('SIGTERM', () => { shutdownAll(); process.exit(0) })
process.on('SIGINT', () => { shutdownAll(); process.exit(0) })
