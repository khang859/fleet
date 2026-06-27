import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { ChatStore } from '../chat-store';
import { ChatWorkspace } from '../chat-workspace';
import { ChatImageStorage } from '../image/image-storage';

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

  it('backfills a legacy flat message table into a linear active path', () => {
    const dir = join(TEST_DIR, 'legacy');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'legacy.db');
    // Build a pre-tree schema (no parent_id / active_child_id / active_head_id).
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat',
        model TEXT, title_locked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    raw
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?,?,?,?)')
      .run('lc', 'Legacy', 1, 1);
    raw
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)'
      )
      .run('m1', 'lc', 'user', 'q1', 10);
    raw
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)'
      )
      .run('m2', 'lc', 'assistant', 'a1', 20);
    raw
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)'
      )
      .run('m3', 'lc', 'user', 'q2', 30);
    raw.close();

    const migrated = new ChatStore(dbPath);
    const msgs = migrated.getMessages('lc');
    expect(msgs.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
    expect(msgs[0].parentId).toBeNull();
    expect(msgs[1].parentId).toBe('m1');
    expect(migrated.activeLeafId('lc')).toBe('m3');
    migrated.close();
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

  it('appends and reads messages oldest-first along the active path', () => {
    const c = store.createConversation();
    const u = store.addMessage({ conversationId: c.id, role: 'user', content: 'hi' });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'hello', parentId: u.id });
    const msgs = store.getMessages(c.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'hello']);
  });

  it('pages sibling assistant variants and follows the selected one', () => {
    const c = store.createConversation();
    const u = store.addMessage({ conversationId: c.id, role: 'user', content: 'hi' });
    const a1 = store.addMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'v1',
      parentId: u.id
    });
    const a2 = store.addMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'v2',
      parentId: u.id
    });

    // Newest variant is active by default.
    let msgs = store.getMessages(c.id);
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'v2']);
    const assistant = msgs[1];
    expect(assistant.variants).toEqual({ index: 2, total: 2, ids: [a1.id, a2.id] });

    // Selecting the older variant switches the active path.
    store.selectVariant(a1.id);
    msgs = store.getMessages(c.id);
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'v1']);
    expect(msgs[1].variants?.index).toBe(1);
  });

  it('branches when an earlier user message is edited and uses the new branch downstream', () => {
    const c = store.createConversation();
    const u1 = store.addMessage({ conversationId: c.id, role: 'user', content: 'first' });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'r1', parentId: u1.id });
    // Edit = a new user sibling under the same parent (here, root).
    const u2 = store.addMessage({ conversationId: c.id, role: 'user', content: 'first (edited)' });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'r2', parentId: u2.id });

    const msgs = store.getMessages(c.id);
    expect(msgs.map((m) => m.content)).toEqual(['first (edited)', 'r2']);
    expect(msgs[0].variants).toEqual({ index: 2, total: 2, ids: [u1.id, u2.id] });
    expect(store.activeLeafId(c.id)).toBe(msgs[1].id);
  });

  it('forks a conversation with history up to a message, leaving the original intact', () => {
    const c = store.createConversation({ title: 'Orig' });
    const u1 = store.addMessage({ conversationId: c.id, role: 'user', content: 'q1' });
    const a1 = store.addMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'a1',
      parentId: u1.id
    });
    const u2 = store.addMessage({
      conversationId: c.id,
      role: 'user',
      content: 'q2',
      parentId: a1.id
    });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'a2', parentId: u2.id });

    // Fork from a1 → branch carries [q1, a1] only.
    const branch = store.forkConversation(a1.id);
    expect(branch).not.toBeNull();
    expect(branch?.parentConversationId).toBe(c.id);
    expect(branch?.title).toBe('Orig (branch)');
    expect(store.getMessages(branch!.id).map((m) => m.content)).toEqual(['q1', 'a1']);

    // Original is unchanged, and its messages have distinct ids from the copies.
    expect(store.getMessages(c.id).map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
    const branchIds = new Set(store.getMessages(branch!.id).map((m) => m.id));
    expect(branchIds.has(a1.id)).toBe(false);

    // Continuing the branch does not touch the original.
    const bu = store.addMessage({
      conversationId: branch!.id,
      role: 'user',
      content: 'branch-only',
      parentId: store.activeLeafId(branch!.id)
    });
    expect(bu.conversationId).toBe(branch!.id);
    expect(store.getMessages(c.id)).toHaveLength(4);
  });

  it('copies image files on fork so deleting the parent does not dangle the branch', () => {
    const workspace = new ChatWorkspace(join(TEST_DIR, 'ws'), join(TEST_DIR, 'legacy'));
    const storage = new ChatImageStorage(workspace);

    const c = store.createConversation({ title: 'WithImage' });
    const u = store.addMessage({ conversationId: c.id, role: 'user', content: 'draw a fox' });
    const saved = storage.save(c.id, Buffer.from('FOXPNG'), 'image/png');
    const a = store.addMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'here',
      parentId: u.id
    });
    store.addImages({
      messageId: a.id,
      conversationId: c.id,
      images: [{ ref: saved.ref, mimeType: 'image/png', kind: 'generated' }]
    });

    const branch = store.forkConversation(a.id, (ref, cid) => storage.copyInto(ref, cid));
    expect(branch).not.toBeNull();
    const branchRef = store.getMessages(branch!.id).find((m) => m.images?.length)?.images?.[0].ref;
    expect(branchRef).toBeDefined();
    expect(branchRef).not.toBe(saved.ref); // branch owns its own copy

    // Delete the parent's folder; the branch's image must survive.
    workspace.delete(c.id);
    expect(existsSync(saved.ref)).toBe(false);
    expect(existsSync(branchRef!)).toBe(true);
  });

  it('getPathTo returns root→message ancestors for context', () => {
    const c = store.createConversation();
    const u = store.addMessage({ conversationId: c.id, role: 'user', content: 'q' });
    const a = store.addMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'ans',
      parentId: u.id
    });
    expect(store.getPathTo(a.id).map((m) => m.content)).toEqual(['q', 'ans']);
    expect(store.getPathTo(u.id).map((m) => m.content)).toEqual(['q']);
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

  it('full-text searches message bodies, not just titles', () => {
    const a = store.createConversation({ title: 'Alpha' });
    const b = store.createConversation({ title: 'Beta' });
    store.addMessage({ conversationId: a.id, role: 'user', content: 'how do I configure webpack' });
    store.addMessage({ conversationId: b.id, role: 'user', content: 'cooking pasta tonight' });

    const hits = store.searchConversations('webpack');
    expect(hits.map((h) => h.conversationId)).toEqual([a.id]);
    expect(hits[0].snippet.toLowerCase()).toContain('webpack');
    // A body term that is in neither title still matches by content.
    expect(store.searchConversations('pasta').map((h) => h.conversationId)).toEqual([b.id]);
    // No match → empty.
    expect(store.searchConversations('zzznotpresent')).toEqual([]);
  });

  it('persists pin and folder state across restart', () => {
    const dir = join(tmpdir(), `fleet-chat-org-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const s = new ChatStore(join(dir, 'org.db'));
    const c = s.createConversation({ title: 'Z chat' });
    const d = s.createConversation({ title: 'A chat' });
    s.setConversationPinned(d.id, true);
    s.setConversationFolder(c.id, 'Work');
    s.close();

    const reopened = new ChatStore(join(dir, 'org.db'));
    const list = reopened.listConversations();
    // Pinned floats first regardless of recency.
    expect(list[0].id).toBe(d.id);
    expect(list[0].pinned).toBe(true);
    expect(list.find((x) => x.id === c.id)?.folder).toBe('Work');
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
