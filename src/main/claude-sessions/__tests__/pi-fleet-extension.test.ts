import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHookEvent, type HookEvent } from '../hook-events';
import { hashPrompt } from '../registry';

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** The extension in `resources/`, as Pi loads it. */
async function loadExtension(): Promise<(pi: unknown) => void> {
  const path = join(__dirname, '../../../../resources/pi-extensions/fleet.js');
  const module = (await import(/* @vite-ignore */ path)) as { default: (pi: unknown) => void };
  return module.default;
}

describe('the Pi extension', () => {
  let dir: string;
  let server: Server;
  let events: HookEvent[];
  let handlers: Map<string, Handler>;

  const ctx = (hasUI = true): unknown => ({
    hasUI,
    cwd: '/repo',
    model: { contextWindow: 272_000 },
    sessionManager: { getSessionId: () => 's1', getSessionFile: () => '/x/t_s1.jsonl' }
  });

  /** Fire a Pi event, and wait until Fleet's socket has what it sent. */
  async function fire(name: string, event: unknown = {}, context = ctx()): Promise<void> {
    const before = events.length;
    const result = await handlers.get(name)?.(event, context);
    expect(result).toBeUndefined();
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before));
  }

  async function start(env: Record<string, string>): Promise<void> {
    vi.stubEnv('FLEET_SESSION', env.session);
    vi.stubEnv('FLEET_COPILOT_SOCKET', env.socket);
    vi.stubEnv('FLEET_PANE_ID', 'pane-1');
    const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
    (await loadExtension())(pi);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-pi-ext-'));
    events = [];
    handlers = new Map();
    server = createServer((socket) => {
      let text = '';
      socket.on('data', (chunk) => (text += chunk.toString()));
      socket.on('end', () => {
        const parsed = parseHookEvent(text);
        if (parsed) events.push(parsed);
        socket.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(join(dir, 's.sock'), resolve));
    await start({ session: '1', socket: join(dir, 's.sock') });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a session in a form Fleet takes', async () => {
    await fire('session_start', { reason: 'startup' });
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      cwd: '/repo',
      event: 'SessionStart',
      runtime: 'pi',
      paneId: 'pane-1',
      source: 'startup',
      transcriptPath: '/x/t_s1.jsonl',
      contextWindow: 272_000
    });
  });

  it('reports a turn with a tool, in order', async () => {
    await fire('before_agent_start', { prompt: 'go' });
    await fire('tool_execution_start', {
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'ls' }
    });
    await fire('tool_execution_end', { toolCallId: 't1', toolName: 'bash', isError: true });
    await fire('agent_settled', { aborted: false });

    expect(events.map((e) => e.event)).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUseFailure',
      'Stop'
    ]);
    expect(events[1]).toMatchObject({ tool: 'Bash', toolUseId: 't1', status: 'running_tool' });
  });

  it('hashes the text as submitted, before Pi expands a template', async () => {
    await handlers.get('input')?.({ text: '  /review  ' }, ctx());
    await fire('before_agent_start', { prompt: 'The long expanded template' });
    expect(events[0].promptHash).toBe(hashPrompt('/review'));
  });

  it('reports a failed run with its reason', async () => {
    const messages = [{ role: 'assistant', stopReason: 'error', errorMessage: 'Rate limited' }];
    await handlers.get('agent_end')?.({ messages }, ctx());
    await fire('agent_settled', { aborted: false });
    expect(events[0]).toMatchObject({
      event: 'StopFailure',
      status: 'api_error',
      error: 'unknown',
      message: 'Rate limited'
    });
  });

  it('reports a stop, not a failure, when the user stopped the run', async () => {
    const messages = [{ role: 'assistant', stopReason: 'error', errorMessage: 'Aborted' }];
    await handlers.get('agent_end')?.({ messages }, ctx());
    await fire('agent_settled', { aborted: true });
    expect(events[0].event).toBe('Stop');
  });

  it('shows a dialog as a question, then goes back to what Pi was doing', async () => {
    await fire('ui_prompt_start');
    expect(events[0]).toMatchObject({ status: 'waiting_for_approval', tool: 'AskUserQuestion' });

    await fire('ui_prompt_end');
    expect(events[1]).toMatchObject({ event: 'Stop', status: 'waiting_for_input' });

    await handlers.get('agent_start')?.({}, ctx());
    await fire('ui_prompt_end');
    expect(events[2]).toMatchObject({ event: 'PostToolUse', status: 'processing' });
  });

  it('stays busy through a compaction that retries the turn', async () => {
    await handlers.get('agent_start')?.({}, ctx());
    await fire('session_before_compact');
    await fire('session_compact', { willRetry: true });
    await fire('agent_settled', { aborted: false });
    expect(events.map((e) => e.status)).toEqual(['compacting', 'processing', 'waiting_for_input']);
  });

  it('goes back to the prompt after a compaction the user asked for', async () => {
    await fire('session_compact', { willRetry: false });
    expect(events[0]).toMatchObject({ event: 'Stop', status: 'waiting_for_input' });
  });

  it('keeps no hash from a follow-up typed during a run', async () => {
    await handlers.get('input')?.({ text: 'later', streamingBehavior: 'followUp' }, ctx());
    await fire('before_agent_start', { prompt: 'first' });
    expect(events[0].promptHash).toBe(hashPrompt('first'));
  });

  it('ends the session only when Pi quits', async () => {
    await handlers.get('session_shutdown')?.({ reason: 'new' }, ctx());
    await fire('session_shutdown', { reason: 'quit' });
    expect(events.map((e) => e.event)).toEqual(['SessionEnd']);
  });

  it('says nothing for a run with no screen', async () => {
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx(false));
    await fire('session_start', { reason: 'startup' });
    expect(events).toHaveLength(1);
  });

  it('does nothing outside a Fleet pane', async () => {
    const none = new Map<string, Handler>();
    vi.stubEnv('FLEET_SESSION', '');
    (await loadExtension())({ on: (name: string, h: Handler) => none.set(name, h) });
    expect(none.size).toBe(0);
  });

  it('never breaks Pi when Fleet has gone', async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(join(dir, 's.sock'), { force: true });
    await expect(
      handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx())
    ).resolves.toBeUndefined();
    await new Promise<void>((resolve) => server.listen(join(dir, 's.sock'), resolve));
  });
});
