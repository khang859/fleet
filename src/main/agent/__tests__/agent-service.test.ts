import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  buildSystemPrompt,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  EMPTY_AGENT_USAGE,
  MAX_TOOL_ROUNDS_CEILING,
  textMessage,
  type AgentCompactRequest,
  type AgentMessage,
  type AgentSendRequest
} from '../../../shared/agent-types';
import type { AgentScheduleCapability, AgentToolCall } from '../../../shared/agent-tools';
import type { AgentTodoItem } from '../../../shared/agent-todos';
import {
  CLEARED_RESULT_TEXT,
  CLEAR_KEEP_RECENT,
  COMPACT_SYSTEM_PROMPT,
  SUMMARY_WIRE_PREFIX
} from '../../../shared/agent-context';
import {
  AgentService,
  FLEET_WIRE_PREFIX,
  toCompactMessages,
  toReasoningParam,
  toWireHistory,
  withClearedWireResults,
  withResumeNote,
  withScheduleReminder,
  withSubagentReminder,
  withTodoReminder
} from '../agent-service';
import { ScheduleStore } from '../schedule-store';
import { SCHEDULE_WIRE_PREFIX } from '../../../shared/agent-schedule';
import { PermissionGate } from '../permissions/gate';
import { SubagentManager, type LiveSubagent } from '../subagents/manager';
import {
  collectToolCalls,
  parseStreamLine,
  type AgentWireMessage,
  type StreamOutcome,
  type StreamRequest,
  type ToolCallDelta,
  type WireToolCall
} from '../openrouter';

/**
 * A machine with no subagent definitions on it, which is what the tests below
 * are about: what a turn does. What it does when there *are* subagents has its
 * own file, and letting these reach the real loader would make every assertion
 * about the tool list depend on what is in `resources/agents` today.
 */
const NO_SUBAGENTS = new SubagentManager({
  emit: () => {},
  run: async () => Promise.reject(new Error('no subagent should run here')),
  definitions: async () => Promise.resolve([])
});

/**
 * A schedule store pointed at a temporary file, replaced before every test.
 *
 * A `let` rather than a constant because it has to be swapped, and swapped
 * rather than cleared because the store reads its file once and keeps it: two
 * tests sharing one would share whatever the first of them set.
 */
let SCHEDULES = new ScheduleStore({ file: join(tmpdir(), 'fleet-agent-service-schedules.json') });
let schedulesDir: string;

beforeEach(() => {
  schedulesDir = mkdtempSync(join(tmpdir(), 'fleet-agent-service-schedules-'));
  SCHEDULES = new ScheduleStore({ file: join(schedulesDir, 'schedules.json') });
});

afterEach(() => {
  rmSync(schedulesDir, { recursive: true, force: true });
});

/**
 * A machine with one subagent already out and never coming back, for the rounds
 * that are meant to name it. Its child hangs deliberately: what is being checked
 * is what a turn sends while one is still running, which is the only time there
 * is anything to say.
 */
async function oneRunningSubagent(threadId: string): Promise<SubagentManager> {
  const subagents = new SubagentManager({
    emit: () => {},
    run: async () => new Promise(() => {}),
    definitions: async () =>
      Promise.resolve([
        {
          name: 'explore',
          description: 'looks things up',
          systemPrompt: 'be brief',
          tools: null,
          model: 'inherit',
          source: 'bundled' as const,
          path: '/repo/.fleet/agents/explore.md'
        }
      ])
  });
  await subagents.dispatch({
    agent: 'explore',
    prompt: 'find where the column width is decided',
    tools: null,
    parentModel: 'a/model',
    threadId,
    callId: 'call-1',
    cwd: '/repo'
  });
  return subagents;
}

/**
 * A gate that lets everything through. Whether a command is allowed is its own
 * file's business; these tests are about what a turn does with the answer.
 */
const PASS_GATE = new PermissionGate({
  getRules: () => ({ allow: ['*'], deny: [], mcp: { allow: ['*'], deny: [] } }),
  persistAllow: () => {},
  persistAllowMcp: () => {},
  emit: () => {}
});

const REQUEST: AgentSendRequest = {
  streamId: 'stream-1',
  threadId: 'thread-1',
  cwd: '/repo',
  history: [
    textMessage('a', 'user', 'hi'),
    { ...textMessage('b', 'assistant', 'hello'), reasoning: 'thinking', reasoningMs: 1200 }
  ],
  text: 'what does this do?',
  attachments: [],
  todos: []
};

const COMPACT_REQUEST: AgentCompactRequest = {
  streamId: 'compact-1',
  cwd: '/repo',
  messages: REQUEST.history
};

const SETTINGS = {
  ...DEFAULT_AGENT_SETTINGS,
  coding: { ...DEFAULT_AGENT_SETTINGS.coding, model: 'anthropic/claude-sonnet-4.5' }
};

/**
 * A finished round, as the stream reports one. Most tests care only about what
 * the model asked for next, so who served it defaults to unstated - which is
 * also what a provider that does not name itself sends.
 */
const round = (toolCalls: WireToolCall[] = []): StreamOutcome => ({
  toolCalls,
  model: null,
  provider: null
});

/** Collects emitted events and resolves once the turn has ended. */
function collector(): {
  emit: (channel: string, payload: unknown) => void;
  events: Array<{ channel: string; payload: unknown }>;
  ended: Promise<void>;
} {
  const events: Array<{ channel: string; payload: unknown }> = [];
  let finish = (): void => {};
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    events,
    ended,
    emit: (channel, payload) => {
      events.push({ channel, payload });
      if (
        channel === IPC_CHANNELS.AGENT_STREAM_DONE ||
        channel === IPC_CHANNELS.AGENT_STREAM_ERROR ||
        channel === IPC_CHANNELS.AGENT_COMPACT_DONE
      ) {
        finish();
      }
    }
  };
}

