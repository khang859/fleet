import { appendFileSync } from 'node:fs';
import type { RuntimeEvent, RuntimeRequest, RuntimeResponse } from '../shared/starbase-runtime';
import { StarbaseRuntimeCore } from './starbase-runtime-core';
import { toCodedError } from './errors';

const RUNTIME_TRACE_FILE = '/tmp/fleet-starbase-runtime.log';

function trace(message: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  try {
    appendFileSync(
      RUNTIME_TRACE_FILE,
      `[${new Date().toISOString()} pid=${process.pid}] ${message}${suffix}\n`,
      'utf8'
    );
  } catch {
    // Ignore trace write failures.
  }
}

type ParentPortLike = {
  on: (
    event: 'message',
    listener: (event: RuntimeRequest | { data?: RuntimeRequest }) => void
  ) => void;
  postMessage: (message: RuntimeResponse | RuntimeEvent) => void;
};

type ProcessLike = NodeJS.Process & {
  parentPort?: ParentPortLike;
  send?: (message: RuntimeResponse | RuntimeEvent) => void;
  on(event: 'message', listener: (message: RuntimeRequest) => void): NodeJS.Process;
};

const processRef = process as ProcessLike;
const parentPort = processRef.parentPort;
const transport = parentPort
  ? {
      onMessage: (listener: (request: RuntimeRequest) => void) => {
        parentPort.on('message', (event) => {
          listener('data' in event && event.data !== undefined ? event.data : event);
        });
      },
      postMessage: (message: RuntimeResponse | RuntimeEvent) => parentPort.postMessage(message)
    }
  : typeof processRef.send === 'function'
    ? {
        onMessage: (listener: (request: RuntimeRequest) => void) => {
          processRef.on('message', listener);
        },
        postMessage: (message: RuntimeResponse | RuntimeEvent) => processRef.send?.(message)
      }
    : null;

trace('runtime-process module loaded', {
  hasParentPort: Boolean(parentPort),
  hasProcessSend: typeof processRef.send === 'function'
});

if (!transport) {
  throw new Error('Starbase runtime must run with an IPC transport');
}

const runtime = new StarbaseRuntimeCore();
runtime.setEventSink((event) => {
  trace('event emitted', { event: event.event });
  transport.postMessage(event);
});

// Electron utility processes can exit once the event loop goes idle even though
// a parentPort message handler is registered. Keep one ref'd timer alive so the
// runtime remains resident to service future IPC calls.
const keepAliveTimer = setInterval(() => {}, 60_000);
trace('keepalive timer started');

process.on('uncaughtException', (error) => {
  trace('uncaughtException', { message: error.message, stack: error.stack });
  console.error('[starbase-runtime] uncaught exception:', error);
  try {
    transport.postMessage({
      event: 'runtime.status',
      payload: { state: 'error', error: error.message }
    } satisfies RuntimeEvent);
  } catch {
    // Ignore secondary IPC failures while crashing.
  }
});

process.on('unhandledRejection', (reason) => {
  trace('unhandledRejection', {
    reason:
      reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason)
  });
  console.error('[starbase-runtime] unhandled rejection:', reason);
  try {
    const error =
      reason instanceof Error
        ? reason
        : new Error(typeof reason === 'string' ? reason : String(reason));
    transport.postMessage({
      event: 'runtime.status',
      payload: { state: 'error', error: error.message }
    } satisfies RuntimeEvent);
  } catch {
    // Ignore secondary IPC failures while crashing.
  }
});

process.on('exit', (code) => {
  clearInterval(keepAliveTimer);
  trace('process exit', { code });
});

transport.onMessage((request) => {
  trace('request received', { id: request.id, method: request.method });
  void runtime
    .invoke(request.method, request.args)
    .then((data) => {
      trace('request succeeded', { id: request.id, method: request.method });
      transport.postMessage({ id: request.id, ok: true, data } satisfies RuntimeResponse);
    })
    .catch((error: unknown) => {
      const err = toCodedError(error);
      trace('request failed', {
        id: request.id,
        method: request.method,
        message: err.message,
        code: err.code
      });
      transport.postMessage({
        id: request.id,
        ok: false,
        error: err.message ?? 'Unknown error',
        code: err.code
      } satisfies RuntimeResponse);
    });
});
