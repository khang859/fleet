import { describe, expect, it } from 'vitest'
import { StarbaseRuntimeClient } from '../starbase-runtime-client'

describe('StarbaseRuntimeClient message shape handling', () => {
  it('unwraps direct payloads and MessageEvent-like payloads', () => {
    const client = new StarbaseRuntimeClient(new URL('file:///tmp/runtime.mjs'))
    const unwrap = (
      client as unknown as {
        unwrapMessage: (message: unknown) => unknown
      }
    ).unwrapMessage.bind(client)

    const payload = { event: 'runtime.status', payload: { state: 'ready' } }

    expect(unwrap(payload)).toEqual(payload)
    expect(unwrap({ data: payload })).toEqual(payload)
    expect(unwrap(undefined)).toBeUndefined()
  })
})
