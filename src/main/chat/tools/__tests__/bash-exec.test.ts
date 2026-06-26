import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { scrubEnv, runBash } from '../bash-exec';

describe('scrubEnv', () => {
  it('removes likely-secret variables', () => {
    const out = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      AWS_SECRET_ACCESS_KEY: 'x',
      OPENAI_API_KEY: 'y',
      GITHUB_TOKEN: 'z',
      DB_PASSWORD: 'p'
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/u');
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.DB_PASSWORD).toBeUndefined();
  });
});

describe('runBash', () => {
  it.skipIf(process.platform === 'win32')('captures stdout and exit code', async () => {
    const res = await runBash({ command: 'echo hello', cwd: tmpdir() });
    expect(res.stdout.trim()).toBe('hello');
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('reports a non-zero exit code', async () => {
    const res = await runBash({ command: 'exit 3', cwd: tmpdir() });
    expect(res.exitCode).toBe(3);
  });
});
