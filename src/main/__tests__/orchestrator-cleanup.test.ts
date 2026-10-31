import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeOrchestratorData } from '../orchestrator-cleanup';

describe('removeOrchestratorData', () => {
  let sessionsDir: string;

  const settings = { dropOrchestrator: vi.fn() };
  const run = async (): Promise<void> => removeOrchestratorData({ sessionsDir, settings });

  beforeEach(() => {
    vi.clearAllMocks();
    sessionsDir = mkdtempSync(join(tmpdir(), 'orchestrator-cleanup-'));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('deletes the ledgers and keeps the chats', async () => {
    writeFileSync(join(sessionsDir, 'chat.jsonl'), '{"t":"session"}\n');
    writeFileSync(join(sessionsDir, 'chat.fleet.json'), '{}');

    await run();

    expect(readdirSync(sessionsDir)).toEqual(['chat.jsonl']);
    expect(settings.dropOrchestrator).toHaveBeenCalledOnce();
  });

  it('finds nothing to do the second time', async () => {
    writeFileSync(join(sessionsDir, 'chat.fleet.json'), '{}');

    await run();
    await run();

    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  it('still drops the setting when there is no sessions folder', async () => {
    rmSync(sessionsDir, { recursive: true });

    await run();

    expect(existsSync(sessionsDir)).toBe(false);
    expect(settings.dropOrchestrator).toHaveBeenCalledOnce();
  });
});
