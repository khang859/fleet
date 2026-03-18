import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('pid-cwd', () => ({
  default: vi.fn().mockResolvedValue('/tmp/test-cwd'),
}))

import { CwdPoller } from '../cwd-poller'
import { EventBus } from '../event-bus'
import type { PtyManager } from '../pty-manager'
import pidCwd from 'pid-cwd'

function makeMockPtyManager(cwd = '/old-cwd'): PtyManager {
  return {
    getCwd: vi.fn().mockReturnValue(cwd),
    updateCwd: vi.fn(),
    getPid: vi.fn().mockReturnValue(999),
    paneIds: vi.fn().mockReturnValue([]),
    has: vi.fn().mockReturnValue(true),
  } as unknown as PtyManager
}

describe('CwdPoller', () => {
  let eventBus: EventBus
  let poller: CwdPoller

  beforeEach(() => {
    vi.useFakeTimers()
    eventBus = new EventBus()
  })

  afterEach(() => {
    poller?.stopAll()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('uses pid-cwd instead of lsof on macOS', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd')
    poller = new CwdPoller(eventBus, ptyManager)
    poller.startPolling('pane-1', 999)

    await vi.advanceTimersByTimeAsync(5001)

    expect(pidCwd).toHaveBeenCalledWith(999)
  })

  it('emits cwd-changed when cwd differs', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd')
    poller = new CwdPoller(eventBus, ptyManager)

    const changes: string[] = []
    eventBus.on('cwd-changed', (e) => changes.push(e.cwd))

    poller.startPolling('pane-1', 999)
    await vi.advanceTimersByTimeAsync(5001)

    expect(changes).toContain('/tmp/test-cwd')
  })

  it('stopPolling clears the timer', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd')
    poller = new CwdPoller(eventBus, ptyManager)

    poller.startPolling('pane-1', 999)
    poller.stopPolling('pane-1')

    await vi.advanceTimersByTimeAsync(10000)

    expect(pidCwd).not.toHaveBeenCalled()
  })
})
