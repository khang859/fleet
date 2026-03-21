import chokidar, { type FSWatcher } from 'chokidar'
import { existsSync, readdirSync, statSync, type Dirent } from 'fs'
import { open, stat } from 'fs/promises'
import { extname, basename, join } from 'path'

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
  private queuedReads = new Set<string>()
  private pendingReads = new Set<string>()
  private scanTimer: ReturnType<typeof setInterval> | null = null

  constructor(private watchDir: string) {}

  onRecord(callback: RecordCallback): void {
    this.callbacks.push(callback)
  }

  start(): void {
    if (!existsSync(this.watchDir)) return
    const usePolling = process.env.VITEST === 'true'
    this.seedExistingFiles()

    this.watcher = chokidar.watch([join(this.watchDir, '*.jsonl'), join(this.watchDir, '*', '*.jsonl')], {
      persistent: false,
      ignoreInitial: false,
      usePolling,
      interval: usePolling ? 50 : undefined,
      awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 },
    })

    this.watcher.on('add', (filePath: string) => {
      if (extname(filePath) !== '.jsonl') return
      if (this.watchedFiles.has(filePath)) return
      stat(filePath).then((fileStat) => {
        this.watchedFiles.set(filePath, { filePath, offset: 0, lineBuffer: '' })
        if (fileStat.size > 0) this.scheduleRead(filePath)
      }).catch(() => {})
    })

    this.watcher.on('change', (filePath: string) => {
      if (extname(filePath) !== '.jsonl') return
      if (this.watchedFiles.has(filePath)) this.scheduleRead(filePath)
    })

    this.watcher.on('unlink', (filePath: string) => {
      this.watchedFiles.delete(filePath)
    })

    this.scanTimer = setInterval(() => {
      this.scanForChanges()
    }, usePolling ? 50 : 250)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    this.watchedFiles.clear()
    this.queuedReads.clear()
    this.pendingReads.clear()
  }

  private seedExistingFiles(): void {
    for (const filePath of this.listJsonlFiles()) {
      if (this.watchedFiles.has(filePath)) continue
      try {
        const fileStat = statSync(filePath)
        this.watchedFiles.set(filePath, {
          filePath,
          offset: fileStat.size,
          lineBuffer: '',
        })
      } catch {
        // Ignore files that disappear mid-scan.
      }
    }
  }

  private listJsonlFiles(): string[] {
    const files: string[] = []
    const visitDir = (dirPath: string, depth: number): void => {
      let entries: Dirent[]
      try {
        entries = readdirSync(dirPath, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory() && depth < 1) {
          visitDir(fullPath, depth + 1)
          continue
        }
        if (!entry.isFile() || extname(fullPath) !== '.jsonl') {
          continue
        }
        files.push(fullPath)
      }
    }

    visitDir(this.watchDir, 0)
    return files
  }

  private scanForChanges(): void {
    const currentFiles = new Set(this.listJsonlFiles())

    for (const filePath of currentFiles) {
      const watched = this.watchedFiles.get(filePath)
      try {
        const fileStat = statSync(filePath)
        if (!watched) {
          this.watchedFiles.set(filePath, { filePath, offset: 0, lineBuffer: '' })
          if (fileStat.size > 0) this.scheduleRead(filePath)
          continue
        }

        if (fileStat.size < watched.offset) {
          watched.offset = 0
          watched.lineBuffer = ''
        }
        if (fileStat.size > watched.offset) {
          this.scheduleRead(filePath)
        }
      } catch {
        this.watchedFiles.delete(filePath)
      }
    }

    for (const filePath of this.watchedFiles.keys()) {
      if (!currentFiles.has(filePath)) {
        this.watchedFiles.delete(filePath)
      }
    }
  }

  private scheduleRead(filePath: string): void {
    if (this.pendingReads.has(filePath)) {
      this.queuedReads.add(filePath)
      return
    }
    this.pendingReads.add(filePath)
    void this.readNewLines(filePath).finally(() => {
      this.pendingReads.delete(filePath)
      if (this.queuedReads.delete(filePath) && this.watchedFiles.has(filePath)) {
        this.scheduleRead(filePath)
      }
    })
  }

  private async readNewLines(filePath: string): Promise<void> {
    const watched = this.watchedFiles.get(filePath)
    if (!watched) return

    try {
      const fileStat = await stat(watched.filePath)
      if (fileStat.size <= watched.offset) return

      const bytesToRead = fileStat.size - watched.offset
      const buf = Buffer.alloc(bytesToRead)
      const fileHandle = await open(watched.filePath, 'r')
      try {
        await fileHandle.read(buf, 0, bytesToRead, watched.offset)
      } finally {
        await fileHandle.close()
      }
      watched.offset = fileStat.size

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
