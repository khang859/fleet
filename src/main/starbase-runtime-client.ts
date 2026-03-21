import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  RuntimeBootstrapArgs,
  RuntimeEvent,
  RuntimeRequest,
  RuntimeResponse
} from '../shared/starbase-runtime';
import type { StarbaseRuntimeStatus } from '../shared/ipc-api';
import { CodedError } from './errors';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type RuntimeEventMap = {
  'runtime.status': StarbaseRuntimeStatus;
  'starbase.snapshot': unknown;
  'starbase.log-entry': unknown;
  'sentinel.socket-restart-requested': { reason: string };
};

type RuntimeEnvelope = RuntimeResponse | RuntimeEvent;
type RuntimeMessageLike = RuntimeEnvelope | { data?: RuntimeEnvelope } | undefined;

function isRuntimeEnvelope(value: unknown): value is RuntimeEnvelope {
  if (!value || typeof value !== 'object') return false;
  return ('event' in value && typeof value.event === 'string') || ('id' in value && 'ok' in value);
}

const RUNTIME_PARENT_TRACE_FILE = '/tmp/fleet-starbase-parent.log';

function trace(message: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  try {
    appendFileSync(
      RUNTIME_PARENT_TRACE_FILE,
      `[${new Date().toISOString()} pid=${process.pid}] runtime-client ${message}${suffix}\n`,
      'utf8'
    );
  } catch {
    // Ignore trace write failures.
  }
}

export class StarbaseRuntimeClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private emitter = new EventEmitter();
  private bootstrapPromise: Promise<void> | null = null;
  private status: StarbaseRuntimeStatus = { state: 'starting' };

  constructor(private scriptUrl: URL) {}

  async start(args: RuntimeBootstrapArgs): Promise<void> {
    if (this.bootstrapPromise) return this.bootstrapPromise;

    this.status = { state: 'starting' };
    this.bootstrapPromise = (async () => {
      const scriptPath = fileURLToPath(this.scriptUrl);
      const child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      this.child = child;
      trace('spawned child', { pid: child.pid, scriptPath });

      child.on('spawn', () => {
        // eslint-disable-next-line no-console
        console.log(`[starbase-runtime] spawned pid=${child.pid ?? 'unknown'}`);
        trace('child spawn event', { pid: child.pid });
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          // eslint-disable-next-line no-console
          console.log(`[starbase-runtime:stdout] ${text}`);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          console.error(`[starbase-runtime:stderr] ${text}`);
        }
      });

      child.on('error', (error) => {
        console.error('[starbase-runtime] child process error:', error);
        trace('child process error', { message: error.message, stack: error.stack });
      });

      child.on('message', (message: RuntimeMessageLike) => {
        trace('parent received raw message', this.describeMessage(message));
        // eslint-disable-next-line no-console
        console.log('[starbase-runtime] parent received message', {
          rawType: typeof message,
          hasData: Boolean(message && typeof message === 'object' && 'data' in message)
        });
        this.handleMessage(this.unwrapMessage(message));
      });

      child.on('exit', (code) => {
        const error = new Error(`Starbase runtime exited with code ${code ?? 'null'}`);
        this.child = null;
        this.bootstrapPromise = null;
        if (this.status.state !== 'error') {
          this.setStatus({ state: 'error', error: error.message });
        }
        console.error('[starbase-runtime] exited', { code });
        trace('child exit', { code });
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
      });

      await this.invoke('runtime.bootstrap', args);
    })().catch((error) => {
      this.bootstrapPromise = null;
      try {
        this.child?.kill();
      } catch {
        // Ignore shutdown errors after failed bootstrap.
      }
      this.child = null;
      throw error;
    });

    return this.bootstrapPromise;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.bootstrapPromise = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // Ignore shutdown errors.
    }
  }

  async invoke<T>(method: string, args?: unknown): Promise<T> {
    const child = this.child;
    if (!child) {
      throw new Error('Starbase runtime is not running');
    }

    const id = randomUUID();
    const request: RuntimeRequest = { id, method, args };
    // eslint-disable-next-line no-console
    console.log('[starbase-runtime] parent sending request', { id, method });
    trace('parent sending request', { id, method });

    return new Promise<T>((resolve, reject) => {
      const resolveFn: (value: unknown) => void = (value) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        resolve(value as T);
      };
      this.pending.set(id, { resolve: resolveFn, reject });
      child.send?.(request, (error) => {
        if (error) {
          console.error('[starbase-runtime] send failed', { id, method, error });
          trace('send failed', { id, method, message: error.message, stack: error.stack });
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(error);
          }
        }
      });
    });
  }

  getStatus(): StarbaseRuntimeStatus {
    return this.status;
  }

  on<K extends keyof RuntimeEventMap>(
    event: K,
    listener: (payload: RuntimeEventMap[K]) => void
  ): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof RuntimeEventMap>(
    event: K,
    listener: (payload: RuntimeEventMap[K]) => void
  ): void {
    this.emitter.off(event, listener);
  }

  private handleMessage(message: RuntimeEnvelope | undefined): void {
    if (!message) {
      console.warn('[starbase-runtime] parent received empty message');
      trace('parent received empty message');
      return;
    }

    if ('event' in message) {
      // eslint-disable-next-line no-console
      console.log('[starbase-runtime] parent handling event', { event: message.event });
      trace('parent handling event', { event: message.event });
      if (message.event === 'runtime.status') {
        this.setStatus(message.payload);
      }
      this.emitter.emit(message.event, message.payload);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      console.warn('[starbase-runtime] parent received response with no pending request', {
        id: message.id
      });
      trace('response with no pending request', { id: message.id });
      return;
    }
    this.pending.delete(message.id);

    if (message.ok) {
      // eslint-disable-next-line no-console
      console.log('[starbase-runtime] parent resolved request', { id: message.id });
      trace('parent resolved request', { id: message.id });
      pending.resolve(message.data);
      return;
    }

    const error = new CodedError(message.error, message.code ?? 'UNKNOWN');
    console.error('[starbase-runtime] parent rejected request', {
      id: message.id,
      message: message.error,
      code: message.code
    });
    trace('parent rejected request', {
      id: message.id,
      message: message.error,
      code: message.code
    });
    pending.reject(error);
  }

  private setStatus(status: StarbaseRuntimeStatus): void {
    this.status = status;
    trace('status updated', status);
    this.emitter.emit('runtime.status', status);
  }

  private unwrapMessage(message: RuntimeMessageLike): RuntimeEnvelope | undefined {
    if (!message) {
      return undefined;
    }

    if (typeof message !== 'object') {
      trace('received non-object IPC payload', { valueType: typeof message });
      return undefined;
    }

    const keys = Object.keys(message);
    if (
      keys.length === 1 &&
      keys[0] === 'data' &&
      'data' in message &&
      message.data !== undefined
    ) {
      return isRuntimeEnvelope(message.data) ? message.data : undefined;
    }

    return isRuntimeEnvelope(message) ? message : undefined;
  }

  private describeMessage(message: RuntimeMessageLike): Record<string, unknown> {
    if (message === undefined) {
      return { kind: 'undefined' };
    }
    if (typeof message !== 'object') {
      return { kind: typeof message, value: String(message) };
    }

    const keys = Object.keys(message);
    const unwrapped =
      'data' in message && message.data && typeof message.data === 'object'
        ? Object.keys(message.data)
        : null;

    return {
      kind: Array.isArray(message) ? 'array' : 'object',
      keys,
      dataKeys: unwrapped
    };
  }
}
