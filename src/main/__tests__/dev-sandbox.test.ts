import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as FleetHome from '../../shared/fleet-home';

const paths = vi.hoisted(() => ({ root: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (): string => join(paths.root, 'appData'),
    setPath: vi.fn()
  }
}));

vi.mock('../../shared/fleet-home', async (importOriginal) => ({
  ...(await importOriginal<typeof FleetHome>()),
  get FLEET_HOME(): string {
    return join(paths.root, 'home');
  }
}));

const { app } = await import('electron');
const { enterDevSandbox } = await import('../dev-sandbox');

beforeEach(() => {
  paths.root = mkdtempSync(join(tmpdir(), 'fleet-dev-sandbox-'));
  const release = join(paths.root, 'appData', 'Fleet');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, 'fleet-settings.json'), '{"theme":"dark"}');
  writeFileSync(join(release, 'fleet-layouts.json'), '{}');
});

afterEach(() => {
  rmSync(paths.root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('enterDevSandbox', () => {
  it('copies settings into its own data folder, but not saved panes', () => {
    enterDevSandbox();

    const devData = join(paths.root, 'home', 'electron');
    expect(readFileSync(join(devData, 'fleet-settings.json'), 'utf8')).toBe('{"theme":"dark"}');
    expect(existsSync(join(devData, 'fleet-layouts.json'))).toBe(false);
    expect(app.setPath).toHaveBeenCalledWith('userData', devData);
  });

  it('drops the names of the Fleet pane it was started from', () => {
    vi.stubEnv('FLEET_PANE_ID', 'outer-pane');
    vi.stubEnv('FLEET_COPILOT_SOCKET', '/outer/fleet-copilot.sock');
    vi.stubEnv('PATH', '/bin');

    enterDevSandbox();

    expect(process.env.FLEET_PANE_ID).toBeUndefined();
    expect(process.env.FLEET_COPILOT_SOCKET).toBeUndefined();
    expect(process.env.PATH).toBe('/bin');
  });
});
