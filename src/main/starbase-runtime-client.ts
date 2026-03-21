import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { utilityProcess } from 'electron'
import type { MessageEvent, UtilityProcess } from 'electron'
import type {
  RuntimeBootstrapArgs,
  RuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/starbase-runtime'
import type { StarbaseRuntimeStatus } from '../shared/ipc-api'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error & { code?: string }) => void
}

type RuntimeEventMap = {
  'runtime.status': StarbaseRuntimeStatus
  'starbase.snapshot': unknown
  'starbase.log-entry': unknown
  'sentinel.socket-restart-requested': { reason: string }
}

export class StarbaseRuntimeClient {
  private child: UtilityProcess | null = null
  private pending = new Map<string, PendingRequest>()
  private emitter = new EventEmitter()
  private bootstrapPromise: Promise<void> | null = null
  private status: StarbaseRuntimeStatus = { state: 'starting' }

  constructor(private scriptUrl: URL) {}

  async start(args: RuntimeBootstrapArgs): Promise<void> {
    if (this.bootstrapPromise) return this.bootstrapPromise

    this.status = { state: 'starting' }
    this.bootstrapPromise = (async () => {
      const child = utilityProcess.fork(fileURLToPath(this.scriptUrl))
      this.child = child

      child.on('message', (message: MessageEvent) => {
        this.handleMessage(message.data as RuntimeResponse | RuntimeEvent)
      })

      child.on('exit', (_code) => {
        const error = new Error('Starbase runtime exited')
        this.child = null
        this.bootstrapPromise = null
        if (this.status.state !== 'error') {
          this.setStatus({ state: 'error', error: error.message })
        }
        for (const pending of this.pending.values()) {
          pending.reject(error)
        }
        this.pending.clear()
      })

      await this.invoke('runtime.bootstrap', args)
    })().catch((error) => {
      this.bootstrapPromise = null
      try {
        this.child?.kill()
      } catch {
        // Ignore shutdown errors after failed bootstrap.
      }
      this.child = null
      throw error
    })

    return this.bootstrapPromise
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.bootstrapPromise = null
    if (!child) return
    try {
      child.kill()
    } catch {
      // Ignore shutdown errors.
    }
  }

  async invoke<T>(method: string, args?: unknown): Promise<T> {
    const child = this.child
    if (!child) {
      throw new Error('Starbase runtime is not running')
    }

    const id = randomUUID()
    const request: RuntimeRequest = { id, method, args }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      child.postMessage(request)
    })
  }

  getStatus(): StarbaseRuntimeStatus {
    return this.status
  }

  on<K extends keyof RuntimeEventMap>(event: K, listener: (payload: RuntimeEventMap[K]) => void): void {
    this.emitter.on(event, listener)
  }

  off<K extends keyof RuntimeEventMap>(event: K, listener: (payload: RuntimeEventMap[K]) => void): void {
    this.emitter.off(event, listener)
  }

  private handleMessage(message: RuntimeResponse | RuntimeEvent): void {
    if ('event' in message) {
      if (message.event === 'runtime.status') {
        this.setStatus(message.payload)
      }
      this.emitter.emit(message.event, message.payload)
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)

    if (message.ok) {
      pending.resolve(message.data)
      return
    }

    const error = new Error(message.error) as Error & { code?: string }
    error.code = message.code
    pending.reject(error)
  }

  private setStatus(status: StarbaseRuntimeStatus): void {
    this.status = status
    this.emitter.emit('runtime.status', status)
  }
}
