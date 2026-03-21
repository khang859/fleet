import type { RuntimeEvent, RuntimeRequest, RuntimeResponse } from '../shared/starbase-runtime'
import { StarbaseRuntimeCore } from './starbase-runtime-core'

type ParentPortLike = {
  on: (event: 'message', listener: (event: { data: RuntimeRequest }) => void) => void
  postMessage: (message: RuntimeResponse | RuntimeEvent) => void
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

if (!parentPort) {
  throw new Error('Starbase runtime must run inside an Electron utility process')
}

const runtime = new StarbaseRuntimeCore()
runtime.setEventSink((event) => {
  parentPort.postMessage(event)
})

parentPort.on('message', (event) => {
  const request = event.data
  void runtime
    .invoke(request.method, request.args)
    .then((data) => {
      parentPort.postMessage({ id: request.id, ok: true, data } satisfies RuntimeResponse)
    })
    .catch((error: unknown) => {
      const err = error as Error & { code?: string }
      parentPort.postMessage({
        id: request.id,
        ok: false,
        error: err.message ?? 'Unknown error',
        code: err.code,
      } satisfies RuntimeResponse)
    })
})
