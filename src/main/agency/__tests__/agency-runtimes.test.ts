import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSignedIn } from '../crew/availability';
import { readEvaServer } from '../crew/eva-server';
import type { Captured } from '../exec';
import { AgencyService } from '../index';
import { REPO } from './fixture';

/** Settings › Agency › Crew › Runtimes, as main hands it to the renderer. */

const EVA_KEY = 'sk-or-v1-test-key-that-must-stay-in-eva';
const EMAIL = 'someone@example.com';

let dir: string;
let service: AgencyService;

/**
 * A pane's shell, run for real: a `claude` that prints its login, and eva's
 * settings with a key. It runs in the test's folder, as the fixture's
 * project folder is not on disk.
 */
async function shell(
  line: string,
  _cwd: string,
  env: Record<string, string> = {}
): Promise<Captured> {
  return new Promise((done) => {
    execFile(
      '/bin/sh',
      ['-c', line],
      { cwd: dir, env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir, ...env } },
      (err, stdout) => done({ code: err ? 1 : 0, stdout: stdout.trim() })
    );
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-runtimes-'));
  mkdirSync(join(dir, 'bin'));
  const claude = join(dir, 'bin', 'claude');
  writeFileSync(
    claude,
    `#!/bin/sh\nprintf '{\\n  "loggedIn": true,\\n  "authMethod": "claude.ai",\\n  "email": "${EMAIL}",\\n  "subscriptionType": "max"\\n}\\n'\n`
  );
  chmodSync(claude, 0o755);
  mkdirSync(join(dir, '.eva'));
  writeFileSync(
    join(dir, '.eva', 'config.toml'),
    `provider = "openrouter"\nmodel = "qwen/qwen3-coder"\napi_key = "${EVA_KEY}"\n`
  );
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    agencyHome: join(dir, 'home'),
    evaServer: async (cwd) => readEvaServer(cwd, shell),
    claudeSignedIn: async (cwd) => claudeSignedIn(cwd, {}, shell)
  });
  service.ensureLobby(REPO);
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('crewRuntimes', () => {
  it('says signed in and key set, and hands the renderer neither the login nor the key', async () => {
    const views = await service.crewRuntimes(REPO.repoId);

    expect(views.map((v) => [v.check.runtime, v.signedIn])).toEqual([
      ['claude', true],
      ['eva', true]
    ]);
    expect(views[1].server).toMatchObject({ provider: 'openrouter', model: 'qwen/qwen3-coder' });
    const sent = JSON.stringify(views);
    expect(sent).not.toContain(EVA_KEY);
    expect(sent).not.toContain(EMAIL);
    expect(sent).not.toContain('max');
  });

  it('gives each runtime its default crew at once', async () => {
    const views = await service.crewRuntimes(REPO.repoId);
    expect(views.map((v) => v.defaultAtOnce)).toEqual([2, 4]);
  });
});
