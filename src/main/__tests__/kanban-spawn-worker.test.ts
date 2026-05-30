import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildWorkerInvocation } from '../kanban/spawn-worker';

const ROOT = join(tmpdir(), `fleet-kanban-spawn-test-${Date.now()}`);

describe('buildWorkerInvocation', () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it('builds rune --prompt args with the profile and writes a scoped mcp.json', () => {
    const workspace = join(ROOT, 'ws');
    mkdirSync(workspace, { recursive: true });
    const inv = buildWorkerInvocation({
      task: {
        id: 'abc',
        title: 'Do X',
        body: 'details',
        assignee: 'researcher',
        modelOverride: null
      },
      workspace,
      mcpPort: 5599,
      runToken: 'tok-abc',
      logPath: join(ROOT, 'abc.log')
    });

    expect(inv.command).toBe('rune');
    expect(inv.args).toContain('--prompt');
    expect(inv.args).toContain('--profile');
    expect(inv.args).toContain('researcher');
    expect(inv.env.RUNE_MCP_CONFIG).toBe(join(workspace, '.rune', 'mcp.json'));
    expect(inv.env.FLEET_KANBAN_TASK).toBe('abc');

    const cfg = JSON.parse(readFileSync(join(workspace, '.rune', 'mcp.json'), 'utf-8'));
    expect(cfg.servers.kanban.url).toBe('http://127.0.0.1:5599/mcp?run=tok-abc');
    expect(cfg.servers.kanban.type).toBe('http');
    expect(existsSync(join(workspace, '.rune', 'mcp.json'))).toBe(true);
  });

  it('adds --model when a model override is set', () => {
    const workspace = join(ROOT, 'ws2');
    mkdirSync(workspace, { recursive: true });
    const inv = buildWorkerInvocation({
      task: { id: 'd', title: 't', body: '', assignee: 'r', modelOverride: 'gpt-4' },
      workspace,
      mcpPort: 1,
      runToken: 'x',
      logPath: join(ROOT, 'd.log')
    });
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('gpt-4');
  });
});
