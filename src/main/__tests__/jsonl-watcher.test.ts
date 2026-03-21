import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlWatcher, type JsonlRecord } from '../jsonl-watcher'

type EmittedRecord = {
  sessionId: string
  record: JsonlRecord
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-jsonl-test-'))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(assertion: () => void, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now()
  let lastError: unknown

  while (Date.now() - start < timeoutMs) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await sleep(intervalMs)
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for assertion')
}

async function waitForReady(watcher: JsonlWatcher): Promise<void> {
  await waitFor(() => {
    expect((watcher as JsonlWatcher & { isReady?: boolean }).isReady).toBe(true)
  })
}

describe('JsonlWatcher', () => {
  let dir: string
  let projectDir: string
  let watcher: JsonlWatcher
  let emitted: EmittedRecord[]

  beforeEach(() => {
    dir = createTempDir()
    projectDir = join(dir, 'project-abc')
    mkdirSync(projectDir, { recursive: true })
    emitted = []
  })

  afterEach(() => {
    watcher?.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  function startWatcher(): void {
    watcher = new JsonlWatcher(dir)
    watcher.onRecord((sessionId, record) => {
      emitted.push({ sessionId, record })
    })
    watcher.start()
  }

  it('skips pre-existing files on startup', async () => {
    const filePath = join(projectDir, 'session-existing.jsonl')
    writeFileSync(filePath, `${JSON.stringify({ type: 'user' })}\n`)

    startWatcher()
    await waitForReady(watcher)
    await sleep(100)

    expect(emitted).toEqual([])
  })

  it('reads a new file from byte 0 after ready', async () => {
    startWatcher()
    await waitForReady(watcher)

    const filePath = join(projectDir, 'session-live.jsonl')
    writeFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`)

    await waitFor(() => {
      expect(emitted).toEqual([
        {
          sessionId: 'session-live',
          record: expect.objectContaining({ type: 'assistant' }),
        },
      ])
    })
  })

  it('emits only appended records for an existing file', async () => {
    const filePath = join(projectDir, 'session-append.jsonl')
    writeFileSync(filePath, `${JSON.stringify({ type: 'user' })}\n`)

    startWatcher()
    await waitForReady(watcher)
    await sleep(100)

    appendFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`)

    await waitFor(() => {
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        sessionId: 'session-append',
        record: { type: 'assistant' },
      })
    })
  })

  it('resets offset after truncation', async () => {
    startWatcher()
    await waitForReady(watcher)

    const filePath = join(projectDir, 'session-truncate.jsonl')
    writeFileSync(filePath, `${JSON.stringify({ type: 'user' })}\n`)

    await waitFor(() => {
      expect(emitted).toHaveLength(1)
    })

    writeFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`)

    await waitFor(() => {
      expect(emitted).toHaveLength(2)
      expect(emitted[1]).toMatchObject({
        sessionId: 'session-truncate',
        record: { type: 'assistant' },
      })
    })
  })

  it('supports unlink and recreate for the same path', async () => {
    startWatcher()
    await waitForReady(watcher)

    const filePath = join(projectDir, 'session-recreate.jsonl')
    writeFileSync(filePath, `${JSON.stringify({ type: 'user' })}\n`)

    await waitFor(() => {
      expect(emitted).toHaveLength(1)
    })

    unlinkSync(filePath)
    await sleep(100)

    writeFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`)

    await waitFor(() => {
      expect(emitted).toHaveLength(2)
      expect(emitted[1]).toMatchObject({
        sessionId: 'session-recreate',
        record: { type: 'assistant' },
      })
    })
  })

  it('does not duplicate records across rapid successive changes', async () => {
    startWatcher()
    await waitForReady(watcher)

    const filePath = join(projectDir, 'session-rapid.jsonl')
    writeFileSync(filePath, `${JSON.stringify({ type: 'user', seq: 1 })}\n`)
    appendFileSync(filePath, `${JSON.stringify({ type: 'assistant', seq: 2 })}\n`)

    await waitFor(() => {
      expect(emitted).toHaveLength(2)
    })

    expect(emitted.map(({ record }) => record.seq)).toEqual([1, 2])
  })

  it('buffers partial lines until a newline arrives', async () => {
    startWatcher()
    await waitForReady(watcher)

    const filePath = join(projectDir, 'session-partial.jsonl')
    writeFileSync(filePath, '{"type":"assistant"')

    await sleep(150)
    expect(emitted).toEqual([])

    appendFileSync(filePath, ',"step":1}\n')

    await waitFor(() => {
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({
        sessionId: 'session-partial',
        record: { type: 'assistant', step: 1 },
      })
    })
  })

  it('does not create a recurring scan timer in production mode', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const on = vi.fn((_event: string, _handler: (...args: unknown[]) => void) => mockedWatcher)
    const mockedWatcher = { on, close }
    const watch = vi.fn(() => mockedWatcher)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const originalVitestEnv = process.env.VITEST

    process.env.VITEST = 'false'
    vi.resetModules()
    vi.doMock('chokidar', () => ({
      default: { watch },
      watch,
    }))

    try {
      const { JsonlWatcher: MockedJsonlWatcher } = await import('../jsonl-watcher')
      const mocked = new MockedJsonlWatcher(dir)
      mocked.start()

      expect(watch).toHaveBeenCalledTimes(1)
      expect(setIntervalSpy).not.toHaveBeenCalled()
      expect('scanTimer' in (mocked as object)).toBe(false)

      mocked.stop()
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      process.env.VITEST = originalVitestEnv
      setIntervalSpy.mockRestore()
      vi.doUnmock('chokidar')
      vi.resetModules()
    }
  })
})
