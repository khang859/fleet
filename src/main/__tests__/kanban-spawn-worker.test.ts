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
      logPath: join(ROOT, 'abc.log'),
      mode: 'work'
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
      logPath: join(ROOT, 'd.log'),
      mode: 'work'
    });
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('gpt-4');
  });

  it('writes the assigned profile to <workspace>/.rune/profiles/<name>.md', () => {
    const workspace = join(ROOT, 'ws3');
    mkdirSync(workspace, { recursive: true });
    buildWorkerInvocation({
      task: { id: 'p', title: 't', body: '', assignee: 'researcher', modelOverride: null },
      workspace,
      mcpPort: 1,
      runToken: 'x',
      logPath: join(ROOT, 'p.log'),
      mode: 'work',
      profile: {
        name: 'researcher',
        role: 'worker' as const,
        model: 'claude-opus-4-8',
        skills: ['docs'],
        instructions: 'Research.'
      }
    });
    const file = join(workspace, '.rune', 'profiles', 'researcher.md');
    expect(existsSync(file)).toBe(true);
    const md = readFileSync(file, 'utf-8');
    expect(md).toContain('name: researcher');
    expect(md).toContain('model: claude-opus-4-8');
    expect(md).toContain('skills: [docs]');
    expect(md).toContain('Research.');
  });

  it('writes no profiles dir when no profile is provided', () => {
    const workspace = join(ROOT, 'ws4');
    mkdirSync(workspace, { recursive: true });
    buildWorkerInvocation({
      task: { id: 'q', title: 't', body: '', assignee: null, modelOverride: null },
      workspace,
      mcpPort: 1,
      runToken: 'x',
      logPath: join(ROOT, 'q.log'),
      mode: 'work'
    });
    expect(existsSync(join(workspace, '.rune', 'profiles'))).toBe(false);
  });

  it('does not write a profile file when the profile name is invalid (path traversal guard)', () => {
    const workspace = join(ROOT, 'ws5');
    mkdirSync(workspace, { recursive: true });
    buildWorkerInvocation({
      task: { id: 'r', title: 't', body: '', assignee: 'x', modelOverride: null },
      workspace,
      mcpPort: 1,
      runToken: 'x',
      logPath: join(ROOT, 'r.log'),
      mode: 'work',
      profile: { name: '../evil', role: 'worker' as const, model: '', skills: [], instructions: 'b' }
    });
    expect(existsSync(join(workspace, '.rune', 'profiles'))).toBe(false);
  });

  it('builds a decompose prompt with the worker roster and --profile orchestrator', () => {
    const workspace = join(ROOT, 'ws6');
    mkdirSync(workspace, { recursive: true });
    const inv = buildWorkerInvocation({
      task: { id: 't1', title: 'big', body: 'do everything', assignee: null, modelOverride: null },
      workspace,
      mcpPort: 1234,
      runToken: 'tok',
      logPath: join(ROOT, 'r.log'),
      mode: 'decompose',
      profile: { name: 'orchestrator', role: 'orchestrator', model: '', skills: [], instructions: 'route' },
      roster: [{ name: 'coder', description: 'writes code' }]
    });
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toMatch(/decompose/i);
    expect(prompt).toContain('coder: writes code');
    expect(prompt).toContain('kanban_create');
    expect(prompt).toContain('kanban_complete');
    expect(prompt).toMatch(/do not implement/i);
    expect(inv.args).toContain('--profile');
    expect(inv.args[inv.args.indexOf('--profile') + 1]).toBe('orchestrator');
  });

  it('builds a specify prompt that says not to create child tasks', () => {
    const workspace = join(ROOT, 'ws7');
    mkdirSync(workspace, { recursive: true });
    const inv = buildWorkerInvocation({
      task: { id: 't2', title: 'vague', body: 'x', assignee: null, modelOverride: null },
      workspace,
      mcpPort: 1234,
      runToken: 'tok',
      logPath: join(ROOT, 'r.log'),
      mode: 'specify',
      profile: { name: 'orchestrator', role: 'orchestrator', model: '', skills: [], instructions: 'route' }
    });
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toMatch(/kanban_update/);
    expect(prompt).toMatch(/do not create child/i);
  });

  it('builds the normal work prompt for mode work', () => {
    const workspace = join(ROOT, 'ws8');
    mkdirSync(workspace, { recursive: true });
    const inv = buildWorkerInvocation({
      task: { id: 't3', title: 'fix', body: 'bug', assignee: 'default', modelOverride: null },
      workspace,
      mcpPort: 1234,
      runToken: 'tok',
      logPath: join(ROOT, 'r.log'),
      mode: 'work'
    });
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toMatch(/^work kanban task t3/);
    expect(inv.args[inv.args.indexOf('--profile') + 1]).toBe('default');
  });
});
