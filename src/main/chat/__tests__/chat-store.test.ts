import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
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

  it('records and lists audit entries newest-first, persisting across restart', () => {
    const conv = store.createConversation();
    store.addAudit({
      conversationId: conv.id,
      tool: 'read_file',
      detail: 'a.txt',
      cwd: '/w',
      decision: 'allowed',
      status: 'ok',
      result: 'hi'
    });
    store.addAudit({
      conversationId: 'other',
      tool: 'bash',
      detail: 'rm -rf /',
      cwd: '/w',
      decision: 'denied',
      status: 'denied',
      result: 'The user denied this command.'
    });

    const all = store.listAudit();
    expect(all.map((a) => a.tool)).toEqual(['bash', 'read_file']); // newest first
    expect(store.listAudit({ conversationId: conv.id }).map((a) => a.tool)).toEqual(['read_file']);

    // Survives a reopen, and is independent of conversation deletion (durable ledger).
    store.deleteConversation(conv.id);
    store.close();
    store = new ChatStore(DB_PATH);
    expect(store.listAudit()).toHaveLength(2);
  });

  it('caps stored audit result text', () => {
    const conv = store.createConversation();
    store.addAudit({
      conversationId: conv.id,
      tool: 'bash',
      detail: 'cat big',
      cwd: '/w',
      decision: 'approved',
      status: 'ok',
      result: 'x'.repeat(5000)
    });
    expect(store.listAudit()[0].result.length).toBe(2000);
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

  it('auto-names an unlocked conversation but not a locked one', () => {
    const c = store.createConversation();
    expect(c.titleLocked).toBe(false);
    expect(store.autoNameConversation(c.id, 'Auto Title')).toBe(true);
    expect(store.getConversation(c.id)?.title).toBe('Auto Title');

    // A manual rename locks the title; further auto-naming is a no-op.
    store.renameConversation(c.id, 'Manual Title');
    expect(store.getConversation(c.id)?.titleLocked).toBe(true);
    expect(store.autoNameConversation(c.id, 'Auto Again')).toBe(false);
    expect(store.getConversation(c.id)?.title).toBe('Manual Title');
  });

  it('migrates a pre-title_locked db by adding the column', () => {
    const dir = join(tmpdir(), `fleet-chat-store-migrate-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'old.db');
    // Simulate an old schema with no title_locked column.
    const raw = new Database(p);
    raw.exec(
      `CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat',
        model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`
    );
    raw
      .prepare(
        'INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)'
      )
      .run('old1', 'Legacy', null, 1, 1);
    raw.close();

    const migrated = new ChatStore(p);
    expect(migrated.getConversation('old1')?.titleLocked).toBe(false);
    expect(migrated.autoNameConversation('old1', 'Named')).toBe(true);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists and reads message images grouped per message, cascading on delete', () => {
    const dir = join(tmpdir(), `fleet-chat-store-img-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'imgs.db'));
    const conv = store.createConversation();
    const m = store.addMessage({ conversationId: conv.id, role: 'assistant', content: 'here' });
    store.addImages({
      messageId: m.id,
      conversationId: conv.id,
      images: [
        { ref: '/tmp/a.png', mimeType: 'image/png', kind: 'generated' },
        { ref: '/tmp/b.png', mimeType: 'image/png', kind: 'generated' }
      ]
    });

    const msgs = store.getMessages(conv.id);
    expect(msgs[0].images?.map((i) => i.ref)).toEqual(['/tmp/a.png', '/tmp/b.png']);

    store.deleteConversation(conv.id);

    const raw = new Database(join(dir, 'imgs.db'));
    const count = raw.prepare('SELECT COUNT(*) AS n FROM message_images').get() as { n: number };
    expect(count.n).toBe(0);
    raw.close();

    const reopened = new ChatStore(join(dir, 'imgs.db'));
    expect(reopened.getMessages(conv.id)).toEqual([]);
    store.close();
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
