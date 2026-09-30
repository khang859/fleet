## Context

See proposal.md for motivation; the specs hold the requirements.

The current state that shapes this design:

- **Hook pipeline.** The Go hook (`hooks/fleet-copilot-go/main.go`) exits unless `FLEET_SESSION` is set, maps Claude Code hook events to a status, and sends JSON to a unix socket.
  `CopilotSocketServer` feeds `CopilotSessionStore`, which holds sessions in memory.
  Everything is created inside `initCopilot` (`src/main/copilot/index.ts`), which returns early unless the platform is darwin and `copilot.enabled` is true.
- **Pane mapping** is a `ps` parent walk (`findPaneForPid`, `copilot/ipc-handlers.ts:29`).
  `PtyManager.create` already has the pane id in scope where it builds the env (`pty-manager.ts:135`).
- **Transcripts** are parsed by `conversation-reader.ts`, which drops `tool_result` blocks and keeps only 60-character tool previews.
  Cost math lives in `sessions/claude-source.ts` (`aggregateClaudeUsage`).
  Both hardcode `~/.claude`.
- **Agent pane** tools are a zod schema plus a spec in `shared/agent-tools.ts`, a handler in `agent/tools/`, and a case in `tools/run.ts`.
  Main-side services reach tools as nullable capabilities on `AgentToolContext` (the `schedule` capability is the template).
  Only `bash` and MCP tools ask for permission, through `PermissionGate`.
- **Scheduled turns.** Main never starts an Agent turn.
  The pane pulls due work (`renderer/store/agent-schedule.ts`) and sends with `scheduleChainDepth`.
- **Main-to-renderer requests.** The layout is renderer-owned, so main cannot create tabs itself.
  `QuitGuard` (`quit-guard.ts`) is the existing request/reply pattern.
- **Verified pre-existing bugs.** Phase 0 fixes:
  - `hook-installer.ts:214-221` resets settings to `{}` on a parse failure;
  - `main.go:251` maps `SubagentStop` to `waiting_for_input`;
  - `session-store.ts:110-113` folds AskUserQuestion into `waitingForInput`;
  - `socket-server.ts:90` chmods the socket `0o777`.

## Goals / Non-Goals

**Goals:**

- One platform-neutral source of truth for Claude session state, which the copilot overlay, the status view and the Orchestrator all consume.
- An Orchestrator that can act with confidence because its context is cheap and current, and its actions are gated and auditable.
- Every phase ships on its own and is useful on its own.

**Non-Goals:**

- Windows support for tracking and spawn.
- Tracking Claude sessions outside Fleet panes, or other agent CLIs such as Codex and Gemini.
- Starting Agent turns from main.
  Wakeups keep the pane-pulls model.
- Auto-answering Claude Code's folder trust dialog, or any TUI menu other than the permission hook.
- An LLM-written session summary as the default context.
  The brief is deterministic, and LLM reads are opt-in through the analyst subagent.

## Decisions

### D1. New `src/main/claude-sessions/` core module; copilot becomes a consumer

The module contains:

- `hook-events` (zod-parsed wire format);
- `hook-server` (the renamed socket server, plus the permission broker, which holds a permission hook open only while a consumer that can answer it, such as the copilot window, is registered; otherwise the hook is released at once and Claude Code prompts in the terminal);
- `phase` (a pure reducer from event to phase);
- `registry`;
- `pane-resolver`;
- `hook-installer` (moved);
- `transcript` (normalizer and incremental tail);
- `brief`;
- `usage-accumulator` (extracted from `claude-source`);
- `git-probe`;
- `input` (safe delivery and draft tracking);
- `pane-activity-bridge`;
- `ipc-handlers`;
- `index` (the composition root).

An ESLint `no-restricted-imports` override stops this module from importing `copilot`, `agent`, `sessions`, `electron` or `main/index`.
`ipc-handlers` therefore takes an injected registrar with `ipcMain`'s `handle` signature instead of importing Electron.
Pricing and git are injected.

`CopilotSession` types in `shared/types.ts` become aliases of the new types, so the mascot renderer is untouched.

_Alternative considered:_ split `copilot/index.ts` into a core half and an overlay half and extend `CopilotSessionStore`.
That is a smaller diff.
It would keep a core service inside a module named after a macOS mascot, behind a gate that tracking no longer has, and it would postpone the same move.

