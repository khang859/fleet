import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { CommsService, CommsRateLimitError } from '../starbase/comms-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-comms');
let db: StarbaseDB;
let svc: CommsService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/comms-test', join(TEST_DIR, 'starbases'));
  db.open();
  svc = new CommsService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('CommsService', () => {
  it('should send a transmission', () => {
    const id = svc.send({ from: 'crew-1', to: 'admiral', type: 'mission_complete', payload: '{}' });
    expect(id).toBeGreaterThan(0);
  });

  it('should get unread transmissions', () => {
    svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });
    const unread = svc.getUnread('admiral');
    expect(unread).toHaveLength(2);
  });

  it('should mark a transmission as read', () => {
    const id = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.markRead(id);
    const unread = svc.getUnread('admiral');
    expect(unread).toHaveLength(0);
  });

  it('should resolve a transmission with reply', () => {
    const id = svc.send({
      from: 'crew-1',
      to: 'admiral',
      type: 'hailing',
      payload: '{"question":"help"}'
    });
    svc.resolve(id, 'Here is your answer');
    const unread = svc.getUnread('admiral');
    expect(unread).toHaveLength(0);
  });

  it('should get thread messages', () => {
    const id1 = svc.send({
      from: 'crew-1',
      to: 'admiral',
      type: 'hailing',
      payload: '{}',
      threadId: 'thread-1'
    });
    svc.send({
      from: 'admiral',
      to: 'crew-1',
      type: 'directive',
      payload: '{}',
      threadId: 'thread-1',
      inReplyTo: id1
    });
    const thread = svc.getThread('thread-1');
    expect(thread).toHaveLength(2);
  });

  it('should get recent transmissions with optional filter', () => {
    svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'admiral', to: 'crew-1', type: 'directive', payload: '{}' });

    const all = svc.getRecent();
    expect(all).toHaveLength(3);

    const crew1 = svc.getRecent({ crewId: 'crew-1' });
    expect(crew1).toHaveLength(2); // sent one, received one
  });

  it('should throw when resolving non-existent transmission', () => {
    expect(() => svc.resolve(999, 'response')).toThrow('Transmission not found: 999');
  });

  it('should delete a single transmission', () => {
    const id = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    expect(svc.delete(id)).toBe(true);
    expect(svc.getRecent()).toHaveLength(0);
  });

  it('should return false when deleting non-existent transmission', () => {
    expect(svc.delete(999)).toBe(false);
  });

  it('should clear all transmissions', () => {
    svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });
    const count = svc.clear();
    expect(count).toBe(2);
    expect(svc.getRecent()).toHaveLength(0);
  });

  it('should clear transmissions for a specific crew', () => {
    svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'admiral', to: 'crew-1', type: 'directive', payload: '{}' });
    const count = svc.clear({ crewId: 'crew-1' });
    expect(count).toBe(2); // from crew-1 + to crew-1
    expect(svc.getRecent()).toHaveLength(1); // only crew-2's message remains
  });

  it('should mark all transmissions as read', () => {
    svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });
    const count = svc.markAllRead();
    expect(count).toBe(2);
    expect(svc.getUnread('admiral')).toHaveLength(0);
  });

  it('should mark all transmissions as read for a specific crew', () => {
    svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });
    const count = svc.markAllRead({ crewId: 'admiral' });
    expect(count).toBe(2);
    expect(svc.getUnread('admiral')).toHaveLength(0);
  });

  describe('deduplication', () => {
    it('should increment repeat_count for identical message within 5 minutes', () => {
      const id1 = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'hello' });
      const id2 = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'hello' });
      expect(id2).toBe(id1);

      const rows = svc.getRecent();
      expect(rows).toHaveLength(1);
      expect(rows[0].repeat_count).toBe(2);
    });

    it('should insert a new row for a different message', () => {
      svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'hello' });
      svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'goodbye' });

      const rows = svc.getRecent();
      expect(rows).toHaveLength(2);
      expect(rows[0].repeat_count).toBe(1);
      expect(rows[1].repeat_count).toBe(1);
    });

    it('should insert a new row for the same message after 5+ minutes', () => {
      svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'hello' });

      // Backdate the existing message to 6 minutes ago
      db.getDb()
        .prepare(
          "UPDATE comms SET created_at = datetime('now', '-6 minutes') WHERE from_crew = 'crew-1'"
        )
        .run();

      svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'hello' });

      const rows = svc.getRecent();
      expect(rows).toHaveLength(2);
    });

    it('should not deduplicate messages to different recipients', () => {
      const id1 = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'hello' });
      const id2 = svc.send({ from: 'crew-1', to: 'crew-2', type: 'hailing', payload: 'hello' });
      expect(id2).not.toBe(id1);

      const rows = svc.getRecent();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.repeat_count === 1)).toBe(true);
    });

    it('should not consume rate limit budget for deduplicated messages', () => {
      // Set up a crew with rate limiting
      db.getDb()
        .prepare(
          "INSERT OR IGNORE INTO sectors (id, name, root_path) VALUES ('test', 'test', '/tmp/test')"
        )
        .run();
      db.getDb()
        .prepare(
          "INSERT INTO crew (id, sector_id, status, comms_count_minute) VALUES ('crew-dedup', 'test', 'active', 0)"
        )
        .run();

      svc.setRateLimit(2);

      // Send a message — should increment counter to 1
      svc.send({ from: 'crew-dedup', to: 'admiral', type: 'hailing', payload: 'hello' });
      // Send the same message — should dedup, counter stays at 1
      svc.send({ from: 'crew-dedup', to: 'admiral', type: 'hailing', payload: 'hello' });

      const row = db
        .getDb()
        .prepare('SELECT comms_count_minute FROM crew WHERE id = ?')
        .get('crew-dedup') as { comms_count_minute: number };
      expect(row.comms_count_minute).toBe(1);
    });
  });

  describe('filtering', () => {
    it('should filter by type', () => {
      svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
      svc.send({ from: 'crew-1', to: 'admiral', type: 'mission_complete', payload: '{}' });
      svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });

      const hailing = svc.getRecent({ type: 'hailing' });
      expect(hailing).toHaveLength(2);
      expect(hailing.every((r) => r.type === 'hailing')).toBe(true);
    });

    it('should filter by from', () => {
      svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
      svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });
      svc.send({ from: 'admiral', to: 'crew-1', type: 'directive', payload: '{}' });

      const fromCrew1 = svc.getRecent({ from: 'crew-1' });
      expect(fromCrew1).toHaveLength(1);
      expect(fromCrew1[0].from_crew).toBe('crew-1');
    });

    it('should throw when both crewId and from are provided', () => {
      expect(() => svc.getRecent({ crewId: 'crew-1', from: 'crew-1' })).toThrow(
        'Cannot filter by both crewId and from'
      );
    });
  });

  describe('execution_id', () => {
    function insertExecution(id: string): void {
      db.getDb()
        .prepare(
          "INSERT OR IGNORE INTO protocol_executions (id, feature_request) VALUES (?, 'test')"
        )
        .run(id);
    }

    it('stores execution_id on a transmission', () => {
      insertExecution('exec-123');
      const id = svc.send({
        from: 'navigator',
        to: 'admiral',
        type: 'gate-pending',
        payload: 'test',
        executionId: 'exec-123'
      });
      const row = db.getDb().prepare('SELECT execution_id FROM comms WHERE id = ?').get(id) as {
        execution_id: string;
      };
      expect(row.execution_id).toBe('exec-123');
    });

    it('filters unread comms by execution_id', () => {
      insertExecution('exec-A');
      insertExecution('exec-B');
      svc.send({
        from: 'navigator',
        to: 'admiral',
        type: 'gate-pending',
        payload: 'a',
        executionId: 'exec-A'
      });
      svc.send({
        from: 'navigator',
        to: 'admiral',
        type: 'gate-pending',
        payload: 'b',
        executionId: 'exec-B'
      });
      const rows = svc.getUnreadByExecution('exec-A');
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toBe('a');
    });
  });

  describe('dedup exclusion for navigator', () => {
    function insertExecution(id: string): void {
      db.getDb()
        .prepare(
          "INSERT OR IGNORE INTO protocol_executions (id, feature_request) VALUES (?, 'test')"
        )
        .run(id);
    }

    it('does not deduplicate identical messages from navigator', () => {
      insertExecution('exec-1');
      insertExecution('exec-2');
      svc.send({
        from: 'navigator',
        to: 'admiral',
        type: 'protocol-complete',
        payload: 'done',
        executionId: 'exec-1'
      });
      svc.send({
        from: 'navigator',
        to: 'admiral',
        type: 'protocol-complete',
        payload: 'done',
        executionId: 'exec-2'
      });
      const rows = db
        .getDb()
        .prepare("SELECT * FROM comms WHERE from_crew = 'navigator'")
        .all() as Array<{ id: number }>;
      expect(rows).toHaveLength(2);
    });
  });

  describe('rate limiting', () => {
    function ensureSector(): void {
      db.getDb()
        .prepare(
          "INSERT OR IGNORE INTO sectors (id, name, root_path) VALUES ('test', 'test', '/tmp/test')"
        )
        .run();
    }

    it('should reject transmissions above rate limit', () => {
      ensureSector();
      db.getDb()
        .prepare(
          "INSERT INTO crew (id, sector_id, status, comms_count_minute) VALUES ('crew-rl', 'test', 'active', 5)"
        )
        .run();

      svc.setRateLimit(5);
      expect(() =>
        svc.send({ from: 'crew-rl', to: 'admiral', type: 'hailing', payload: '{}' })
      ).toThrow(CommsRateLimitError);
    });

    it('should allow transmissions below rate limit', () => {
      ensureSector();
      db.getDb()
        .prepare(
          "INSERT INTO crew (id, sector_id, status, comms_count_minute) VALUES ('crew-ok', 'test', 'active', 0)"
        )
        .run();

      svc.setRateLimit(5);
      const id = svc.send({ from: 'crew-ok', to: 'admiral', type: 'hailing', payload: '{}' });
      expect(id).toBeGreaterThan(0);

      // Counter should have incremented
      const row = db
        .getDb()
        .prepare('SELECT comms_count_minute FROM crew WHERE id = ?')
        .get('crew-ok') as { comms_count_minute: number };
      expect(row.comms_count_minute).toBe(1);
    });

    it('should not rate limit admiral messages', () => {
      svc.setRateLimit(1);
      // Admiral can always send
      const id = svc.send({ from: 'admiral', to: 'crew-1', type: 'directive', payload: '{}' });
      expect(id).toBeGreaterThan(0);
    });
  });
});
