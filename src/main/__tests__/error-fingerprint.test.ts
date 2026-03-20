import { describe, it, expect } from 'vitest'
import { computeFingerprint, classifyError } from '../starbase/error-fingerprint'

describe('computeFingerprint', () => {
  it('returns a 16-char hex string', () => {
    const fp = computeFingerprint('Error: test failed\nat line 42')
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('returns same fingerprint for identical errors', () => {
    const a = computeFingerprint('Error: test failed')
    const b = computeFingerprint('Error: test failed')
    expect(a).toBe(b)
  })

  it('strips timestamps before hashing', () => {
    const a = computeFingerprint('2026-03-20T10:00:00Z Error: test failed')
    const b = computeFingerprint('2026-03-21T15:30:00Z Error: test failed')
    expect(a).toBe(b)
  })

  it('strips PIDs before hashing', () => {
    const a = computeFingerprint('pid=12345 Error: crash')
    const b = computeFingerprint('pid=99999 Error: crash')
    expect(a).toBe(b)
  })

  it('strips memory addresses before hashing', () => {
    const a = computeFingerprint('at 0x7fff5fbff8c0')
    const b = computeFingerprint('at 0x1234abcd0000')
    expect(a).toBe(b)
  })

  it('uses last 50 lines only', () => {
    const longOutput = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const shortOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 50}`).join('\n')
    expect(computeFingerprint(longOutput)).toBe(computeFingerprint(shortOutput))
  })

  it('handles empty input', () => {
    const fp = computeFingerprint('')
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('classifyError', () => {
  it('returns non-retryable for ENOENT', () => {
    expect(classifyError('Error: ENOENT: no such file or directory')).toBe('non-retryable')
  })

  it('returns non-retryable for EACCES', () => {
    expect(classifyError('Error: EACCES: permission denied')).toBe('non-retryable')
  })

  it('returns non-retryable for MODULE_NOT_FOUND', () => {
    expect(classifyError("Error: Cannot find module 'express'")).toBe('non-retryable')
  })

  it('returns non-retryable for 401/403', () => {
    expect(classifyError('HTTP 401 Unauthorized')).toBe('non-retryable')
    expect(classifyError('HTTP 403 Forbidden')).toBe('non-retryable')
  })

  it('returns non-retryable for missing config', () => {
    expect(classifyError('config file not found at /etc/app.json')).toBe('non-retryable')
  })

  it('returns transient for generic errors', () => {
    expect(classifyError('TypeError: Cannot read properties of undefined')).toBe('transient')
  })

  it('returns transient for empty output', () => {
    expect(classifyError('')).toBe('transient')
  })

  it('returns persistent when same fingerprint provided', () => {
    expect(classifyError('some error', 'abc123', 'abc123')).toBe('persistent')
  })

  it('returns transient when different fingerprint provided', () => {
    expect(classifyError('some error', 'abc123', 'def456')).toBe('transient')
  })
})
