import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChatStore } from '../chat-store';

const TEST_DIR = join(tmpdir(), `fleet-chat-store-test-${process.pid}`);
const DB_PATH = join(TEST_DIR, 'chat.db');

describe('ChatStore', () => {
  let store: ChatStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new ChatStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates the db file', () => {
    expect(existsSync(DB_PATH)).toBe(true);
  });

  it('creates and lists conversations newest-first', () => {
    const a = store.createConversation({ title: 'First' });
    const b = store.createConversation({ title: 'Second' });
    store.renameConversation(a.id, 'First updated'); // bumps a.updatedAt
    const list = store.listConversations();
    expect(list.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(list[0].title).toBe('First updated');
    void b;
  });

  it('appends and reads messages oldest-first', () => {
    const c = store.createConversation();
    store.addMessage({ conversationId: c.id, role: 'user', content: 'hi' });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'hello' });
    const msgs = store.getMessages(c.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'hello']);
  });

  it('cascade-deletes messages with their conversation', () => {
    const c = store.createConversation();
    store.addMessage({ conversationId: c.id, role: 'user', content: 'hi' });
    store.deleteConversation(c.id);
    expect(store.getConversation(c.id)).toBeNull();
    expect(store.getMessages(c.id)).toEqual([]);
  });

  it('sets a per-conversation model override', () => {
    const c = store.createConversation();
    expect(c.model).toBeNull();
    store.setConversationModel(c.id, 'openai/gpt-4o');
    expect(store.getConversation(c.id)?.model).toBe('openai/gpt-4o');
  });
});
