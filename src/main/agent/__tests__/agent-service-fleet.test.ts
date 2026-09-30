import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  DEFAULT_AGENT_SETTINGS,
  textMessage,
  type AgentSendRequest
} from '../../../shared/agent-types';
import type { SubagentDefinition } from '../../../shared/agent-subagents';
import { AgentService } from '../agent-service';
import { ScheduleStore } from '../schedule-store';
import { PermissionGate } from '../permissions/gate';
import { SubagentManager, type TaskRun } from '../subagents/manager';
import type { StreamOutcome, StreamRequest, WireToolCall } from '../completions';
import { resolveTarget as route, type ResolvedTarget } from '../model-routing';
import type { FleetHost } from '../fleet/host';
import type { FleetActDeps } from '../fleet/capability';
import { FleetLedgerStore } from '../fleet/ledger-store';
import { ActLimiter } from '../fleet/limiter';
import { FleetSpawns } from '../fleet/spawns';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

/**
 * Orchestrator mode as a turn sees it: which tools are offered, what the
 * prompt says about them, which subagents exist, and what a subagent inherits.
 */

const RESOLVE_TARGET = (model: string | null): ResolvedTarget =>
  route(model, { getOpenRouterKey: () => 'sk-or-test', getEndpoints: () => [] });

const PASS_GATE = new PermissionGate({
  getRules: () => ({ allow: ['*'], deny: [], mcp: { allow: ['*'], deny: [] } }),
  persistAllow: () => {},
  persistAllowMcp: () => {},
  emit: () => {}
});

const SETTINGS = {
  ...DEFAULT_AGENT_SETTINGS,
  coding: { ...DEFAULT_AGENT_SETTINGS.coding, model: 'anthropic/claude-sonnet-4.5' }
};

const definition = (name: string, tools: SubagentDefinition['tools']): SubagentDefinition => ({
  name,
  description: `${name} does things`,
  model: 'inherit',
  tools,
  systemPrompt: 'be brief',
  source: 'bundled',
  path: `/agents/${name}.md`
});

const DEFINITIONS = [
  definition('explore', ['read', 'glob', 'grep']),
  definition('fleet-analyst', ['fleet_sessions', 'fleet_read', 'fleet_diff'])
];

const HOST: FleetHost = {
  tracking: () => ({ status: { state: 'running' }, installProblems: [] }),
  sessions: () => [],
  starting: () => [],
  transcript: async () => Promise.resolve(null),
  inputsFor: () => [],
  git: async () => Promise.reject(new Error('unused')),
  now: () => Date.now()
};