describe('parseStreamLine', () => {
  /** A parsed line that carried nothing but the field under test. */
  const bare = { content: '', reasoning: '', toolCalls: [], model: null, provider: null };

  it('reads content and reasoning deltas', () => {
    expect(parseStreamLine('data: {"choices":[{"delta":{"content":"he"}}]}')).toEqual({
      ...bare,
      content: 'he',
      usage: null
    });
    expect(parseStreamLine('data: {"choices":[{"delta":{"reasoning":"hm"}}]}')).toEqual({
      ...bare,
      reasoning: 'hm',
      usage: null
    });
  });

  it('reads the token usage the last message carries', () => {
    const usage = '"usage":{"prompt_tokens":194,"completion_tokens":2,"total_tokens":196}';

    expect(parseStreamLine(`data: {"choices":[{"delta":{"content":""}}],${usage}}`)).toEqual({
      ...bare,
      usage: {
        promptTokens: 194,
        completionTokens: 2,
        totalTokens: 196,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null
      }
    });
  });

  it('reads the cost and the detail counts when the provider sends them', () => {
    const usage = [
      '"usage":{"prompt_tokens":194,"completion_tokens":20,"total_tokens":214',
      '"cost":0.0042',
      '"prompt_tokens_details":{"cached_tokens":150,"cache_write_tokens":44}',
      '"completion_tokens_details":{"reasoning_tokens":12}}'
    ].join(',');

    expect(parseStreamLine(`data: {"choices":[],${usage}}`)).toEqual({
      ...bare,
      usage: {
        promptTokens: 194,
        completionTokens: 20,
        totalTokens: 214,
        cachedTokens: 150,
        cacheWriteTokens: 44,
        reasoningTokens: 12,
        costUsd: 0.0042
      }
    });
  });

  /*
   * The distinction the whole total rests on: a provider that says nothing
   * about caching cached nothing, but one that says nothing about price has
   * not told us it was free.
   */
  it('reads a silent provider as zero cached tokens and an unknown cost', () => {
    const line = parseStreamLine(
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}'
    );

    expect(line).toMatchObject({ usage: { cachedTokens: 0, costUsd: null } });
  });

  it('reads which model and upstream actually served the round', () => {
    expect(
      parseStreamLine(
        'data: {"choices":[{"delta":{"content":"x"}}],"model":"anthropic/claude-sonnet-4.5","provider":"Google"}'
      )
    ).toEqual({
      ...bare,
      content: 'x',
      usage: null,
      model: 'anthropic/claude-sonnet-4.5',
      provider: 'Google'
    });
  });

  it('recognises the end of the stream', () => {
    expect(parseStreamLine('data: [DONE]')).toBe('done');
  });

  it('ignores keep-alives, blank lines and anything unparseable', () => {
    // OpenRouter interleaves comment lines while the upstream model warms up.
    expect(parseStreamLine(': OPENROUTER PROCESSING')).toBeNull();
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('event: message')).toBeNull();
    expect(parseStreamLine('data: {not json')).toBeNull();
    expect(parseStreamLine('data: {"choices":[]}')).toBeNull();
  });
});

describe('toReasoningParam', () => {
  const base = DEFAULT_AGENT_SETTINGS.coding;

  it('is absent when nothing is set, so the model default applies', () => {
    expect(toReasoningParam(base)).toBeNull();
  });

  it('sends the one form the user configured, most specific first', () => {
    expect(toReasoningParam({ ...base, reasoningEnabled: true })).toEqual({ enabled: true });
    expect(toReasoningParam({ ...base, reasoningEnabled: true, reasoningEffort: 'high' })).toEqual({
      effort: 'high'
    });
    expect(
      toReasoningParam({
        ...base,
        reasoningEnabled: true,
        reasoningEffort: 'high',
        reasoningTokens: 4096
      })
    ).toEqual({ max_tokens: 4096 });
  });
});

describe('buildSystemPrompt', () => {
  it('uses the built-in instructions, which ask for Markdown', () => {
    const prompt = buildSystemPrompt('/repo', null);

    expect(prompt).toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
    expect(prompt).toContain('Markdown');
  });

  it('replaces the instructions with the user override', () => {
    const prompt = buildSystemPrompt('/repo', 'Answer only in haiku.');

    expect(prompt).toContain('Answer only in haiku.');
    expect(prompt).not.toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
  });

  it('keeps the working folder whatever the prompt says', () => {
    expect(buildSystemPrompt('/repo', null)).toContain('/repo');
    expect(buildSystemPrompt('/repo', 'Answer only in haiku.')).toContain('/repo');
  });

  it('treats a blank override as no override, so the field can be cleared', () => {
    expect(buildSystemPrompt('/repo', '   \n ')).toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
  });
});

describe('withTodoReminder', () => {
  const items: AgentTodoItem[] = [
    { id: '1', content: 'read the file', activeForm: null, status: 'completed' },
    { id: '2', content: 'change it', activeForm: null, status: 'in_progress' }
  ];
  const history: AgentWireMessage[] = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'go' }
  ];

  it('puts the list last, where it is the most recent thing said', () => {
    const sent = withTodoReminder(history, items, 0);

    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.role).toBe('user');
    expect(sent.at(-1)?.content).toContain('2. [~] change it');
  });

  /*
   * A mid-conversation system message is handled inconsistently across
   * providers, and a turn here may be answered by any of them - so the note
   * says who it is from rather than relying on a role or a tag to.
   */
  it('marks it as Fleet talking rather than the user', () => {
    expect(withTodoReminder(history, items, 0).at(-1)?.content).toContain(FLEET_WIRE_PREFIX);
  });

  /*
   * The reason it is spliced onto a copy. Written into the array the turn
   * accumulates, every round would leave another stale list behind, each one
   * contradicting the next about what is done.
   */
  it('leaves the messages it was given alone', () => {
    withTodoReminder(history, items, 0);

    expect(history).toHaveLength(2);
  });

  it('says nothing once the whole list is settled', () => {
    const done = items.map((item) => ({ ...item, status: 'completed' as const }));

    expect(withTodoReminder(history, done, 0)).toBe(history);
  });

  it('asks for a list when there is none', () => {
    expect(withTodoReminder(history, [], 0).at(-1)?.content).toContain('todo_add');
  });
});

/*
 * The turn a subagent's report starts on its own. It carries no message of its
 * own, so nothing in the transcript says the parent already answered - and the
 * last thing the user said is still the request that started the work.
 */
describe('withResumeNote', () => {
  const history: AgentWireMessage[] = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'review this PR' }
  ];

  it('tells the turn it has already replied', () => {
    const sent = withResumeNote(history, true);

    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.content).toContain('already replied');
  });

  it('marks it as Fleet talking rather than the user', () => {
    expect(withResumeNote(history, true).at(-1)?.content).toContain(FLEET_WIRE_PREFIX);
  });

  it('leaves the messages it was given alone', () => {
    withResumeNote(history, true);

    expect(history).toHaveLength(2);
  });

  /* Every ordinary turn, which is nearly all of them. */
  it('says nothing on a turn the user started', () => {
    expect(withResumeNote(history, false)).toBe(history);
  });
});

