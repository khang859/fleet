import { execFileSync } from 'child_process';
import { networkInterfaces } from 'os';
import { posix } from 'path';
import { parseWslUncPath } from '../../shared/path-platform';
import { wslExePath } from '../wsl-service';
import { createLogger } from '../logger';

const log = createLogger('kanban-agent-ctx');

/**
 * Phase 3c-agent (see docs/wsl-path-handling-plan.md §"agent execution"). The
 * kanban autopilot worker/verify runs operate on the task *worktree*. When the
 * board's repo lives inside a WSL distro the worktree is a `\\wsl.localhost\…`
 * UNC path, so those runs must execute *inside* the distro — same boundary the
 * git/worktree slice already crosses in workspace.ts — and `rune` must reach the
 * kanban MCP server that Fleet (a win32 process) hosts on the Windows side.
 *
 * Everything here is keyed off the workspace path string alone (no PathContext
 * is threaded for kanban repos), mirroring workspace.ts.
 */

/** A worktree that lives inside a WSL distro: its distro + POSIX path. */
export type AgentWslLocation = { distro: string; posixCwd: string };

/**
 * Infer the WSL location of a task workspace from its path. A
 * `\\wsl.localhost\<distro>\…` (or `\\wsl$\…`) UNC path → run inside that distro;
 * any native (drive/posix) path → null (run natively, unchanged).
 */
export function agentWslLocation(workspace: string): AgentWslLocation | null {
  const u = parseWslUncPath(workspace);
  return u ? { distro: u.distro, posixCwd: u.posixPath } : null;
}

/**
 * POSIX path of `<workspace>/.rune/mcp.json` *inside the distro*, for the
 * `RUNE_MCP_CONFIG` env var rune reads. The file itself is written by Fleet over
 * the UNC bridge (a Windows-accessible path); rune sees it at this POSIX path.
 */
export function agentMcpConfigPosixPath(loc: AgentWslLocation): string {
  return posix.join(loc.posixCwd, '.rune', 'mcp.json');
}

/** The MCP server URL rune connects to. `host` is resolved per networking mode. */
export function agentMcpUrl(mcpPort: number, runToken: string, host: string): string {
  return `http://${host}:${mcpPort}/mcp?run=${runToken}`;
}

/** A logical process invocation, before any WSL wrapping. */
export interface AgentSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** The concrete spawn target after (optional) WSL wrapping. */
export interface AgentSpawn {
  file: string;
  argv: string[];
  /** undefined for WSL (the cwd travels in `--cd`); the native cwd otherwise. */
  cwd: string | undefined;
  /** Extra env to merge over process.env. Empty for WSL (vars travel inline). */
  env: Record<string, string>;
}

/**
 * Wrap a logical invocation to run inside a WSL distro, or pass it through for a
 * native workspace. For WSL we run
 *
 *     wsl.exe -d <distro> --cd <posixCwd> --exec env K=V… <command> <args…>
 *
 * `--exec` passes argv verbatim with **no shell** (no quoting/globbing hazard);
 * the env vars travel as literal `env` arguments rather than via `WSLENV`, so
 * each value (incl. the POSIX mcp.json path) crosses unchanged. The wsl.exe
 * process must NOT inherit the POSIX cwd — it isn't a valid win32 directory — so
 * the native `cwd` is dropped and carried by `--cd` instead.
 */
export function buildAgentSpawn(spec: AgentSpawnSpec, loc: AgentWslLocation | null): AgentSpawn {
  if (!loc) {
    return { file: spec.command, argv: spec.args, cwd: spec.cwd, env: spec.env };
  }
  const envArgs = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
  const head = envArgs.length > 0 ? ['env', ...envArgs] : [];
  const argv = [
    '-d',
    loc.distro,
    '--cd',
    loc.posixCwd,
    '--exec',
    ...head,
    spec.command,
    ...spec.args
  ];
  return { file: wslExePath(), argv, cwd: undefined, env: {} };
}

/**
 * NAT-mode WSL agents reach the host via the distro's default-gateway IP (the
 * host's vEthernet (WSL) adapter), not loopback. With this enabled the kanban MCP
 * server binds that adapter IP in addition to `127.0.0.1` (see
 * KanbanMcpServer.start), and the in-distro agent connects to the gateway URL.
 *
 * REQUIRED per-machine setup: the WSL Hyper-V firewall blocks distro→host inbound
 * by default (`Get-NetFirewallHyperVVMSetting` → DefaultInboundAction = Block), so
 * a scoped Hyper-V firewall rule must allow inbound to the MCP port from the WSL
 * VM. Without it the agent's MCP connection times out. Mirrored-mode distros need
 * none of this (they share the host loopback) and work unconditionally.
 */
