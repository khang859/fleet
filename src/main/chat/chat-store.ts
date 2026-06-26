import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type {
  ChatConversation,
  ChatImageRef,
  ChatMessage,
  ChatRole,
  ChatAuditEntry,
  ChatAuditDecision,
  ChatAuditStatus
} from '../../shared/chat-types';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT 'New chat',
  model        TEXT,
  title_locked INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS message_images (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ref             TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  position        INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_images_conversation
  ON message_images(conversation_id, message_id, position);
CREATE TABLE IF NOT EXISTS chat_audit (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tool            TEXT NOT NULL,
  detail          TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  decision        TEXT NOT NULL,
  status          TEXT NOT NULL,
  result          TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_audit_created ON chat_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_audit_conversation ON chat_audit(conversation_id, created_at);
`;

const AUDIT_DECISIONS = ['allowed', 'approved', 'auto', 'denied', 'blocked', 'error'] as const;
const AUDIT_STATUSES = ['ok', 'denied', 'error'] as const;

const AuditRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  tool: z.string(),
  detail: z.string(),
  cwd: z.string(),
  decision: z.enum(AUDIT_DECISIONS),
  status: z.enum(AUDIT_STATUSES),
  result: z.string(),
  created_at: z.number()
});

/** Cap stored result text so a noisy tool can't bloat the ledger. */
const AUDIT_RESULT_CAP = 2000;

const ConversationRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  model: z.string().nullable(),
  title_locked: z.number(),
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

const MessageImageRowSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  conversation_id: z.string(),
  ref: z.string(),
  mime_type: z.string(),
  position: z.number(),
  kind: z.enum(['generated', 'attachment']),
  created_at: z.number()
});

type ConversationRow = z.infer<typeof ConversationRowSchema>;
type MessageRow = z.infer<typeof MessageRowSchema>;

function toConversation(r: ConversationRow): ChatConversation {
  return {
    id: r.id,
    title: r.title,
    model: r.model,
    titleLocked: r.title_locked !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function toAudit(r: z.infer<typeof AuditRowSchema>): ChatAuditEntry {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    tool: r.tool,
    detail: r.detail,
    cwd: r.cwd,
    decision: r.decision,
    status: r.status,
    result: r.result,
    createdAt: r.created_at
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
    this.migrate();
  }

  /** Additive migrations for DBs created before a column existed. */
  private migrate(): void {
    const cols = z
      .array(z.object({ name: z.string() }))
      .parse(this.db.prepare('PRAGMA table_info(conversations)').all());
    if (!cols.some((c) => c.name === 'title_locked')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0');
    }
  }

  createConversation(input: { title?: string; model?: string | null } = {}): ChatConversation {
    const now = Date.now();
    const row: ConversationRow = {
      id: randomUUID(),
      title: input.title ?? 'New chat',
      model: input.model ?? null,
      title_locked: 0,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        'INSERT INTO conversations (id, title, model, title_locked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(row.id, row.title, row.model, row.title_locked, row.created_at, row.updated_at);
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

  /** Manual rename — locks the title so background auto-naming won't overwrite it. */
  renameConversation(id: string, title: string): void {
    this.db
      .prepare('UPDATE conversations SET title = ?, title_locked = 1, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
  }

  /**
   * Background auto-name. No-ops if the title is locked (user renamed it).
   * Returns true if the title was written. Does not bump updated_at so a
   * late-arriving title doesn't reorder the conversation list.
   */
  autoNameConversation(id: string, title: string): boolean {
    const res = this.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ? AND title_locked = 0')
      .run(title, id);
    return res.changes > 0;
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

  addImages(input: { messageId: string; conversationId: string; images: ChatImageRef[] }): void {
    if (!input.images.length) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO message_images
         (id, message_id, conversation_id, ref, mime_type, position, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = this.db.transaction((images: ChatImageRef[]) => {
      images.forEach((img, i) => {
        stmt.run(
          randomUUID(),
          input.messageId,
          input.conversationId,
          img.ref,
          img.mimeType,
          i,
          img.kind,
          now
        );
      });
    });
    insertAll(input.images);
  }

  getMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId);
    const messages = z.array(MessageRowSchema).parse(rows).map(toMessage);

    const imgRows = this.db
      .prepare(
        'SELECT * FROM message_images WHERE conversation_id = ? ORDER BY message_id, position'
      )
      .all(conversationId);
    const byMessage = new Map<string, ChatImageRef[]>();
    for (const r of z.array(MessageImageRowSchema).parse(imgRows)) {
      const list = byMessage.get(r.message_id) ?? [];
      list.push({ ref: r.ref, mimeType: r.mime_type, kind: r.kind });
      byMessage.set(r.message_id, list);
    }
    for (const m of messages) {
      const imgs = byMessage.get(m.id);
      if (imgs?.length) m.images = imgs;
    }
    return messages;
  }

  /** Append one audit record. Result text is capped; never throws on the hot path. */
  addAudit(input: {
    conversationId: string;
    tool: string;
    detail: string;
    cwd: string;
    decision: ChatAuditDecision;
    status: ChatAuditStatus;
    result: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_audit
           (id, conversation_id, tool, detail, cwd, decision, status, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.conversationId,
        input.tool,
        input.detail,
        input.cwd,
        input.decision,
        input.status,
        input.result.slice(0, AUDIT_RESULT_CAP),
        Date.now()
      );
  }

  /** Most-recent-first audit entries, optionally scoped to one conversation. */
  listAudit(opts: { conversationId?: string; limit?: number } = {}): ChatAuditEntry[] {
    const limit = opts.limit ?? 500;
    const rows = opts.conversationId
      ? this.db
          .prepare(
            'SELECT * FROM chat_audit WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
          )
          .all(opts.conversationId, limit)
      : this.db.prepare('SELECT * FROM chat_audit ORDER BY created_at DESC LIMIT ?').all(limit);
    return z.array(AuditRowSchema).parse(rows).map(toAudit);
  }

  close(): void {
    this.db.close();
  }
}
