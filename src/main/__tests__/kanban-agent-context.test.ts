import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  agentWslLocation,
  agentMcpConfigPosixPath,
  agentMcpUrl,
  buildAgentSpawn,
  detectWslNetworking,
  resolveAgentHost,
  agentHostFor,
  __clearAgentHostCache,
  type SyncExec
} from '../kanban/agent-context';

vi.mock('../wsl-service', () => ({ wslExePath: () => 'wsl.exe' }));

const DISTRO = 'Ubuntu-24.04';
const WSL_WS = `\\\\wsl.localhost\\${DISTRO}\\home\\khang\\.fleet\\kanban\\worktrees\\t1`;
const WSL_POSIX = '/home/khang/.fleet/kanban/worktrees/t1';

describe('agentWslLocation', () => {
  it('infers distro + posix path from a wsl.localhost UNC workspace', () => {
    expect(agentWslLocation(WSL_WS)).toEqual({ distro: DISTRO, posixCwd: WSL_POSIX });
  });
  it('infers from the legacy wsl$ UNC form', () => {
    expect(agentWslLocation(`\\\\wsl$\\${DISTRO}\\home\\k`)).toEqual({
      distro: DISTRO,
      posixCwd: '/home/k'
    });
  });
  it('returns null for native drive and posix paths', () => {
    expect(agentWslLocation('C:\\repos\\bar\\wt')).toBeNull();
    expect(agentWslLocation('/home/khang/native')).toBeNull();
  });
});

describe('agentMcpConfigPosixPath', () => {
  it('joins .rune/mcp.json onto the posix worktree path', () => {
    expect(agentMcpConfigPosixPath({ distro: DISTRO, posixCwd: WSL_POSIX })).toBe(
      `${WSL_POSIX}/.rune/mcp.json`
    );
  });
});

describe('agentMcpUrl', () => {
  it('builds the run-scoped URL with the resolved host', () => {
    expect(agentMcpUrl(5599, 'tok', '127.0.0.1')).toBe('http://127.0.0.1:5599/mcp?run=tok');
    expect(agentMcpUrl(5599, 'tok', '192.168.32.1')).toBe('http://192.168.32.1:5599/mcp?run=tok');
  });
});

describe('buildAgentSpawn', () => {
  it('passes a native invocation through unchanged', () => {
    const spec = {
      command: 'rune',
      args: ['--prompt', 'do it'],
      cwd: 'C:\\repos\\bar\\wt',
      env: { RUNE_MCP_CONFIG: 'C:\\repos\\bar\\wt\\.rune\\mcp.json' }
    };
    expect(buildAgentSpawn(spec, null)).toEqual({
      file: 'rune',
      argv: ['--prompt', 'do it'],
      cwd: 'C:\\repos\\bar\\wt',
      env: spec.env
    });
  });

  it('wraps a WSL invocation: --cd posixCwd, env inline, no inherited cwd', () => {
    const out = buildAgentSpawn(
      {
        command: 'rune',
        args: ['--prompt', 'do it', '--profile', 'p'],
        cwd: WSL_WS,
        env: { RUNE_MCP_CONFIG: `${WSL_POSIX}/.rune/mcp.json`, FLEET_KANBAN_TASK: 'abc' }
      },
      { distro: DISTRO, posixCwd: WSL_POSIX }
    );
    expect(out.file).toBe('wsl.exe');
    expect(out.cwd).toBeUndefined();
    expect(out.env).toEqual({});
    expect(out.argv).toEqual([
      '-d',
      DISTRO,
      '--cd',
      WSL_POSIX,
      '--exec',
      'env',
      `RUNE_MCP_CONFIG=${WSL_POSIX}/.rune/mcp.json`,
      'FLEET_KANBAN_TASK=abc',
      'rune',
      '--prompt',
      'do it',
      '--profile',
      'p'
    ]);
  });

  it('omits the env prefix when there are no env vars (verify run)', () => {
    const out = buildAgentSpawn(
      { command: 'sh', args: ['-c', 'npm test'], cwd: WSL_WS, env: {} },
      { distro: DISTRO, posixCwd: WSL_POSIX }
    );
    expect(out.argv).toEqual(['-d', DISTRO, '--cd', WSL_POSIX, '--exec', 'sh', '-c', 'npm test']);
  });
});