describe('withScheduleReminder', () => {
  const history: AgentWireMessage[] = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'go' }
  ];
  const capability = (): AgentScheduleCapability => ({
    chainDepth: null,
    create: (input) =>
      SCHEDULES.create({
        sessionId: 'session-1',
        cwd: '/repo',
        cron: input.cron,
        note: input.note,
        recurring: input.recurring,
        depth: 0,
        now: new Date()
      }),
    list: () => SCHEDULES.list('session-1'),
    cancel: (id) => SCHEDULES.cancel(id, 'session-1')
  });
  /** One set, as a conversation that has been using this would have. */
  const set = (): AgentScheduleCapability => {
    const schedule = capability();
    schedule.create({ cron: '0 3 * * *', note: 'Check the release job.', recurring: false });
    return schedule;
  };

  // The ids are the point of it. Without them a model that wants to cancel
  // something it set two hours ago has to spend a round asking what it set.
  it('names each one with the id that cancels it', () => {
    const schedule = set();

    const sent = withScheduleReminder(history, schedule);

    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.content).toContain(schedule.list()[0].id);
    expect(sent.at(-1)?.content).toContain('Check the release job.');
  });

  it('marks it as Fleet talking rather than the user', () => {
    expect(withScheduleReminder(history, set()).at(-1)?.content).toContain(FLEET_WIRE_PREFIX);
  });

  it('leaves the messages it was given alone', () => {
    withScheduleReminder(history, set());

    expect(history).toHaveLength(2);
  });

  /*
   * The one that decides whether this is worth sending at all. Most turns of
   * most conversations have nothing scheduled, and a line saying so on every
   * round would be the whole cost of the feature paid where it has nothing to
   * say.
   */
  it('says nothing at all when the conversation has none', () => {
    expect(withScheduleReminder(history, capability())).toBe(history);
  });

  // A subagent has no schedules and no way to get any, so there is nothing here
  // for it to be told.
  it('says nothing to a subagent', () => {
    expect(withScheduleReminder(history, null)).toBe(history);
  });
});

describe('withSubagentReminder', () => {
  const history: AgentWireMessage[] = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'go' }
  ];
  const running: LiveSubagent[] = [
    { taskId: 't1', agent: 'explore', prompt: 'find where the column width is decided' },
    { taskId: 't2', agent: 'review', prompt: 'review the permission gate' }
  ];

  /*
   * The whole of why it is worth sending. The parent has a receipt for each of
   * these somewhere up the transcript and no way to tell which ones are still
   * out except by diffing them against the reports that have landed since.
   */
  it('names each one that has not reported', () => {
    const sent = withSubagentReminder(history, running, new Set());

    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.content).toContain('- explore: find where the column width is decided');
    expect(sent.at(-1)?.content).toContain('- review: review the permission gate');
  });

  it('marks it as Fleet talking rather than the user', () => {
    expect(withSubagentReminder(history, running, new Set()).at(-1)?.content).toContain(
      FLEET_WIRE_PREFIX
    );
  });

  it('leaves the messages it was given alone', () => {
    withSubagentReminder(history, running, new Set());

    expect(history).toHaveLength(2);
  });

  /*
   * The one that decides whether the feature is worth having. Most turns of
   * most conversations start no subagents at all, and a line saying so every
   * round would be the whole cost of this paid where it has nothing to say.
   */
  it('says nothing at all when none are running', () => {
    expect(withSubagentReminder(history, [], new Set())).toBe(history);
  });

  /*
   * A child stopped on a permission prompt is indistinguishable from a slow one
   * from the parent's side, which is the case where "say what you are waiting
   * for and stop" goes worst: it stops, and nobody has told the user that the
   * thing it is waiting for needs a click.
   */
  it('says which are stopped on a question, and what that means', () => {
    const sent = withSubagentReminder(history, running, new Set(['t2']));
    const content = sent.at(-1)?.content ?? '';

    expect(content).toContain('- review [stopped, waiting for the user to answer it]:');
    expect(content).toContain('- explore: find');
    expect(content).toContain('will not go on until the user answers');
  });

  it('leaves out the advice about stopped ones when none are stopped', () => {
    expect(withSubagentReminder(history, running, new Set()).at(-1)?.content).not.toContain(
      'will not go on until the user answers'
    );
  });

  /*
   * Five of them at whatever length the model felt like writing is a cost that
   * grows with nothing the user asked for. The parent wrote these prompts, so
   * the line only has to remind it which one this is.
   */
  it('shortens a long prompt', () => {
    const long = [{ taskId: 't1', agent: 'explore', prompt: 'x'.repeat(400) }];
    const content = withSubagentReminder(history, long, new Set()).at(-1)?.content ?? '';

    expect(content).toContain(`${'x'.repeat(120)}...`);
    expect(content).not.toContain('x'.repeat(121));
  });

  /* A prompt written over several lines would otherwise break the list apart. */
  it('flattens a prompt onto one line', () => {
    const wrapped = [{ taskId: 't1', agent: 'explore', prompt: 'find the\n\n  column width' }];
    const content = withSubagentReminder(history, wrapped, new Set()).at(-1)?.content ?? '';

    expect(content).toContain('- explore: find the column width');
  });
});

describe('toWireHistory', () => {
  it('puts the system prompt ahead of the transcript', async () => {
    const messages = await toWireHistory(REQUEST, 'be brief');

    expect(messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'what does this do?' }
    ]);
  });

  it('sends a summary as a labelled user message, not as the assistant speaking', async () => {
    const summary = textMessage('s', 'summary', 'we chose zod');
    const messages = await toWireHistory({ ...REQUEST, history: [summary] }, 'be brief');

    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain(SUMMARY_WIRE_PREFIX);
    expect(messages[1].content).toContain('we chose zod');
  });

  /*
   * `role` is branched with `if` chains rather than switched exhaustively, so a
   * missing branch here compiles perfectly and quietly hands the model its own
   * reminder as something it said. Hence a test rather than a type.
   */
  it('sends a fired schedule as a labelled user message, not as the assistant speaking', async () => {
    const fire = textMessage('f', 'scheduled', 'Check the release job on PR #512.');
    const messages = await toWireHistory({ ...REQUEST, history: [fire] }, 'be brief');

    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain(SCHEDULE_WIRE_PREFIX);
    expect(messages[1].content).toContain('Check the release job on PR #512.');
  });

  it('does not label an ordinary user message as a schedule', async () => {
    const messages = await toWireHistory(REQUEST, 'be brief');

    for (const message of messages) expect(message.content).not.toContain(SCHEDULE_WIRE_PREFIX);
  });

  // The ordering the parts exist for. A model handed its own closing sentence
  // as though it were written before the search it was reacting to is being
  // told a small lie about how it got there.
  it('rebuilds a turn that used tools round by round, in order', async () => {
    const call: AgentToolCall = {
      id: 'call_1',
      name: 'read',
      args: '{"path":"a.ts"}',
      result: 'a.ts lines 1-1',
      error: null,
      summary: '1 line',
      image: null,
      todos: null,
      task: null
    };
    const turn: AgentMessage = {
      id: 'b',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool', call },
        { type: 'text', text: 'It says 42.' }
      ],
      reasoning: '',
      reasoningMs: null
    };

    const messages = await toWireHistory({ ...REQUEST, history: [turn] }, 'be brief');

    expect(messages.slice(1, -1)).toEqual([
      {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"a.ts"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.ts lines 1-1' },
      { role: 'assistant', content: 'It says 42.' }
    ]);
  });

  it('answers a call that never came back, so none is left dangling', async () => {
    const pending: AgentToolCall = {
      id: 'call_1',
      name: 'read',
      args: '{}',
      result: null,
      error: null,
      summary: null,
      image: null,
      todos: null,
      task: null
    };
    const turn: AgentMessage = {
      id: 'b',
      role: 'assistant',
      parts: [{ type: 'tool', call: pending }],
      reasoning: '',
      reasoningMs: null
    };

    const messages = await toWireHistory({ ...REQUEST, history: [turn] }, 'be brief');

    expect(messages[1]).toMatchObject({ role: 'assistant', content: '' });
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'This call did not finish.'
    });
  });

  // A cancelled turn can leave a message with nothing in it at all. Dropping it
  // would put two user messages back to back.
  it('sends an empty assistant turn rather than no turn', async () => {
    const empty: AgentMessage = {
      id: 'b',
      role: 'assistant',
      parts: [],
      reasoning: '',
      reasoningMs: null
    };

    const messages = await toWireHistory({ ...REQUEST, history: [empty] }, 'be brief');

    expect(messages[1]).toEqual({ role: 'assistant', content: '' });
  });
});

