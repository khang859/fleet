import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../chat-store';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';

type Listener = (p: unknown) => void;
const listeners = new Map<string, Listener>();

beforeEach(() => {
  listeners.clear();
  const fleet = {
    chat: {
      listConversations: vi.fn().mockResolvedValue([
        {
          id: 'c1',
          title: 'New chat',
          model: null,
          titleLocked: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]),
      createConversation: vi.fn().mockResolvedValue({
        id: 'c2',
        title: 'New chat',
        model: null,
        titleLocked: false,
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
      },
      onStreamReasoning: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_STREAM_REASONING, cb);
        return () => {};
      },
      onToolStatus: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_TOOL_STATUS, cb);
        return () => {};
      },
      onPermissionRequest: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_PERMISSION_REQUEST, cb);
        return () => {};
      },
      decidePermission: vi.fn().mockResolvedValue(undefined),
      onConversationRenamed: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_CONVERSATION_RENAMED, cb);
        return () => {};
      },
      onConversationTagged: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_CONVERSATION_TAGGED, cb);
        return () => {};
      },
      listImageModels: vi.fn().mockResolvedValue([]),
      skillsGet: vi.fn().mockResolvedValue({ skills: [], budget: { used: 0, cap: 8000 } })
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

const conv = (id: string): unknown => ({
  id,
  title: 'New chat',
  model: null,
  titleLocked: false,
  createdAt: 1,
  updatedAt: 1
});

describe('useChatStore', () => {
  it('init preserves a valid active conversation across remounts', async () => {
    window.fleet.chat.listConversations = vi.fn().mockResolvedValue([conv('a'), conv('b')]);
    // Simulate the user having selected the non-default conversation, then the
    // ChatView remounting (tab switch away and back) which re-runs init().
    useChatStore.setState({ activeId: 'b' });
    await useChatStore.getState().init();
    expect(useChatStore.getState().activeId).toBe('b');
  });

  it('init selects the most-recent conversation on first load', async () => {
    window.fleet.chat.listConversations = vi.fn().mockResolvedValue([conv('a'), conv('b')]);
    useChatStore.setState({ activeId: null });
    await useChatStore.getState().init();
    expect(useChatStore.getState().activeId).toBe('a');
  });

  it('init re-selects the first conversation when the active id no longer exists', async () => {
    window.fleet.chat.listConversations = vi.fn().mockResolvedValue([conv('a'), conv('b')]);
    useChatStore.setState({ activeId: 'gone' });
    await useChatStore.getState().init();
    expect(useChatStore.getState().activeId).toBe('a');
  });

  it('send appends an optimistic user message and enters streaming', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    const s = useChatStore.getState();
    expect(s.messages.at(-1)?.content).toBe('hi');
    expect(s.status).toBe('streaming');
    expect(s.streamId).toBe('s1');
  });

  it('send surfaces an IPC rejection as an error state and rethrows', async () => {
    await useChatStore.getState().init();
    window.fleet.chat.send = vi.fn().mockRejectedValue(new Error('store write failed'));
    await expect(useChatStore.getState().send('hi', 'x/y')).rejects.toThrow('store write failed');
    const s = useChatStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('store write failed');
  });

  it('regenerate surfaces an IPC rejection as an error state (no throw at call site)', async () => {
    await useChatStore.getState().init();
    window.fleet.chat.regenerate = vi
      .fn()
      .mockRejectedValue(new Error('Cannot regenerate this message'));
    await useChatStore.getState().regenerate('m1', 'x/y');
    const s = useChatStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('Cannot regenerate this message');
  });

  it('loadModels records an error on failure and clears it on success', async () => {
    window.fleet.chat.listModels = vi
      .fn()
      .mockRejectedValue(new Error('OpenRouter /models failed: 401'));
    await expect(useChatStore.getState().loadModels()).rejects.toThrow(/401/);
    expect(useChatStore.getState().modelsError).toMatch(/401/);

    window.fleet.chat.listModels = vi
      .fn()
      .mockResolvedValue([{ id: 'a/b', name: 'B', contextLength: 1 }]);
    await useChatStore.getState().loadModels();
    expect(useChatStore.getState().modelsError).toBeNull();
    expect(useChatStore.getState().models).toHaveLength(1);
  });

  it('clearModels drops cached lists and errors', () => {
    useChatStore.setState({
      models: [{ id: 'a/b', name: 'B', contextLength: 1 } as never],
      modelsError: 'boom'
    });
    useChatStore.getState().clearModels();
    const s = useChatStore.getState();
    expect(s.models).toHaveLength(0);
    expect(s.modelsError).toBeNull();
  });

  it('applies chunk then done events', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    // Token deltas are coalesced into a ~50ms flush, so they land in
    // streamingText only after the throttle window elapses.
    vi.useFakeTimers();
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'Hel' });
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'lo' });
    vi.advanceTimersByTime(50);
    vi.useRealTimers();
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

  it('cancel preserves streamed reasoning in the placeholder', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    // Only reasoning streamed (model still thinking) — the placeholder must still
    // be committed so the reasoning is not lost until the convo is reselected.
    listeners.get(IPC_CHANNELS.CHAT_STREAM_REASONING)?.({ streamId: 's1', delta: 'Hmm ' });
    listeners.get(IPC_CHANNELS.CHAT_STREAM_REASONING)?.({ streamId: 's1', delta: 'let me think' });
    useChatStore.getState().cancel();
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      reasoning: 'Hmm let me think'
    });
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

  it('queues a permission request for the active stream and clears it on decide', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_PERMISSION_REQUEST)?.({
      requestId: 'r1',
      streamId: 's1',
      tool: 'Bash',
      command: 'npm test',
      rememberPrefix: 'npm test'
    });
    expect(useChatStore.getState().permissionRequests).toHaveLength(1);
    await useChatStore.getState().decidePermission('r1', 'allow-once');
    expect(useChatStore.getState().permissionRequests).toHaveLength(0);
    expect(window.fleet.chat.decidePermission).toHaveBeenCalledWith('r1', 'allow-once');
  });

  it('ignores a permission request for a stale stream', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_PERMISSION_REQUEST)?.({
      requestId: 'r2',
      streamId: 'OTHER',
      tool: 'Bash',
      command: 'rm -rf x'
    });
    expect(useChatStore.getState().permissionRequests).toHaveLength(0);
  });

  it('applies a background rename event to the sidebar', async () => {
    await useChatStore.getState().init();
    expect(useChatStore.getState().conversations[0]?.title).toBe('New chat');
    listeners.get(IPC_CHANNELS.CHAT_CONVERSATION_RENAMED)?.({ id: 'c1', title: 'Fix login bug' });
    expect(useChatStore.getState().conversations.find((c) => c.id === 'c1')?.title).toBe(
      'Fix login bug'
    );
  });

  it('a manual rename locks the title', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().renameConversation('c1', 'My title');
    const conv = useChatStore.getState().conversations.find((c) => c.id === 'c1');
    expect(conv?.title).toBe('My title');
    expect(conv?.titleLocked).toBe(true);
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

  it('error commits a reasoning placeholder before the authoritative reload', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_REASONING)?.({ streamId: 's1', delta: 'thinking…' });
    // Error before any content delta: reasoning streamed client-side must remain
    // visible. Asserted synchronously, before the getMessages reload resolves.
    listeners.get(IPC_CHANNELS.CHAT_STREAM_ERROR)?.({
      streamId: 's1',
      message: 'boom',
      partial: ''
    });
    const s = useChatStore.getState();
    expect(s.status).toBe('error');
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', reasoning: 'thinking…' });
  });
});
