import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_HOME, checkoutRoot } from '../shared/fleet-home';

/** What a new sandbox starts with: settings and saved keys. Never jobs, panes or history. */
const SEED_FILES = [
  'fleet-settings.json',
  'fleet-chat-secrets.json',
  'fleet-agent-mcp-secrets.json',
  'fleet-env-sync-secrets.json'
];

/** What a Fleet pane tells the programs in it about the Fleet it belongs to. */
const PANE_ENV = [
  'FLEET_SESSION',
  'FLEET_PANE_ID',
  'FLEET_COPILOT_SOCKET',
  'FLEET_BRIDGE_SOCKET',
  'FLEET_HOOK_BIN',
  'FLEET_CLI'
];

/**
 * Give a dev build its own Electron data folder inside its checkout's
 * `FLEET_HOME`, so its settings, saved panes and browser storage are apart
 * from the installed app's and from every other checkout's. A new sandbox
 * copies the installed app's settings once. Runs before the first store opens.
 */
export function enterDevSandbox(): void {
  const releaseData = join(app.getPath('appData'), 'Fleet');
  const devData = join(FLEET_HOME, 'electron');

  if (!existsSync(devData)) {
    mkdirSync(devData, { recursive: true });
    for (const file of SEED_FILES) {
      const from = join(releaseData, file);
      if (existsSync(from)) copyFileSync(from, join(devData, file));
    }
    // Names the checkout, so a stale sandbox can be told apart and deleted.
    writeFileSync(join(FLEET_HOME, 'checkout'), `${checkoutRoot()}\n`);
  }

  // Started from another Fleet's pane, this app would hand that pane's names
  // to what it runs outside its own panes, and their hooks would report there.
  for (const key of PANE_ENV) delete process.env[key];

  app.setPath('userData', devData);
  app.setPath('sessionData', devData);
}