describe('toCompactMessages', () => {
  it('hands the messages over as a transcript under the compaction instructions', async () => {
    const messages = await toCompactMessages(COMPACT_REQUEST);

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain(COMPACT_SYSTEM_PROMPT);
    expect(messages[0].content).toContain('/repo');
    expect(messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]);
    // Ends on a user turn: a transcript that stops on an assistant message is
    // an invalid request for some providers.
    expect(messages.at(-1)?.role).toBe('user');
  });
});

/**
 * Attachments on the wire.
 *
 * Nothing about an attachment lives in the transcript except a path, so this is
 * where a screenshot stops being a filename and becomes bytes. It happens on
 * every turn, for every attachment the conversation has ever had - which is
 * what "stays in context" means, and why the reading is deliberately late.
 */
describe('toWireHistory: attachments', () => {
  let dir: string;

  const shot = (): { kind: 'image'; path: string; mimeType: string; name: string } => ({
    kind: 'image',
    path: join(dir, 'shot.png'),
    mimeType: 'image/png',
    name: 'shot.png'
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wire-'));
    writeFileSync(join(dir, 'shot.png'), 'pixels');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The shape every turn had before attachments existed, and still has when
  // there are none. Parts are the exception, not the new normal.
  it('leaves a message with nothing attached as a plain string', async () => {
    const messages = await toWireHistory({ ...REQUEST, cwd: dir }, 'be brief');

    expect(messages.at(-1)).toEqual({ role: 'user', content: 'what does this do?' });
  });

  it('sends what was typed as text and what was attached after it', async () => {
    const messages = await toWireHistory(
      { ...REQUEST, cwd: dir, attachments: [shot()] },
      'be brief'
    );

    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what does this do?' },
        { type: 'text', text: 'Image file: shot.png' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz' } }
      ]
    });
  });

  // Dropping a screenshot in with nothing to say is a complete message.
  it('sends an attachment with no words as parts without an empty one', async () => {
    const messages = await toWireHistory(
      { ...REQUEST, cwd: dir, text: '', attachments: [shot()] },
      'be brief'
    );

    expect(messages.at(-1)).toMatchObject({
      content: [{ type: 'text', text: 'Image file: shot.png' }, { type: 'image_url' }]
    });
  });

  // The whole of "stays in context": a picture attached ten turns ago is read
  // off disk again now, rather than having been left behind in the transcript.
  it('re-reads an attachment from a turn already in the transcript', async () => {
    const earlier: AgentMessage = {
      ...textMessage('a', 'user', 'look at this'),
      parts: [
        { type: 'text', text: 'look at this' },
        { type: 'attachment', attachment: shot() }
      ]
    };

    const messages = await toWireHistory({ ...REQUEST, cwd: dir, history: [earlier] }, 'be brief');

    expect(messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'look at this' }, { type: 'text' }, { type: 'image_url' }]
    });
  });

  /*
   * A tool result is text and only text - the API's rule, not ours - so a
   * picture `read` came back with rides in a user message immediately after it.
   * Immediately: anything in between separates the image from the call that
   * produced it, and the model has no other way to tell which is which.
   */
  it('puts a picture a call came back with right after its result', async () => {
    const call: AgentToolCall = {
      id: 'call_1',
      name: 'read',
      args: '{"path":"shot.png"}',
      result: 'shot.png is an image. It is shown below.',
      error: null,
      summary: '6 B',
      image: { path: join(dir, 'shot.png'), mimeType: 'image/png' },
      todos: null,
      task: null
    };
    const turn: AgentMessage = {
      id: 'b',
      role: 'assistant',
      parts: [{ type: 'tool', call }],
      reasoning: '',
      reasoningMs: null
    };

    const messages = await toWireHistory({ ...REQUEST, cwd: dir, history: [turn] }, 'be brief');

    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(messages[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Image file: shot.png' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz' } }
      ]
    });
  });

  /*
   * And it waits for the rest of the round. A model may ask for several things
   * at once, and the API takes the answers as an unbroken run - a picture
   * dropped between two results is not a result, and the whole request is
   * rejected. Since the transcript is rebuilt from the same parts on every
   * later turn, getting this wrong would not fail once: it would fail forever.
   */
  it('holds a picture back until every call in the round has been answered', async () => {
    const looked: AgentToolCall = {
      id: 'call_1',
      name: 'read',
      args: '{"path":"shot.png"}',
      result: 'shot.png is an image. It is shown below.',
      error: null,
      summary: '6 B',
      image: { path: join(dir, 'shot.png'), mimeType: 'image/png' },
      todos: null,
      task: null
    };
    const searched: AgentToolCall = {
      id: 'call_2',
      name: 'grep',
      args: '{"pattern":"todo"}',
      result: 'no matches',
      error: null,
      summary: '0 matches',
      image: null,
      todos: null,
      task: null
    };
    const turn: AgentMessage = {
      id: 'b',
      role: 'assistant',
      parts: [
        { type: 'tool', call: looked },
        { type: 'tool', call: searched }
      ],
      reasoning: '',
      reasoningMs: null
    };

    const messages = await toWireHistory({ ...REQUEST, cwd: dir, history: [turn] }, 'be brief');

    expect(messages.slice(1, 5).map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(messages[4]).toMatchObject({ content: [{ type: 'text' }, { type: 'image_url' }] });
  });

  // A turn is not worth failing over a file that moved out from under it.
  it('says a file it can no longer read is gone rather than throwing', async () => {
    const missing = { ...shot(), path: join(dir, 'deleted.png') };

    const messages = await toWireHistory(
      { ...REQUEST, cwd: dir, attachments: [missing] },
      'be brief'
    );

    expect(messages.at(-1)).toMatchObject({
      content: [
        { type: 'text', text: 'what does this do?' },
        { type: 'text', text: expect.stringContaining('could not be read') }
      ]
    });
  });

  // Compaction is a model reading a conversation to write it down shorter.
  // Re-sending the pictures for that would be paying for them twice.
  it('leaves the pictures out of the compacting call', async () => {
    const earlier: AgentMessage = {
      ...textMessage('a', 'user', 'look at this'),
      parts: [
        { type: 'text', text: 'look at this' },
        { type: 'attachment', attachment: shot() }
      ]
    };

    const messages = await toCompactMessages({ ...COMPACT_REQUEST, messages: [earlier] });

    expect(messages[1]).toEqual({ role: 'user', content: 'look at this' });
  });
});

