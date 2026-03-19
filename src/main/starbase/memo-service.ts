import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import type { EventBus } from '../event-bus'

export type MemoRow = {
  id: string
  crew_id: string | null
  mission_id: number | null
  event_type: string
  file_path: string
  status: string
  retry_count: number
  created_at: string
  updated_at: string
}

export class MemoService {
  constructor(
    private db: Database.Database,
    private eventBus?: EventBus,
  ) {}

  insert(opts: {
    crewId: string | null
    missionId: number | null
    eventType: string
    filePath: string
    retryCount?: number
  }): MemoRow {
    const id = `memo-${randomBytes(4).toString('hex')}`
    this.db
      .prepare(
        `INSERT INTO memos (id, crew_id, mission_id, event_type, file_path, retry_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, opts.crewId, opts.missionId, opts.eventType, opts.filePath, opts.retryCount ?? 0)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
    return this.get(id)!
  }

  get(id: string): MemoRow | undefined {
    return this.db.prepare('SELECT * FROM memos WHERE id = ?').get(id) as MemoRow | undefined
  }

  listUnread(): MemoRow[] {
    return this.db
      .prepare("SELECT * FROM memos WHERE status = 'unread' ORDER BY created_at DESC")
      .all() as MemoRow[]
  }

  listAll(): MemoRow[] {
    return this.db
      .prepare("SELECT * FROM memos ORDER BY created_at DESC")
      .all() as MemoRow[]
  }

  markRead(id: string): void {
    this.db
      .prepare("UPDATE memos SET status = 'read', updated_at = datetime('now') WHERE id = ?")
      .run(id)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  dismiss(id: string): void {
    this.db
      .prepare("UPDATE memos SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?")
      .run(id)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  getUnreadCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM memos WHERE status = 'unread'")
      .get() as { count: number }
    return row.count
  }
}
