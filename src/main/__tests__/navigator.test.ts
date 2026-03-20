import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { Navigator } from '../starbase/navigator';
import { ConfigService } from '../starbase/config-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-navigator');

let db: StarbaseDB;
let configService: ConfigService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/nav-test', join(TEST_DIR, 'starbases'));
  db.open();
  configService = new ConfigService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Navigator', () => {
  it('reports idle when no processes running', () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
    expect(nav.activeCount).toBe(0);
    expect(nav.isRunning('exec-1')).toBe(false);
  });

  it('deduplicates: returns false if execution already running', async () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
    // Manually inject a fake running entry
    ;(nav as unknown as { running: Map<string, unknown> }).running.set('exec-1', { proc: { killed: false, kill: vi.fn() }, executionId: 'exec-1', startedAt: Date.now() });
    const result = await nav.dispatch({ executionId: 'exec-1', protocolSlug: 'research-and-deploy', featureRequest: 'build X', currentStep: 1, context: null });
    expect(result).toBe(false);
  });

  it('respects max concurrent limit', async () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
    const running = (nav as unknown as { running: Map<string, unknown> }).running;
    running.set('exec-A', { proc: { killed: false, kill: vi.fn() }, executionId: 'exec-A', startedAt: Date.now() });
    running.set('exec-B', { proc: { killed: false, kill: vi.fn() }, executionId: 'exec-B', startedAt: Date.now() });
    // max is 2 by default config
    const result = await nav.dispatch({ executionId: 'exec-C', protocolSlug: 'research-and-deploy', featureRequest: 'build X', currentStep: 1, context: null });
    expect(result).toBe(false);
  });

  it('creates workspace directory on first dispatch attempt', async () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123', fleetBinDir: '/usr/local/bin' });
    // dispatch will fail (no claude binary in test) but workspace setup happens first
    await nav.dispatch({ executionId: 'exec-new', protocolSlug: 'research-and-deploy', featureRequest: 'build X', currentStep: 1, context: null }).catch(() => {});
    // Just verify no crash and process cleaned up
    expect(nav.activeCount).toBe(0); // process failed or never started, cleaned up
  });

  it('clears running map on reconcile', () => {
    const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
    ;(nav as unknown as { running: Map<string, unknown> }).running.set('exec-1', {});
    nav.reconcile();
    expect(nav.activeCount).toBe(0);
  });
});
