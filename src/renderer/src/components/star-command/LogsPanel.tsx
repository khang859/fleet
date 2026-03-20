import { useState, useEffect, useRef, useCallback } from 'react'

type LogEntry = {
  id: number
  source: 'ships_log' | 'comms'
  timestamp: string
  eventType: string
  actor: string | null
  target?: string | null
  detail: unknown
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp)
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return timestamp.slice(11, 19) || timestamp
  }
}

function eventColor(entry: LogEntry): string {
  if (entry.source === 'comms') return 'text-yellow-400'
  switch (entry.eventType) {
    case 'deployed': return 'text-teal-400'
    case 'queued': return 'text-blue-400'
    case 'safety_guard': return 'text-orange-400'
    case 'exited': {
      const detail = typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail ?? '')
      if (detail.includes('complete') || detail.includes('Complete')) return 'text-green-400'
      if (detail.includes('abort') || detail.includes('Abort')) return 'text-neutral-500'
      return 'text-red-400'
    }
    default: return 'text-neutral-400'
  }
}

function summarize(detail: unknown): string {
  if (!detail) return ''
  if (typeof detail === 'string') {
    try {
      const parsed = JSON.parse(detail)
      if (typeof parsed === 'object' && parsed !== null) {
        const keys = ['summary', 'message', 'reason', 'status', 'exitCode']
        for (const k of keys) {
          if (k in parsed && parsed[k] != null) return String(parsed[k]).slice(0, 80)
        }
        return detail.slice(0, 80)
      }
      return String(parsed).slice(0, 80)
    } catch {
      return detail.slice(0, 80)
    }
  }
  return JSON.stringify(detail).slice(0, 80)
}

function LogRow({ entry }: { entry: LogEntry }) {
  const color = eventColor(entry)
  const time = formatTime(entry.timestamp)
  const eventLabel = entry.eventType.toUpperCase().padEnd(16)
  const actor = entry.actor ?? ''
  const detail = summarize(entry.detail)

  return (
    <div className="flex gap-2 leading-relaxed">
      <span className="text-neutral-600 shrink-0">[{time}]</span>
      <span className={`${color} shrink-0 w-36`}>{eventLabel}</span>
      <span className="text-neutral-400 shrink-0 max-w-[120px] truncate">{actor}</span>
      <span className="text-neutral-500 truncate">{detail}</span>
    </div>
  )
}

export function LogsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const seenIds = useRef<Set<string>>(new Set())

  const loadAll = useCallback(() => {
    window.fleet.starbase.getShipsLog({ limit: 200 }).then((rows) => {
      const typed = rows as LogEntry[]
      seenIds.current = new Set(typed.map(e => `${e.source}:${e.id}`))
      setEntries(typed)
    })
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    const unsub = window.fleet.starbase.onLogEntry((raw) => {
      const entry = raw as LogEntry
      const key = `${entry.source}:${entry.id}`
      if (seenIds.current.has(key)) return
      seenIds.current.add(key)
      setEntries(prev => {
        const next = [...prev, entry]
        return next.slice(-500)
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto font-mono text-xs p-3 space-y-0.5">
      {entries.length === 0 ? (
        <p className="text-neutral-600 italic">No log entries yet.</p>
      ) : (
        entries.map(entry => (
          <LogRow key={`${entry.source}:${entry.id}`} entry={entry} />
        ))
      )}
      <div ref={bottomRef} />
    </div>
  )
}
