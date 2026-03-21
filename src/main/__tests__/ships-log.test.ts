import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { ShipsLog } from '../starbase/ships-log';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-ships-log');
let db: StarbaseDB;
let log: ShipsLog;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/ships-log-test', join(TEST_DIR, 'starbases'));
  db.open();
  log = new ShipsLog(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ShipsLog', () => {
  it('should log an event and return its id', () => {
    const id = log.log({ crewId: 'crew-1', eventType: 'deployed', detail: { sectorId: 'api' } });
    expect(id).toBeGreaterThan(0);
  });

  it('should query by crewId', () => {
    log.log({ crewId: 'crew-1', eventType: 'deployed', detail: { sectorId: 'api' } });
    log.log({ crewId: 'crew-2', eventType: 'deployed', detail: { sectorId: 'web' } });
    log.log({ crewId: 'crew-1', eventType: 'exited', detail: { reason: 'done' } });

    const entries = log.query({ crewId: 'crew-1' });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.crew_id === 'crew-1')).toBe(true);
  });

  it('should query by eventType', () => {
    log.log({ crewId: 'crew-1', eventType: 'deployed', detail: { sectorId: 'api' } });
    log.log({ crewId: 'crew-2', eventType: 'exited', detail: { reason: 'done' } });
    log.log({ crewId: 'crew-3', eventType: 'deployed', detail: { sectorId: 'web' } });

    const entries = log.query({ eventType: 'deployed' });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.event_type === 'deployed')).toBe(true);
  });

  it('should query with combined filters', () => {
    log.log({ crewId: 'crew-1', eventType: 'deployed', detail: {} });
    log.log({ crewId: 'crew-1', eventType: 'exited', detail: {} });
    log.log({ crewId: 'crew-2', eventType: 'deployed', detail: {} });

    const entries = log.query({ crewId: 'crew-1', eventType: 'deployed' });
    expect(entries).toHaveLength(1);
  });

  it('should query with limit', () => {
    for (let i = 0; i < 10; i++) {
      log.log({ crewId: 'crew-1', eventType: 'deployed', detail: { i } });
    }
    const entries = log.query({ crewId: 'crew-1', limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it('should getRecent entries across all crew', () => {
    log.log({ crewId: 'crew-1', eventType: 'deployed', detail: {} });
    log.log({ crewId: 'crew-2', eventType: 'exited', detail: {} });
    log.log({ crewId: 'crew-3', eventType: 'lost', detail: {} });

    const recent = log.getRecent(2);
    expect(recent).toHaveLength(2);
    // Most recent first
    expect(recent[0].event_type).toBe('lost');
  });

  it('should store detail as JSON string', () => {
    log.log({
      crewId: 'crew-1',
      eventType: 'deployed',
      detail: { sectorId: 'api', missionId: 42 }
    });
    const entries = log.query({ crewId: 'crew-1' });
    const parsed = JSON.parse(entries[0].detail!);
    expect(parsed.sectorId).toBe('api');
    expect(parsed.missionId).toBe(42);
  });

  it('should handle null crewId for system events', () => {
    const id = log.log({ eventType: 'reconciliation', detail: { lostCrew: 3 } });
    expect(id).toBeGreaterThan(0);

    const entries = log.query({ eventType: 'reconciliation' });
    expect(entries).toHaveLength(1);
    expect(entries[0].crew_id).toBeNull();
  });
});
