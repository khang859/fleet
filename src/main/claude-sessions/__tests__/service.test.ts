import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { connect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeSessionsService, claudeConfigDirs } from '../index';
import { DEFAULT_SETTINGS } from '../../../shared/constants';
import type { FleetSettings } from '../../../shared/types';
import type { SetHookState } from '../pane-activity-bridge';
import type { GitRunner } from '../git-probe';
import { BUNDLED_PRICES } from '../../../shared/claude-pricing';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { ClaudeSessionsSnapshot } from '../../../shared/claude-sessions';

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
  let snapshots: ClaudeSessionsSnapshot[];
  let git: ReturnType<typeof vi.fn<GitRunner>>;
  let writeToPane: ReturnType<typeof vi.fn<(paneId: string, data: string) => void>>;

  const create = (platform: NodeJS.Platform = 'linux'): ClaudeSessionsService =>
    new ClaudeSessionsService({
      platform,
      homeDir: '/home/u',
      getSettings: () => settings,
      panes: { has: (id) => id === 'pane-1', paneIds: () => ['pane-1'], getPid: () => 1 },
      workspaceOf: () => ({ workspaceId: 'ws-1', workspaceName: 'Main' }),
      setHookState,
      writeToPane,
      ipc: { handle: (channel, listener) => handled.set(channel, listener) },
      socketPath,
      installer: installer as never,
      priceTable: () => BUNDLED_PRICES,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      git
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-sessions-'));
    socketPath = join(dir, 'hook.sock');
    settings = structuredClone(DEFAULT_SETTINGS);
    installer = { ensureHooks: vi.fn(() => new Map()), uninstall: vi.fn() };
    setHookState = vi.fn<SetHookState>();
    handled = new Map();
    snapshots = [];
    writeToPane = vi.fn();
    git = vi.fn<GitRunner>(async (_cwd, args) =>
      Promise.resolve({
        stdout: args[0] === 'status' ? '## feature/x...origin/feature/x\0 M a.ts\0' : '',
        truncated: false
      })
    );
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

    // An option is picked by its number, as a key press; a prompt is refused.
    expect((await service.sendPrompt('s1', 'use Postgres', 'user')).ok).toBe(false);
    expect(service.answerQuestion('s1', 'Postgres')).toBe(false);
    expect(service.answerQuestion('s1', '2')).toBe(true);
    expect(writeToPane.mock.calls).toEqual([['pane-1', '2\r']]);
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

  describe('settling from the transcript', () => {
    const jsonl = (...lines: object[]): string =>
      lines.map((l) => `${JSON.stringify(l)}\n`).join('');
    const bashUse = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'rm -rf build' } }
        ]
      }
    };

    it('leaves a permission answered No in the terminal waiting for a prompt', async () => {
      const transcript = join(dir, 's1.jsonl');
      writeFileSync(transcript, jsonl(bashUse));
      await service.start();
      await send(socketPath, { ...permission('tu-1'), transcript_path: transcript });
      expect(service.registry.get('s1')?.phase).toBe('waitingForApproval');

      appendFileSync(
        transcript,
        jsonl({
          type: 'user',
          uuid: 'r1',
          toolUseResult: 'User rejected tool use',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-1',
                content: "The user doesn't want to proceed with this tool use.",
                is_error: true
              }
            ]
          }
        })
      );
      await vi.waitFor(() =>
        expect(service.registry.get('s1')).toMatchObject({
          phase: 'waitingForInput',
          waitingKind: 'prompt',
          pendingPermissions: []
        })
      );
    });

    it('puts a session back to work when a queued prompt starts after the Stop', async () => {
      const transcript = join(dir, 's1.jsonl');
      writeFileSync(
        transcript,
        jsonl({ type: 'queue-operation', operation: 'enqueue', content: 'next one' })
      );
      await service.start();
      await send(socketPath, event({ transcript_path: transcript }));
      await send(
        socketPath,
        event({ event: 'Stop', status: 'waiting_for_input', transcript_path: transcript })
      );
      expect(service.registry.get('s1')?.phase).toBe('waitingForInput');

      appendFileSync(transcript, jsonl({ type: 'queue-operation', operation: 'dequeue' }));
      await vi.waitFor(() => expect(service.registry.get('s1')?.phase).toBe('processing'));
      const brief = await service.transcript('s1');
      expect(brief?.path).toBe(transcript);
    });
  });

  it('types a prompt into the pane unless the user is typing there', async () => {
    await service.start();
    await send(socketPath, event({ event: 'Stop', status: 'waiting_for_input' }));
    writeToPane.mockImplementation((_pane, data) => {
      if (data === '\r') {
        void send(socketPath, event({ event: 'UserPromptSubmit', status: 'processing' }));
      }
    });

    const sent = await service.sendPrompt('s1', 'Run the tests', 'user');
    expect(sent).toEqual({ ok: true, confirmed: true, text: 'Run the tests' });
    expect(writeToPane.mock.calls).toEqual([
      ['pane-1', 'Run the tests'],
      ['pane-1', '\r']
    ]);
    expect(service.inputsFor('s1')).toEqual([expect.objectContaining({ origin: 'user' })]);

    await send(socketPath, event({ event: 'Stop', status: 'waiting_for_input' }));
    writeToPane.mockClear();
    service.onPaneInput('pane-1', 'half typed');
    expect((await service.sendPrompt('s1', 'Run the tests', 'user')).ok).toBe(false);
    expect(writeToPane).not.toHaveBeenCalled();
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
  describe('status view', () => {
    const list = (): ClaudeSessionsSnapshot =>
      handled.get(IPC_CHANNELS.CLAUDE_SESSIONS_LIST)?.(null, undefined) as ClaudeSessionsSnapshot;

    it('lists each pane session with its usage and git state', async () => {
      await service.start();
      const transcript = join(dir, 's1.jsonl');
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1_000_000 } }
        })}\n`
      );
      await send(socketPath, event({ transcript_path: transcript }));
      await send(
        socketPath,
        event({ event: 'Stop', status: 'waiting_for_input', transcript_path: transcript })
      );

      await vi.waitFor(() =>
        expect(list().sessions).toEqual([
          expect.objectContaining({
            sessionId: 's1',
            phase: 'waitingForInput',
            usage: { costUsd: 5, contextTokens: 1_000_000, contextLimit: 1_000_000 },
            git: expect.objectContaining({ branch: 'feature/x', dirtyFiles: 1 })
          })
        ])
      );
      expect(list().status).toEqual({ state: 'running' });
      expect(git).toHaveBeenCalledWith('/repo', expect.arrayContaining(['status']));
    });

    it('leaves out a claude run by a tool inside the pane', async () => {
      await service.start();
      await send(socketPath, event({ event: 'Stop', status: 'waiting_for_input' }));
      await send(
        socketPath,
        event({ session_id: 'nested', pid: process.ppid, event: 'UserPromptSubmit' })
      );
      expect(service.registry.list()).toHaveLength(2);
      expect(list().sessions.map((s) => s.sessionId)).toEqual(['s1']);
    });

    it('pushes changes as one coalesced snapshot', async () => {
      await service.start();
      await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
      snapshots.length = 0;
      await send(socketPath, event());
      await send(socketPath, event({ event: 'PreToolUse', tool: 'Bash', tool_use_id: 't1' }));
      await send(socketPath, event({ event: 'Stop', status: 'waiting_for_input' }));
      await vi.waitFor(() => expect(snapshots.at(-1)?.sessions[0]?.phase).toBe('waitingForInput'));
      // Three events in quick succession, not three pushes (git may add one more).
      expect(snapshots.length).toBeLessThanOrEqual(2);
    });

    it('reports folders it could not install hooks into', async () => {
      installer.ensureHooks.mockReturnValue(
        new Map([['/home/u/.claude', new Error('settings.json could not be read')]])
      );
      await service.start();
      expect(list().installProblems).toEqual([
        { configDir: '/home/u/.claude', detail: 'settings.json could not be read' }
      ]);
    });

    it('says when tracking is off, unsupported, or could not start', async () => {
      settings.claudeSessions.trackSessions = false;
      await service.start();
      expect(list().status).toEqual({ state: 'off' });

      await service.stop();
      handled = new Map();
      service = create('win32');
      await service.start();
      expect(list().status).toEqual({ state: 'unsupported' });

      await service.stop();
      handled = new Map();
      settings.claudeSessions.trackSessions = true;
      socketPath = join(dir, 'missing', 'hook.sock');
      service = create();
      await service.start();
      expect(list().status).toMatchObject({ state: 'failed' });
    });
  });
});