### D2. Pane identity: `FLEET_PANE_ID` with the `ps` walk as fallback

`PtyManager` adds `FLEET_PANE_ID` to the env, and the hook forwards it as `pane_id`.
The resolver accepts it only if `ptyManager.has(paneId)`.
That also rejects ids forwarded from another Fleet instance or through tmux or ssh.
When there is no id, it falls back to the `ps` walk, so sessions started before the hook binary updates keep working.
Only hits are cached.

The hook also forwards `transcript_path` from Claude Code's hook stdin, plus `config_dir` and a protocol version.
This fixes the `CLAUDE_CONFIG_DIR` bug and the lossy cwd-to-folder encoding.

The pid the hook reports must be Claude's, because the liveness check ends sessions whose pid is gone.
Claude Code runs hooks through `sh -c`, and dash (the `/bin/sh` of Debian and Ubuntu) forks rather than execs, so the hook's parent is a shell that exits with it.
The hook steps past a parent that is a shell.
This was found in the Phase 1 E2E, where every Linux session ended about 10 seconds after it started.

### D3. Phase model

Phases are `starting | processing | waitingForInput | waitingForApproval | compacting | ended`.
`waitingForInput` also carries `waitingKind: prompt | question`.

The rules for the awkward cases:

- `SubagentStop` becomes a new status that the reducer ignores for phase.
- A new `session_id` on a known pane (from `/clear`) ends the old session and bumps the pane's epoch.
  Only when it comes from the same Claude process (same pid, or `SessionStart` with source `clear` or `resume`), or the old session's process is gone.
  A different live process, such as `claude -p` run by a tool in that pane, is tracked alongside without taking the pane, and the pane badge keeps following the pane's own session.
  This was found in review of Phase 1: the first rule alone ended the interactive session for good.
- A tool that finishes while another waits for approval does not leave `waitingForApproval`.
- `starting` covers a spawned pane that has not sent `SessionStart` yet.

The reducer is pure and table-tested.

### D4. Hooks installed by default, safely

The user chose on-by-default, with a `claudeSessions.trackSessions` setting to turn it off.
To make that safe, the installer:

- aborts on an unparseable or non-object `settings.json`, leaves it untouched, and shows the error in the UI;
- writes `settings.json.fleet-bak` before changing anything;
- writes to a temp file and renames it into place;
- quotes the command.

On startup it runs `ensureHooks` for every Claude config folder Fleet uses: the default plus any workspace overrides.
That also refreshes the binary after an upgrade.
`FolderHooks` loses its darwin gate.

### D5. Safe input delivery

`input.sendPrompt(sessionId, text, origin)` is the single path for both the copilot chat send (`origin: user`) and `fleet_send` (`origin: orchestrator`).
It writes nothing unless all of these hold:

- the phase is `waitingForInput` with kind `prompt`;
- the pane's draft is clean;
- there has been no user keystroke for 3 s;
- the rate limit passes.

Draft tracking works on renderer-originated PTY writes in main.
Printable input marks the draft dirty.
Enter, Ctrl-C, Ctrl-U or a `UserPromptSubmit` hook event marks it clean.

