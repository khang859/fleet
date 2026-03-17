import { useState, useRef, useEffect, useCallback } from 'react'
import { useStarCommandStore } from '../store/star-command-store'
import type { AdmiralChatMessage } from '../store/star-command-store'
import { StarCommandConfig } from './StarCommandConfig'
import { CrtFrame } from './star-command/CrtFrame'
import { Avatar } from './star-command/Avatar'
import { StarCommandScene } from './star-command/StarCommandScene'

type StreamChunk = {
  type: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  result?: string
  error?: string
}

function MessageBubble({ msg }: { msg: AdmiralChatMessage }) {
  const [toolExpanded, setToolExpanded] = useState(false)

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] px-3 py-2 rounded-lg bg-blue-600/70 text-white text-sm whitespace-pre-wrap backdrop-blur-sm">
          {msg.content}
        </div>
      </div>
    )
  }

  if (msg.role === 'tool') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] px-3 py-1.5 rounded-lg bg-neutral-800/70 border border-neutral-700/50 text-xs backdrop-blur-sm">
          <button
            className="flex items-center gap-1 text-neutral-400 hover:text-neutral-200"
            onClick={() => setToolExpanded(!toolExpanded)}
          >
            <span className="text-xs">{toolExpanded ? '\u25BC' : '\u25B6'}</span>
            <span className="font-mono">{msg.toolName}</span>
            {msg.toolResult ? (
              <span className="text-green-400 ml-1">done</span>
            ) : (
              <span className="text-yellow-400 ml-1 animate-pulse">running...</span>
            )}
          </button>
          {toolExpanded && (
            <div className="mt-1 space-y-1">
              {msg.toolInput && (
                <pre className="text-neutral-500 overflow-x-auto text-xs">
                  {JSON.stringify(msg.toolInput, null, 2)}
                </pre>
              )}
              {msg.toolResult && (
                <pre className="text-neutral-400 overflow-x-auto text-xs max-h-32 overflow-y-auto">
                  {msg.toolResult}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // assistant
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] px-3 py-2 rounded-lg bg-neutral-800/70 text-neutral-100 text-sm whitespace-pre-wrap backdrop-blur-sm">
        {msg.content}
      </div>
    </div>
  )
}

export function StarCommandTab() {
  const {
    messages,
    isStreaming,
    streamBuffer,
    addUserMessage,
    appendStreamText,
    addToolCallMessage,
    addToolResultMessage,
    finalizeAssistantMessage,
    setStreamError,
    setIsStreaming,
    setCrewList,
    setMissionQueue,
    setSectors,
    setUnreadCount,
  } = useStarCommandStore()

  const { admiralAvatarState } = useStarCommandStore()
  const [input, setInput] = useState('')
  const [view, setView] = useState<'chat' | 'config'>('chat')
  const [talkFrame, setTalkFrame] = useState(false)

  // Oscillate between speaking and default while streaming to simulate talking
  useEffect(() => {
    if (admiralAvatarState !== 'speaking') { setTalkFrame(false); return }
    const interval = setInterval(() => setTalkFrame((f) => !f), 300)
    return () => clearInterval(interval)
  }, [admiralAvatarState])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamBuffer])

  // Listen for streaming chunks from main process via preload API
  useEffect(() => {
    const cleanupChunk = window.fleet.admiral.onStreamChunk((chunk: unknown) => {
      const c = chunk as StreamChunk
      switch (c.type) {
        case 'text':
          appendStreamText(c.text ?? '')
          break
        case 'tool_use':
          addToolCallMessage(c.name ?? 'unknown', c.input ?? {})
          break
        case 'tool_result':
          addToolResultMessage(c.name ?? 'unknown', c.result ?? '')
          break
        case 'done':
          finalizeAssistantMessage()
          break
        case 'error':
          setStreamError(c.error ?? 'Unknown error')
          break
      }
    })

    const cleanupEnd = window.fleet.admiral.onStreamEnd(() => {
      finalizeAssistantMessage()
    })

    const cleanupError = window.fleet.admiral.onStreamError((err) => {
      setStreamError(err.error)
    })

    return () => {
      cleanupChunk()
      cleanupEnd()
      cleanupError()
    }
  }, [
    appendStreamText,
    addToolCallMessage,
    addToolResultMessage,
    finalizeAssistantMessage,
    setStreamError
  ])

  // Listen for status updates via preload API
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

  // Initial status fetch + poll fallback (onStatusUpdate is the primary push mechanism)
  const refreshStatus = useCallback(() => {
    window.fleet.starbase.listCrew().then((crew) => setCrewList(crew as never[]))
    window.fleet.starbase.listMissions().then((missions) => setMissionQueue(missions as never[]))
    window.fleet.starbase.listSectors().then((sectors) => setSectors(sectors as never[]))
  }, [setCrewList, setMissionQueue, setSectors])

  useEffect(() => {
    refreshStatus()
    const interval = setInterval(refreshStatus, 5000)
    return () => clearInterval(interval)
  }, [refreshStatus])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || isStreaming) return

    addUserMessage(text)
    setInput('')
    setIsStreaming(true)

    window.fleet.admiral.sendMessage(text).catch((err: Error) => {
      setStreamError(err.message)
    })
  }, [input, isStreaming, addUserMessage, setIsStreaming, setStreamError])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <div className="h-full flex">
      {/* Chat panel wrapped in CRT frame */}
      <CrtFrame>
        <div className="flex flex-1 min-h-0 min-w-0">
          {/* Chat column */}
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
                    view === 'chat'
                      ? 'bg-neutral-700 text-neutral-200'
                      : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                  onClick={() => setView('chat')}
                >
                  Chat
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
          </div>

          {view === 'config' ? (
            <StarCommandConfig />
          ) : (
            <>
              {/* Messages + avatar overlay */}
              <div className="flex-1 relative min-h-0">
                <div className="absolute inset-0 overflow-y-auto px-4 pt-3 pb-24 space-y-3">
                  {messages.length === 0 && !streamBuffer && (
                    <div className="flex flex-col items-center justify-center h-full text-neutral-600">
                      <p className="text-sm">Welcome to Star Command</p>
                      <p className="text-xs mt-1">
                        Ask the Admiral to deploy agents, manage sectors, or check status.
                      </p>
                    </div>
                  )}
                  {messages.map((msg) => (
                    <MessageBubble key={msg.id} msg={msg} />
                  ))}
                  {streamBuffer && (
                    <div className="flex justify-start">
                      <div className="max-w-[80%] px-3 py-2 rounded-lg bg-neutral-800/70 text-neutral-100 text-sm whitespace-pre-wrap backdrop-blur-sm">
                        {streamBuffer}
                        <span className="inline-block w-1.5 h-4 bg-neutral-400 ml-0.5 animate-pulse" />
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Admiral avatar — fixed at bottom-left of chat area */}
                <div className="absolute bottom-2 left-3 flex flex-col items-center gap-1 pointer-events-none z-10">
                  <Avatar
                    type="admiral"
                    variant={admiralAvatarState === 'speaking' ? (talkFrame ? 'speaking' : 'default') : admiralAvatarState}
                    size={80}
                  />
                  <span className="text-[9px] font-mono text-teal-400 uppercase tracking-widest">
                    Admiral
                  </span>
                </div>
              </div>

              {/* Input bar */}
              <div className="border-t border-neutral-800 px-4 py-3 bg-neutral-900">
                <div className="flex items-end gap-2">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isStreaming ? 'Admiral is responding...' : 'Message the Admiral...'}
                    disabled={isStreaming}
                    rows={1}
                    className="flex-1 resize-none bg-neutral-800 text-white text-sm rounded-lg px-3 py-2 border border-neutral-700 focus:border-blue-500 focus:outline-none placeholder:text-neutral-500 disabled:opacity-50 max-h-32 overflow-y-auto"
                    style={{ minHeight: '36px' }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={isStreaming || !input.trim()}
                    className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Send
                  </button>
                </div>
              </div>
            </>
          )}
          </div>{/* end chat column */}
        </div>{/* end flex row */}
      </CrtFrame>

      <StarCommandScene className="flex-1 min-w-[280px]" />
    </div>
  )
}
