import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../chat-store';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';

type Listener = (p: unknown) => void;
const listeners = new Map<string, Listener>();

beforeEach(() => {
  listeners.clear();
  const fleet = {
    chat: {
      listConversations: vi
        .fn()
        .mockResolvedValue([
          { id: 'c1', title: 'New chat', model: null, createdAt: 1, updatedAt: 1 }
        ]),
      createConversation: vi.fn().mockResolvedValue({
        id: 'c2',
        title: 'New chat',
        model: null,
        createdAt: 2,
        updatedAt: 2
      }),
      renameConversation: vi.fn().mockResolvedValue(undefined),
      setConversationModel: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([]),
      send: vi.fn().mockResolvedValue({
        streamId: 's1',
        userMessage: { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 3 }
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      listModels: vi.fn().mockResolvedValue([{ id: 'x/y', name: 'Y', contextLength: 4096 }]),
      getSettings: vi.fn().mockResolvedValue({ provider: 'openrouter', defaultModel: 'x/y' }),
      patchSettings: vi.fn().mockResolvedValue(undefined),
      setKey: vi.fn().mockResolvedValue(undefined),
      hasKey: vi.fn().mockResolvedValue(true),
      onStreamChunk: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_STREAM_CHUNK, cb);
        return () => {};
      },
      onStreamDone: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_STREAM_DONE, cb);
        return () => {};
      },
      onStreamError: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_STREAM_ERROR, cb);
        return () => {};
      }
    }
  };
  (globalThis as unknown as { window: { fleet: typeof fleet } }).window = { fleet };
  useChatStore.setState({
    conversations: [],
    activeId: 'c1',
    messages: [],
    streamingText: null,
    streamId: null,
    models: [],
    keyPresent: false,
    status: 'idle',
    error: null
  });
});

describe('useChatStore', () => {
  it('send appends an optimistic user message and enters streaming', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    const s = useChatStore.getState();
    expect(s.messages.at(-1)?.content).toBe('hi');
    expect(s.status).toBe('streaming');
    expect(s.streamId).toBe('s1');
  });

  it('applies chunk then done events', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'Hel' });
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'lo' });
    expect(useChatStore.getState().streamingText).toBe('Hello');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_DONE)?.({
      streamId: 's1',
      message: { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'Hello', createdAt: 4 }
    });
    const s = useChatStore.getState();
    expect(s.status).toBe('idle');
    expect(s.streamingText).toBeNull();
    expect(s.messages.at(-1)?.content).toBe('Hello');
  });

  it('cancel commits the partial reply into the visible message list', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'Par' });
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'tial' });
    useChatStore.getState().cancel();
    const s = useChatStore.getState();
    expect(s.status).toBe('idle');
    expect(s.streamId).toBeNull();
    expect(s.streamingText).toBeNull();
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Partial' });
  });

  it('cancel with no streamed text leaves the message list unchanged', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    const before = useChatStore.getState().messages.length;
    useChatStore.getState().cancel();
    expect(useChatStore.getState().messages.length).toBe(before);
  });

  it('setConversationModel persists and updates the conversation', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().setConversationModel('c1', 'anthropic/claude');
    expect(window.fleet.chat.setConversationModel).toHaveBeenCalledWith('c1', 'anthropic/claude');
    const conv = useChatStore.getState().conversations.find((c) => c.id === 'c1');
    expect(conv?.model).toBe('anthropic/claude');
  });

  it('applies an error event with partial text', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_ERROR)?.({
      streamId: 's1',
      message: 'boom',
      partial: 'part'
    });
    const s = useChatStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('boom');
  });
});
