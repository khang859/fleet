import { useRef, useState, useEffect, useCallback } from 'react'
import { loadScSpriteSheet } from './star-command/sc-sprite-loader'
import { useStarCommandStore } from '../store/star-command-store'
import { StarCommandConfig } from './StarCommandConfig'
import { CrtFrame } from './star-command/CrtFrame'
import { Avatar } from './star-command/Avatar'
import { AdmiralSidebar } from './star-command/AdmiralSidebar'
import { StatusBar } from './star-command/StatusBar'
import { useTerminal } from '../hooks/use-terminal'

function AdmiralTerminal({ paneId }: { paneId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(containerRef, {
    paneId,
    cwd: '',
    attachOnly: true,
    isActive: true,
    // Claude Code draws its own TUI cursor; disable xterm's hardware cursor
    // to prevent a duplicate block cursor from appearing.
    cursorHidden: true,
  })
  return (
    <div className="h-full w-full p-2">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}

export function StarCommandTab() {
  const {
    admiralPaneId,
    admiralStatus,
    admiralError,
    setAdmiralPty,
    setCrewList,
    setMissionQueue,
    setSectors,
    setUnreadCount,
    admiralAvatarState,
    setAdmiralState,
  } = useStarCommandStore()

  const [view, setView] = useState<'terminal' | 'config'>('terminal')
  const [talkFrame, setTalkFrame] = useState(false)
  const [resetConfirm, setResetConfirm] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-dismiss reset confirmation after 5s (Baymard: time-limited destructive states)
  useEffect(() => {
    if (resetConfirm) {
      resetTimerRef.current = setTimeout(() => setResetConfirm(false), 5000)
      return () => {
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      }
    }
  }, [resetConfirm])

  // Oscillate talk frame while admiral is speaking
  useEffect(() => {
    if (admiralAvatarState !== 'speaking') { setTalkFrame(false); return }
    const interval = setInterval(() => setTalkFrame((f) => !f), 300)
    return () => clearInterval(interval)
  }, [admiralAvatarState])

  // Load sprite sheet (previously done by StarCommandScene)
  useEffect(() => { loadScSpriteSheet() }, [])

  // On mount: ensure Admiral is started and listen for status changes
  useEffect(() => {
    window.fleet.admiral.ensureStarted().then((paneId: string | null) => {
      if (paneId) {
        setAdmiralPty(paneId, 'running')
      }
    })

    const cleanup = window.fleet.admiral.onStatusChanged((data) => {
      setAdmiralPty(
        data.paneId,
        data.status as 'running' | 'stopped' | 'starting',
        data.error ?? null
      )
    })

    return cleanup
  }, [setAdmiralPty])

  // Listen for detailed admiral state changes (thinking, speaking, etc.)
  useEffect(() => {
    const cleanup = window.fleet.admiral.onStateDetail((data) => {
      setAdmiralState(
        data.state as 'standby' | 'thinking' | 'speaking' | 'alert',
        data.statusText
      )
    })
    return cleanup
  }, [setAdmiralState])

  // Listen for starbase status updates
  useEffect(() => {
    const cleanup = window.fleet.starbase.onStatusUpdate((payload: unknown) => {
      const p = payload as {
        crew?: unknown[]
        missions?: unknown[]
        sectors?: unknown[]
        unreadCount?: number
      }
      if (p.crew) setCrewList(p.crew as never[])
      if (p.missions) setMissionQueue(p.missions as never[])
      if (p.sectors) setSectors(p.sectors as never[])
      if (p.unreadCount !== undefined) setUnreadCount(p.unreadCount)
    })

    return cleanup
  }, [setCrewList, setMissionQueue, setSectors, setUnreadCount])

  // Initial status fetch + poll fallback
  const refreshStatus = useCallback(() => {
    window.fleet.starbase.listCrew().then((crew) => setCrewList(crew as never[]))
    window.fleet.starbase.listMissions().then((missions) => setMissionQueue(missions as never[]))
    window.fleet.starbase.listSectors().then((sectors) => setSectors(sectors as never[]))
    window.fleet.starbase.getUnreadComms().then((msgs) => setUnreadCount((msgs as unknown[]).length))
  }, [setCrewList, setMissionQueue, setSectors, setUnreadCount])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  return (
    <div className="h-full flex">
      {/* Terminal panel wrapped in CRT frame */}
      <CrtFrame className="flex-1 min-w-0">
        <div className="flex flex-1 min-h-0 min-w-0">
          {/* Main column */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {/* Header */}
            <div
              className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 bg-neutral-900 relative z-20"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <div className="flex items-center gap-2">
                <span className="text-yellow-400 text-lg">{'\u2605'}</span>
                <h2 className="text-sm font-semibold text-neutral-200">Star Command</h2>
                <div className="flex items-center ml-3 bg-neutral-800 rounded-md p-0.5">
                  <button
                    className={`text-xs px-2.5 py-1 rounded transition-colors ${
                      view === 'terminal'
                        ? 'bg-neutral-700 text-neutral-200'
                        : 'text-neutral-500 hover:text-neutral-300'
                    }`}
                    onClick={() => setView('terminal')}
                  >
                    Admiral
                  </button>
                  <button
                    className={`text-xs px-2.5 py-1 rounded transition-colors ${
                      view === 'config'
                        ? 'bg-neutral-700 text-neutral-200'
                        : 'text-neutral-500 hover:text-neutral-300'
                    }`}
                    onClick={() => setView('config')}
                  >
                    Config
                  </button>
                </div>
              </div>

              {/* Admiral status + reset */}
              <div className="flex items-center gap-3">
                {/* Two-step reset confirmation (NNG: explicit destructive action confirmation) */}
                {resetConfirm ? (
                  <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-800/50 rounded-md px-2 py-1">
                    <span className="text-[10px] text-red-300 mr-1">Delete workspace &amp; restart?</span>
                    <button
                      className="text-[10px] px-2 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded transition-colors font-medium"
                      onClick={() => {
                        setResetConfirm(false)
                        setAdmiralPty(null, 'starting')
                        window.fleet.admiral.reset().then((paneId) => {
                          setAdmiralPty(paneId, 'running')
                        }).catch((err: Error) => {
                          setAdmiralPty(null, 'stopped', err.message)
                        })
                      }}
                    >
                      Confirm
                    </button>
                    <button
                      className="text-[10px] px-2 py-0.5 text-neutral-400 hover:text-neutral-200 transition-colors"
                      onClick={() => setResetConfirm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="text-[10px] text-neutral-500 hover:text-red-400 transition-colors"
                    title="Reset Admiral workspace"
                    onClick={() => setResetConfirm(true)}
                  >
                    Reset
                  </button>
                )}

                <span
                  className={`w-2 h-2 rounded-full ${
                    admiralStatus === 'running'
                      ? 'bg-green-400'
                      : admiralStatus === 'starting'
                        ? 'bg-yellow-400 animate-pulse'
                        : 'bg-red-500'
                  }`}
                />
                <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
                  {admiralStatus}
                </span>
              </div>
            </div>

            {view === 'config' ? (
              <StarCommandConfig />
            ) : (
              <div className="flex-1 relative min-h-0">
                {/* Admiral terminal */}
                {admiralPaneId ? (
                  <AdmiralTerminal paneId={admiralPaneId} />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-600">
                    <p className="text-sm">
                      {admiralStatus === 'starting' ? 'Starting Admiral...' : 'Admiral offline'}
                    </p>
                    {admiralError && (
                      <p className="text-xs text-red-400 mt-1 max-w-xs text-center">{admiralError}</p>
                    )}
                  </div>
                )}

                {/* Offline overlay with restart button */}
                {admiralStatus === 'stopped' && admiralPaneId === null && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-950/80 backdrop-blur-sm z-20">
                    <Avatar
                      type="admiral"
                      variant="standby"
                      size={64}
                    />
                    <p className="text-sm text-neutral-400 mt-3">Admiral offline</p>
                    {admiralError && (
                      <p className="text-xs text-red-400 mt-1 max-w-xs text-center">{admiralError}</p>
                    )}
                    <button
                      className="mt-4 px-4 py-2 bg-teal-700 hover:bg-teal-600 text-white text-sm font-medium rounded-lg transition-colors"
                      onClick={() => {
                        setAdmiralPty(null, 'starting')
                        window.fleet.admiral.restart().then((paneId) => {
                          setAdmiralPty(paneId, 'running')
                        }).catch((err: Error) => {
                          setAdmiralPty(null, 'stopped', err.message)
                        })
                      }}
                    >
                      Restart Admiral
                    </button>
                  </div>
                )}

              </div>
            )}

            {/* Status bar */}
            <StatusBar />
          </div>
        </div>
      </CrtFrame>

      <AdmiralSidebar
        avatarVariant={admiralAvatarState === 'speaking' ? (talkFrame ? 'speaking' : 'default') : admiralAvatarState}
      />
    </div>
  )
}
