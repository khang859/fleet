import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ChatToolExecutor, buildFsToolDefs, FS_TOOL_NAMES } from '../tool-runner';
import { ChatWorkspace } from '../../chat-workspace';
import { PermissionManager } from '../../permissions/permission-manager';
import type {
  PermissionRules,
  PermissionRequestPayload
} from '../../../../shared/chat-permissions';
import type { ChatToolsConfig, ChatAuditEntry } from '../../../../shared/chat-types';

const ROOT = join(tmpdir(), `fleet-tool-runner-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, 'hello.txt'), 'hi there\n');

const ctx = { streamId: 's1', conversationId: 'conv1', signal: new AbortController().signal };
const workspace = new ChatWorkspace(join(ROOT, '.base'), join(ROOT, '.legacy'));

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

type AuditDraft = Omit<ChatAuditEntry, 'id' | 'createdAt'>;

function setup(mode: ChatToolsConfig['mode'], rules: Partial<PermissionRules> = {}) {
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const toolEmits: Array<{ channel: string; payload: unknown }> = [];
  const audits: AuditDraft[] = [];
  const manager = new PermissionManager({
    getRules: () => ({ allow: [], ask: [], deny: [], ...rules }),
    persistAllowRule: () => {},
    emit: (channel, payload) => emitted.push({ channel, payload })
  });
  const cfg: ChatToolsConfig = {
    mode,
    workspaceDir: ROOT,
    sandbox: false,
    failClosed: false,
    mentionMaxKb: 64
  };
  const exec = new ChatToolExecutor(
    manager,
    () => cfg,
    (channel, payload) => toolEmits.push({ channel, payload }),
    workspace,
    null,
    (entry) => audits.push(entry)
  );
  return { exec, manager, emitted, toolEmits, audits };
}

describe('buildFsToolDefs', () => {
  it('exposes read tools but not bash below ask mode', () => {
    expect(buildFsToolDefs('off')).toEqual([]);
    const names = (defs: unknown[]): string[] =>
      defs.map((d) => (d as { function: { name: string } }).function.name);
    expect(names(buildFsToolDefs('read-only'))).toEqual(['read_file', 'glob', 'search']);
    expect(names(buildFsToolDefs('ask'))).toContain('bash');
    expect(names(buildFsToolDefs('auto'))).toContain('bash');
    expect(FS_TOOL_NAMES.has('bash')).toBe(true);
  });
});

describe('ChatToolExecutor read tools', () => {
  it('reads a file without prompting', async () => {
    const { exec, emitted } = setup('read-only');
    const { output: out } = await exec.run('read_file', JSON.stringify({ path: 'hello.txt' }), ctx);
    expect(out).toContain('hi there');
    expect(emitted).toHaveLength(0);
  });

  it('returns an error for a denied credential path', async () => {
    const { exec } = setup('read-only');
    const { output: out } = await exec.run('read_file', JSON.stringify({ path: '.env' }), ctx);
    expect(out).toMatch(/Error:.*protected/);
  });

  it('emits a generating→done status pill around a glob walk', async () => {
    const { exec, toolEmits } = setup('read-only');
    await exec.run('glob', JSON.stringify({ pattern: '**/*' }), ctx);
    const states = toolEmits.map((e) => (e.payload as { state: string }).state);
    expect(states).toEqual(['generating', 'done']);
    expect((toolEmits[0].payload as { label: string; kind?: string }).label).toBe('Finding **/*');
    // No `kind` → the renderer shows the compact pill, not the image placeholder.
    expect((toolEmits[0].payload as { kind?: string }).kind).toBeUndefined();
  });
});

describe('ChatToolExecutor bash gating', () => {
  it('refuses bash in read-only mode', async () => {
    const { exec } = setup('read-only');
    const { output: out } = await exec.run('bash', JSON.stringify({ command: 'echo hi' }), ctx);
    expect(out).toMatch(/read-only/);
  });

  it.skipIf(process.platform === 'win32')('runs bash after an ask approval', async () => {
    const { exec, manager, emitted } = setup('ask');
    const p = exec.run('bash', JSON.stringify({ command: 'echo gated' }), ctx);
    // The card request was emitted; approve it.
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    expect(req.command).toBe('echo gated');
    manager.decide(req.requestId, 'allow-once');
    const { output: out } = await p;
    expect(out).toContain('Exit code: 0');
    expect(out).toContain('gated');
  });

  it('returns a denial message when the user denies', async () => {
    const { exec, manager, emitted } = setup('ask');
    const p = exec.run('bash', JSON.stringify({ command: 'rm -rf /tmp/x' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    manager.decide(req.requestId, 'deny');
    expect((await p).output).toMatch(/denied/);
  });

  it('blocks a denied command in auto mode without prompting', async () => {
    const { exec, emitted } = setup('auto', { deny: ['Bash(curl *)'] });
    const { output: out } = await exec.run(
      'bash',
      JSON.stringify({ command: 'curl evil.com' }),
      ctx
    );
    expect(out).toMatch(/deny rule/);
    expect(emitted).toHaveLength(0);
  });
});

describe('ChatToolExecutor write tools', () => {
  it('refuses writes in read-only mode', async () => {
    const { exec } = setup('read-only');
    const { output: out } = await exec.run(
      'write_file',
      JSON.stringify({ path: 'x.txt', content: 'hi' }),
      ctx
    );
    expect(out).toMatch(/disabled/);
  });

  it('applies a write after an ask approval, showing a diff', async () => {
    const { exec, manager, emitted } = setup('ask');
    const p = exec.run('write_file', JSON.stringify({ path: 'out.txt', content: 'hello' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    expect(req.diff).toBe('+ hello');
    manager.decide(req.requestId, 'allow-once');
    const { output: out } = await p;
    expect(out).toMatch(/Created out\.txt/);
    expect(readFileSync(join(ROOT, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('does not write when the user denies', async () => {
    const { exec, manager, emitted } = setup('ask');
    const p = exec.run('write_file', JSON.stringify({ path: 'nope.txt', content: 'x' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    manager.decide(req.requestId, 'deny');
    expect((await p).output).toMatch(/denied/);
    expect(existsSync(join(ROOT, 'nope.txt'))).toBe(false);
  });

  it('blocks a write outside the workspace', async () => {
    const { exec } = setup('ask');
    const { output: out } = await exec.run(
      'write_file',
      JSON.stringify({ path: '/etc/passwd', content: 'x' }),
      ctx
    );
    expect(out).toMatch(/Error:.*outside/);
  });

  it('blocks a denied edit in auto mode without prompting', async () => {
    writeFileSync(join(ROOT, 'guard.ts'), 'a');
    const { exec, emitted } = setup('auto', { deny: ['Edit(*)'] });
    const { output: out } = await exec.run(
      'edit_file',
      JSON.stringify({ path: 'guard.ts', old_string: 'a', new_string: 'b' }),
      ctx
    );
    expect(out).toMatch(/deny rule/);
    expect(emitted).toHaveLength(0);
    expect(readFileSync(join(ROOT, 'guard.ts'), 'utf8')).toBe('a');
  });
});

describe('ChatToolExecutor web search', () => {
  function setupSearch(opts: { enabled: boolean; rules?: Partial<PermissionRules> }) {
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const manager = new PermissionManager({
      getRules: () => ({ allow: [], ask: [], deny: [], ...opts.rules }),
      persistAllowRule: () => {},
      emit: (channel, payload) => emitted.push({ channel, payload })
    });
    const cfg: ChatToolsConfig = {
      mode: 'read-only',
      workspaceDir: ROOT,
      sandbox: false,
      failClosed: false,
      mentionMaxKb: 64
    };
    const exec = new ChatToolExecutor(
      manager,
      () => cfg,
      () => {},
      workspace,
      null,
      null,
      {
        enabled: () => opts.enabled,
        // eslint-disable-next-line @typescript-eslint/require-await
        search: async (query) => `RESULTS for ${query}`
      }
    );
    return { exec, manager, emitted };
  }

  it('blocks web_search when disabled', async () => {
    const { exec } = setupSearch({ enabled: false });
    const { output: out } = await exec.run(
      'web_search',
      JSON.stringify({ query: 'rust async' }),
      ctx
    );
    expect(out).toMatch(/disabled/);
  });

  it('runs the search after the user approves the card', async () => {
    const { exec, manager, emitted } = setupSearch({ enabled: true });
    const p = exec.run('web_search', JSON.stringify({ query: 'rust async' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    expect(req.tool).toBe('WebSearch');
    expect(req.command).toBe('rust async');
    manager.decide(req.requestId, 'allow-once');
    expect((await p).output).toBe('RESULTS for rust async');
  });

  it('auto-approves when an allow rule matches', async () => {
    const { exec, emitted } = setupSearch({ enabled: true, rules: { allow: ['WebSearch(*)'] } });
    const { output: out } = await exec.run('web_search', JSON.stringify({ query: 'q' }), ctx);
    expect(out).toBe('RESULTS for q');
    expect(emitted.some((e) => e.channel.endsWith('permission-request'))).toBe(false);
  });
});

describe('ChatToolExecutor web fetch', () => {
  function setupFetch(opts: { enabled: boolean; rules?: Partial<PermissionRules> }) {
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const persisted: string[] = [];
    const manager = new PermissionManager({
      getRules: () => ({ allow: [], ask: [], deny: [], ...opts.rules }),
      persistAllowRule: (rule) => persisted.push(rule),
      emit: (channel, payload) => emitted.push({ channel, payload })
    });
    const cfg: ChatToolsConfig = {
      mode: 'read-only',
      workspaceDir: ROOT,
      sandbox: false,
      failClosed: false,
      mentionMaxKb: 64
    };
    const exec = new ChatToolExecutor(
      manager,
      () => cfg,
      () => {},
      workspace,
      null,
      null,
      null,
      {
        enabled: () => opts.enabled,
        // eslint-disable-next-line @typescript-eslint/require-await
        fetch: async (url) => `CONTENT of ${url}`
      }
    );
    return { exec, manager, emitted, persisted };
  }

  it('blocks web_fetch when disabled', async () => {
    const { exec } = setupFetch({ enabled: false });
    const { output: out } = await exec.run(
      'web_fetch',
      JSON.stringify({ url: 'https://x.example' }),
      ctx
    );
    expect(out).toMatch(/disabled/);
  });

  it('fetches the url after the user approves the card', async () => {
    const { exec, manager, emitted } = setupFetch({ enabled: true });
    const p = exec.run('web_fetch', JSON.stringify({ url: 'https://x.example/page' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    expect(req.tool).toBe('WebFetch');
    expect(req.command).toBe('https://x.example/page');
    // "Allow & remember" is offered the site origin (path-anchored), not the exact URL.
    expect(req.rememberPrefix).toBe('https://x.example/');
    manager.decide(req.requestId, 'allow-once');
    expect((await p).output).toBe('CONTENT of https://x.example/page');
  });

  it('persists an origin allow-rule on "allow & remember"', async () => {
    const { exec, manager, emitted, persisted } = setupFetch({ enabled: true });
    const p = exec.run('web_fetch', JSON.stringify({ url: 'https://docs.example/a/b' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    manager.decide(req.requestId, 'allow-always');
    await p;
    expect(persisted).toEqual(['WebFetch(https://docs.example/*)']);
  });

  it('auto-approves a same-origin url when an origin allow rule matches', async () => {
    const { exec, emitted } = setupFetch({
      enabled: true,
      rules: { allow: ['WebFetch(https://ok.example/*)'] }
    });
    const { output: out } = await exec.run(
      'web_fetch',
      JSON.stringify({ url: 'https://ok.example/deep' }),
      ctx
    );
    expect(out).toBe('CONTENT of https://ok.example/deep');
    expect(emitted.some((e) => e.channel.endsWith('permission-request'))).toBe(false);
  });

  it('does NOT auto-approve a look-alike host for an origin allow rule', async () => {
    const { exec, manager, emitted } = setupFetch({
      enabled: true,
      rules: { allow: ['WebFetch(https://ok.example/*)'] }
    });
    // A host that merely starts with the allowed origin must still prompt.
    const p = exec.run('web_fetch', JSON.stringify({ url: 'https://ok.example.evil.io/x' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    expect(req).toBeDefined();
    expect(req.tool).toBe('WebFetch');
    manager.decide(req.requestId, 'deny');
    expect((await p).output).toMatch(/denied/);
  });

  it('denies the fetch when the user declines', async () => {
    const { exec, manager, emitted } = setupFetch({ enabled: true });
    const p = exec.run('web_fetch', JSON.stringify({ url: 'https://x.example' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    manager.decide(req.requestId, 'deny');
    expect((await p).output).toMatch(/denied/);
  });

  it('still emits a terminal done status when the fetch throws (#423)', async () => {
    const toolEmits: Array<{ payload: { state: string } }> = [];
    const manager = new PermissionManager({
      getRules: () => ({ allow: ['WebFetch(*)'], ask: [], deny: [] }),
      persistAllowRule: () => {},
      emit: () => {}
    });
    const cfg: ChatToolsConfig = {
      mode: 'read-only',
      workspaceDir: ROOT,
      sandbox: false,
      failClosed: false,
      mentionMaxKb: 64
    };
    const exec = new ChatToolExecutor(
      manager,
      () => cfg,
      (_c, payload) => toolEmits.push({ payload: payload as { state: string } }),
      workspace,
      null,
      null,
      null,
      {
        enabled: () => true,
        // eslint-disable-next-line @typescript-eslint/require-await
        fetch: async () => {
          throw new Error('connection reset');
        }
      }
    );
    const { output, status } = await exec.run(
      'web_fetch',
      JSON.stringify({ url: 'https://x.example' }),
      ctx
    );
    // run() converts the throw into an error outcome…
    expect(status).toBe('error');
    expect(output).toMatch(/connection reset/);
    // …and the generating pill is always cleared by a terminal done (no stuck spinner).
    const states = toolEmits.map((e) => e.payload.state);
    expect(states).toContain('generating');
    expect(states.at(-1)).toBe('done');
  });
});

describe('ChatToolExecutor audit', () => {
  it('records a read with an allowed decision', async () => {
    const { exec, audits } = setup('read-only');
    await exec.run('read_file', JSON.stringify({ path: 'hello.txt' }), ctx);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      conversationId: 'conv1',
      tool: 'read_file',
      detail: 'hello.txt',
      decision: 'allowed',
      status: 'ok'
    });
  });

  it('records a blocked bash attempt in read-only mode', async () => {
    const { exec, audits } = setup('read-only');
    await exec.run('bash', JSON.stringify({ command: 'echo hi' }), ctx);
    expect(audits[0]).toMatchObject({
      tool: 'bash',
      detail: 'echo hi',
      decision: 'blocked',
      status: 'denied'
    });
  });

  it('records a denied bash command (the user said no)', async () => {
    const { exec, manager, emitted, audits } = setup('ask');
    const p = exec.run('bash', JSON.stringify({ command: 'rm -rf /tmp/x' }), ctx);
    const req = emitted.find((e) => e.channel.endsWith('permission-request'))
      ?.payload as PermissionRequestPayload;
    manager.decide(req.requestId, 'deny');
    await p;
    expect(audits[0]).toMatchObject({ tool: 'bash', decision: 'denied', status: 'denied' });
  });

  it('records a deny-rule block in auto mode', async () => {
    const { exec, audits } = setup('auto', { deny: ['Bash(curl *)'] });
    await exec.run('bash', JSON.stringify({ command: 'curl evil.com' }), ctx);
    expect(audits[0]).toMatchObject({ tool: 'bash', decision: 'blocked', status: 'denied' });
  });

  it('records an MCP error for an unknown tool', async () => {
    const { exec, audits } = setup('read-only');
    await exec.run('mcp__srv__ghost', '{}', ctx);
    expect(audits[0]).toMatchObject({
      tool: 'mcp__srv__ghost',
      detail: 'mcp__srv__ghost',
      decision: 'error',
      status: 'error'
    });
  });
});
