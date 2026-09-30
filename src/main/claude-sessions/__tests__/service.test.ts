import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { connect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeSessionsService, claudeConfigDirs } from '../index';
import { DEFAULT_SETTINGS } from '../../../shared/constants';
import type { FleetSettings } from '../../../shared/types';
import type { SetHookState } from '../pane-activity-bridge';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

async function send(socketPath: string, event: object): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = '';
    const client = connect(socketPath, () => client.end(JSON.stringify(event)));
    client.on('data', (chunk) => (reply += chunk.toString()));
    client.on('close', () => resolve(reply));
    client.on('error', reject);
  });
}

const event = (overrides: object = {}): object => ({
  session_id: 's1',
  cwd: '/repo',
  event: 'UserPromptSubmit',
  status: 'processing',
  pid: process.pid,
  pane_id: 'pane-1',
  protocol: 2,
  ...overrides
});

describe('claudeConfigDirs', () => {
  it('lists the default folder and each workspace folder once', () => {
    const settings: FleetSettings = {
      ...DEFAULT_SETTINGS,
      copilot: {
        ...DEFAULT_SETTINGS.copilot,
        workspaceOverrides: {
          a: { claudeConfigDir: '/w/.claude-a' },
          b: { claudeConfigDir: ' ' },
          c: { claudeConfigDir: '/w/.claude-a' },
          d: undefined
        }
      }
    };
    expect(claudeConfigDirs(settings, '/home/u')).toEqual(['/home/u/.claude', '/w/.claude-a']);
  });
});

