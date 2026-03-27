import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron app before importing logger
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name === 'home') return '/tmp/fleet-logger-test';
      return '/tmp';
    }
  }
}));

// Mock winston-daily-rotate-file to avoid real file I/O in tests
vi.mock('winston-daily-rotate-file', () => {
  const Transport = vi.fn();
  Transport.prototype.on = vi.fn();
  Transport.prototype.log = vi.fn();
  return { default: Transport };
});

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.LOG_LEVEL;
  });

  it('exports createLogger function', async () => {
    const mod = await import('../logger');
    expect(typeof mod.createLogger).toBe('function');
  });

  it('exports root logger instance', async () => {
    const mod = await import('../logger');
    expect(mod.logger).toBeDefined();
    expect(typeof mod.logger.info).toBe('function');
    expect(typeof mod.logger.debug).toBe('function');
    expect(typeof mod.logger.warn).toBe('function');
    expect(typeof mod.logger.error).toBe('function');
  });

  it('createLogger returns a child logger with tag metadata', async () => {
    const mod = await import('../logger');
    const log = mod.createLogger('test-module');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('defaults to debug level when app is not packaged', async () => {
    const mod = await import('../logger');
    expect(mod.logger.level).toBe('debug');
  });

  it('respects LOG_LEVEL env var override', async () => {
    process.env.LOG_LEVEL = 'warn';
    const mod = await import('../logger');
    expect(mod.logger.level).toBe('warn');
  });
});
