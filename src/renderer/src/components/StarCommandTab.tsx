import { useRef, useState, useEffect, useCallback } from 'react'
import { useStarCommandStore } from '../store/star-command-store'
import { StarCommandConfig } from './StarCommandConfig'
import { CrtFrame } from './star-command/CrtFrame'
import { Avatar } from './star-command/Avatar'
import { StarCommandScene } from './star-command/StarCommandScene'
import { StatusBar } from './star-command/StatusBar'
import { useTerminal } from '../hooks/use-terminal'

function AdmiralTerminal({ paneId }: { paneId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(containerRef, {
    paneId,
    cwd: '',
    attachOnly: true,
    isActive: true,
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
  } = useStarCommandStore()

  const [view, setView] = useState<'terminal' | 'config'>('terminal')
  const [talkFrame, setTalkFrame] = useState(false)

  // Oscillate talk frame while admiral is speaking
  useEffect(() => {
    if (admiralAvatarState !== 'speaking') { setTalkFrame(false); return }
    const interval = setInterval(() => setTalkFrame((f) => !f), 300)
    return () => clearInterval(interval)
  }, [admiralAvatarState])

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
  }, [setCrewList, setMissionQueue, setSectors])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  return (
    <div className="h-full flex">
      {/* Terminal panel wrapped in CRT frame */}
      <CrtFrame>
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

              {/* Admiral status indicator */}
              <div className="flex items-center gap-2">
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

                {/* Admiral avatar — fixed at bottom-left when terminal is active */}
                {admiralPaneId && (
                  <div className="absolute bottom-2 left-3 flex flex-col items-center gap-1 pointer-events-none z-10">
                    <Avatar
                      type="admiral"
                      variant={admiralAvatarState === 'speaking' ? (talkFrame ? 'speaking' : 'default') : admiralAvatarState}
                      size={64}
                    />
                    <span className="text-[9px] font-mono text-teal-400 uppercase tracking-widest">
                      Admiral
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Status bar */}
            <StatusBar />
          </div>
        </div>
      </CrtFrame>

      <StarCommandScene className="flex-1 min-w-[280px]" />
    </div>
  )
}