const call = (name: string, args: object): WireToolCall => ({
  id: `call-${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
});

const outcome = (toolCalls: WireToolCall[] = []): StreamOutcome => ({
  toolCalls,
  serverToolCalls: [],
  citations: [],
  model: null,
  provider: null
});

describe('orchestrator mode', () => {
  let dir: string;
  let runs: TaskRun[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-service-fleet-'));
    runs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs one turn, answering each round with the next set of calls, and returns every round sent. */
  async function turn(options: {
    orchestrator: boolean;
    wired?: boolean;
    calls?: WireToolCall[][];
    history?: AgentSendRequest['history'];
    ledger?: FleetLedgerStore;
    act?: FleetActDeps;
  }): Promise<StreamRequest[]> {
    const rounds: StreamRequest[] = [];
    const request: AgentSendRequest = {
      streamId: 'stream-1',
      threadId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
      cwd: dir,
      history: options.history ?? [],
      text: 'what are my sessions doing?',
      attachments: [],
      todos: [],
      orchestrator: options.orchestrator
    };
    await new Promise<void>((resolve) => {
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
        getSettings: () => SETTINGS,
        subagents: new SubagentManager({
          emit: () => {},
          run: async (run) => {
            runs.push(run);
            return Promise.resolve({ report: 'done', usage: null });
          },
          definitions: async () => Promise.resolve(DEFINITIONS)
        }),
        fleet:
          options.wired === false
            ? null
            : {
                host: HOST,
                ledger: options.ledger ?? new FleetLedgerStore(dir),
                act: options.act ?? null
              },
        getApiKey: () => 'sk-or-test',
        resolveTarget: RESOLVE_TARGET,
        emit,
        stream: async (req: StreamRequest) => {
          rounds.push(req);
          return Promise.resolve(outcome(options.calls?.[rounds.length - 1] ?? []));
        }
      }).send(request);
    });
    return rounds;
  }

  const names = (round: StreamRequest): string[] =>
    (round.tools ?? []).map((spec) => spec.function.name);
  const system = (round: StreamRequest): string => {
    const { content } = round.messages[0];
    return typeof content === 'string' ? content : '';
  };
  const taskSpec = (round: StreamRequest): string =>
    JSON.stringify((round.tools ?? []).find((s) => s.function.name === 'task'));

  it('offers no fleet tool, block or analyst to a regular pane', async () => {
    const [round] = await turn({ orchestrator: false });
    expect(names(round).filter((n) => n.startsWith('fleet_'))).toEqual([]);
    expect(system(round)).not.toContain('Orchestrating Claude Code sessions');
    expect(taskSpec(round)).toContain('explore');
    expect(taskSpec(round)).not.toContain('fleet-analyst');
    // Not even as a tool a subagent could be handed: named there, the model
    // learns they exist and tries to reach them some other way.
    expect(taskSpec(round)).not.toContain('fleet_');
    // The same for a tool no child gets: there is no image model here, and a
    // child never gets the image tool anyway.
    expect(taskSpec(round)).not.toContain('"image"');
    expect(taskSpec(round)).toContain('"read"');
  });

  it('offers the read tools, the block and the analyst in orchestrator mode', async () => {
    const [round] = await turn({ orchestrator: true });
    expect(names(round).filter((n) => n.startsWith('fleet_'))).toEqual([
      'fleet_sessions',
      'fleet_read',
      'fleet_diff'
    ]);
    expect(system(round)).toContain('## Orchestrating Claude Code sessions');
    expect(system(round)).toContain('dispatch the `fleet-analyst` subagent');
    expect(system(round)).toContain('`<session-data>` fences');
    expect(taskSpec(round)).toContain('fleet-analyst');
    expect(taskSpec(round)).toContain('fleet_read');
  });

  it('offers nothing when the session service is not wired up', async () => {
    const [round] = await turn({ orchestrator: true, wired: false });
    expect(names(round).filter((n) => n.startsWith('fleet_'))).toEqual([]);
  });

  it('runs a fleet tool through the capability', async () => {
    const rounds = await turn({
      orchestrator: true,
      calls: [[call('fleet_sessions', {})]]
    });
    expect(JSON.stringify(rounds[1].messages)).toContain(
      'No Claude Code sessions are running in Fleet panes.'
    );
  });

  it('refuses a fleet tool called from a regular pane', async () => {
    const rounds = await turn({
      orchestrator: false,
      calls: [[call('fleet_read', { session: 'x', level: 'brief' })]]
    });
    expect(JSON.stringify(rounds[1].messages)).toContain(
      'works only in an Agent pane in orchestrator mode'
    );
  });

  it("hands the analyst a read-only pick of the Orchestrator's tools", async () => {
    await turn({
      orchestrator: true,
      calls: [[call('task', { agent: 'fleet-analyst', prompt: 'read abcdef12 in depth' })]]
    });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const [run] = runs;
    expect(run.definition.name).toBe('fleet-analyst');
    expect(run.fleet).not.toBeNull();
    expect(run.fleet?.send).toBeNull();
    expect(run.fleet?.spawn).toBeNull();
    expect(run.fleet?.wait).toBeNull();
    expect(run.fleet?.permission).toBeNull();
  });

  it('refuses to dispatch the analyst from a regular pane', async () => {
    const rounds = await turn({
      orchestrator: false,
      calls: [[call('task', { agent: 'fleet-analyst', prompt: 'read it' })]]
    });
    expect(runs).toEqual([]);
    expect(JSON.stringify(rounds[1].messages)).toContain('There is no subagent called');
  });

  it('refuses to hand a fleet tool to a subagent from a regular pane', async () => {
    const rounds = await turn({
      orchestrator: false,
      calls: [[call('task', { agent: 'explore', prompt: 'look around', tools: ['fleet_read'] })]]
    });
    expect(runs).toEqual([]);
    expect(JSON.stringify(rounds[1].messages)).toContain(
      'fleet_read works only in an Agent pane in orchestrator mode'
    );
  });

  it('gives a subagent with no list of its own no fleet tool from a regular pane', async () => {
    DEFINITIONS.push(definition('general', null));
    try {
      await turn({
        orchestrator: false,
        calls: [[call('task', { agent: 'general', prompt: 'do it' })]]
      });
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      expect(runs[0].tools.filter((t) => t.startsWith('fleet_'))).toEqual([]);
      expect(runs[0].tools).toContain('read');
    } finally {
      DEFINITIONS.pop();
    }
  });

  it('explains the missing tools once the mode is turned off mid-conversation', async () => {
    const earlier: AgentSendRequest['history'] = [
      textMessage('u1', 'user', 'what are my sessions doing?'),
      {
        ...textMessage('a1', 'assistant', ''),
        parts: [
          {
            type: 'tool',
            call: {
              id: 'c1',
              name: 'fleet_sessions',
              args: '{}',
              result: 'none',
              error: null,
              summary: '0 sessions',
              image: null,
              todos: null,
              task: null
            }
          }
        ]
      }
    ];
    const [off] = await turn({ orchestrator: false, history: earlier });
    expect(system(off)).toContain('## Orchestrator mode is off');
    const [fresh] = await turn({ orchestrator: false });
    expect(system(fresh)).not.toContain('Orchestrator mode is off');
  });

  it('sends the ledger after the cached conversation on every round, even once compacted', async () => {
    const ledger = new FleetLedgerStore(dir);
    ledger.addEntry('6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', {
      action: 'send',
      ref: 'abcdef12',
      paneId: 'abcdef12-pane',
      sessionId: 's1',
      epoch: 0,
      prompt: '[orchestrator] Run the tests',
      why: 'the refactor is done',
      expect: 'the failing test names',
      at: Date.now(),
      started: true
    });
    // Everything before this was folded into one summary, the ledger's entry with it.
    const compacted: AgentSendRequest['history'] = [
      { ...textMessage('s', 'summary', 'We refactored the parser.'), role: 'summary' }
    ];
    const rounds = await turn({
      orchestrator: true,
      history: compacted,
      ledger,
      calls: [[call('fleet_sessions', {})]]
    });
    expect(rounds).toHaveLength(2);
    for (const round of rounds) {
      const at = round.messages.findIndex(
        (m) => typeof m.content === 'string' && m.content.includes('Your fleet ledger')
      );
      expect(at).toBeGreaterThanOrEqual(round.cacheUpTo ?? Infinity);
      expect(round.messages[at].content).toContain('#1 prompted abcdef12');
      expect(round.messages[at].content).toContain('expecting: the failing test names');
    }
  });

  it('sends no ledger to a regular pane', async () => {
    const [round] = await turn({ orchestrator: false });
    expect(JSON.stringify(round.messages)).not.toContain('Your fleet ledger');
  });

  it('offers fleet_send and fleet_spawn once wired up, and never to a subagent', async () => {
    const act: FleetActDeps = {
      prompter: {
        refusal: () => null,
        send: async () => Promise.resolve({ ok: false, reason: 'unused' })
      },
      limiter: new ActLimiter(),
      spawns: new FleetSpawns(),
      platform: 'linux',
      openTab: async () => Promise.resolve('unused'),
      worktrees: {
        create: async () => Promise.reject(new Error('unused')),
        remove: async () => Promise.resolve()
      },
      notePaneInput: () => {},
      newPaneId: () => 'unused'
    };
    const [round] = await turn({
      orchestrator: true,
      act,
      calls: [[call('task', { agent: 'fleet-analyst', prompt: 'read abcdef12' })]]
    });
    expect(names(round)).toContain('fleet_send');
    expect(names(round)).toContain('fleet_spawn');
    expect(system(round)).toContain('`fleet_send` types a prompt into a session');
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].fleet?.send).toBeNull();
    expect(runs[0].tools).not.toContain('fleet_send');
    expect(runs[0].fleet?.spawn).toBeNull();
  });
});