describe('AgentService', () => {
  it('streams deltas out on their own channels and ends with done', async () => {
    const { emit, events, ended } = collector();
    const stream = vi.fn(async (req: StreamRequest) => {
      req.onReasoning('thinking');
      req.onDelta('an ');
      req.onDelta('answer');
      return Promise.resolve(round());
    });

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    expect(events.map((e) => e.channel)).toEqual([
      IPC_CHANNELS.AGENT_STREAM_REASONING,
      IPC_CHANNELS.AGENT_STREAM_CHUNK,
      IPC_CHANNELS.AGENT_STREAM_CHUNK,
      IPC_CHANNELS.AGENT_STREAM_DONE
    ]);
    expect(events[1].payload).toEqual({ streamId: 'stream-1', delta: 'an ' });
  });

  /*
   * The wiring the roster rests on. Read per round from the live registry
   * rather than assembled once, so a child that reports in the middle of a long
   * turn stops being named on the round after it does.
   */
  it('names the subagents still out in every round it sends', async () => {
    const { emit, ended } = collector();
    const rounds: StreamRequest[] = [];
    const stream = async (req: StreamRequest): Promise<StreamOutcome> => {
      rounds.push(req);
      return Promise.resolve(round());
    };

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: await oneRunningSubagent(REQUEST.threadId),
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    // Second to last, behind the task list: the roster is context for the
    // round, and the plan is what the round is meant to be getting on with.
    expect(rounds[0].messages.at(-2)?.content).toContain(
      '- explore: find where the column width is decided'
    );
  });

  /*
   * The reason this is affordable. Most turns of most conversations start no
   * subagents at all, and a line saying so on every round of every one of them
   * would be the whole cost of the feature paid where it has nothing to say.
   */
  it('sends nothing at all about subagents when none are running', async () => {
    const { emit, ended } = collector();
    const rounds: StreamRequest[] = [];
    const stream = async (req: StreamRequest): Promise<StreamOutcome> => {
      rounds.push(req);
      return Promise.resolve(round());
    };

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    expect(
      rounds[0].messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('have not reported back yet')
      )
    ).toBe(false);
  });

  /*
   * A resumed turn is one the pane started, not the user, and the wire it
   * builds cannot show that: there is no message on it to be empty. Without the
   * note the model reads a review request that has not been answered and
   * answers it, having answered it a few messages above.
   */
  it('tells a resumed turn that it has already replied', async () => {
    const { emit, ended } = collector();
    const rounds: StreamRequest[] = [];
    const stream = async (req: StreamRequest): Promise<StreamOutcome> => {
      rounds.push(req);
      return Promise.resolve(round());
    };

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, text: '', resumed: true });
    await ended;

    expect(
      rounds[0].messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('already replied')
      )
    ).toBe(true);
  });

  it('says nothing of the kind on an ordinary turn', async () => {
    const { emit, ended } = collector();
    const rounds: StreamRequest[] = [];
    const stream = async (req: StreamRequest): Promise<StreamOutcome> => {
      rounds.push(req);
      return Promise.resolve(round());
    };

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    expect(
      rounds[0].messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('already replied')
      )
    ).toBe(false);
  });

  it('passes the configured model and inference settings through', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () => Promise.resolve(round()));

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => ({
        ...SETTINGS,
        coding: { ...SETTINGS.coding, maxTokens: 8192, temperature: 0.2, reasoningEffort: 'high' }
      }),
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'anthropic/claude-sonnet-4.5',
        maxTokens: 8192,
        temperature: 0.2,
        reasoning: { effort: 'high' }
      })
    );
  });

  it('sends the configured system prompt instead of the default', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () => Promise.resolve(round()));

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => ({ ...SETTINGS, systemPrompt: 'Answer only in haiku.' }),
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            role: 'system',
            // The override, then the folder Fleet always appends.
            content: expect.stringMatching(/Answer only in haiku[\s\S]*\/repo/)
          }
        ])
      })
    );
  });

  it('reports the token usage the provider counted, so context can be measured', async () => {
    const { emit, events, ended } = collector();
    const usage = {
      ...EMPTY_AGENT_USAGE,
      promptTokens: 900,
      completionTokens: 100,
      totalTokens: 1000
    };

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onDelta('an answer');
        req.onUsage?.(usage);
        return Promise.resolve(round());
      }
    }).send(REQUEST);
    await ended;

    expect(events.at(-1)).toEqual({
      channel: IPC_CHANNELS.AGENT_STREAM_DONE,
      payload: {
        streamId: 'stream-1',
        // One round, so what was billed and what is in the window are the same
        // numbers - it takes a second round for them to part ways.
        usage: { billed: usage, contextTokens: 1000, calls: 1, model: null, provider: null }
      }
    });
  });

  it('reports no usage rather than a zero when the provider sends none', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: vi.fn(async () => Promise.resolve(round()))
    }).send(REQUEST);
    await ended;

    expect(events.at(-1)?.payload).toEqual({ streamId: 'stream-1', usage: null });
  });

  it('reports a missing key as a stream error rather than throwing', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => null,
      emit,
      stream: vi.fn()
    }).send(REQUEST);
    await ended;

    expect(events).toEqual([
      {
        channel: IPC_CHANNELS.AGENT_STREAM_ERROR,
        payload: { streamId: 'stream-1', message: 'No OpenRouter API key configured', usage: null }
      }
    ]);
  });

  it('reports a missing model the same way', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => ({ ...SETTINGS, coding: { ...SETTINGS.coding, model: null } }),
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: vi.fn()
    }).send({ ...REQUEST, streamId: 'stream-2' });
    await ended;

    expect(events[0].payload).toEqual({
      streamId: 'stream-2',
      message: 'No coding model selected',
      usage: null
    });
  });

  it('compacts by returning the finished summary in one piece', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onDelta('  They chose zod ');
        req.onDelta('over casts.  ');
        req.onUsage?.({
          ...EMPTY_AGENT_USAGE,
          promptTokens: 500,
          completionTokens: 20,
          totalTokens: 520
        });
        return Promise.resolve(round());
      }
    }).compact(COMPACT_REQUEST);
    await ended;

    // Nothing streams to the pane: one event, carrying the whole summary.
    expect(events).toEqual([
      {
        channel: IPC_CHANNELS.AGENT_COMPACT_DONE,
        payload: {
          streamId: 'compact-1',
          summary: 'They chose zod over casts.',
          usage: {
            billed: {
              ...EMPTY_AGENT_USAGE,
              promptTokens: 500,
              completionTokens: 20,
              totalTokens: 520
            },
            contextTokens: 520,
            calls: 1,
            model: null,
            provider: null
          }
        }
      }
    ]);
  });

  it('does not spend the configured thinking budget on a summary', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () => Promise.resolve(round()));

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => ({
        ...SETTINGS,
        coding: { ...SETTINGS.coding, reasoningEffort: 'high', maxTokens: 64_000 }
      }),
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      // An empty stream fails the compaction, which is fine: the request has
      // already been made by then, and the request is what this asserts on.
      stream
    }).compact(COMPACT_REQUEST);
    await ended;

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: null, maxTokens: 4096 })
    );
  });

  it('fails rather than replacing a transcript with an empty summary', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onDelta('   \n ');
        return Promise.resolve(round());
      }
    }).compact(COMPACT_REQUEST);
    await ended;

    expect(events).toEqual([
      {
        channel: IPC_CHANNELS.AGENT_STREAM_ERROR,
        // This stub reported no usage, so there is nothing to charge the
        // session for - a failure carrying what it spent is tested below.
        payload: {
          streamId: 'compact-1',
          message: 'The model returned an empty summary',
          usage: null
        }
      }
    ]);
  });

  it('leaves the transcript alone when a compaction is cancelled', async () => {
    const { emit, events, ended } = collector();
    const service = new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async () => {
        service.cancel('compact-1');
        await Promise.resolve();
        throw new Error('The operation was aborted.');
      }
    });

    service.compact(COMPACT_REQUEST);
    await ended;

    // Ends on the ordinary done channel, with no summary to apply.
    expect(events).toEqual([
      {
        channel: IPC_CHANNELS.AGENT_STREAM_DONE,
        payload: { streamId: 'compact-1', usage: null }
      }
    ]);
  });

  it('treats a cancel as a normal ending, keeping the partial reply', async () => {
    const { emit, events, ended } = collector();
    const service = new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onDelta('half');
        service.cancel('stream-1');
        await Promise.resolve();
        // Whatever fetch would have thrown once aborted.
        throw new Error('The operation was aborted.');
      }
    });

    service.send(REQUEST);
    await ended;

    expect(events.map((e) => e.channel)).toEqual([
      IPC_CHANNELS.AGENT_STREAM_CHUNK,
      IPC_CHANNELS.AGENT_STREAM_DONE
    ]);
  });

  /*
   * The rounds before an ending were billed whatever the ending was. A stop
   * button that also wiped out what the turn had already spent would be a
   * quieter bug than most: the pane looks right, and the total is simply low.
   */
  it('reports what a cancelled turn had already spent', async () => {
    const { emit, events, ended } = collector();
    const service = new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onUsage?.({
          ...EMPTY_AGENT_USAGE,
          promptTokens: 800,
          totalTokens: 900,
          costUsd: 0.004
        });
        service.cancel('stream-1');
        await Promise.resolve();
        throw new Error('The operation was aborted.');
      }
    });

    service.send(REQUEST);
    await ended;

    expect(events.at(-1)).toMatchObject({
      channel: IPC_CHANNELS.AGENT_STREAM_DONE,
      payload: { usage: { billed: { costUsd: 0.004 }, calls: 1 } }
    });
  });

  it('reports what a failed turn had already spent', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onUsage?.({
          ...EMPTY_AGENT_USAGE,
          promptTokens: 800,
          totalTokens: 900,
          costUsd: 0.004
        });
        return Promise.reject(new Error('OpenRouter responded 500'));
      }
    }).send(REQUEST);
    await ended;

    expect(events.at(-1)).toMatchObject({
      channel: IPC_CHANNELS.AGENT_STREAM_ERROR,
      payload: { message: 'OpenRouter responded 500', usage: { calls: 1 } }
    });
  });
});

