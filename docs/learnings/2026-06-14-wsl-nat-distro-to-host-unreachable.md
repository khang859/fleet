# WSL NAT mode: distro→host is unreachable, and not because of the firewall

## Context

Phase 3c-agent runs the kanban autopilot `rune` agent _inside_ a WSL distro (for
`\\wsl.localhost\…` worktrees). The agent must reach Fleet's kanban MCP server,
which Fleet (a win32 process) hosts on the Windows side. Whether that works
depends on the distro's WSL networking mode:

- **mirrored**: the distro shares the host loopback → `127.0.0.1:<port>` works.
- **NAT** (the default): `127.0.0.1` inside the distro is the _distro's own_
  loopback. The host would have to be reached on another address.

We tried to support NAT by binding the MCP server to the host's vEthernet (WSL)
adapter IP (the distro's default gateway, e.g. `192.168.32.1`) and pointing the
agent at that gateway URL. It was shipped enabled in #255, then **validated on
real hardware and reverted** — it does not work.

## What the validation proved

On a confirmed NAT box (`wslinfo` = `nat`, distro `192.168.35.16/20`, gateway
`192.168.32.1`), a host TCP listener bound to `192.168.32.1:18080` was probed
from inside the distro under every firewall configuration:

| Config                                                                 | distro→host `192.168.32.1:18080` |
| ---------------------------------------------------------------------- | -------------------------------- |
| no rule                                                                | timeout                          |
| `New-NetFirewallHyperVRule` Inbound/Allow (port 18080, WSL VM)         | timeout                          |
| + `New-NetFirewallRule` standard inbound Allow (TCP 18080, WSL subnet) | timeout                          |
| + `Set-NetFirewallHyperVVMSetting -DefaultInboundAction Allow`         | timeout                          |

Control directions, same listener:

- **host → its own listener** `192.168.32.1:18080` → **succeeds** (the bind and
  listener are fine).
- **host → distro** `192.168.35.16` (ping) → **succeeds**.
- **distro → host gateway** ICMP ping → **100% loss**.

So only the **distro→host** direction is blocked, and **no firewall change opens
it** — including the broadest possible one (`DefaultInboundAction = Allow`).

## Root cause

This is **WSL2 NAT-level isolation between the VM and host services**, not a
firewall-rule problem. In NAT mode the distro gets outbound SNAT (it can reach
the internet), but it cannot initiate connections to services on the host's
vEthernet (WSL) adapter — even though that adapter IP is its default gateway and
is in the same `/20`. This matches the well-known "can't reach the Windows host
from WSL" reports (e.g. the `host.docker.internal` problem). The previous guess
that the **WSL Hyper-V firewall** (`DefaultInboundAction = Block`) was the cause
was **wrong** — flipping it to `Allow` changed nothing.

## Consequence for the code

`WSL_NAT_AGENTS_ENABLED` stays **false**. NAT distros are refused with an
actionable message telling the user to switch to mirrored networking
(`networkingMode=mirrored` in `%UserProfile%\.wslconfig`, then `wsl --shutdown`).
Mirrored mode shares the host loopback and is the supported path; it needs no
server dual-bind, no adapter-IP discovery, and no firewall rule. The
dual-bind / `wslAdapterIp` machinery added in #255 was reverted as dead code.

## Probing tips (from inside a WSL session)

- Authoritative mode check: `wslinfo --networking-mode`. Don't infer mirrored
  from the `10.255.255.254`-on-loopback nameserver — that's NAT DNS tunneling.
- Windows interop works from the distro: `powershell.exe -NoProfile -Command …`
  drives host-side checks (adapter IPs, firewall settings, a throwaway
  `[System.Net.Sockets.TcpListener]`, `Test-NetConnection`) without leaving the
  shell. Elevation (firewall changes) needs a real UAC approval — `Start-Process
-Verb RunAs` throws `InvalidOperationException` if the prompt is dismissed.
- `zsh` has no `/dev/tcp` pseudo-device (that's a bash-ism) — use `curl`/`nc`,
  and read **timeout vs. "connection refused"**: timeout = dropped/isolated,
  refused = reachable host with a closed port.
