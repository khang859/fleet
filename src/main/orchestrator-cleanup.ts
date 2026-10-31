import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const LEDGER_SUFFIX = '.fleet.json';

type Deps = {
  sessionsDir: string;
  settings: { dropOrchestrator: () => void };
};

/**
 * Remove what the Orchestrator left behind. It finds nothing to do from the
 * second start on, so it needs no marker to run once.
 */
export async function removeOrchestratorData({ sessionsDir, settings }: Deps): Promise<void> {
  settings.dropOrchestrator();
  if (!existsSync(sessionsDir)) return;

  const ledgers = readdirSync(sessionsDir).filter((name) => name.endsWith(LEDGER_SUFFIX));
  for (const name of ledgers) {
    await rm(join(sessionsDir, name), { force: true });
  }
}
