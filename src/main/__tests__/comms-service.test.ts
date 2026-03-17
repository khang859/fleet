import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { CommsService } from '../starbase/comms-service';
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
});