describe('detectWslNetworking', () => {
  it('reports mirrored and skips the gateway probe', () => {
    const exec = vi.fn().mockReturnValue('mirrored\n') as unknown as SyncExec;
    const net = detectWslNetworking(DISTRO, exec);
    expect(net).toEqual({ mode: 'mirrored', gatewayIp: null });
    // only the wslinfo call, no `ip route`
    expect((exec as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('reports nat with the default-route gateway IP', () => {
    const exec = vi.fn((_file: string, args: string[]) =>
      args.includes('wslinfo') ? 'nat\n' : '192.168.32.1\n'
    ) as unknown as SyncExec;
    expect(detectWslNetworking(DISTRO, exec)).toEqual({
      mode: 'nat',
      gatewayIp: '192.168.32.1'
    });
  });

  it('falls back to unknown when wslinfo is absent (old WSL)', () => {
    const exec = vi.fn((_file: string, args: string[]) => {
      if (args.includes('wslinfo')) throw new Error('wslinfo: not found');
      return '192.168.32.1\n';
    }) as unknown as SyncExec;
    // unknown still probes the gateway but the mode stays unknown
    expect(detectWslNetworking(DISTRO, exec)).toEqual({
      mode: 'unknown',
      gatewayIp: '192.168.32.1'
    });
  });

  it('leaves gatewayIp null when the route output is not an IP', () => {
    const exec = vi.fn((_file: string, args: string[]) =>
      args.includes('wslinfo') ? 'nat\n' : 'garbage\n'
    ) as unknown as SyncExec;
    expect(detectWslNetworking(DISTRO, exec)).toEqual({ mode: 'nat', gatewayIp: null });
  });
});

describe('resolveAgentHost', () => {
  it('mirrored → loopback', () => {
    expect(resolveAgentHost({ mode: 'mirrored', gatewayIp: null })).toEqual({
      host: '127.0.0.1'
    });
  });
  it('unknown → loopback (optimistic, WSL1 / pre-NAT)', () => {
    expect(resolveAgentHost({ mode: 'unknown', gatewayIp: null })).toEqual({
      host: '127.0.0.1'
    });
  });
  it('nat refused while the bind/firewall work is gated off', () => {
    const r = resolveAgentHost({ mode: 'nat', gatewayIp: '192.168.32.1' }, false);
    expect('unsupported' in r).toBe(true);
  });
  it('nat → gateway host once enabled', () => {
    expect(resolveAgentHost({ mode: 'nat', gatewayIp: '192.168.32.1' }, true)).toEqual({
      host: '192.168.32.1'
    });
  });
  it('nat enabled but no gateway → still refused', () => {
    const r = resolveAgentHost({ mode: 'nat', gatewayIp: null }, true);
    expect('unsupported' in r).toBe(true);
  });
});

describe('agentHostFor', () => {
  beforeEach(() => __clearAgentHostCache());

  it('detects then caches per distro (exec runs once)', () => {
    const exec = vi.fn().mockReturnValue('mirrored\n') as unknown as SyncExec;
    expect(agentHostFor(DISTRO, exec)).toEqual({ host: '127.0.0.1' });
    expect(agentHostFor(DISTRO, exec)).toEqual({ host: '127.0.0.1' });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('surfaces the unsupported reason under NAT', () => {
    const exec = vi.fn((_file: string, args: string[]) =>
      args.includes('wslinfo') ? 'nat\n' : '192.168.32.1\n'
    ) as unknown as SyncExec;
    const r = agentHostFor(DISTRO, exec);
    expect('unsupported' in r).toBe(true);
  });
});