describe('collectToolCalls', () => {
  const frag = (
    index: number,
    over: Partial<{ id: string | null; name: string | null; args: string }> = {}
  ): ToolCallDelta => ({ index, id: null, name: null, args: '', ...over });

  it('reassembles a call streamed a few characters at a time', () => {
    const calls = collectToolCalls([
      frag(0, { id: 'call_1', name: 'read' }),
      frag(0, { args: '{"path":' }),
      frag(0, { args: '"a.ts"}' })
    ]);

    expect(calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }
    ]);
  });

  it('keeps two calls apart by their index, in the order asked for', () => {
    const calls = collectToolCalls([
      frag(0, { id: 'a', name: 'grep' }),
      frag(1, { id: 'b', name: 'glob' }),
      frag(1, { args: '{"pattern":"*.ts"}' }),
      frag(0, { args: '{"pattern":"x"}' })
    ]);

    expect(calls.map((c) => c.function.name)).toEqual(['grep', 'glob']);
    expect(calls[1].function.arguments).toBe('{"pattern":"*.ts"}');
  });

  it('gives a call an id when the provider streamed none', () => {
    expect(collectToolCalls([frag(0, { name: 'read', args: '{}' })])[0].id).toBe('call_0');
  });

  it('ignores a fragment that never named a tool', () => {
    expect(collectToolCalls([frag(0, { args: '{}' })])).toEqual([]);
  });
});

