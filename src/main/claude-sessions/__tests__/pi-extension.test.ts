import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

import { ensurePiExtension, piAgentDir, removePiExtension } from '../pi-extension';

const TEXT = '// fleet-managed: v1\nexport default () => {};\n';

describe('pi extension installer', () => {
  let agentDir: string;
  let file: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'fleet-pi-'));
    file = join(agentDir, 'extensions', 'fleet.js');
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('honors PI_CODING_AGENT_DIR', () => {
    expect(piAgentDir({}, '/home/u')).toBe('/home/u/.pi/agent');
    expect(piAgentDir({ PI_CODING_AGENT_DIR: '/custom' }, '/home/u')).toBe('/custom');
  });

  it('writes the extension, and rewrites it when its text changed', () => {
    ensurePiExtension(agentDir, TEXT);
    expect(readFileSync(file, 'utf8')).toBe(TEXT);

    const next = TEXT.replace('v1', 'v2');
    ensurePiExtension(agentDir, next);
    expect(readFileSync(file, 'utf8')).toBe(next);
  });

  it('does nothing when Pi was never run', () => {
    const missing = join(agentDir, 'nope');
    ensurePiExtension(missing, TEXT);
    expect(existsSync(missing)).toBe(false);
  });

  it('leaves a file of the user alone, and says so', () => {
    mkdirSync(join(agentDir, 'extensions'));
    writeFileSync(file, 'export default () => {};\n');

    expect(() => ensurePiExtension(agentDir, TEXT)).toThrow(/not Fleet's/);
    removePiExtension(agentDir);
    expect(readFileSync(file, 'utf8')).toBe('export default () => {};\n');
  });

  it('removes its own file, and is fine when there is none', () => {
    ensurePiExtension(agentDir, TEXT);
    removePiExtension(agentDir);
    expect(existsSync(file)).toBe(false);
    expect(() => removePiExtension(agentDir)).not.toThrow();
  });
});
