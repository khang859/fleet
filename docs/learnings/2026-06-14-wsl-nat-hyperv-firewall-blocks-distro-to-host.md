# WSL NAT mode: Hyper-V firewall drops distro→host inbound

## Context

Phase 3c-agent runs the kanban autopilot `rune` agent *inside* a WSL distro
(for `\\wsl.localhost\…` worktrees). The agent must reach Fleet's kanban MCP
server, which Fleet (a win32 process) binds on the Windows host. Whether that
works depends on the distro's WSL networking mode:

- **mirrored**: the distro shares the host loopback → `127.0.0.1:<port>` just
  works, no exposure widening.
- **NAT** (the default): `127.0.0.1` inside the distro is the *distro's own*
  loopback. The host is reachable only via the distro's default-gateway IP
  (the host's vEthernet (WSL) adapter, e.g. `192.168.32.1`).

## The non-obvious blocker (confirmed empirically)

Even after binding the MCP server to the host's WSL-adapter IP and pointing the
agent at the gateway URL, **the connection still times out under NAT.** The
cause is the **WSL Hyper-V firewall**, not classic Windows Firewall:

```
PS> Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore
DefaultInboundAction  : Block      # <-- distro→host inbound is dropped
DefaultOutboundAction : Allow
```

Reproduced from inside the distro (host listener bound to `192.168.32.1:<port>`):

- `curl`/`nc` to the listening port → **timed out** (filtered/dropped), *not*
  "connection refused".
- `nc` to a *closed* host port → identical timeout ⇒ it's a blanket inbound
  drop, not port-specific.
- `ping 192.168.32.1` → 100% packet loss (ICMP dropped too).
- The host-side listener logged **no connection** the whole time.

A "timed out" (vs "connection refused") is the tell: the SYN is being silently
dropped by a firewall, not rejected by a closed port.

The adapter name itself is the hint — modern WSL shows
`vEthernet (WSL (Hyper-V firewall))`. Distro↔host traffic is governed by the
**Hyper-V firewall** layer, configured via `*-NetFirewallHyperVRule` /
`Set-NetFirewallHyperVVMSetting` against the WSL VM-creator id
(`{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}`). A classic `New-NetFirewallRule`
inbound rule does **not** touch it — an easy way to "fix" it and have it still
fail.

## What this means for the code

`WSL_NAT_AGENTS_ENABLED` (in `src/main/kanban/agent-context.ts`) gates NAT
support. With it on:

- `KanbanMcpServer.start()` dual-binds: `127.0.0.1` (host-side PM chat + native
  agents) **plus** the host's WSL-adapter IP (`wslAdapterIp()` via
  `os.networkInterfaces()`) at the same port.
- The agent connects to `http://<gatewayIp>:<port>/mcp?run=<token>`.

…but a working NAT agent **also requires a per-machine Hyper-V firewall rule**
allowing inbound to the MCP port from the WSL VM. Without it the agent's MCP
connection hangs. This cannot be created from a normal-privilege process (needs
elevation), so it is a manual setup step, documented on the flag. Prefer
recommending **mirrored mode** (set `networkingMode=mirrored` in
`%UserProfile%\.wslconfig`, then `wsl --shutdown`) — it sidesteps all of this.

## Probing tips (from inside a WSL session)

- Authoritative mode check: `wslinfo --networking-mode` (don't infer from the
  `10.255.255.254`-on-loopback artifact — that's NAT-mode DNS tunneling, *not*
  a mirrored signature).
- Windows interop works from the distro: `powershell.exe -NoProfile -Command …`
  lets you drive host-side checks (adapter IPs, Hyper-V firewall settings, even
  a throwaway `[System.Net.Sockets.TcpListener]`) without leaving the shell.
- `zsh` has no `/dev/tcp` pseudo-device (that's a bash-ism) — use `curl`/`nc`
  for reachability tests, or a connect timeout will read as a false negative.