describe('the tool loop', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-agent-loop-'));
    writeFileSync(join(dir, 'answer.txt'), 'the answer is 42');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (name: string, args: object): WireToolCall => ({
    id: 'call_1',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  });

  /**
   * What a round was sent, without the task-list reminder spliced onto the end
   * of every one of them. These tests are about the conversation; the reminder
   * has its own describe below, and leaving it in would only mean every
   * assertion about the last message counting backwards past it.
   */
  const conversation = (req: StreamRequest): AgentWireMessage[] =>
    req.messages.filter(
      (m) => !(typeof m.content === 'string' && m.content.startsWith(FLEET_WIRE_PREFIX))
    );

  /** A stream that asks for `calls` on its first round and answers on its second. */
  function twoRounds(calls: WireToolCall[]): {
    stream: (req: StreamRequest) => Promise<StreamOutcome>;
    rounds: StreamRequest[];
  } {
    const rounds: StreamRequest[] = [];
    return {
      rounds,
      stream: async (req) => {
        rounds.push(req);
        if (rounds.length === 1) return Promise.resolve(round(calls));
        req.onDelta('42');
        return Promise.resolve(round());
      }
    };
  }

  it('runs what the model asked for and sends the result back', async () => {
    const { emit, ended } = collector();
    const { stream, rounds } = twoRounds([call('read', { path: 'answer.txt' })]);

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    // The second round sees its own request and the answer to it.
    const sent = conversation(rounds[1]);
    expect(sent.at(-2)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', function: { name: 'read' } }]
    });
    expect(sent.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(sent.at(-1)).toHaveProperty('content', expect.stringContaining('the answer is 42'));
  });

  /*
   * The point of teaching `read` to return pictures: the model asked to look at
   * a screenshot on this round, so it has to be able to see it on the next one.
   * The picture is injected into the running turn rather than only when the
   * transcript is rebuilt - otherwise the agent reads an image, is told a file
   * it cannot see exists, and answers about nothing.
   */
  it('shows the model a picture a call returned, in the same turn it asked', async () => {
    const { emit, events, ended } = collector();
    writeFileSync(join(dir, 'shot.png'), 'pixels');
    const { stream, rounds } = twoRounds([call('read', { path: 'shot.png' })]);

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    const sent = conversation(rounds[1]);
    expect(sent.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(sent.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Image file: shot.png' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz' } }
      ]
    });
    // And the pane is told, so the transcript shows what the agent looked at.
    const end = events.find((e) => e.channel === IPC_CHANNELS.AGENT_TOOL_END);
    expect(end?.payload).toMatchObject({
      call: { image: { path: realpathSync(join(dir, 'shot.png')), mimeType: 'image/png' } }
    });
  });

  it('tells the pane a call started and how it ended', async () => {
    const { emit, events, ended } = collector();
    const { stream } = twoRounds([call('read', { path: 'answer.txt' })]);

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(events.map((e) => e.channel)).toEqual([
      IPC_CHANNELS.AGENT_TOOL_START,
      IPC_CHANNELS.AGENT_TOOL_END,
      IPC_CHANNELS.AGENT_STREAM_CHUNK,
      IPC_CHANNELS.AGENT_STREAM_DONE
    ]);
    expect(events[0].payload).toMatchObject({
      call: { id: 'call_1', name: 'read', result: null, summary: null }
    });
    expect(events[1].payload).toMatchObject({ call: { summary: '1 line', error: null } });
  });

  // The failure that must not end the turn: the model asked for something it
  // cannot have, and the only way it can fix that is by being told.
  it('hands a refused call back to the model as its result', async () => {
    const { emit, events, ended } = collector();
    const { stream, rounds } = twoRounds([call('read', { path: '../../../etc/passwd' })]);

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(conversation(rounds[1]).at(-1)).toHaveProperty(
      'content',
      expect.stringContaining('outside the working folder')
    );
    expect(events.at(-1)?.channel).toBe(IPC_CHANNELS.AGENT_STREAM_DONE);
    const end = events.find((e) => e.channel === IPC_CHANNELS.AGENT_TOOL_END);
    expect(end?.payload).toMatchObject({ call: { summary: 'failed' } });
  });

  it('offers the tools to the model', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () => Promise.resolve(round()));

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'read' }) })
        ])
      })
    );
  });

  /*
   * Image generation is off unless a model has been chosen for it, and off has
   * to mean the model never hears of the tool. A tool it can name but nothing
   * can run costs a round and answers with an apology.
   */
  describe('image generation', () => {
    const withImage = {
      ...SETTINGS,
      image: { ...SETTINGS.image, model: 'google/gemini-3-pro-image' }
    };

    /** The request one turn opened with, under the given settings. */
    async function firstRound(settings: typeof SETTINGS): Promise<StreamRequest> {
      const { emit, ended } = collector();
      const rounds: StreamRequest[] = [];
      const stream = async (req: StreamRequest): Promise<StreamOutcome> => {
        rounds.push(req);
        return Promise.resolve(round());
      };
      new AgentService({
        schedules: SCHEDULES,
        gate: PASS_GATE,
        getSettings: () => settings,
        subagents: NO_SUBAGENTS,
        getApiKey: () => 'sk-or-test',
        emit,
        stream
      }).send({ ...REQUEST, cwd: dir });
      await ended;
      return rounds[0];
    }

    /** The names of the tools one turn offered, in the order it offered them. */
    async function toolsOffered(settings: typeof SETTINGS): Promise<string[]> {
      const round = await firstRound(settings);
      return (round.tools ?? []).map((spec) => spec.function.name);
    }

    it('does not offer the image tool when no image model is set', async () => {
      expect(await toolsOffered(SETTINGS)).not.toContain('image');
    });

    it('offers it once one is', async () => {
      expect(await toolsOffered(withImage)).toContain('image');
    });

    /** The system message one turn opened with. */
    async function systemPrompt(settings: typeof SETTINGS): Promise<string> {
      const round = await firstRound(settings);
      const { content } = round.messages[0];
      // Always a string: only a user message ever carries parts.
      return typeof content === 'string' ? content : '';
    }

    it('leaves the image instructions out of the prompt when it is off', async () => {
      expect(await systemPrompt(SETTINGS)).not.toContain('`image` generates a picture');
    });

    it('tells the model about it when it is on', async () => {
      const prompt = await systemPrompt(withImage);
      expect(prompt).toContain('`image` generates a picture');
      // Whatever else is appended, the folder is still the last word.
      expect(prompt).toContain(`Working folder: ${dir}`);
    });

    /*
     * These two stop at the generator. What the tool does with the image it
     * gets back - where it saves it, what it reports - is its own file's
     * business, and testing it here would mean writing into the real
     * ~/.fleet/agent/images. What is checked here is the wiring: that the
     * capability is built at all, that it carries the right settings, and that
     * a render on the way out reaches the pane.
     */
    it('hands the tool a generator that carries the user’s settings, not the key', async () => {
      const { emit, ended } = collector();
      const image = vi.fn(async () =>
        Promise.resolve({ data: Buffer.from('x'), mimeType: 'image/png', costUsd: 0.02 })
      );
      let attempt = 0;
      const stream = vi.fn(async () => {
        attempt += 1;
        return Promise.resolve(round(attempt === 1 ? [call('image', { prompt: 'a cap' })] : []));
      });

      new AgentService({
        schedules: SCHEDULES,
        gate: PASS_GATE,
        getSettings: () => ({
          ...withImage,
          image: { ...withImage.image, resolution: '2K', quality: 'high', seed: 3 }
        }),
        subagents: NO_SUBAGENTS,
        getApiKey: () => 'sk-or-test',
        emit,
        stream,
        image
      }).send({ ...REQUEST, cwd: dir });
      await ended;

      expect(image).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'google/gemini-3-pro-image',
          prompt: 'a cap',
          apiKey: 'sk-or-test',
          config: expect.objectContaining({ resolution: '2K', quality: 'high', seed: 3 })
        }),
        expect.anything()
      );
    });

    it('sends a partial render to the pane, on the row that asked for it', async () => {
      const { emit, events, ended } = collector();
      const image = vi.fn(async (req: { onPartial: (p: unknown) => void }) => {
        req.onPartial({ data: Buffer.from('half drawn'), mimeType: 'image/png' });
        return Promise.resolve({ data: Buffer.from('x'), mimeType: 'image/png', costUsd: null });
      });
      let attempt = 0;
      const stream = vi.fn(async () => {
        attempt += 1;
        return Promise.resolve(round(attempt === 1 ? [call('image', { prompt: 'a cap' })] : []));
      });

      new AgentService({
        schedules: SCHEDULES,
        gate: PASS_GATE,
        getSettings: () => withImage,
        subagents: NO_SUBAGENTS,
        getApiKey: () => 'sk-or-test',
        emit,
        stream,
        image: image as never
      }).send({ ...REQUEST, cwd: dir });
      await ended;

      const partial = events.find((e) => e.channel === IPC_CHANNELS.AGENT_IMAGE_PARTIAL);
      expect(partial?.payload).toMatchObject({
        streamId: REQUEST.streamId,
        callId: 'call_1',
        image: `data:image/png;base64,${Buffer.from('half drawn').toString('base64')}`
      });
    });
  });

  // The loop this cannot have: a model that keeps calling tools forever costs
  // money on every lap.
  it('stops after the number of rounds the user set', async () => {
    const { emit, events, ended } = collector();
    const stream = vi.fn(async () =>
      Promise.resolve(round([call('read', { path: 'answer.txt' })]))
    );

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => ({ ...SETTINGS, maxToolRounds: 12 }),
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(stream).toHaveBeenCalledTimes(12);
    expect(events.at(-1)?.channel).toBe(IPC_CHANNELS.AGENT_STREAM_ERROR);
    expect(events.at(-1)?.payload).toMatchObject({ message: expect.stringContaining('12 rounds') });
  });

  /*
   * The setting is the user's, but it is not the only thing between a loop and
   * an unbounded bill: unset means "as long as it takes", and something still
   * has to end a turn that will never end on its own.
   */
  it('holds a cap above the ceiling to the ceiling', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () =>
      Promise.resolve(round([call('read', { path: 'answer.txt' })]))
    );

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => ({ ...SETTINGS, maxToolRounds: MAX_TOOL_ROUNDS_CEILING * 10 }),
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(stream).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS_CEILING);
  });

  it('does not offer tools when summarizing', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async (req: StreamRequest) => {
      req.onDelta('a summary');
      return Promise.resolve(round());
    });

    new AgentService({
      schedules: SCHEDULES,
      gate: PASS_GATE,
      getSettings: () => SETTINGS,
      subagents: NO_SUBAGENTS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).compact(COMPACT_REQUEST);
    await ended;

    expect(stream.mock.calls[0][0].tools).toBeUndefined();
  });
});

