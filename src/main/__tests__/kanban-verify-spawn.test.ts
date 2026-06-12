import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnVerify, buildVerifyScript } from '../kanban/spawn-worker';

const TEST_DIR = join(tmpdir(), `fleet-verify-spawn-${Date.now()}`);

describe('buildVerifyScript', () => {
  it('chains commands with markers and stop-on-first-failure semantics', () => {
    const script = buildVerifyScript([
      { label: 'typecheck', command: 'echo tc' },
      { label: 'tests', command: 'echo te' }
    ]);
    expect(script).toContain('=== verify: typecheck ===');
    expect(script).toContain('=== verify: tests ===');
    expect(script).toContain('&&'); // failure short-circuits the chain
  });

  it("escapes single quotes in labels", () => {
    const script = buildVerifyScript([{ label: "it's quick", command: 'true' }]);
    expect(script).toContain(`'=== verify: it'\\''s quick ==='`);
  });
});

describe('spawnVerify', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('runs commands, writes the log, and exits 0 on success', async () => {
    const logPath = join(TEST_DIR, 'ok.log');
    const code = await new Promise<number | null>((res) => {
      spawnVerify(
        { workspace: TEST_DIR, commands: [{ label: 'one', command: 'true' }], logPath },
        (exit) => res(exit.code)
      );
    });
    expect(code).toBe(0);
    expect(readFileSync(logPath, 'utf-8')).toContain('=== verify: one ===');
  });

  it('stops at the first failing command and exits non-zero', async () => {
    const logPath = join(TEST_DIR, 'fail.log');
    const code = await new Promise<number | null>((res) => {
      spawnVerify(
        {
          workspace: TEST_DIR,
          commands: [
            { label: 'first', command: 'false' },
            { label: 'second', command: 'echo SHOULD_NOT_RUN' }
          ],
          logPath
        },
        (exit) => res(exit.code)
      );
    });
    expect(code).not.toBe(0);
    expect(readFileSync(logPath, 'utf-8')).not.toContain('SHOULD_NOT_RUN');
  });
});