describe.skipIf(process.platform === 'win32')('ClaudeSessionsService', () => {
  let dir: string;
  let socketPath: string;
  let settings: FleetSettings;
  let installer: { ensureHooks: ReturnType<typeof vi.fn>; uninstall: ReturnType<typeof vi.fn> };
  let setHookState: ReturnType<typeof vi.fn<SetHookState>>;
  let handled: Map<string, (event: unknown, arg: unknown) => unknown>;
  let service: ClaudeSessionsService;

  const create = (platform: NodeJS.Platform = 'linux'): ClaudeSessionsService =>
    new ClaudeSessionsService({
      platform,
      homeDir: '/home/u',
      getSettings: () => settings,
      panes: { has: (id) => id === 'pane-1', paneIds: () => ['pane-1'], getPid: () => 1 },
      workspaceOf: () => ({ workspaceId: 'ws-1', workspaceName: 'Main' }),
      setHookState,
      ipc: { handle: (channel, listener) => handled.set(channel, listener) },
      socketPath,
      installer: installer as never
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-sessions-'));
    socketPath = join(dir, 'hook.sock');
    settings = structuredClone(DEFAULT_SETTINGS);
    installer = { ensureHooks: vi.fn(() => new Map()), uninstall: vi.fn() };
    setHookState = vi.fn<SetHookState>();
    handled = new Map();
    service = create();
  });

  afterEach(async () => {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('installs hooks and tracks a session from a Fleet pane', async () => {
    await service.start();
    expect(installer.ensureHooks).toHaveBeenCalledWith(['/home/u/.claude']);

    await send(socketPath, event());

    expect(service.registry.list()).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        paneId: 'pane-1',
        workspaceId: 'ws-1',
        phase: 'processing'
      })
    ]);
    expect(setHookState).toHaveBeenCalledWith('pane-1', 'working', process.pid);
  });

  it('keeps the pane badge on the pane session while a nested claude runs', async () => {
    await service.start();
    await send(socketPath, event({ event: 'Stop', status: 'waiting_for_input' }));
    setHookState.mockClear();

    const nested = { session_id: 'nested', pid: process.ppid };
    await send(
      socketPath,
      event({ ...nested, event: 'SessionStart', status: 'waiting_for_input' })
    );
    await send(socketPath, event({ ...nested, event: 'UserPromptSubmit', status: 'processing' }));
    await send(socketPath, event({ ...nested, event: 'SessionEnd', status: 'ended' }));

    expect(setHookState).not.toHaveBeenCalled();
    expect(service.registry.getByPane('pane-1')?.sessionId).toBe('s1');
  });

  it('drops an event from a terminal Fleet does not own', async () => {
    await service.start();
    await send(socketPath, event({ pane_id: 'elsewhere', pid: undefined }));
    expect(service.registry.list()).toEqual([]);
  });

  const permission = (toolUseId: string): object =>
    event({
      event: 'PermissionRequest',
      status: 'waiting_for_approval',
      tool: 'Bash',
      tool_use_id: toolUseId
    });

  it('holds a permission request and delivers the answer', async () => {
    await service.start();
    service.addPermissionAnswerer();
    const reply = send(
      socketPath,
      event({
        event: 'PermissionRequest',
        status: 'waiting_for_approval',
        tool: 'Bash',
        tool_use_id: 'tu-1'
      })
    );
    await vi.waitFor(() => expect(service.broker.has('tu-1')).toBe(true));

    expect(service.respondToPermission('tu-1', 'allow')).toBe(true);
    expect(JSON.parse(await reply)).toEqual({ decision: 'allow', reason: '' });
    expect(service.registry.get('s1')?.phase).toBe('processing');
  });

  it('releases a permission request at once when nothing can answer it', async () => {
    await service.start();
    // Resolves only because the service closed the connection unanswered.
    expect(await send(socketPath, permission('tu-1'))).toBe('');
    expect(service.broker.has('tu-1')).toBe(false);
    // Still recorded: Claude Code is asking in the terminal instead.
    expect(service.registry.get('s1')?.phase).toBe('waitingForApproval');
  });

  it('lets go of held requests when the last answerer leaves', async () => {
    await service.start();
    const first = service.addPermissionAnswerer();
    const second = service.addPermissionAnswerer();
    const reply = send(socketPath, permission('tu-1'));
    await vi.waitFor(() => expect(service.broker.has('tu-1')).toBe(true));

    first();
    first();
    expect(service.broker.has('tu-1')).toBe(true);
    second();
    expect(await reply).toBe('');
    expect(service.broker.has('tu-1')).toBe(false);
  });

  it('answers nothing for a question dialog, which the hook does not wait on', async () => {
    await service.start();
    await send(
      socketPath,
      event({ event: 'PermissionRequest', status: 'waiting_for_approval', tool: 'AskUserQuestion' })
    );
    expect(service.registry.get('s1')).toMatchObject({
      phase: 'waitingForInput',
      waitingKind: 'question'
    });
  });

  it('stops, removes its hooks and forgets sessions when tracking is turned off', async () => {
    await service.start();
    await send(socketPath, event());

    settings.claudeSessions.trackSessions = false;
    await service.onSettingsChanged();

    expect(installer.uninstall).toHaveBeenCalledWith('/home/u/.claude');
    expect(service.isRunning).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(service.registry.list()).toEqual([]);
    expect(setHookState).toHaveBeenLastCalledWith('pane-1', null);
  });

  it('does not remove hooks when it starts with tracking already off', async () => {
    settings.claudeSessions.trackSessions = false;
    await service.start();
    expect(installer.uninstall).not.toHaveBeenCalled();
    expect(installer.ensureHooks).not.toHaveBeenCalled();
    expect(service.isRunning).toBe(false);
  });

  it('starts again when tracking is turned back on, and installs into a new workspace folder', async () => {
    await service.start();
    settings.claudeSessions.trackSessions = false;
    await service.onSettingsChanged();
    settings.claudeSessions.trackSessions = true;
    settings.copilot.workspaceOverrides = { ws: { claudeConfigDir: '/w/.claude-ws' } };
    await service.onSettingsChanged();

    expect(service.isRunning).toBe(true);
    expect(installer.ensureHooks).toHaveBeenLastCalledWith(['/home/u/.claude', '/w/.claude-ws']);
  });

  it('ends a pane’s session when the pane closes', async () => {
    await service.start();
    await send(socketPath, event());
    service.onPaneClosed('pane-1');
    expect(service.registry.get('s1')?.phase).toBe('ended');
  });

  it('does nothing on Windows', async () => {
    await service.stop();
    service = create('win32');
    await service.start();
    expect(service.isRunning).toBe(false);
    expect(installer.ensureHooks).not.toHaveBeenCalled();
  });

  it('serves hook status for a folder', () => {
    expect([...handled.keys()]).toEqual(
      expect.arrayContaining([
        'copilot:install-hooks-to',
        'copilot:uninstall-hooks-from',
        'copilot:hook-status-for'
      ])
    );
    expect(() => handled.get('copilot:hook-status-for')?.(null, 42)).toThrow(
      'Expected a folder path'
    );
  });
});
