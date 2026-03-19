import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { ConfigService } from '../starbase/config-service';
import { MemoService } from '../starbase/memo-service';
import { FirstOfficer, type ActionableEvent } from '../starbase/first-officer';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-first-officer');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let configService: ConfigService;
let memoService: MemoService;
let firstOfficer: FirstOfficer;
let missionId: number;
const CREW_ID = 'api-crew-abcd';
const SECTOR_ID = 'api';

const makeEvent = (overrides: Partial<ActionableEvent> = {}): ActionableEvent => ({
  crewId: CREW_ID,
  missionId,
  sectorId: SECTOR_ID,
  sectorName: 'api',
  eventType: 'mission-failed',
  missionSummary: 'Add auth endpoint',
  missionPrompt: 'Create a /auth endpoint',
  acceptanceCriteria: null,
  verifyCommand: null,
  crewOutput: 'Error: tests failed',
  verifyResult: null,
  reviewNotes: null,
  retryCount: 0,
  ...overrides,
});

beforeEach(() => {
  // Override HOME so FirstOfficer writes workspace under test dir
  process.env.HOME = TEST_DIR;

  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '');

  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();

  const rawDb = db.getDb();
  configService = new ConfigService(rawDb);
  memoService = new MemoService(rawDb);

  // Insert sector and mission so FK constraints are satisfied
  const sectorSvc = new SectorService(rawDb, WORKSPACE_DIR);
  sectorSvc.addSector({ path: 'api' });

  const missionSvc = new MissionService(rawDb);
  const mission = missionSvc.addMission({
    sectorId: SECTOR_ID,
    summary: 'Add auth endpoint',
    prompt: 'Create a /auth endpoint',
  });
  missionId = mission.id;

  // Insert crew row (minimal, no FK for crew table)
  rawDb.prepare('INSERT INTO crew (id, sector_id, status) VALUES (?, ?, ?)').run(
    CREW_ID,
    SECTOR_ID,
    'active',
  );

  firstOfficer = new FirstOfficer({
    db: rawDb,
    configService,
    memoService,
    starbaseId: db.getStarbaseId(),
  });
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('FirstOfficer', () => {
  it('activeCount starts at 0', () => {
    expect(firstOfficer.activeCount).toBe(0);
  });

  it('getStatus() returns idle when no processes running and no unread memos', () => {
    expect(firstOfficer.getStatus()).toBe('idle');
  });

  it('isRunning() returns false for unknown crew/mission combination', () => {
    expect(firstOfficer.isRunning('unknown-crew', 9999)).toBe(false);
  });

  it('dispatch() writes an escalation memo when retryCount >= maxRetries', async () => {
    // Get the configured max retries
    const maxRetries = configService.get('first_officer_max_retries') as number;
    expect(maxRetries).toBeGreaterThan(0);

    const event = makeEvent({ retryCount: maxRetries });
    const result = await firstOfficer.dispatch(event);

    // dispatch returns true (handled via escalation path)
    expect(result).toBe(true);

    // A memo should now exist in DB
    const memos = memoService.listAll();
    expect(memos.length).toBeGreaterThanOrEqual(1);

    const escalation = memos.find((m) => m.event_type === 'mission-failed');
    expect(escalation).toBeDefined();
    expect(escalation!.crew_id).toBe(CREW_ID);
    expect(escalation!.mission_id).toBe(missionId);

    // The memo file should exist on disk
    expect(existsSync(escalation!.file_path)).toBe(true);

    // File content should mention "Maximum retries exhausted"
    const { readFileSync } = await import('fs');
    const content = readFileSync(escalation!.file_path, 'utf-8');
    expect(content).toContain('Maximum retries exhausted');
  });

  it('dispatch() returns false if already running for same crew+mission', async () => {
    // Manually inject a running entry to simulate an in-flight process
    const runningMap: Map<string, unknown> = (firstOfficer as unknown as { running: Map<string, unknown> }).running;
    runningMap.set(`${CREW_ID}:${missionId}`, {
      proc: { killed: false, kill: () => {} },
      crewId: CREW_ID,
      missionId,
      startedAt: Date.now(),
    });

    const event = makeEvent();
    const result = await firstOfficer.dispatch(event);
    expect(result).toBe(false);
  });

  it('dispatch() returns false if concurrency limit is reached', async () => {
    const maxConcurrent = configService.get('first_officer_max_concurrent') as number;
    const runningMap: Map<string, unknown> = (firstOfficer as unknown as { running: Map<string, unknown> }).running;

    // Fill up running slots with dummy entries
    for (let i = 0; i < maxConcurrent; i++) {
      runningMap.set(`other-crew-${i}:${i}`, {
        proc: { killed: false, kill: () => {} },
        crewId: `other-crew-${i}`,
        missionId: i,
        startedAt: Date.now(),
      });
    }

    const event = makeEvent();
    const result = await firstOfficer.dispatch(event);
    expect(result).toBe(false);
  });

  it('writeHailingMemo() creates a memo file and DB record', () => {
    firstOfficer.writeHailingMemo({
      crewId: CREW_ID,
      missionId,
      sectorName: 'api',
      payload: JSON.stringify({ message: 'Should I use JWT or OAuth?' }),
      createdAt: new Date().toISOString(),
    });

    const memos = memoService.listAll();
    expect(memos.length).toBe(1);

    const memo = memos[0];
    expect(memo.crew_id).toBe(CREW_ID);
    expect(memo.mission_id).toBe(missionId);
    expect(memo.event_type).toBe('unanswered-hailing');
    expect(memo.status).toBe('unread');

    // File should exist on disk
    expect(existsSync(memo.file_path)).toBe(true);

    const { readFileSync } = require('fs');
    const content = readFileSync(memo.file_path, 'utf-8');
    expect(content).toContain('Unanswered Hailing');
    expect(content).toContain('Should I use JWT or OAuth?');
    expect(content).toContain(CREW_ID);
  });

  it('getStatus() returns memo when there are unread memos', () => {
    firstOfficer.writeHailingMemo({
      crewId: CREW_ID,
      missionId,
      sectorName: 'api',
      payload: 'Help needed',
      createdAt: new Date().toISOString(),
    });

    expect(firstOfficer.getStatus()).toBe('memo');
  });

  it('getStatusText() returns Idle when nothing is running', () => {
    expect(firstOfficer.getStatusText()).toBe('Idle');
  });
});
