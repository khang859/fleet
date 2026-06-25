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
