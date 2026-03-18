import * as pty from 'node-pty'
import { getDefaultShell } from './shell-detection'

export type PtyCreateOptions = {
  paneId: string
  cwd: string
  shell?: string
  cmd?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
}

export type PtyCreateResult = {
  paneId: string
  pid: number
}

type PtyEntry = {
  process: pty.IPty
  paneId: string
  cwd: string
  outputBuffer: string
  dataDisposable: pty.IDisposable | null
  exitDisposable: pty.IDisposable | null
}

const FLUSH_INTERVAL_MS = 16
const BUFFER_OVERFLOW_BYTES = 256 * 1024

export class PtyManager {
  private ptys = new Map<string, PtyEntry>()
  /** PTYs that must not be killed by the renderer-driven GC (e.g. Star Command crews). */
  private protectedPtys = new Set<string>()
  private dataCallbacks = new Map<string, (data: string) => void>()
  private flushTimer: ReturnType<typeof setInterval> | null = null

  create(opts: PtyCreateOptions): PtyCreateResult {
    if (this.ptys.has(opts.paneId)) {
      throw new Error(`${opts.paneId} already exists`)
    }

    const shell = opts.shell ?? getDefaultShell()
    const args: string[] = []

    if (opts.cmd) {
      args.push('-c', `${opts.cmd}; exec ${shell}`)
    }

    console.log(`[pty] shell="${shell}" cwd="${opts.cwd}" PATH="${process.env.PATH?.substring(0, 80)}"`)
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
    })

    const entry: PtyEntry = {
      process: proc,
      paneId: opts.paneId,
      cwd: opts.cwd,
      outputBuffer: '',
      dataDisposable: null,
      exitDisposable: null,
    }

    // Register the internal buffering callback immediately at create time so
    // the IDisposable is captured and can be disposed during kill().
    entry.dataDisposable = proc.onData((data: string) => {
      entry.outputBuffer += data
      if (entry.outputBuffer.length > BUFFER_OVERFLOW_BYTES) {
        this.flushPane(opts.paneId)
        proc.pause()
      }
    })

    this.ptys.set(opts.paneId, entry)

    return { paneId: opts.paneId, pid: proc.pid }
  }

  write(paneId: string, data: string): void {
    const entry = this.ptys.get(paneId)
    if (entry) {
      entry.process.write(data)
    }
  }

  resize(paneId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(paneId)
    if (entry) {
      entry.process.resize(cols, rows)
    }
  }

  protect(paneId: string): void {
    this.protectedPtys.add(paneId)
  }

  kill(paneId: string): void {
    const entry = this.ptys.get(paneId)
    if (entry) {
      entry.dataDisposable?.dispose()
      entry.exitDisposable?.dispose()
      this.dataCallbacks.delete(paneId)
      entry.process.kill()
      this.ptys.delete(paneId)
      this.protectedPtys.delete(paneId)
    }
  }

  killAll(): void {
    for (const [paneId] of this.ptys) {
      this.kill(paneId)
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  has(paneId: string): boolean {
    return this.ptys.has(paneId)
  }

  get(paneId: string): PtyEntry | undefined {
    return this.ptys.get(paneId)
  }

  paneIds(): string[] {
    return Array.from(this.ptys.keys())
  }

  getCwd(paneId: string): string | undefined {
    return this.ptys.get(paneId)?.cwd
  }

  updateCwd(paneId: string, cwd: string): void {
    const entry = this.ptys.get(paneId)
    if (entry) entry.cwd = cwd
  }

  getPid(paneId: string): number | undefined {
    return this.ptys.get(paneId)?.process.pid
  }

  /** Kill any PTY whose paneId is not in the given set of active IDs (and not protected). */
  gc(activePaneIds: Set<string>): string[] {
    const killed: string[] = []
    for (const paneId of this.ptys.keys()) {
      if (!activePaneIds.has(paneId) && !this.protectedPtys.has(paneId)) {
        this.kill(paneId)
        killed.push(paneId)
      }
    }
    return killed
  }

  /**
   * Register a callback that receives batched PTY output every ~16ms.
   * The internal process.onData listener is already registered at create() time;
   * this method wires up the flush callback and starts the shared flush timer.
   */
  onData(paneId: string, callback: (data: string) => void): void {
    const entry = this.ptys.get(paneId)
    if (!entry) return

    this.dataCallbacks.set(paneId, callback)

    // Start shared flush timer if not already running
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS)
    }
  }

  /** Resume a paused PTY (called by renderer after consuming a batch). */
  resume(paneId: string): void {
    const entry = this.ptys.get(paneId)
    if (entry) entry.process.resume()
  }

  onExit(paneId: string, callback: (exitCode: number) => void): void {
    const entry = this.ptys.get(paneId)
    if (entry) {
      entry.exitDisposable = entry.process.onExit(({ exitCode }) => {
        this.dataCallbacks.delete(paneId)
        this.ptys.delete(paneId)
        this.protectedPtys.delete(paneId)
        callback(exitCode)
      })
    }
  }

  private flushPane(paneId: string): void {
    const entry = this.ptys.get(paneId)
    if (!entry || !entry.outputBuffer) return
    const callback = this.dataCallbacks.get(paneId)
    if (callback) {
      callback(entry.outputBuffer)
      entry.outputBuffer = ''
    }
  }

  private flushAll(): void {
    for (const paneId of this.ptys.keys()) {
      this.flushPane(paneId)
    }
  }
}
