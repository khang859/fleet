import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { ConfigService } from '../starbase/config-service';
import { FirstOfficer, type ActionableEvent } from '../starbase/first-officer';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { SupplyRouteService } from '../starbase/supply-route-service';
import { CargoService } from '../starbase/cargo-service';
import { ShipsLog } from '../starbase/ships-log';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-first-officer');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let rawDb: ReturnType<StarbaseDB['getDb']>;
let configService: ConfigService;
let firstOfficer: FirstOfficer;
let missionId: number;
let missionService: MissionService;
let cargoService: CargoService;
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
  ...overrides
});

beforeEach(() => {
  // Override HOME so FirstOfficer writes workspace under test dir
  process.env.HOME = TEST_DIR;

  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '');

  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();

  rawDb = db.getDb();
  configService = new ConfigService(rawDb);

  // Insert sector and mission so FK constraints are satisfied
  const sectorSvc = new SectorService(rawDb, WORKSPACE_DIR);
  sectorSvc.addSector({ path: 'api' });

  missionService = new MissionService(rawDb);
  const mission = missionService.addMission({
    sectorId: SECTOR_ID,
    summary: 'Add auth endpoint',
    prompt: 'Create a /auth endpoint'
  });
  missionId = mission.id;

  cargoService = new CargoService(rawDb, new SupplyRouteService(rawDb), configService);

  // Insert crew row (minimal, no FK for crew table)
  rawDb
    .prepare('INSERT INTO crew (id, sector_id, status) VALUES (?, ?, ?)')
    .run(CREW_ID, SECTOR_ID, 'active');

  firstOfficer = new FirstOfficer({
    db: rawDb,
    configService,
    missionService,
    cargoService,
    crewService: {
      recallCrew: () => {},
      deployCrew: () => ({ crewId: 'replacement', missionId }),
      deleteCrew: () => {},
      observeCrew: () => null
    } as any,
    shipsLog: new ShipsLog(rawDb),
    starbaseId: db.getStarbaseId()
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

  it('dispatch() writes an escalation comm when retryCount >= maxRetries', async () => {
    const maxRetries = configService.get('first_officer_max_retries') as number;
    expect(maxRetries).toBeGreaterThan(0);
    const event = makeEvent({ retryCount: maxRetries });
    const result = await firstOfficer.dispatch(event);
    expect(result).toBe(true);

    const comms = rawDb
      .prepare("SELECT * FROM comms WHERE type = 'memo' AND mission_id = ?")
      .all(missionId) as Array<{ id: number; payload: string; read: number }>;

    expect(comms.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(comms[0].payload);
    expect(payload.crewId).toBe(CREW_ID);
    expect(payload.missionId).toBe(missionId);
    expect(payload.summary).toContain('Maximum retries exhausted');
  });

  it('dispatch() returns false if already running for same crew+mission', async () => {
    // Manually inject a running entry to simulate an in-flight process
    const runningMap: Map<string, unknown> = (
      firstOfficer as unknown as { running: Map<string, unknown> }
    ).running;
    runningMap.set(`${CREW_ID}:${missionId}`, {
      proc: { killed: false, kill: () => {} },
      crewId: CREW_ID,
      missionId,
      startedAt: Date.now()
    });

    const event = makeEvent();
    const result = await firstOfficer.dispatch(event);
    expect(result).toBe(false);
  });

  it('dispatch() returns false if concurrency limit is reached', async () => {
    const maxConcurrent = configService.get('first_officer_max_concurrent') as number;
    const runningMap: Map<string, unknown> = (
      firstOfficer as unknown as { running: Map<string, unknown> }
    ).running;

    // Fill up running slots with dummy entries
    for (let i = 0; i < maxConcurrent; i++) {
      runningMap.set(`other-crew-${i}:${i}`, {
        proc: { killed: false, kill: () => {} },
        crewId: `other-crew-${i}`,
        missionId: i,
        startedAt: Date.now()
      });
    }

    const event = makeEvent();
    const result = await firstOfficer.dispatch(event);
    expect(result).toBe(false);
  });

  it('writeHailingMemo() creates a hailing-memo comm and file', async () => {
    await firstOfficer.writeHailingMemo({
      crewId: CREW_ID,
      missionId,
      sectorName: 'api',
      payload: JSON.stringify({ message: 'Should I use JWT or OAuth?' }),
      createdAt: new Date().toISOString()
    });

    const comms = rawDb
      .prepare("SELECT * FROM comms WHERE type = 'hailing-memo' AND mission_id = ?")
      .all(missionId) as Array<{ id: number; payload: string; read: number; from_crew: string }>;

    expect(comms.length).toBe(1);
    expect(comms[0].read).toBe(0);
    expect(comms[0].from_crew).toBe('first-officer');

    const payload = JSON.parse(comms[0].payload);
    expect(payload.crewId).toBe(CREW_ID);
    expect(payload.missionId).toBe(missionId);
    expect(payload.summary).toContain('Unanswered hailing');
  });

  it('getStatus() returns memo when there are unread memos', async () => {
    await firstOfficer.writeHailingMemo({
      crewId: CREW_ID,
      missionId,
      sectorName: 'api',
      payload: 'Help needed',
      createdAt: new Date().toISOString()
    });

    expect(firstOfficer.getStatus()).toBe('memo');
  });

  it('getStatusText() returns Idle when nothing is running', () => {
    expect(firstOfficer.getStatusText()).toBe('Idle');
  });

  it('writeAutoEscalationComm() writes auto-escalation comm', async () => {
    await firstOfficer.writeAutoEscalationComm({
      crewId: CREW_ID,
      missionId,
      classification: 'persistent',
      fingerprint: 'abc123def456',
      summary: 'Test failure',
      errorText: 'Error: test failed'
    });

    const comms = rawDb
      .prepare("SELECT * FROM comms WHERE type = 'memo' AND mission_id = ?")
      .all(missionId) as Array<{ payload: string }>;

    expect(comms.length).toBe(1);
    const payload = JSON.parse(comms[0].payload);
    expect(payload.classification).toBe('persistent');
    expect(payload.fingerprint).toBe('abc123def456');
    expect(payload.eventType).toBe('auto-escalation');
  });

  it('writeHailingMemo() uses analyst context when analyst is provided and succeeds', async () => {
    const mockAnalyst = {
      // eslint-disable-next-line @typescript-eslint/require-await
      writeHailingContext: async () =>
        'The crew is waiting for a decision on authentication strategy. Check if the question requires a policy decision. Respond via the Admiral interface.'
    };

    const foWithAnalyst = new FirstOfficer({
      db: rawDb,
      configService,
      missionService,
      cargoService,
      crewService: {
        recallCrew: () => {},
        deployCrew: () => ({ crewId: 'replacement', missionId }),
        deleteCrew: () => {},
        observeCrew: () => null
      } as any,
      analyst: mockAnalyst as any,
      shipsLog: new ShipsLog(rawDb),
      starbaseId: db.getStarbaseId()
    });

    await foWithAnalyst.writeHailingMemo({
      crewId: CREW_ID,
      missionId,
      sectorName: 'api',
      payload: JSON.stringify({ message: 'Should I use JWT or OAuth?' }),
      createdAt: new Date().toISOString()
    });

    const comms = rawDb
      .prepare("SELECT * FROM comms WHERE type = 'hailing-memo' AND mission_id = ?")
      .all(missionId) as Array<{ payload: string }>;

    expect(comms.length).toBe(1);
    const { filePath } = JSON.parse(comms[0].payload) as { filePath: string };
    const { readFileSync } = await import('fs');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('The crew is waiting for a decision on authentication strategy');
    expect(content).not.toContain('over 60 seconds');
  });

  it('writeHailingMemo() falls back to template when analyst returns null', async () => {
    const mockAnalyst = {
      // eslint-disable-next-line @typescript-eslint/require-await
      writeHailingContext: async () => null
    };

    const foWithAnalyst = new FirstOfficer({
      db: rawDb,
      configService,
      missionService,
      cargoService,
      crewService: {
        recallCrew: () => {},
        deployCrew: () => ({ crewId: 'replacement', missionId }),
        deleteCrew: () => {},
        observeCrew: () => null
      } as any,
      analyst: mockAnalyst as any,
      shipsLog: new ShipsLog(rawDb),
      starbaseId: db.getStarbaseId()
    });

    await foWithAnalyst.writeHailingMemo({
      crewId: CREW_ID,
      missionId,
      sectorName: 'api',
      payload: JSON.stringify({ message: 'Should I use JWT or OAuth?' }),
      createdAt: new Date().toISOString()
    });

    const comms = rawDb
      .prepare("SELECT * FROM comms WHERE type = 'hailing-memo' AND mission_id = ?")
      .all(missionId) as Array<{ payload: string }>;

    expect(comms.length).toBe(1);
    const { filePath } = JSON.parse(comms[0].payload) as { filePath: string };
    const { readFileSync } = await import('fs');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('over 60 seconds');
  });

  it('logs first_officer_dismissed to ships_log on escalation', async () => {
    const shipsLog = new ShipsLog(rawDb);
    const fo = new FirstOfficer({
      db: rawDb,
      configService,
      missionService,
      cargoService,
      crewService: {
        recallCrew: () => {},
        deployCrew: () => ({ crewId: 'replacement', missionId }),
        deleteCrew: () => {},
        observeCrew: () => null
      } as any,
      starbaseId: db.getStarbaseId(),
      shipsLog
    });

    // Trigger max-retries escalation path (no claude spawn needed)
    const maxRetries = configService.get('first_officer_max_retries') as number;
    const event = makeEvent({ retryCount: maxRetries });
    await fo.dispatch(event);

    const entries = shipsLog.query({ eventType: 'first_officer_dismissed' });
    expect(entries).toHaveLength(1);
    expect(entries[0].crew_id).toBe(CREW_ID);
    const detail = JSON.parse(entries[0].detail!);
    expect(detail.missionId).toBe(missionId);
  });

  it('falls back to escalate-and-dismiss when decision payload is invalid', () => {
    const decision = (firstOfficer as any).parseDecision('not-json', makeEvent());
    expect(decision.decision).toBe('escalate-and-dismiss');
  });

  it('normalizes a recover-and-dismiss decision payload', () => {
    const decision = (firstOfficer as any).parseDecision(
      JSON.stringify({
        decision: 'recover-and-dismiss',
        reason: 'useful partial output',
        salvage: {
          shouldCreateCargo: true,
          title: 'Recovered notes',
          contentMarkdown: '# Notes',
          sourceKinds: ['crew-output'],
          summary: 'Recovered summary'
        }
      }),
      makeEvent()
    );

    expect(decision.decision).toBe('recover-and-dismiss');
    expect(decision.salvage.shouldCreateCargo).toBe(true);
    expect(decision.salvage.title).toBe('Recovered notes');
  });
});
