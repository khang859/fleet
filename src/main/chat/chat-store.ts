import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { ChatConversation, ChatMessage, ChatRole } from '../../shared/chat-types';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'New chat',
  model       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
`;

const ConversationRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  model: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number()
});

const MessageRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  created_at: z.number()
});

type ConversationRow = z.infer<typeof ConversationRowSchema>;
type MessageRow = z.infer<typeof MessageRowSchema>;

function toConversation(r: ConversationRow): ChatConversation {
  return {
    id: r.id,
    title: r.title,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function toMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at
  };
}

export class ChatStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = wal');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  createConversation(input: { title?: string; model?: string | null } = {}): ChatConversation {
    const now = Date.now();
    const row: ConversationRow = {
      id: randomUUID(),
      title: input.title ?? 'New chat',
      model: input.model ?? null,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        'INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(row.id, row.title, row.model, row.created_at, row.updated_at);
    return toConversation(row);
  }

  listConversations(): ChatConversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
    return z.array(ConversationRowSchema).parse(rows).map(toConversation);
  }

  getConversation(id: string): ChatConversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (row == null) return null;
    return toConversation(ConversationRowSchema.parse(row));
  }

  renameConversation(id: string, title: string): void {
    this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
  }

  setConversationModel(id: string, model: string | null): void {
    this.db
      .prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?')
      .run(model, Date.now(), id);
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  addMessage(input: { conversationId: string; role: ChatRole; content: string }): ChatMessage {
    const now = Date.now();
    const row: MessageRow = {
      id: randomUUID(),
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      created_at: now
    };
    this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(row.id, row.conversation_id, row.role, row.content, row.created_at);
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(now, input.conversationId);
    return toMessage(row);
  }

  getMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId);
    return z.array(MessageRowSchema).parse(rows).map(toMessage);
  }

  close(): void {
    this.db.close();
  }
}
