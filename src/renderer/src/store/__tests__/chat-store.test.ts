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
    error: null,
    toolStatus: null,
    permissionRequests: []
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

  it('cancel reconciles to the persisted turn (real id) via the aborted event', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'Par' });
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'tial' });
    // Main persists the partial and returns the authoritative thread on reload.
    const persisted = {
      id: 'a1',
      conversationId: 'c1',
      role: 'assistant',
      content: 'Partial',
      parentId: 'm1',
      createdAt: 4
    };
    window.fleet.chat.getMessages = vi
      .fn()
      .mockResolvedValue([
        { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 3 },
        persisted
      ]);
    useChatStore.getState().cancel();
    // cancel() asks main to abort but keeps streamId so the terminal event lands.
    expect(window.fleet.chat.cancel).toHaveBeenCalledWith('s1');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_ERROR)?.({
      streamId: 's1',
      message: 'aborted',
      partial: 'Partial',
      aborted: true
    });
    await new Promise((r) => setTimeout(r, 0));
    const s = useChatStore.getState();
    expect(s.status).toBe('idle');
    expect(s.error).toBeNull();
    expect(s.streamId).toBeNull();
    expect(s.streamingText).toBeNull();
    // Reconciled to the real persisted row — no synthetic local- placeholder.
    expect(s.messages.at(-1)).toMatchObject({ id: 'a1', role: 'assistant', content: 'Partial' });
  });

  it('cancel reconciles a reasoning-only turn from the persisted thread', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_REASONING)?.({ streamId: 's1', delta: 'Hmm ' });
    listeners.get(IPC_CHANNELS.CHAT_STREAM_REASONING)?.({ streamId: 's1', delta: 'let me think' });
    window.fleet.chat.getMessages = vi.fn().mockResolvedValue([
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 3 },
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        content: '',
        reasoning: 'Hmm let me think',
        parentId: 'm1',
        createdAt: 4
      }
    ]);
    useChatStore.getState().cancel();
    listeners.get(IPC_CHANNELS.CHAT_STREAM_ERROR)?.({
      streamId: 's1',
      message: 'aborted',
      partial: '',
      aborted: true
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      reasoning: 'Hmm let me think'
    });
  });

  it('cancel with no streamed text leaves the message list unchanged', async () => {
    await useChatStore.getState().init();
    await useChatStore.getState().send('hi', 'x/y');
    const userOnly = [
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 3 }
    ];
    window.fleet.chat.getMessages = vi.fn().mockResolvedValue(userOnly);
    useChatStore.getState().cancel();
    listeners.get(IPC_CHANNELS.CHAT_STREAM_ERROR)?.({
      streamId: 's1',
      message: 'aborted',
      partial: '',
      aborted: true
    });
    await new Promise((r) => setTimeout(r, 0));
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('replays a terminal event that arrived before send() resolved (no stuck spinner)', async () => {
    await useChatStore.getState().init();
    // The main stream errors before the renderer learns its streamId: the event
    // fires synchronously inside send(), while get().streamId is still null.
    window.fleet.chat.send = vi.fn().mockImplementation(async () => {
      listeners.get(IPC_CHANNELS.CHAT_STREAM_ERROR)?.({
        streamId: 's9',
        message: 'early boom',
        partial: ''
      });
      return Promise.resolve({
        streamId: 's9',
        userMessage: { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 3 }
      });
    });
    await useChatStore.getState().send('hi', 'x/y');
    const s = useChatStore.getState();
    // adoptStream replays the buffered error instead of leaving status 'streaming'.
    expect(s.status).toBe('error');
    expect(s.error).toBe('early boom');
    expect(s.streamId).toBeNull();
  });

  it('regenerate replaces the active branch rather than appending a duplicate', async () => {
    await useChatStore.getState().init();
    useChatStore.setState({
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          role: 'user',
          content: 'hi',
          parentId: null,
          createdAt: 3
        },
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          content: 'old',
          parentId: 'm1',
          createdAt: 4
        }
      ]
    });
    window.fleet.chat.regenerate = vi.fn().mockResolvedValue({ streamId: 's2' });
    const newThread = [
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 3 },
      {
        id: 'a2',
        conversationId: 'c1',
        role: 'assistant',
        content: 'new',
        parentId: 'm1',
        createdAt: 5
      }
    ];
    window.fleet.chat.getMessages = vi.fn().mockResolvedValue(newThread);
    await useChatStore.getState().regenerate('a1', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_DONE)?.({
      streamId: 's2',
      message: {
        id: 'a2',
        conversationId: 'c1',
        role: 'assistant',
        content: 'new',
        parentId: 'm1',
        createdAt: 5
      }
    });
    // Synchronously on DONE, the new answer must NOT be appended under the old one.
    const sync = useChatStore.getState().messages;
    expect(sync.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(sync.map((m) => m.id)).toEqual(['m1', 'a1']);
    await new Promise((r) => setTimeout(r, 0));
    // The reload swaps in the authoritative new branch.
    expect(useChatStore.getState().messages).toEqual(newThread);
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
    expect(window.fleet.chat.decidePermission).toHaveBeenCalledWith('r1', 'allow-once');
    // #424: the card is NOT dropped on decide (it resolves in place); it clears
    // only when the turn ends.
    expect(useChatStore.getState().permissionRequests).toHaveLength(1);
    listeners.get(IPC_CHANNELS.CHAT_STREAM_DONE)?.({
      streamId: 's1',
      message: { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'ok', createdAt: 4 }
    });
    expect(useChatStore.getState().permissionRequests).toHaveLength(0);
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
