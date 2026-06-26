import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type {
  ChatConversation,
  ChatImageRef,
  ChatMessage,
  ChatMessageUsage,
  ChatRole,
  ChatAuditEntry,
  ChatAuditDecision,
  ChatAuditStatus
} from '../../shared/chat-types';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL DEFAULT 'New chat',
  model                  TEXT,
  title_locked           INTEGER NOT NULL DEFAULT 0,
  active_head_id         TEXT,
  parent_conversation_id TEXT,
  fork_message_id        TEXT,
  persona_id             TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  parent_id       TEXT,
  active_child_id TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cached_tokens     INTEGER,
  cost              REAL,
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
  active_head_id: z.string().nullable(),
  parent_conversation_id: z.string().nullable(),
  fork_message_id: z.string().nullable(),
  persona_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number()
});

const MessageRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  parent_id: z.string().nullable(),
  active_child_id: z.string().nullable(),
  prompt_tokens: z.number().nullable(),
  completion_tokens: z.number().nullable(),
  cached_tokens: z.number().nullable(),
  cost: z.number().nullable(),
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
    parentConversationId: r.parent_conversation_id,
    personaId: r.persona_id,
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
  const msg: ChatMessage = {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    parentId: r.parent_id,
    createdAt: r.created_at
  };
  // Usage is recorded only on assistant turns that returned accounting.
  if (r.prompt_tokens != null || r.completion_tokens != null || r.cost != null) {
    msg.usage = {
      promptTokens: r.prompt_tokens ?? 0,
      completionTokens: r.completion_tokens ?? 0,
      cachedTokens: r.cached_tokens ?? 0,
      cost: r.cost
    };
  }
  return msg;
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
    const convCols = z
      .array(z.object({ name: z.string() }))
      .parse(this.db.prepare('PRAGMA table_info(conversations)').all());
    if (!convCols.some((c) => c.name === 'title_locked')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0');
    }
    const hasActiveHead = convCols.some((c) => c.name === 'active_head_id');
    if (!hasActiveHead) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN active_head_id TEXT');
    }
    if (!convCols.some((c) => c.name === 'parent_conversation_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT');
      this.db.exec('ALTER TABLE conversations ADD COLUMN fork_message_id TEXT');
    }
    if (!convCols.some((c) => c.name === 'persona_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN persona_id TEXT');
    }

    const msgCols = z
      .array(z.object({ name: z.string() }))
      .parse(this.db.prepare('PRAGMA table_info(messages)').all());
    const hasParent = msgCols.some((c) => c.name === 'parent_id');
    if (!hasParent) {
      this.db.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT');
      this.db.exec('ALTER TABLE messages ADD COLUMN active_child_id TEXT');
      this.backfillTurnTree();
    }
    if (!msgCols.some((c) => c.name === 'prompt_tokens')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER');
      this.db.exec('ALTER TABLE messages ADD COLUMN completion_tokens INTEGER');
      this.db.exec('ALTER TABLE messages ADD COLUMN cached_tokens INTEGER');
      this.db.exec('ALTER TABLE messages ADD COLUMN cost REAL');
    }
    // Created here (not in SCHEMA_SQL) so it runs only after parent_id is
    // guaranteed to exist — legacy tables gain the column above first.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)');
  }

  /**
   * Turn a legacy flat message list into a linear turn tree: chain each message
   * to the previous one by creation order, and point each conversation's head at
   * its first message. Existing chats then render as a single (un-paged) path.
   */
  private backfillTurnTree(): void {
    const convs = z
      .array(z.object({ id: z.string() }))
      .parse(this.db.prepare('SELECT id FROM conversations').all());
    const setParent = this.db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?');
    const setChild = this.db.prepare('UPDATE messages SET active_child_id = ? WHERE id = ?');
    const setHead = this.db.prepare('UPDATE conversations SET active_head_id = ? WHERE id = ?');
    const run = this.db.transaction((conversationIds: string[]) => {
      for (const cid of conversationIds) {
        const ids = z
          .array(z.object({ id: z.string() }))
          .parse(
            this.db
              .prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
              .all(cid)
          )
          .map((r) => r.id);
        if (ids.length === 0) continue;
        setHead.run(ids[0], cid);
        for (let i = 0; i < ids.length; i++) {
          if (i > 0) setParent.run(ids[i - 1], ids[i]);
          if (i < ids.length - 1) setChild.run(ids[i + 1], ids[i]);
        }
      }
    });
    run(convs.map((c) => c.id));
  }

  createConversation(
    input: { title?: string; model?: string | null; personaId?: string | null } = {}
  ): ChatConversation {
    const now = Date.now();
    const row: ConversationRow = {
      id: randomUUID(),
      title: input.title ?? 'New chat',
      model: input.model ?? null,
      title_locked: 0,
      active_head_id: null,
      parent_conversation_id: null,
      fork_message_id: null,
      persona_id: input.personaId ?? null,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare(
        'INSERT INTO conversations (id, title, model, title_locked, persona_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        row.id,
        row.title,
        row.model,
        row.title_locked,
        row.persona_id,
        row.created_at,
        row.updated_at
      );
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

  setConversationPersona(id: string, personaId: string | null): void {
    this.db
      .prepare('UPDATE conversations SET persona_id = ?, updated_at = ? WHERE id = ?')
      .run(personaId, Date.now(), id);
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  /**
   * Append a message under `parentId` (or as a new root when null) and make it
   * the active child of its parent — newest attempt wins by default. Returns the
   * persisted message.
   */
  addMessage(input: {
    conversationId: string;
    role: ChatRole;
    content: string;
    parentId?: string | null;
    usage?: ChatMessageUsage | null;
  }): ChatMessage {
    const now = Date.now();
    const parentId = input.parentId ?? null;
    const u = input.usage ?? null;
    const row: MessageRow = {
      id: randomUUID(),
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      parent_id: parentId,
      active_child_id: null,
      prompt_tokens: u ? u.promptTokens : null,
      completion_tokens: u ? u.completionTokens : null,
      cached_tokens: u ? u.cachedTokens : null,
      cost: u ? u.cost : null,
      created_at: now
    };
    this.db
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, role, content, parent_id, active_child_id,
            prompt_tokens, completion_tokens, cached_tokens, cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.conversation_id,
        row.role,
        row.content,
        row.parent_id,
        null,
        row.prompt_tokens,
        row.completion_tokens,
        row.cached_tokens,
        row.cost,
        row.created_at
      );
    if (parentId) {
      this.db.prepare('UPDATE messages SET active_child_id = ? WHERE id = ?').run(row.id, parentId);
    } else {
      this.db
        .prepare('UPDATE conversations SET active_head_id = ? WHERE id = ?')
        .run(row.id, input.conversationId);
    }
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(now, input.conversationId);
    return toMessage(row);
  }

  private getRow(id: string): MessageRow | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row == null ? null : MessageRowSchema.parse(row);
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.getRow(id);
    return row ? toMessage(row) : null;
  }

  /** Children of a node, oldest → newest. Root children when parentId is null. */
  private childrenOf(conversationId: string, parentId: string | null): MessageRow[] {
    const rows = parentId
      ? this.db
          .prepare('SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at ASC')
          .all(parentId)
      : this.db
          .prepare(
            'SELECT * FROM messages WHERE conversation_id = ? AND parent_id IS NULL ORDER BY created_at ASC'
          )
          .all(conversationId);
    return z.array(MessageRowSchema).parse(rows);
  }

  /** The active root→leaf path: follow active_child, defaulting to newest child. */
  private activePathRows(conversationId: string): MessageRow[] {
    const conv = this.getConversation(conversationId);
    if (!conv) return [];
    const roots = this.childrenOf(conversationId, null);
    if (roots.length === 0) return [];
    const headId = this.headId(conversationId) ?? roots[roots.length - 1].id;
    const path: MessageRow[] = [];
    let current = this.getRow(headId);
    while (current) {
      path.push(current);
      const kids = this.childrenOf(conversationId, current.id);
      if (kids.length === 0) break;
      const nextId = current.active_child_id ?? kids[kids.length - 1].id;
      current = kids.find((k) => k.id === nextId) ?? kids[kids.length - 1];
    }
    return path;
  }

  private headId(conversationId: string): string | null {
    const row = this.db
      .prepare('SELECT active_head_id AS h FROM conversations WHERE id = ?')
      .get(conversationId);
    return z.object({ h: z.string().nullable() }).parse(row).h;
  }

  /** Ancestors of `messageId` plus itself, root → message. For regenerate/edit context. */
  getPathTo(messageId: string): ChatMessage[] {
    const chain: MessageRow[] = [];
    let node = this.getRow(messageId);
    while (node) {
      chain.push(node);
      node = node.parent_id ? this.getRow(node.parent_id) : null;
    }
    chain.reverse();
    return this.withImagesAndVariants(chain);
  }

  /** The last message on the active path, or null for an empty conversation. */
  activeLeafId(conversationId: string): string | null {
    const path = this.activePathRows(conversationId);
    return path.length ? path[path.length - 1].id : null;
  }

  /** Make `messageId` the active variant under its parent (pager selection). */
  selectVariant(messageId: string): void {
    const row = this.getRow(messageId);
    if (!row) return;
    if (row.parent_id) {
      this.db
        .prepare('UPDATE messages SET active_child_id = ? WHERE id = ?')
        .run(messageId, row.parent_id);
    } else {
      this.db
        .prepare('UPDATE conversations SET active_head_id = ? WHERE id = ?')
        .run(messageId, row.conversation_id);
    }
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

  /**
   * Fork a new conversation seeded with the history up to (and including)
   * `messageId`. The source conversation is left untouched; the branch records a
   * parent link for discovery in the sidebar.
   */
  forkConversation(messageId: string): ChatConversation | null {
    const src = this.getRow(messageId);
    if (!src) return null;
    const srcConv = this.getConversation(src.conversation_id);
    if (!srcConv) return null;
    const path = this.getPathTo(messageId);

    const fork = this.db.transaction((): ChatConversation => {
      const branch = this.createConversation({
        title: `${srcConv.title} (branch)`,
        model: srcConv.model,
        personaId: srcConv.personaId
      });
      this.db
        .prepare(
          'UPDATE conversations SET parent_conversation_id = ?, fork_message_id = ? WHERE id = ?'
        )
        .run(src.conversation_id, messageId, branch.id);
      let parentId: string | null = null;
      for (const m of path) {
        const copy = this.addMessage({
          conversationId: branch.id,
          role: m.role,
          content: m.content,
          parentId
        });
        if (m.images?.length) {
          this.addImages({ messageId: copy.id, conversationId: branch.id, images: m.images });
        }
        parentId = copy.id;
      }
      return branch;
    });
    const branch = fork();
    return this.getConversation(branch.id);
  }

  /** The active conversation thread (root → leaf), with images + variant pagers. */
  getMessages(conversationId: string): ChatMessage[] {
    return this.withImagesAndVariants(this.activePathRows(conversationId));
  }

  /** Attach images and sibling-variant pager info to a sequence of rows. */
  private withImagesAndVariants(rows: MessageRow[]): ChatMessage[] {
    const messages = rows.map(toMessage);
    if (messages.length === 0) return messages;

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const imgRows = this.db
      .prepare(
        `SELECT * FROM message_images WHERE message_id IN (${placeholders}) ORDER BY message_id, position`
      )
      .all(...ids);
    const byMessage = new Map<string, ChatImageRef[]>();
    for (const r of z.array(MessageImageRowSchema).parse(imgRows)) {
      const list = byMessage.get(r.message_id) ?? [];
      list.push({ ref: r.ref, mimeType: r.mime_type, kind: r.kind });
      byMessage.set(r.message_id, list);
    }

    for (const m of messages) {
      const imgs = byMessage.get(m.id);
      if (imgs?.length) m.images = imgs;
      const siblings = this.childrenOf(m.conversationId, m.parentId);
      if (siblings.length > 1) {
        const sibIds = siblings.map((s) => s.id);
        m.variants = { index: sibIds.indexOf(m.id) + 1, total: sibIds.length, ids: sibIds };
      }
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
