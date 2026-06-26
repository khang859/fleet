import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChatStore } from '../chat-store';
import type { ChatSecrets } from '../chat-secrets';
import { OpenRouterClient } from '../openrouter-client';
import { ChatService } from '../chat-service';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { ChatImageStorage } from '../image/image-storage';
import type { ChatImageProvider } from '../image/types';
import type { ChatToolExecutor } from '../tools/tool-runner';

const stubExecutor = { run: async () => Promise.resolve('') } as unknown as ChatToolExecutor;

import type { SkillManager } from '../skills/skill-manager';
const stubSkills = {
  systemPrompt: () => null,
  toolDef: () => null,
  resolveInvocation: () => null,
  hasLoadSkillTool: () => false,
  runLoadSkill: () => ''
} as unknown as SkillManager;

const fakeProvider: ChatImageProvider = {
  id: 'openrouter',
  generate: vi.fn(async () => ({ data: Buffer.from('IMG'), mimeType: 'image/png' }))
};

const DIR = join(tmpdir(), `fleet-chat-service-test-${process.pid}`);

function fakeSecrets(): ChatSecrets {
  let key: string | null = 'sk-test';
  return {
    isEncryptionAvailable: () => true,
    setKey: (k: string) => (key = k),
    getKey: () => key,
    hasKey: () => key !== null,
    clearKey: () => (key = null)
  } as unknown as ChatSecrets;
}

