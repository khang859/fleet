import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeAdmiralData } from '../admiral-cleanup';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() })
}));

describe('removeAdmiralData', () => {
  let home: string;
  let sessionsDir: string;

  const layouts = { dropJobTabs: vi.fn() };
  const settings = { dropAgency: vi.fn() };
  const sessions = {
    delete: vi.fn((id: string) => {
      rmSync(join(sessionsDir, `${id}.jsonl`));
      return true;
    })
  };
  const run = async (): Promise<void> =>
    removeAdmiralData({ fleetHome: home, sessionsDir, sessions, layouts, settings });

  const writeSession = (id: string, header: object): void => {
    writeFileSync(join(sessionsDir, `${id}.jsonl`), `${JSON.stringify(header)}\n{"t":"message"}\n`);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    home = mkdtempSync(join(tmpdir(), 'admiral-cleanup-'));
    sessionsDir = join(home, 'agent', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('does nothing without an agency database', async () => {
    mkdirSync(join(home, 'crew'));
    writeSession('old', { t: 'session', scope: 'admiral' });

    await run();

    expect(existsSync(join(home, 'crew'))).toBe(true);
    expect(sessions.delete).not.toHaveBeenCalled();
    expect(layouts.dropJobTabs).not.toHaveBeenCalled();
  });

  it('removes the Admiral data and keeps the other sessions', async () => {
    writeFileSync(join(home, 'agency.db'), '');
    writeFileSync(join(home, 'agency.db-wal'), '');
    writeFileSync(join(home, 'agency.db-shm'), '');
    mkdirSync(join(home, 'agency', 'jobs'), { recursive: true });
    mkdirSync(join(home, 'crew'));
    writeSession('admiral', { t: 'session', scope: 'admiral' });
    writeSession('plain', { t: 'session' });
    writeFileSync(join(sessionsDir, 'broken.jsonl'), 'not json');

    await run();

    expect(readdirSync(sessionsDir).sort()).toEqual(['broken.jsonl', 'plain.jsonl']);
    expect(readdirSync(home)).toEqual(['agent']);
    expect(layouts.dropJobTabs).toHaveBeenCalledOnce();
    expect(settings.dropAgency).toHaveBeenCalledOnce();
  });

  it('clears what a window reads before the first await', async () => {
    writeFileSync(join(home, 'agency.db'), '');
    writeSession('admiral', { t: 'session', scope: 'admiral' });

    const done = run();

    expect(layouts.dropJobTabs).toHaveBeenCalledOnce();
    expect(sessions.delete).toHaveBeenCalledWith('admiral');
    await done;
  });

  it('keeps the database when a step fails, so the next start tries again', async () => {
    writeFileSync(join(home, 'agency.db'), '');
    settings.dropAgency.mockImplementationOnce(() => {
      throw new Error('settings file is locked');
    });

    await expect(run()).rejects.toThrow('settings file is locked');

    expect(existsSync(join(home, 'agency.db'))).toBe(true);
  });
});
