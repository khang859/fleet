import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lockfile } from '../starbase/lockfile';
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-lockfile');

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Lockfile', () => {
  it('should acquire a lock and write lock file', () => {
    const lockfile = new Lockfile(TEST_DIR, 'test-123');
    const result = lockfile.acquire();
    expect(result).toBe('acquired');

    const lockPath = join(TEST_DIR, 'starbase-test-123.lock');
    const data = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(data.pid).toBe(process.pid);
    expect(data.timestamp).toBeDefined();

    lockfile.release();
  });

  it('should detect active lock from live PID', () => {
    // Write a lock with our own PID (which is alive)
    const lockPath = join(TEST_DIR, 'starbase-test-123.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() })
    );

    const lockfile = new Lockfile(TEST_DIR, 'test-123');
    const result = lockfile.acquire();
    expect(result).toBe('read-only');

    // No release needed — we didn't actually acquire
  });

  it('should detect stale lock from dead PID', () => {
    // PID 99999999 should not exist
    const lockPath = join(TEST_DIR, 'starbase-test-123.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, timestamp: new Date().toISOString() }));

    const lockfile = new Lockfile(TEST_DIR, 'test-123');
    const result = lockfile.acquire();
    expect(result).toBe('acquired');

    // Verify it overwrote with our PID
    const data = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(data.pid).toBe(process.pid);

    lockfile.release();
  });

  it('should treat lock older than 24 hours as stale regardless of PID', () => {
    const lockPath = join(TEST_DIR, 'starbase-test-123.lock');
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    // Use our own PID (alive) but with old timestamp
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: oldTimestamp }));

    const lockfile = new Lockfile(TEST_DIR, 'test-123');
    const result = lockfile.acquire();
    expect(result).toBe('acquired');

    lockfile.release();
  });

  it('should release the lock file on close', () => {
    const lockfile = new Lockfile(TEST_DIR, 'test-123');
    lockfile.acquire();
    lockfile.release();

    const lockPath = join(TEST_DIR, 'starbase-test-123.lock');
    expect(() => readFileSync(lockPath)).toThrow();
  });

  it('should handle missing lock file on release gracefully', () => {
    const lockfile = new Lockfile(TEST_DIR, 'test-123');
    // Release without acquiring — should not throw
    expect(() => lockfile.release()).not.toThrow();
  });
});