describe('ChatService.send', () => {
  it('persists the user message, streams deltas, then persists the assistant message', async () => {
    mkdirSync(DIR, { recursive: true });
    const store = new ChatStore(join(DIR, 'chat.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    // Stub streamCompletion to emit two deltas then resolve.
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      opts.onDelta('Hel');
      opts.onDelta('lo');
      return { content: 'Hello', toolCalls: [], finishReason: null };
    });
    const events: Array<{ channel: string; payload: unknown }> = [];
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'deepseek/deepseek-v4-flash',
      getImageModel: () => null,
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'off',
      getTools: () => ({
        mode: 'off',
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64
      }),
      getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
      getPersonas: () => ({ presets: [], defaultId: null }),
      isWebSearchReady: () => false,
      getMcpToolDefs: () => [],
      skills: stubSkills,
      toolExecutor: stubExecutor,
      imageProvider: fakeProvider,
      imageStorage: new ChatImageStorage(join(DIR, 'imgs')),
      emit: (channel, payload) => events.push({ channel, payload })
    });

    const res = service.send({ conversationId: conv.id, text: 'hi', model: 'x/y' });
    expect(res.userMessage.content).toBe('hi');
    // Let the async streaming microtasks flush.
    await vi.waitFor(() => {
      expect(events.some((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_DONE)).toBe(true);
    });

    const chunks = events.filter((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_CHUNK);
    expect(chunks.length).toBe(2);
    const msgs = store.getMessages(conv.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toBe('Hello');
    store.close();
    rmSync(DIR, { recursive: true, force: true });
  });

  it('emits stream-error with the partial text on failure', async () => {
    mkdirSync(DIR, { recursive: true });
    const store = new ChatStore(join(DIR, 'chat2.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      opts.onDelta('part');
      throw new Error('boom');
    });
    const events: Array<{ channel: string; payload: unknown }> = [];
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      getImageModel: () => null,
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'off',
      getTools: () => ({
        mode: 'off',
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64
      }),
      getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
      getPersonas: () => ({ presets: [], defaultId: null }),
      isWebSearchReady: () => false,
      getMcpToolDefs: () => [],
      skills: stubSkills,
      toolExecutor: stubExecutor,
      imageProvider: fakeProvider,
      imageStorage: new ChatImageStorage(join(DIR, 'imgs')),
      emit: (channel, payload) => events.push({ channel, payload })
    });
    service.send({ conversationId: conv.id, text: 'hi', model: 'x/y' });
    await vi.waitFor(() => {
      expect(events.some((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_ERROR)).toBe(true);
    });
    const err = events.find((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_ERROR);
    expect((err?.payload as { partial: string }).partial).toBe('part');
    store.close();
    rmSync(DIR, { recursive: true, force: true });
  });
});

it('runs the image tool loop and persists a generated image', async () => {
  const dir = join(tmpdir(), `fleet-chat-tool-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const store = new ChatStore(join(dir, 'tool.db'));
  const conv = store.createConversation();
  const client = new OpenRouterClient();
  let round = 0;
  vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
    round += 1;
    if (round === 1) {
      return {
        content: 'Sure!',
        toolCalls: [{ id: 'call_1', name: 'generate_image', arguments: '{"prompt":"a fox"}' }],
        finishReason: 'tool_calls'
      };
    }
    opts.onDelta('Done.');
    return { content: 'Done.', toolCalls: [], finishReason: 'stop' };
  });
  const provider: ChatImageProvider = {
    id: 'openrouter',
    generate: vi.fn(async () => ({ data: Buffer.from('IMG'), mimeType: 'image/png' }))
  };
  const events: Array<{ channel: string; payload: unknown }> = [];
  const service = new ChatService({
    store,
    client,
    secrets: fakeSecrets(),
    getDefaultModel: () => 'm',
    getImageModel: () => 'google/gemini-2.5-flash-image',
    getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
    getToolsMode: () => 'off',
    getTools: () => ({
      mode: 'off',
      workspaceDir: null,
      sandbox: false,
      failClosed: false,
      mentionMaxKb: 64
    }),
    getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
    getPersonas: () => ({ presets: [], defaultId: null }),
    isWebSearchReady: () => false,
    getMcpToolDefs: () => [],
    skills: stubSkills,
    toolExecutor: stubExecutor,
    imageProvider: provider,
    imageStorage: new ChatImageStorage(dir),
    emit: (channel, payload) => events.push({ channel, payload })
  });

  // model must support tools for the tool to be offered:
  service.send({ conversationId: conv.id, text: 'draw a fox', model: 'm', supportsTools: true });
  await vi.waitFor(() => {
    expect(events.some((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_DONE)).toBe(true);
  });
  expect(events.some((e) => e.channel === IPC_CHANNELS.CHAT_TOOL_STATUS)).toBe(true);
  const msgs = store.getMessages(conv.id);
  const assistant = msgs.find((m) => m.role === 'assistant');
  expect(assistant?.images?.[0]?.kind).toBe('generated');
  const done = events.find((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_DONE);
  const donePayload = done?.payload;
  // narrow without an unsafe cast: assert shape via the persisted-message contract
  expect(
    (donePayload as { message: { images?: Array<{ kind: string }> } }).message.images?.[0]?.kind
  ).toBe('generated');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('passes the reference image to the provider as a base64 data URL when editing', async () => {
  const dir = join(tmpdir(), `fleet-chat-edit-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const store = new ChatStore(join(dir, 'edit.db'));
  const conv = store.createConversation();
  const client = new OpenRouterClient();
  let round = 0;
  vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
    round += 1;
    if (round === 1) {
      return {
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'generate_image', arguments: '{"prompt":"add a hat","edit":true}' }
        ],
        finishReason: 'tool_calls'
      };
    }
    opts.onDelta('Done.');
    return { content: 'Done.', toolCalls: [], finishReason: 'stop' };
  });
  const generate = vi.fn<ChatImageProvider['generate']>(async () => ({
    data: Buffer.from('OUT'),
    mimeType: 'image/png'
  }));
  const provider: ChatImageProvider = { id: 'openrouter', generate };
  const events: Array<{ channel: string; payload: unknown }> = [];
  const service = new ChatService({
    store,
    client,
    secrets: fakeSecrets(),
    getDefaultModel: () => 'm',
    getImageModel: () => 'google/gemini-2.5-flash-image',
    getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
    getToolsMode: () => 'off',
    getTools: () => ({
      mode: 'off',
      workspaceDir: null,
      sandbox: false,
      failClosed: false,
      mentionMaxKb: 64
    }),
    getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
    getPersonas: () => ({ presets: [], defaultId: null }),
    isWebSearchReady: () => false,
    getMcpToolDefs: () => [],
    skills: stubSkills,
    toolExecutor: stubExecutor,
    imageProvider: provider,
    imageStorage: new ChatImageStorage(dir),
    emit: (channel, payload) => events.push({ channel, payload })
  });

  // A 1x1 PNG supplied as a composer attachment (data URL).
  const attachment =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  service.send({
    conversationId: conv.id,
    text: 'add a hat',
    model: 'm',
    supportsTools: true,
    attachments: [attachment]
  });
  await vi.waitFor(() => {
    expect(events.some((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_DONE)).toBe(true);
  });

  expect(generate).toHaveBeenCalledTimes(1);
  const req = generate.mock.calls[0][0];
  // A data URL (the remote API contract) — NOT an on-disk path under tmpdir.
  expect(req.referenceImages?.[0]).toMatch(/^data:image\/png;base64,/);
  expect(req.referenceImages?.[0]).not.toContain(dir);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ChatService regenerate / edit', () => {
  function makeService(dir: string, store: ChatStore, client: OpenRouterClient): ChatService {
    return new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      getImageModel: () => null,
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'off',
      getTools: () => ({
        mode: 'off',
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64
      }),
      getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
      getPersonas: () => ({ presets: [], defaultId: null }),
      isWebSearchReady: () => false,
      getMcpToolDefs: () => [],
      skills: stubSkills,
      toolExecutor: stubExecutor,
      imageProvider: fakeProvider,
      imageStorage: new ChatImageStorage(join(dir, 'imgs')),
      emit: () => {}
    });
  }

  it('regenerate adds a sibling assistant attempt and pages between them', async () => {
    const dir = join(tmpdir(), `fleet-chat-regen-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'r.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    let n = 0;
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      n += 1;
      const text = `reply${n}`;
      opts.onDelta(text);
      return { content: text, toolCalls: [], finishReason: null };
    });
    const service = makeService(dir, store, client);

    service.send({ conversationId: conv.id, text: 'hi', model: 'm' });
    await vi.waitFor(() => expect(store.getMessages(conv.id).length).toBe(2));
    const assistant = store.getMessages(conv.id)[1];

    service.regenerate({ conversationId: conv.id, messageId: assistant.id, model: 'm' });
    await vi.waitFor(() => expect(store.getMessages(conv.id)[1].content).toBe('reply2'));

    const active = store.getMessages(conv.id);
    expect(active.map((m) => m.content)).toEqual(['hi', 'reply2']); // newest attempt active
    expect(active[1].variants).toMatchObject({ index: 2, total: 2 });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('regenerate re-streams the response to a user turn whose stream failed', async () => {
    const dir = join(tmpdir(), `fleet-chat-retry-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'retry.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    const seen: string[] = [];
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      const msgs = opts.messages as Array<{ role: string; content: string }>;
      seen.push(msgs.map((m) => m.content).join('|'));
      opts.onDelta('recovered');
      return { content: 'recovered', toolCalls: [], finishReason: null };
    });
    const service = makeService(dir, store, client);

    // Simulate a failed turn: a user message exists with no assistant reply.
    const userMsg = store.addMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'hi',
      parentId: null
    });

    service.regenerate({ conversationId: conv.id, messageId: userMsg.id, model: 'm' });
    await vi.waitFor(() => expect(store.getMessages(conv.id).length).toBe(2));

    const active = store.getMessages(conv.id);
    expect(active.map((m) => m.content)).toEqual(['hi', 'recovered']);
    expect(seen[0]).toContain('hi'); // the model saw the user's prompt
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('editMessage re-runs from an edited user turn on a new branch', async () => {
    const dir = join(tmpdir(), `fleet-chat-edit2-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'e.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    const seen: string[] = [];
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      const msgs = opts.messages as Array<{ role: string; content: string }>;
      seen.push(msgs.map((m) => m.content).join('|'));
      opts.onDelta('ok');
      return { content: 'ok', toolCalls: [], finishReason: null };
    });
    const service = makeService(dir, store, client);

    service.send({ conversationId: conv.id, text: 'original', model: 'm' });
    await vi.waitFor(() => expect(store.getMessages(conv.id).length).toBe(2));
    const userMsg = store.getMessages(conv.id)[0];

    service.editMessage({
      conversationId: conv.id,
      messageId: userMsg.id,
      text: 'edited',
      model: 'm'
    });
    await vi.waitFor(() => expect(seen.length).toBe(2));

    // The regenerated turn saw the edited text, not the original.
    expect(seen[1]).toContain('edited');
    const active = store.getMessages(conv.id);
    expect(active[0].content).toBe('edited');
    expect(active[0].variants).toMatchObject({ index: 2, total: 2 });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ChatService usage accounting', () => {
  it('sums per-round usage and persists it on the assistant message', async () => {
    const dir = join(tmpdir(), `fleet-chat-usage-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'usage.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    let round = 0;
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      round += 1;
      if (round === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'c1', name: 'load_skill', arguments: '{"name":"x"}' }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0, cost: 0.001 }
        };
      }
      opts.onDelta('done');
      return {
        content: 'done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 120, completionTokens: 30, cachedTokens: 80, cost: 0.0005 }
      };
    });
    const skills = {
      systemPrompt: () => null,
      toolDef: () => ({ type: 'function', function: { name: 'load_skill' } }),
      resolveInvocation: () => null,
      hasLoadSkillTool: (n: string) => n === 'load_skill',
      runLoadSkill: () => 'BODY'
    } as unknown as SkillManager;
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      getImageModel: () => null,
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'read-only',
      getTools: () => ({
        mode: 'off',
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64
      }),
      getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
      getPersonas: () => ({ presets: [], defaultId: null }),
      isWebSearchReady: () => false,
      getMcpToolDefs: () => [],
      skills,
      toolExecutor: stubExecutor,
      imageProvider: fakeProvider,
      imageStorage: new ChatImageStorage(join(dir, 'imgs')),
      emit: () => {}
    });

    service.send({ conversationId: conv.id, text: 'hi', model: 'm', supportsTools: true });
    await vi.waitFor(() => expect(store.getMessages(conv.id)[1]?.content).toBe('done'));
    const assistant = store.getMessages(conv.id)[1];
    expect(assistant.usage).toEqual({
      promptTokens: 220,
      completionTokens: 40,
      cachedTokens: 80,
      cost: 0.0015
    });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks the system prompt with a cache_control breakpoint when caching is on', async () => {
    const dir = join(tmpdir(), `fleet-chat-cache-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'cache.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    let seen: unknown[] = [];
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      seen = opts.messages;
      opts.onDelta('ok');
      return { content: 'ok', toolCalls: [], finishReason: 'stop', usage: null };
    });
    const skills = {
      systemPrompt: () => 'Available skills:\n- deploy: Deploy',
      toolDef: () => null,
      resolveInvocation: () => null,
      hasLoadSkillTool: () => false,
      runLoadSkill: () => ''
    } as unknown as SkillManager;
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      getImageModel: () => null,
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'read-only',
      getTools: () => ({
        mode: 'off',
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64
      }),
      getUsage: () => ({ showMeter: true, promptCaching: true, budgetWarnUsd: null }),
      getPersonas: () => ({ presets: [], defaultId: null }),
      isWebSearchReady: () => false,
      getMcpToolDefs: () => [],
      skills,
      toolExecutor: stubExecutor,
      imageProvider: fakeProvider,
      imageStorage: new ChatImageStorage(join(dir, 'imgs')),
      emit: () => {}
    });

    service.send({ conversationId: conv.id, text: 'hi', model: 'm', supportsTools: true });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const sys = seen[0] as { role: string; content: Array<{ cache_control?: unknown }> };
    expect(sys.role).toBe('system');
    expect(Array.isArray(sys.content)).toBe(true);
    expect(sys.content[0].cache_control).toEqual({ type: 'ephemeral' });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ChatService attachments', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

  function buildService(dir: string, store: ChatStore, client: OpenRouterClient): ChatService {
    return new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      getImageModel: () => null,
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'off',
      getTools: () => ({
        mode: 'off',
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64
      }),
      getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
      getPersonas: () => ({ presets: [], defaultId: null }),
      isWebSearchReady: () => false,
      getMcpToolDefs: () => [],
      skills: stubSkills,
      toolExecutor: stubExecutor,
      imageProvider: fakeProvider,
      imageStorage: new ChatImageStorage(join(dir, 'imgs')),
      emit: () => {}
    });
  }

  it('sends image attachments as multimodal content to a vision model', async () => {
    const dir = join(tmpdir(), `fleet-chat-att-img-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'att.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    let seen: { messages: unknown[]; plugins?: unknown[] } = { messages: [] };
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      seen = { messages: opts.messages, plugins: opts.plugins };
      opts.onDelta('ok');
      return { content: 'ok', toolCalls: [], finishReason: null, usage: null };
    });
    const service = buildService(dir, store, client);
    service.send({
      conversationId: conv.id,
      text: 'describe',
      model: 'm',
      supportsImages: true,
      attachments: [PNG]
    });
    await vi.waitFor(() => expect(seen.messages.length).toBeGreaterThan(0));
    const user = seen.messages.find((m) => (m as { role: string }).role === 'user') as {
      content: Array<{ type: string }>;
    };
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content.some((p) => p.type === 'image_url')).toBe(true);
    expect(seen.plugins).toBeUndefined(); // no PDF → no file-parser plugin
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the file-parser plugin and a file part for PDF attachments', async () => {
    const dir = join(tmpdir(), `fleet-chat-att-pdf-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'att.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    let seen: { messages: unknown[]; plugins?: unknown[] } = { messages: [] };
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      seen = { messages: opts.messages, plugins: opts.plugins };
      opts.onDelta('ok');
      return { content: 'ok', toolCalls: [], finishReason: null, usage: null };
    });
    const service = buildService(dir, store, client);
    service.send({
      conversationId: conv.id,
      text: 'summarize',
      model: 'm',
      supportsImages: true,
      attachments: [PDF]
    });
    await vi.waitFor(() => expect(seen.messages.length).toBeGreaterThan(0));
    const user = seen.messages.find((m) => (m as { role: string }).role === 'user') as {
      content: Array<{ type: string }>;
    };
    expect(user.content.some((p) => p.type === 'file')).toBe(true);
    expect(seen.plugins).toBeTruthy();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('omits attachments for a non-vision model (text content only)', async () => {
    const dir = join(tmpdir(), `fleet-chat-att-novis-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'att.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    let seen: unknown[] = [];
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      seen = opts.messages;
      opts.onDelta('ok');
      return { content: 'ok', toolCalls: [], finishReason: null, usage: null };
    });
    const service = buildService(dir, store, client);
    service.send({
      conversationId: conv.id,
      text: 'hi',
      model: 'm',
      supportsImages: false,
      attachments: [PNG]
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const user = seen.find((m) => (m as { role: string }).role === 'user') as { content: unknown };
    expect(typeof user.content).toBe('string');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ChatService personas', () => {
  it('injects the conversation persona as the first system message', async () => {
    const dir = join(tmpdir(), `fleet-chat-persona-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'persona.db'));
    const conv = store.createConversation();
    store.setConversationPersona(conv.id, 'p1');
    const client = new OpenRouterClient();
    let seen: Array<{ role: string; content: string }> = [];
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      seen = opts.messages as Array<{ role: string; content: string }>;
      opts.onDelta('ok');
      return { content: 'ok', toolCalls: [], finishReason: null, usage: null };
    });
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      getImageModel: () => null,
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'off',
      getTools: () => ({
        mode: 'off',
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64
      }),
      getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
      getPersonas: () => ({
        presets: [{ id: 'p1', name: 'Pirate', prompt: 'Talk like a pirate.' }],
        defaultId: null
      }),
      isWebSearchReady: () => false,
      getMcpToolDefs: () => [],
      skills: stubSkills,
      toolExecutor: stubExecutor,
      imageProvider: fakeProvider,
      imageStorage: new ChatImageStorage(join(dir, 'imgs')),
      emit: () => {}
    });

    service.send({ conversationId: conv.id, text: 'hi', model: 'm' });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toMatchObject({ role: 'system', content: 'Talk like a pirate.' });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ChatService skills', () => {
  it('injects the skills system prompt + /invoked body and routes load_skill', async () => {
    const dir = join(tmpdir(), `fleet-chat-skills-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'skills.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();

    const skills = {
      systemPrompt: () => 'Available skills:\n- deploy: Deploy the app',
      toolDef: () => ({ type: 'function', function: { name: 'load_skill' } }),
      resolveInvocation: (text: string) =>
        text.startsWith('/deploy') ? { name: 'deploy', body: 'DEPLOY STEPS' } : null,
      hasLoadSkillTool: (n: string) => n === 'load_skill',
      runLoadSkill: () => 'DEPLOY STEPS'
    } as unknown as SkillManager;

    let round = 0;
    const seen: unknown[][] = [];
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      seen.push(opts.messages);
      round += 1;
      if (round === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'c1', name: 'load_skill', arguments: '{"name":"deploy"}' }],
          finishReason: 'tool_calls'
        };
      }
      opts.onDelta('done');
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    });

    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      getImageModel: () => null,
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'read-only',
      getTools: () => ({
        mode: 'off',
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64
      }),
      getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
      getPersonas: () => ({ presets: [], defaultId: null }),
      isWebSearchReady: () => false,
      getMcpToolDefs: () => [],
      skills,
      toolExecutor: stubExecutor,
      imageProvider: fakeProvider,
      imageStorage: new ChatImageStorage(join(dir, 'imgs')),
      emit: () => {}
    });

    service.send({
      conversationId: conv.id,
      text: '/deploy prod',
      model: 'm',
      supportsTools: true
    });
    await vi.waitFor(() => expect(round).toBeGreaterThanOrEqual(2));

    const firstRound = seen[0] as Array<{ role: string; content: string }>;
    expect(firstRound[0]).toMatchObject({ role: 'system' });
    expect(firstRound[0].content).toContain('deploy: Deploy the app');
    expect(firstRound[1].content).toContain('DEPLOY STEPS'); // /deploy body injected
    // load_skill result fed back as a tool message in round 2
    const secondRound = seen[1] as Array<{ role: string; content: string }>;
    expect(secondRound.some((m) => m.role === 'tool' && m.content === 'DEPLOY STEPS')).toBe(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