The text is typed, not pasted: control characters other than LF are dropped, a tab becomes four spaces, and it is written in 128-character chunks 25 ms apart, followed by `\r` about 50 ms later.
Checked on Claude Code 2.1.285 (task 5.1): a bracketed paste of more than one line, or one read of more than about 800 characters, is recorded as `<pasted_content>`, and the model refuses to follow pasted instructions.
Typed, LF inserts a line break and the transcript records exactly what was written.
A prompt ending in `\` is refused, since `\` then Enter is a line break.
The copilot chat's answer to a question dialog is an option number pressed as a key, not a prompt, so it has its own path (`answerQuestion`) that works only while a question dialog is open.
The send is confirmed only by a `UserPromptSubmit` for that session within 5 s; otherwise it is reported as "not confirmed".
The registry also records the origin and a hash of the text.
That is how turn reads tell real Orchestrator prompts from a user typing the prefix.
The hash is of exactly the delivered text, `[orchestrator]` prefix included and trimmed, because that is the text the transcript records and the reader hashes.

_Alternative considered:_ the current `write(text + '\r')`.
It submits half-typed drafts, can split multi-line text, and lands in whatever dialog is open.
_Alternative considered:_ a bracketed paste, the first design.
Claude Code wraps it as pasted content, which its model treats as untrusted and does not act on.

### D6. Orchestrator mode is a per-pane flag

The flag lives on the Agent pane leaf and is sent on each `AgentSendRequest` as `orchestrator: true`.
Fleet tools are defined in `shared/fleet-tools.ts`:

- `FLEET_READ_TOOL_NAMES` (`sessions`, `read`, `diff`) join `SUBAGENT_TOOL_NAMES`;
- `FLEET_ACT_TOOL_NAMES` (`send`, `spawn`, `wait`, `permission`) join `AGENT_TOOL_NAMES` only.

Tool specs are built per turn and advertised only when the flag is set.
Keeping them out of other turns saves about 2-3k tokens per round there, and keeps the act tools' blast radius opt-in.
Within an orchestrator turn a tool is advertised only when its capability member is non-null, and `fleetMember` refuses a call to a null one.
That is how Phase 3 ships the act tool specs and names without offering them: their members stay `null` until Phase 4 wires them.

The Agent side reaches the registry only through a `FleetHost` facade in `agent/fleet/`.
`AgentToolContext.fleet` holds either the full capability or a read-only pick, and is `null` otherwise.

_Alternative considered:_ offering the tools in every Agent pane.
Rejected: it pays the token cost on every round, and wakeups need a designated pane anyway.

### D7. Context economy

- **Transcript normalizer.**
  - It emits `user_prompt`, `assistant_text`, `tool_use`, `tool_result`, `clear` and `meta` events, reusing the existing skip rules.
  - `conversation-reader` is rebuilt on it, and its existing tests pin behavior.
  - `TranscriptTail` reads only new bytes, resets on truncation, and keeps a turn index plus a bounded `toolUseId → byte range` map.
  - Tool results are re-read from disk on demand, so memory stays flat.
- **SessionBrief.**
  - Every item carries a per-session `rev`, which is what makes deltas possible.
  - Todos fold both the `TodoWrite` and the `TaskCreate`/`TaskUpdate` shapes.
  - The git block comes from `git-probe`, cached for 5 s, and runs only when a brief or digest is rendered.
  - The rendered brief is capped at about 3.5k characters, and truncation says what it cut.
- **`fleet_read`.** Levels are `brief`, `turns` and `tool`.
  - A session is named by a short ref: the first 8 characters of its `paneId`.
    The pane outlives `/clear`, so the ref the model already holds keeps working after a clear, where a `sessionId` prefix would go stale.
    `fleet_read` also accepts the full `paneId` or `sessionId`.
  - The cursor `{sessionId, epoch, rev, turn}` is kept per `(orchestrator thread, ref)` in the ledger file.
    A changed `sessionId` or `epoch`, or a `rev` or `turn` past the transcript's own, means the session was cleared, and the read says so.
  - The turn cursor advances only past finished turns, so a turn still running is shown again once it ends.
    A turn waiting on an approval, or on the answer to the session's own question, is still running.
  - `turns` shows the latest turns that fit, and names the oldest one shown when it leaves turns out.
    `before: N` pages back to the turns before turn N. It is a look at older turns, so it neither starts from the cursor nor moves it.
  - Subagent capabilities never advance it.
  - Output is fenced as untrusted session data.
- **`fleet_diff`.** It runs git with a fixed argv, no shell, `--no-ext-diff`, `GIT_OPTIONAL_LOCKS=0`, a timeout and an output cap.
  - The runner, shared with the sidebar's git probe, turns off the programs a repository's config can make reading run: `core.fsmonitor`, `log.showSignature`, and every configured filter driver (blanked through `GIT_CONFIG_KEY_n` pairs, since `-c` splits at the first `=`).
    `status` and `diff` also get `--ignore-submodules=all`, because a submodule's own config names its own filters.
  - The cwd comes only from the registry.
  - `path` goes through `resolveInsideCwd(path, session.cwd)`, which reuses the credential checks.
  - Every view also passes `DENIED_PATHSPECS`, `:(exclude,glob)` pathspecs that mirror the sandbox's denied names.
    Without them a whole-folder diff would print a changed `.env` that the `file` view refuses.
  - The checked path goes to git as `:(literal)<path>`, so a name like `:(top)` cannot be read as pathspec magic that reaches the repository root above the session folder.
  - The `file` view reuses `runRead` with `cwd` swapped.
  - _Alternative considered:_ widening the Agent sandbox to live session folders.
    Rejected: it breaks the "a tool touches only its pane cwd" invariant for every file tool.
- **`fleet-analyst`** is a bundled subagent definition with the read tools only.
  It is advertised only on orchestrator turns.
- **Ledger.**
  - Stored in `<agent sessions dir>/<threadId>.fleet.json`, written atomically, capped, and deleted with the session.
  - `fleet_send` and `fleet_spawn` require `why` and `expect` arguments, and the entry is written automatically.
  - `withFleetLedger` splices open entries, the few most recently settled, and the live session one-liners into each round.
    It sits next to `withRunningSubagents`, after the cache breakpoint.
  - An entry is answered once its session has started on the prompt and has waited for a prompt since the entry was written; a question dialog is still the same turn.
    It ends when its session goes away or is cleared (a new epoch) first.
    The rule reads the session's state, not the events that led to it, so the same check settles entries live from registry changes and, for a conversation not loaded at the time, when its next round is built.
  - A spawn's entry has no session until the new tab reports one; it is matched by pane, and ends if nothing reports within two minutes.
  - _Alternative considered:_ the Agent session log.
    Rejected: compaction folds it, and it is renderer-owned.

### D8. `fleet_spawn` through an env var and a renderer RPC

1. Main validates the cwd.
2. If a worktree was asked for, main creates it with `WorktreeService`.
3. Main mints a `paneId` and records a pending spawn: `cmd = claude "$FLEET_SPAWN_PROMPT"`, `env = { FLEET_SPAWN_PROMPT: "[orchestrator] …" }`.
4. Main asks the renderer to open an unfocused tab with that `paneId`, through a `RendererRpc` modeled on `QuitGuard`.
5. `PTY_CREATE` takes the pending spawn and overrides `cmd` and env.

The prompt never enters the layout, so restoring a layout cannot re-run it, and it needs no shell quoting.
Spawn is refused on Windows and WSL profiles.

_Alternative considered:_ shell-quoting the prompt into `cmd`.
It is fragile across shells, and the prompt would be persisted with the layout.

### D9. Gate extension

`PermissionGate.checkFleet(req)` follows `checkMcp`.
For each action it checks, in order:

- **`send` and `spawn`:**
  1. the per-turn refusal memory;
  2. full access, which allows the action;
  3. an in-memory `fleetGrants` set keyed `send:<sessionId>`;
  4. otherwise it asks.
- **`permission`:**
  1. the user's deny rules, which always refuse;
  2. full access, which skips only the ask;
  3. an `alwaysAskReason`, which still asks;
  4. otherwise it asks.

`AgentPermissionAsk` gets a `fleet` payload.
`Pending.rules` becomes `'shell' | 'mcp' | 'fleet'`.
"Always" for a fleet ask adds a grant; it never persists a rule.
Grants are dropped when the registry removes the session.
Spawn offers only "once".

### D10. Wakeups

The renderer store `agent-fleet.ts` mirrors `agent-schedule.ts`.
It reacts to attention transitions arriving on `CLAUDE_SESSIONS_CHANGED`, and it:

- debounces for 2 s;
- holds the digest while the pane is busy;
- pulls the digest from main with `AGENT_FLEET_PULL_DIGEST`;
- writes a `fleet`-role message and sends with `fleetChainDepth`.

Main renders the digest from registry events after the thread's cursor.
It skips sessions covered by an active `fleet_wait`.
It caps output at 6 sessions and about 1,200 characters per session.
It advances the cursors, and withholds the digest at the chain limit (6).
`AGENT_FLEET_SET_MODE` resets the cursors to "now" when the mode is turned on.

A token bucket limits sends and spawns to 20 per 10 minutes per thread.

_Alternative considered:_ reusing the `scheduled` role.
Rejected: a distinct `fleet` role is clearer in the transcript and in compaction.
The cost is six touch points and no downgrade compatibility for session files.

## Risks / Trade-offs

- **Prompt injection.** Session text reaches an agent that can type into other terminals.
  → Mitigations: untrusted-data fencing, ask by default, rate and chain limits, `fleet_permission` off by default, and deny rules that full access cannot bypass.
- **Hook contract drift.** `transcript_path`, `/clear` semantics and the `toolUseResult` shape could change between Claude Code versions.
  → Verify each against the installed Claude Code during Phase 1.
  → Fall back to the config-dir path, degrade the brief to the registry-only view, and keep a golden fixture per observed shape.
- **A permission denied in the terminal sends no hook event.** Checked on Claude Code 2.1.285: after Esc there is no `Stop`, `PostToolUse` or `Notification`, even after minutes, so the session stays `waitingForApproval` until the next prompt.
  After "No", an `idle_prompt` notification arrived about a minute later and settled it, but nothing arrives sooner.
  While the dialog is still open, no `idle_prompt` arrives, so an unanswered request keeps showing as needing the user.
  → Phase 3 settles it from the transcript, which records the rejection (task 4.2a).
  → Until then the error is on the safe side: `fleet_send` refuses a session that looks like it waits for approval, and the status view shows it as needing the user.
- **A queued prompt runs its turn without a hook event.** Checked on Claude Code 2.1.285 during the Phase 2 E2E: a prompt typed while a turn runs fires `UserPromptSubmit` when it is queued, not when its turn starts.
  The running turn's `Stop` then arrives, and the queued turn runs with no event until its first tool or its own `Stop`, so a text-only queued turn shows as ready while it works.
  A background task finishing queues a turn the same way.
  Counting prompts against stops cannot fix it: an Esc interrupt sends no `Stop`, and the count would leave the session stuck as working.
  → Phase 3 settles it from the transcript, which records `queue-operation` lines with `operation: "enqueue"` and `"dequeue"`: a dequeue after the last `Stop` means a turn is running (task 4.2b).
- **Paste detection in the Claude Code TUI.** Typed input that arrives in one read above about 800 characters is taken as a paste, and the threshold may change between versions.
  A main process stalled long enough for several chunks to pile up in the PTY could also trip it.
  → Chunks are a sixth of the observed threshold.
  → The acknowledgement timeout keeps the tool honest, and a wrapped prompt reads back as "typed by the user", since its recorded text does not match the noted hash.
- **Default hook install edits a user's Claude config.** It already runs on macOS today.
  → Backup, atomic write, abort on parse failure, and a setting to turn it off.
- **Migration blast radius.** Moving files touches copilot, sessions and the mascot renderer.
  → Alias types, pin behavior with the existing tests, and land Phase 1 as small PRs.
- **Token spend from wakeups.**
  → Debounce, batching, the chain limit and the rate limit.
- **Renderer reload drops an in-flight digest.** This is the same at-most-once trade-off as schedules.
  → `fleet_read` with `since: start` recovers the missed state.

## Migration Plan

Each phase is a separate PR, and each is revertible on its own:

- **Phase 0 (bug fixes).** Safe to ship first.
- **Phase 1 (registry).** Keeps the `ps` fallback, so older hook binaries keep working.
  The Go binary is rebuilt by `npm run build:hook`.
- **Phases 3-5.** Additive and behind the per-pane mode or a setting.

Rollback for the default install: turning the setting off removes Fleet's entries.
Reverting the PR restores the old macOS-only behavior, and the backup file stays available.

## Open Questions

- ~~The exact status-view placement within `Sidebar.tsx`, and whether it can be collapsed.~~
  Settled in Phase 2 after a screenshot review: a "Claude Code" section above Agents, collapsible like the other sidebar sections.
  Collapsed, its header still shows the session count or the needs-you count.
  Rows name a pane in a split tab by its custom label or by its position, since panes otherwise share the tab's name.
- ~~The model-to-context-limit table used for the context percentage.~~
  Settled in Phase 2 without a table: every current model has a 200k window, and 4.6 and later models can run with 1M at the standard price, which the transcript does not record.
  So the limit is 200k until a session is seen using more than 200k tokens, then 1M for the rest of that session.
