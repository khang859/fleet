import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  registerLearningsMcp,
  learningsMcpEntry,
  loadPreferredPort,
  persistPort
} from '../learnings/learnings-mcp-registrar';

const TEST_DIR = join(tmpdir(), `fleet-learnings-registrar-test-${Date.now()}`);
const claudeJsonPath = join(TEST_DIR, '.claude.json');

const readJson = (p: string): Record<string, any> => JSON.parse(readFileSync(p, 'utf-8'));

describe('registerLearningsMcp', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('creates the entry and exposes the live entry', () => {
    registerLearningsMcp(49823, { claudeJsonPath });

    expect(readJson(claudeJsonPath).mcpServers['fleet-learnings']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:49823/mcp'
    });
    expect(learningsMcpEntry()).toEqual({ type: 'http', url: 'http://127.0.0.1:49823/mcp' });
  });

  it('preserves existing servers and other keys (never clobbers user config)', () => {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        numStartups: 7,
        mcpServers: { context7: { type: 'http', url: 'https://example.com/mcp' } }
      })
    );

    registerLearningsMcp(49823, { claudeJsonPath });

    const claude = readJson(claudeJsonPath);
    expect(claude.numStartups).toBe(7);
    expect(claude.mcpServers.context7).toBeDefined();
    expect(claude.mcpServers['fleet-learnings']).toBeDefined();
  });

  it('rewrites the entry when the port changes', () => {
    registerLearningsMcp(49823, { claudeJsonPath });
    registerLearningsMcp(50000, { claudeJsonPath });
    expect(readJson(claudeJsonPath).mcpServers['fleet-learnings'].url).toBe(
      'http://127.0.0.1:50000/mcp'
    );
  });

  it('refuses to overwrite an unparseable config', () => {
    writeFileSync(claudeJsonPath, '{ this is not json');
    registerLearningsMcp(49823, { claudeJsonPath });
    expect(readFileSync(claudeJsonPath, 'utf-8')).toBe('{ this is not json');
  });

  it('refuses to overwrite valid JSON that is not an object (array/scalar)', () => {
    // A non-object top-level value must be treated like unparseable, not silently
    // clobbered with `{}` — it could be a hand-rolled or other-tool config holding data.
    const arrayConfig = '[{"keep":true}]';
    writeFileSync(claudeJsonPath, arrayConfig);
    registerLearningsMcp(49823, { claudeJsonPath });
    expect(readFileSync(claudeJsonPath, 'utf-8')).toBe(arrayConfig);
  });

  it('preserves an existing secret when rewriting on a port change (atomic write)', () => {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        mcpServers: {
          context7: { type: 'http', url: 'https://x', headers: { KEY: 'ctx7sk-real' } }
        }
      })
    );
    registerLearningsMcp(49823, { claudeJsonPath });
    registerLearningsMcp(50000, { claudeJsonPath });
    const claude = readJson(claudeJsonPath);
    expect(claude.mcpServers.context7.headers.KEY).toBe('ctx7sk-real');
    expect(claude.mcpServers['fleet-learnings'].url).toBe('http://127.0.0.1:50000/mcp');
    // No temp file left behind by the atomic write.
    expect(existsSync(`${claudeJsonPath}.${process.pid}.tmp`)).toBe(false);
  });
});

describe('port persistence', () => {
  const portFile = join(TEST_DIR, 'mcp-port');
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('returns the fallback when no port has been persisted', () => {
    expect(loadPreferredPort(49823, portFile)).toBe(49823);
  });

  it('round-trips the persisted port so it is preferred next launch', () => {
    persistPort(51000, portFile);
    expect(loadPreferredPort(49823, portFile)).toBe(51000);
  });

  it('falls back when the persisted value is not a valid port', () => {
    writeFileSync(portFile, 'not-a-port');
    expect(loadPreferredPort(49823, portFile)).toBe(49823);
  });
});