/*
 * The within-turn half of clearing. `toWireHistory` is built once from the
 * transcript at the start of a turn; everything a long turn goes on to read is
 * appended after that and never passes through it again, so a forty-round turn
 * would otherwise clear nothing until the next turn began.
 */
describe('withClearedWireResults', () => {
  /** A round: the assistant asking for `name`, and the answer it got. */
  const exchange = (id: string, name: string, resultChars = 40_000): AgentWireMessage[] => [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: id, content: 'x'.repeat(resultChars) }
  ];

  /** The recent calls that are kept whatever they cost. */
  const recent = (): AgentWireMessage[] =>
    Array.from({ length: CLEAR_KEEP_RECENT }, (_, i) => exchange(`new${i}`, 'read', 10)).flat();

  const contentOf = (messages: AgentWireMessage[], id: string): string | undefined =>
    messages.find(
      (m): m is Extract<AgentWireMessage, { role: 'tool' }> =>
        m.role === 'tool' && m.tool_call_id === id
    )?.content;

  it('clears old reproducible results and keeps the calls that asked for them', () => {
    const wire = [...exchange('old1', 'read'), ...exchange('old2', 'grep'), ...recent()];
    const cleared = withClearedWireResults(wire);

    expect(contentOf(cleared, 'old1')).toBe(CLEARED_RESULT_TEXT);
    expect(contentOf(cleared, 'old2')).toBe(CLEARED_RESULT_TEXT);
    // The assistant message naming the call is untouched, or the results would
    // be answers to questions the transcript never asked.
    expect(cleared.filter((m) => m.role === 'assistant')).toEqual(
      wire.filter((m) => m.role === 'assistant')
    );
  });

  it('keeps the most recent results whatever they cost', () => {
    const wire = [...exchange('old1', 'read'), ...recent()];

    for (let i = 0; i < CLEAR_KEEP_RECENT; i++) {
      expect(contentOf(withClearedWireResults(wire), `new${i}`)).toBe('x'.repeat(10));
    }
  });

  it('never clears a command, whose result cannot simply be had again', () => {
    const wire = [...exchange('old1', 'bash'), ...exchange('old2', 'bash'), ...recent()];

    expect(withClearedWireResults(wire)).toBe(wire);
  });

  it('does nothing when there is too little to be worth breaking the cache for', () => {
    const wire = [...exchange('old1', 'read', 1000), ...recent()];

    expect(withClearedWireResults(wire)).toBe(wire);
  });

  /*
   * The history arrives already cleared by `toWireHistory`, so a placeholder is
   * not a saving that is available all over again. Counting it as one would
   * rewrite the same messages every round and invalidate the cache forever.
   */
  it('is settled after one pass', () => {
    const once = withClearedWireResults([...exchange('old1', 'read'), ...recent()]);

    expect(withClearedWireResults(once)).toBe(once);
  });

  it('does not touch the array it was given', () => {
    const wire = [...exchange('old1', 'read'), ...recent()];
    withClearedWireResults(wire);

    expect(contentOf(wire, 'old1')).toBe('x'.repeat(40_000));
  });
});
