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
    const id = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{"question":"help"}' });
    svc.resolve(id, 'Here is your answer');
    const unread = svc.getUnread('admiral');
    expect(unread).toHaveLength(0);
  });

  it('should get thread messages', () => {
    const id1 = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}', threadId: 'thread-1' });
    svc.send({ from: 'admiral', to: 'crew-1', type: 'directive', payload: '{}', threadId: 'thread-1', inReplyTo: id1 });
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

  describe('rate limiting', () => {
    function ensureSector(): void {
      db.getDb()
        .prepare("INSERT OR IGNORE INTO sectors (id, name, root_path) VALUES ('test', 'test', '/tmp/test')")
        .run();
    }

    it('should reject transmissions above rate limit', () => {
      ensureSector();
      db.getDb()
        .prepare("INSERT INTO crew (id, sector_id, status, comms_count_minute) VALUES ('crew-rl', 'test', 'active', 5)")
        .run();

      svc.setRateLimit(5);
      expect(() =>
        svc.send({ from: 'crew-rl', to: 'admiral', type: 'hailing', payload: '{}' }),
      ).toThrow(CommsRateLimitError);
    });

    it('should allow transmissions below rate limit', () => {
      ensureSector();
      db.getDb()
        .prepare("INSERT INTO crew (id, sector_id, status, comms_count_minute) VALUES ('crew-ok', 'test', 'active', 0)")
        .run();

      svc.setRateLimit(5);
      const id = svc.send({ from: 'crew-ok', to: 'admiral', type: 'hailing', payload: '{}' });
      expect(id).toBeGreaterThan(0);

      // Counter should have incremented
      const row = db.getDb().prepare('SELECT comms_count_minute FROM crew WHERE id = ?').get('crew-ok') as { comms_count_minute: number };
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
