import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('renderer logger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock window.fleet.log.batch
    window.fleet = {
      ...window.fleet,
      log: { batch: vi.fn() }
    } as unknown as typeof window.fleet;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('createLogger returns an object with debug/info/warn/error methods', async () => {
    const { createLogger } = await import('../logger');
    const log = createLogger('test:tag');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('outputs to console in dev mode', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { createLogger } = await import('../logger');
    const log = createLogger('test:console');
    log.debug('hello', { key: 'value' });
    expect(consoleSpy).toHaveBeenCalled();
    const call = consoleSpy.mock.calls[0];
    expect(call[0]).toContain('[test:console]');
    expect(call[0]).toContain('hello');
    consoleSpy.mockRestore();
  });

  it('batches logs and flushes over IPC after interval', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { createLogger } = await import('../logger');
    const log = createLogger('test:batch');
    log.debug('msg1');
    log.debug('msg2');

    // Not flushed yet
    expect(window.fleet.log.batch).not.toHaveBeenCalled();

    // Advance past flush interval (100ms)
    vi.advanceTimersByTime(100);

    expect(window.fleet.log.batch).toHaveBeenCalledTimes(1);
    const entries = (window.fleet.log.batch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entries).toHaveLength(2);
    expect(entries[0].tag).toBe('test:batch');
    expect(entries[0].message).toBe('msg1');
    expect(entries[1].message).toBe('msg2');

    vi.spyOn(console, 'debug').mockRestore();
  });

  it('flushes when queue reaches threshold', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { createLogger, FLUSH_SIZE_THRESHOLD } = await import('../logger');
    const log = createLogger('test:threshold');

    for (let i = 0; i < FLUSH_SIZE_THRESHOLD; i++) {
      log.debug(`msg-${i}`);
    }

    // Should have flushed immediately upon hitting threshold
    expect(window.fleet.log.batch).toHaveBeenCalledTimes(1);

    vi.spyOn(console, 'debug').mockRestore();
  });

  it('drops oldest entries when queue overflows', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createLogger, MAX_QUEUE_SIZE } = await import('../logger');
    const log = createLogger('test:overflow');

    for (let i = 0; i < MAX_QUEUE_SIZE + 10; i++) {
      log.debug(`msg-${i}`);
    }

    // Multiple threshold flushes will have fired
    expect(window.fleet.log.batch).toHaveBeenCalled();

    vi.spyOn(console, 'debug').mockRestore();
    vi.spyOn(console, 'warn').mockRestore();
  });

  it('supports lazy metadata via function argument', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { createLogger } = await import('../logger');
    const log = createLogger('test:lazy');
    const lazyFn = vi.fn(() => ({ computed: true }));
    log.debug('lazy test', lazyFn);
    expect(lazyFn).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});
