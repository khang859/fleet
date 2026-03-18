import chokidar, { type FSWatcher } from 'chokidar'
import { openSync, readSync, closeSync, statSync, existsSync } from 'fs'
import { extname, basename } from 'path'

export type JsonlRecord = {
  type: string
  message?: {
    content?: Array<{
      type: string
      name?: string
      input?: unknown
    }>
  }
  data?: {
    type?: string
    parentToolUseID?: string
  }
  [key: string]: unknown
}

type RecordCallback = (sessionId: string, record: JsonlRecord) => void

type WatchedFile = {
  filePath: string
  offset: number
  lineBuffer: string
}

export class JsonlWatcher {
  private watcher: FSWatcher | null = null
  private callbacks: RecordCallback[] = []
  private watchedFiles = new Map<string, WatchedFile>()
  private isReady = false

  constructor(private watchDir: string) {}

  onRecord(callback: RecordCallback): void {
    this.callbacks.push(callback)
  }

  start(): void {
    if (!existsSync(this.watchDir)) return

    this.watcher = chokidar.watch(this.watchDir, {
      persistent: false,
      ignoreInitial: false,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 },
    })

    this.watcher.on('add', (filePath: string) => {
      if (extname(filePath) !== '.jsonl') return
      if (this.watchedFiles.has(filePath)) return
      try {
        const stat = statSync(filePath)
        // Files seen before 'ready' are pre-existing: skip to end (no ghost agents)
        // Files seen after 'ready' are new sessions: read from beginning
        const offset = this.isReady ? 0 : stat.size
        this.watchedFiles.set(filePath, { filePath, offset, lineBuffer: '' })
        // If new file (after ready), read any content already there
        if (this.isReady) {
          const watched = this.watchedFiles.get(filePath)!
          this.readNewLines(watched)
        }
      } catch {}
    })

    this.watcher.on('ready', () => {
      this.isReady = true
    })

    this.watcher.on('change', (filePath: string) => {
      if (extname(filePath) !== '.jsonl') return
      const watched = this.watchedFiles.get(filePath)
      if (watched) this.readNewLines(watched)
    })

    this.watcher.on('unlink', (filePath: string) => {
      this.watchedFiles.delete(filePath)
    })
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    this.watchedFiles.clear()
    this.isReady = false
  }

  private readNewLines(watched: WatchedFile): void {
    try {
      const stat = statSync(watched.filePath)
      if (stat.size <= watched.offset) return

      const bytesToRead = stat.size - watched.offset
      const buf = Buffer.alloc(bytesToRead)
      const fd = openSync(watched.filePath, 'r')
      try {
        readSync(fd, buf, 0, bytesToRead, watched.offset)
      } finally {
        closeSync(fd)
      }
      watched.offset = stat.size

      const text = watched.lineBuffer + buf.toString('utf-8')
      const lines = text.split('\n')
      watched.lineBuffer = lines.pop() || ''

      const sessionId = basename(watched.filePath, '.jsonl')

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as JsonlRecord
          for (const cb of this.callbacks) {
            cb(sessionId, record)
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {}
  }
}