export const WSL_NAT_AGENTS_ENABLED = true;

export type WslNetworking = {
  mode: 'nat' | 'mirrored' | 'unknown';
  /** The Windows host as seen from the distro (NAT only); null otherwise. */
  gatewayIp: string | null;
};

/** Either a resolved MCP host, or a reason the run can't proceed yet. */
export type AgentHost = { host: string } | { unsupported: string };

const NAT_UNSUPPORTED =
  'WSL is in NAT networking mode, so the kanban autopilot agent in the distro ' +
  "can't reach Fleet's board server on the Windows host. Set " +
  'networkingMode=mirrored in %UserProfile%\\.wslconfig and run `wsl --shutdown`, then retry.';

/**
 * Decide which host rune should use to reach the MCP server, given the distro's
 * networking mode. Pure.
 *  - mirrored: the distro shares the host loopback → `127.0.0.1` (no exposure
 *    widening, stays loopback-only).
 *  - unknown (old WSL without `wslinfo`): assume loopback works (WSL1 / pre-NAT);
 *    a genuine failure surfaces as a clear MCP-connect error in the run log.
 *  - nat: reach the host via the default-gateway IP (its vEthernet (WSL) adapter),
 *    which the server also binds. Requires the Hyper-V firewall rule documented on
 *    {@link WSL_NAT_AGENTS_ENABLED}; if that flag is off or no gateway resolved the
 *    run is refused with an actionable message.
 */
export function resolveAgentHost(
  net: WslNetworking,
  natEnabled: boolean = WSL_NAT_AGENTS_ENABLED
): AgentHost {
  if (net.mode === 'mirrored' || net.mode === 'unknown') return { host: '127.0.0.1' };
  if (natEnabled && net.gatewayIp) return { host: net.gatewayIp };
  return { unsupported: NAT_UNSUPPORTED };
}

/** Minimal synchronous exec contract; injectable so detection is unit-testable. */
export type SyncExec = (file: string, args: string[]) => string;

const defaultSyncExec: SyncExec = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 20_000 });

/**
 * Probe a distro's WSL networking mode (and, under NAT, the host gateway IP it
 * can reach). `wslinfo --networking-mode` is authoritative on modern WSL; older
 * builds without it fall back to 'unknown'. The gateway is the default-route
 * next hop inside the distro (the vEthernet (WSL) adapter = the Windows host).
 */
export function detectWslNetworking(
  distro: string,
  exec: SyncExec = defaultSyncExec
): WslNetworking {
  const wsl = wslExePath();
  let mode: WslNetworking['mode'] = 'unknown';
  try {
    const out = exec(wsl, ['-d', distro, '--exec', 'wslinfo', '--networking-mode'])
      .trim()
      .toLowerCase();
    if (out === 'nat' || out === 'mirrored') mode = out;
  } catch {
    // Old WSL without wslinfo, or a stopped distro — leave 'unknown'.
  }
  let gatewayIp: string | null = null;
  if (mode !== 'mirrored') {
    try {
      const route = exec(wsl, [
        '-d',
        distro,
        '--exec',
        'sh',
        '-c',
        "ip route show default | awk '{print $3; exit}'"
      ]).trim();
      gatewayIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(route) ? route : null;
    } catch {
      // No route / no `ip` — leave null; resolveAgentHost will refuse NAT anyway.
    }
  }
  return { mode, gatewayIp };
}

// Networking mode is stable per distro per boot; probe once and cache.
const hostCache = new Map<string, AgentHost>();

/** Resolved MCP host for a distro (cached). Synchronous: safe in the spawn path. */
export function agentHostFor(distro: string, exec: SyncExec = defaultSyncExec): AgentHost {
  const cached = hostCache.get(distro);
  if (cached) return cached;
  const net = detectWslNetworking(distro, exec);
  const resolved = resolveAgentHost(net);
  log.info('resolved WSL agent host', { distro, mode: net.mode, resolved });
  hostCache.set(distro, resolved);
  return resolved;
}

/** Test-only: drop the per-distro cache. */
export function __clearAgentHostCache(): void {
  hostCache.clear();
}

/** Lists the host's network interfaces; injectable so discovery is unit-testable. */
export type ListIfaces = () => ReturnType<typeof networkInterfaces>;

/**
 * The host's vEthernet (WSL) adapter IPv4 — the address a NAT-mode distro reaches
 * the host on (it is the distro's default gateway). The kanban MCP server binds
 * this in addition to loopback so the in-distro agent can connect. null when no
 * WSL adapter exists (no distro running, or a non-Windows host).
 */
export function wslAdapterIp(list: ListIfaces = networkInterfaces): string | null {
  for (const [name, addrs] of Object.entries(list())) {
    if (!/WSL/i.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}
