## Why

Developers run many Claude Code sessions in Fleet panes at once, and keeping track of which one is blocked, finished, or waiting on a permission is hard.
Fleet already has a hook pipeline that knows each session's state, but it lives inside the macOS-only, opt-in copilot mascot module, so on Linux there is no session tracking at all.
The native Agent pane works well, and with the right tools it can act as an Orchestrator that watches those sessions and prompts them.

## What Changes

- Fix pre-existing bugs in the hook pipeline that become dangerous once it is on by default:
  - the hook installer overwrites the user's whole `settings.json` when it fails to parse;
  - `SubagentStop` marks a still-working parent session as waiting for input;
  - an `AskUserQuestion` dialog is indistinguishable from an idle prompt;
  - the hook socket is world-writable (`0o777`);
  - transcript paths ignore `CLAUDE_CONFIG_DIR`.
- Delete the unused `socket-api.ts` / `socket-command-handler.ts` scaffolding (separate commit).
- Add a platform-neutral Claude session registry (`src/main/claude-sessions/`) that runs on every non-Windows platform, independent of the copilot mascot.
  The copilot overlay becomes one consumer of it.
- Panes get a `FLEET_PANE_ID` env var that the Go hook forwards, so sessions map to panes directly instead of through a `ps` parent walk (kept as a fallback).
- **BREAKING (behavior)**: Fleet installs its Claude Code hook into the Claude config folder by default on all non-Windows platforms, with a setting to turn it off.
  Previously this only happened when a macOS user enabled copilot.
- Add an always-visible session status view in the sidebar: phase, idle time, cost, context usage, a needs-you badge, and click to focus the pane.
- Add an orchestrator mode for Agent panes with `fleet_*` tools to list, read, diff, prompt, spawn, wait on, and (behind a setting) answer permissions for Claude sessions.
- Give the Orchestrator enough context to write good prompts without flooding its own context: a deterministic per-session brief, tiered reads with a cursor, a read-only diff tool, a bundled analyst subagent, a ledger of what it asked and why, and wakeup digests that carry what changed.
- Wake an orchestrator pane automatically when a session needs attention, with a chain-depth guard and rate limit against runaway loops.

## Capabilities

### New Capabilities

- `claude-session-tracking`: the always-on registry of Claude Code sessions running in Fleet panes - hook installation, event ingestion, phases, pane mapping, transcript briefs, and safe input delivery.
- `claude-session-status-view`: the always-visible sidebar view of tracked sessions.
- `agent-orchestrator`: orchestrator mode for Agent panes - the `fleet_*` tools, their permission rules, the ledger, and wakeups.

### Modified Capabilities

None. No existing spec covers these areas.

## Impact

- **Main process:**
  - new `src/main/claude-sessions/`;
  - `src/main/copilot/` shrinks to the mascot overlay;
  - `pty-manager.ts` and `ipc-handlers.ts` (PTY env, spawn hand-off);
  - `agent/agent-service.ts`, `agent/tools/`, `agent/permissions/gate.ts`, `agent/subagents/definitions.ts`;
  - new `agent/fleet/`;
  - `main/index.ts` wiring.
- **Go hook** (`hooks/fleet-copilot-go`): new fields (`pane_id`, `transcript_path`, `config_dir`, protocol version) and a `SubagentStop` mapping change.
  Sessions started with an older hook binary fall back to the `ps` walk.
- **Shared types:**
  - new `shared/claude-sessions.ts`, `shared/claude-brief.ts` and `shared/fleet-tools.ts`;
  - `agent-tools.ts` and `agent-types.ts`, including a new `fleet` message role;
  - new IPC channels.
  Agent session files that contain a `fleet` message cannot be read by older Fleet versions.
- **Renderer:**
  - new status panel in `Sidebar.tsx`;
  - Agent pane orchestrator toggle, permission card and digest card;
  - a wakeup delivery store mirroring `agent-schedule.ts`;
  - hook settings UI no longer gated to macOS.
- **User files:** writes hook entries into `<claude config dir>/settings.json` by default, with a backup and an atomic write.
- **Security:**
  - transcripts become input to an agent that can type into other terminals;
  - mitigated by ask-by-default gating, untrusted-data fencing, rate and chain limits, and deny rules that always apply.
- **Delivery:** ships as separate PRs per phase: 0 fixes, 1 registry, 2 status view, 3 read tools, 4 act tools and wakeups, 5 permission tool.
