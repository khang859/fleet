import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  DEFAULT_AGENT_SETTINGS,
  textMessage,
  type AgentSendRequest
} from '../../../shared/agent-types';
import { AgentService } from '../agent-service';
import { ScheduleStore } from '../schedule-store';
import { PermissionGate } from '../permissions/gate';
import { SubagentManager } from '../subagents/manager';
import { McpManager } from '../mcp/manager';
import { fakeServer } from '../mcp/__tests__/fake-server';
import type { StreamOutcome, StreamRequest } from '../completions';
import { resolveTarget as route, type ResolvedTarget } from '../model-routing';

/**
 * Which transport a turn goes out on, and what it carries.
 *
 * The whole of the deferral feature rests on one decision made in one place:
 * a request that has deferred tools goes to the Responses API and a request
 * that does not keeps the transport it has always used. Getting that backwards
 * fails in two different and equally quiet ways - a Chat Completions request
 * carrying `openrouter:tool_search` is a 400, and a Responses request for an
 * ordinary turn is a change of endpoint nobody asked for.
 *
 * So these tests run a real turn with a real MCP manager behind it and look at
 * which stream function was called and what reached it.
 */

const RESOLVE_TARGET = (model: string | null): ResolvedTarget =>
  route(model, { getOpenRouterKey: () => 'sk-or-test', getEndpoints: () => [] });

const PASS_GATE = new PermissionGate({
  getRules: () => ({ allow: ['*'], deny: [], mcp: { allow: ['*'], deny: [] } }),
  persistAllow: () => {},
  persistAllowMcp: () => {},
  emit: () => {}
});

const NO_SUBAGENTS = new SubagentManager({
  emit: () => {},
  run: async () => Promise.reject(new Error('no subagent should run here')),
  definitions: async () => Promise.resolve([])
});

const REQUEST: AgentSendRequest = {
  streamId: 'stream-1',
  threadId: 'thread-1',
  cwd: '/repo',
  history: [textMessage('a', 'user', 'hi')],
  text: 'what does this do?',
  attachments: [],
  todos: []
};

const round = (): StreamOutcome => ({
  toolCalls: [],
  serverToolCalls: [],
  citations: [],
  model: null,
  provider: null
});

/** A manager with one connected server offering two tools. */
async function connectedMcp(): Promise<McpManager> {
  const server = fakeServer({
    tools: [
      { name: 'list_issues', description: 'List issues.', inputSchema: { type: 'object' } },
      { name: 'create_issue', description: 'Create an issue.', inputSchema: { type: 'object' } }
    ]
  });
  const manager = new McpManager({
    getConfig: () => ({ tracker: { url: 'https://tracker.test', enabled: true } }),
    createTransport: () => server.transport
  });
  await manager.reload();
  return manager;
}

/** Runs one turn and hands back what each transport was asked to send. */
async function runTurn(options: {
  toolSearch: boolean;
  mcp: McpManager | null;
}): Promise<{ completions: StreamRequest[]; responses: StreamRequest[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-tool-search-'));
  const completions: StreamRequest[] = [];
  const responses: StreamRequest[] = [];
  const done = new Promise<void>((resolve) => {
    const emit = (channel: string): void => {
      if (
        channel === IPC_CHANNELS.AGENT_STREAM_DONE ||
        channel === IPC_CHANNELS.AGENT_STREAM_ERROR
      ) {
        resolve();
      }
    };
    new AgentService({
      schedules: new ScheduleStore({ file: join(dir, 'schedules.json') }),
      gate: PASS_GATE,
      getSettings: () => ({
        ...DEFAULT_AGENT_SETTINGS,
        coding: { ...DEFAULT_AGENT_SETTINGS.coding, model: 'anthropic/claude-sonnet-4.5' },
        toolSearch: { enabled: options.toolSearch, maxResults: 5 }
      }),
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      resolveTarget: RESOLVE_TARGET,
      mcp: options.mcp,
      emit,
      stream: vi.fn(async (req: StreamRequest) => {
        completions.push(req);
        return Promise.resolve(round());
      }),
      streamResponses: vi.fn(async (req: StreamRequest) => {
        responses.push(req);
        return Promise.resolve(round());
      })
    }).send(REQUEST);
  });
  await done;
  rmSync(dir, { recursive: true, force: true });
  return { completions, responses };
}

describe('a turn with deferral switched on', () => {
  it('goes out on the Responses transport, not Chat Completions', async () => {
    const sent = await runTurn({ toolSearch: true, mcp: await connectedMcp() });
    expect(sent.responses).toHaveLength(1);
    expect(sent.completions).toHaveLength(0);
  });

  /*
   * The tools have to move out of `tools` rather than being copied: left in
   * both, every definition would be stated in full and the saving would be
   * zero while looking exactly like it worked.
   */
  it('moves the server tools out of the stated list and into the deferred one', async () => {
    const sent = await runTurn({ toolSearch: true, mcp: await connectedMcp() });
    const request = sent.responses[0];
    expect(request.deferredTools?.map((t) => t.function.name)).toEqual([
      'mcp__tracker__list_issues',
      'mcp__tracker__create_issue'
    ]);
    expect(request.tools?.map((t) => t.function.name)).not.toContain('mcp__tracker__list_issues');
  });

  it('sends the search tool that finds them again', async () => {
    const sent = await runTurn({ toolSearch: true, mcp: await connectedMcp() });
    expect(sent.responses[0]?.serverTools?.map((t) => t.type)).toContain('openrouter:tool_search');
  });

  it("still states Fleet's own tools in full", async () => {
    const sent = await runTurn({ toolSearch: true, mcp: await connectedMcp() });
    expect(sent.responses[0]?.tools?.map((t) => t.function.name)).toContain('read');
    expect(sent.responses[0]?.tools?.map((t) => t.function.name)).toContain('bash');
  });
});

describe('a turn with deferral switched off', () => {
  it('keeps the Chat Completions transport', async () => {
    const sent = await runTurn({ toolSearch: false, mcp: await connectedMcp() });
    expect(sent.completions).toHaveLength(1);
    expect(sent.responses).toHaveLength(0);
  });

  it('states the server tools in the list, as it always has', async () => {
    const sent = await runTurn({ toolSearch: false, mcp: await connectedMcp() });
    expect(sent.completions[0]?.tools?.map((t) => t.function.name)).toContain(
      'mcp__tracker__list_issues'
    );
    expect(sent.completions[0]?.deferredTools).toEqual([]);
  });
});

/*
 * Deferral with nothing to defer is worse than deferral switched off: the
 * request would carry a search tool that can only ever answer "nothing found",
 * and the prompt would tell the model to use it.
 */
describe('a turn with deferral on but no server connected', () => {
  it('keeps the Chat Completions transport and sends no search tool', async () => {
    const sent = await runTurn({ toolSearch: true, mcp: null });
    expect(sent.completions).toHaveLength(1);
    expect(sent.responses).toHaveLength(0);
    expect(sent.completions[0]?.serverTools?.map((t) => t.type) ?? []).not.toContain(
      'openrouter:tool_search'
    );
  });
});
