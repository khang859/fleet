import { describe, expect, it } from 'vitest'
import { normalizeRuntimeEnv } from '../runtime-env'

describe('normalizeRuntimeEnv', () => {
  it('returns a plain object with only string values', () => {
    const input = Object.create({ INHERITED: 'ignored' }) as Record<string, string | undefined>
    input.PATH = '/usr/bin'
    input.HOME = '/tmp/home'
    input.EMPTY = undefined

    const normalized = normalizeRuntimeEnv(input)

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype)
    expect(normalized).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
    })
    expect('INHERITED' in normalized).toBe(false)
  })
})
