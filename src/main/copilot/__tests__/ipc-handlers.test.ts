import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The copilot's permission answer crosses from its renderer, so main checks
 * what arrives before it answers Claude Code with it.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: vi.fn()
  }
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

const { registerCopilotIpcHandlers } = await import('../ipc-handlers');
const { IPC_CHANNELS } = await import('../../../shared/constants');
type Deps = Parameters<typeof registerCopilotIpcHandlers>;

describe('copilot permission answers', () => {
  const respondToPermission = vi.fn(() => true);

  const respond = (args: object): unknown => {
    const handler = handlers.get(IPC_CHANNELS.COPILOT_RESPOND_PERMISSION);
    if (!handler) throw new Error('no handler');
    return handler({}, args);
  };

  beforeEach(() => {
    handlers.clear();
    respondToPermission.mockClear();
    const sessions = { registry: {}, respondToPermission } as unknown as Deps[0];
    registerCopilotIpcHandlers(sessions, {} as Deps[1], {} as Deps[2], {} as Deps[3], () => null);
  });

  it('passes an allow with the suggestion picked', () => {
    expect(respond({ toolUseId: 'tu-1', decision: 'allow', suggestion: 1 })).toBe(true);
    expect(respondToPermission).toHaveBeenCalledWith('tu-1', 'allow', undefined, 1);
  });

  it('refuses a decision that is neither allow nor deny', () => {
    expect(respond({ toolUseId: 'tu-1', decision: 'maybe' })).toBe(false);
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it('drops a suggestion that is not a whole number', () => {
    respond({ toolUseId: 'tu-1', decision: 'allow', suggestion: 0.5 });
    respond({ toolUseId: 'tu-1', decision: 'allow', suggestion: '0' });
    expect(respondToPermission).toHaveBeenNthCalledWith(1, 'tu-1', 'allow', undefined, undefined);
    expect(respondToPermission).toHaveBeenNthCalledWith(2, 'tu-1', 'allow', undefined, undefined);
  });
});
