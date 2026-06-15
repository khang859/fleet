import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerLearningsMcp, learningsMcpEntry } from '../learnings/learnings-mcp-registrar';

const TEST_DIR = join(tmpdir(), `fleet-learnings-registrar-test-${Date.now()}`);
const claudeJsonPath = join(TEST_DIR, '.claude.json');
const runeMcpPath = join(TEST_DIR, '.rune', 'mcp.json');

const readJson = (p: string): Record<string, any> => JSON.parse(readFileSync(p, 'utf-8'));

describe('registerLearningsMcp', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('creates entries in both configs and exposes the live entry', () => {
    registerLearningsMcp(49823, { claudeJsonPath, runeMcpPath });

    expect(readJson(claudeJsonPath).mcpServers['fleet-learnings']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:49823/mcp'
    });
    expect(readJson(runeMcpPath).servers['fleet-learnings']).toEqual({
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
    mkdirSync(join(TEST_DIR, '.rune'), { recursive: true });
    writeFileSync(
      runeMcpPath,
      JSON.stringify({
        servers: { context7: { type: 'http', url: 'https://x', headers: { KEY: 'secret' } } }
      })
    );

    registerLearningsMcp(49823, { claudeJsonPath, runeMcpPath });

    const claude = readJson(claudeJsonPath);
    expect(claude.numStartups).toBe(7);
    expect(claude.mcpServers.context7).toBeDefined();
    expect(claude.mcpServers['fleet-learnings']).toBeDefined();

    const rune = readJson(runeMcpPath);
    expect(rune.servers.context7.headers.KEY).toBe('secret');
    expect(rune.servers['fleet-learnings']).toBeDefined();
  });

  it('rewrites the entry when the port changes', () => {
    registerLearningsMcp(49823, { claudeJsonPath, runeMcpPath });
    registerLearningsMcp(50000, { claudeJsonPath, runeMcpPath });
    expect(readJson(claudeJsonPath).mcpServers['fleet-learnings'].url).toBe(
      'http://127.0.0.1:50000/mcp'
    );
  });

  it('refuses to overwrite an unparseable config', () => {
    writeFileSync(claudeJsonPath, '{ this is not json');
    registerLearningsMcp(49823, { claudeJsonPath, runeMcpPath });
    // Left intact; rune (valid/missing) still gets written.
    expect(readFileSync(claudeJsonPath, 'utf-8')).toBe('{ this is not json');
    expect(existsSync(runeMcpPath)).toBe(true);
  });
});
