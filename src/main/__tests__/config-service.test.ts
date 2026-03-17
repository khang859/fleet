import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { ConfigService } from '../starbase/config-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-config');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let svc: ConfigService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/config-test', DB_DIR);
  db.open();
  svc = new ConfigService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ConfigService', () => {
  it('should return seeded defaults via get()', () => {
    expect(svc.get('max_concurrent_worktrees')).toBe(5);
    expect(svc.get('default_mission_timeout_min')).toBe(15);
  });

  it('should set and get a value', () => {
    svc.set('max_concurrent_worktrees', 10);
    expect(svc.get('max_concurrent_worktrees')).toBe(10);
  });

  it('should return all config with defaults', () => {
    const all = svc.getAll();
    expect(all.max_concurrent_worktrees).toBe(5);
    expect(all.lifesign_timeout_sec).toBe(30);
  });

  it('should handle unknown keys with fallback to CONFIG_DEFAULTS', () => {
    // If a key is not in the DB but is in defaults, return default
    expect(svc.get('default_review_mode')).toBe('admiral-review');
  });
});
