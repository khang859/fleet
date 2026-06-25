import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChatStore } from '../chat-store';
import type { ChatSecrets } from '../chat-secrets';
import { OpenRouterClient } from '../openrouter-client';
import { ChatService } from '../chat-service';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

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
    });
    const events: Array<{ channel: string; payload: unknown }> = [];
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'deepseek/deepseek-v4-flash',
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
