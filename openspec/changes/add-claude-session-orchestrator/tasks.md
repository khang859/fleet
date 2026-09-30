## 1. Phase 0 - prerequisite fixes (PR 1)

- [x] 1.1 Reproduce the settings wipe end to end: put an unparseable `settings.json` in a temp Claude config folder, run the installer, and record the data loss; add a `docs/learnings/` note
- [x] 1.2 Make `hook-installer` abort on unparseable or non-object settings, write a `.fleet-bak` backup, write atomically via temp file and rename, and quote the command; verify with tmp-dir tests (corrupt JSON left byte-identical, a path with spaces, idempotent re-install, uninstall keeps other hooks)
- [x] 1.3 Map `SubagentStop` to a new `subagent_stop` status in `main.go` that does not change phase; verify with a Go test and a session-store test that the parent stays processing
- [x] 1.4 Keep AskUserQuestion distinct from an idle prompt in the session store (`waitingKind: question`); verify with a store test and check the copilot overlay still renders the question
- [x] 1.5 Change the hook socket mode to `0o600`; verify with a socket-server test that stats the mode
- [x] 1.6 Delete the unused `socket-api.ts` and `socket-command-handler.ts` and their tests, as a separate commit, after `ripwire . --impact` shows no callers; verify with `npm run typecheck`, lint and tests

## 2. Phase 1 - session registry (PR 2, may split)

- [ ] 2.1 Add `shared/claude-sessions.ts` (session, phase, waitingKind, event, change types) and alias the `CopilotSession*` types to them; verify with `npm run typecheck`
- [ ] 2.2 Add `PaneID`, `TranscriptPath`, `ConfigDir`, `Source` and `Protocol` to the Go hook state; verify with Go tests and `npm run build:hook` for darwin and linux
- [ ] 2.3 Inject `FLEET_PANE_ID` in `PtyManager.create`; verify with a pty-manager test and the env-sync tests
- [ ] 2.4 Create `claude-sessions/hook-events.ts` (zod parsing of v1 and v2 payloads) and `phase.ts` (a pure reducer covering subagent stop, question, permissions, epoch on a new session id); verify with table-driven tests
- [ ] 2.5 Create `registry.ts` (list, get, getByPane, events after seq with a 200-entry ring, subscribe, noteInput, pruneDead, dispose clearing timers); verify with unit tests using an injected clock
- [ ] 2.6 Create `pane-resolver.ts` (env pane id validated by `ptyManager.has`, then the `ps` walk fallback, hits-only cache, lazy workspace lookup with retry); verify with unit tests
- [ ] 2.7 Move the socket server to `claude-sessions/hook-server.ts` with a permission broker; move the hook installer; add `ensureHooks` for the default and workspace config folders; verify existing tests pass from the new locations
- [ ] 2.8 Add the `claudeSessions.trackSessions` setting (default on) with removal on turn-off, and ungate `FolderHooks` from darwin; verify with a settings test and by toggling it in the running app
- [ ] 2.9 Add the `index.ts` composition root and wire it in `main/index.ts` on all non-win32 platforms; shrink `copilot/` to the mascot, consuming the registry; move `pane-activity` to an always-on bridge; verify copilot tests pass
- [ ] 2.10 Add the ESLint `no-restricted-imports` boundary for `src/main/claude-sessions/**`; verify `npm run lint` fails on a deliberate bad import, then remove it
- [ ] 2.11 Verify against the installed Claude Code: `transcript_path` is present in hook stdin, `/clear` emits `SessionStart` with a new id, and the shape of `toolUseResult`; record the findings in `docs/learnings/`
- [ ] 2.12 E2E on Linux with copilot disabled: `npm run drive -- up`, run `claude` in a pane with `term-send`, and confirm through `eval` that the registry lists it with the right pane and that the pane activity badge follows its phase

## 3. Phase 2 - status view (PR 3)

- [ ] 3.1 Add `CLAUDE_SESSIONS_LIST` and `CLAUDE_SESSIONS_CHANGED` (coalesced full list) IPC and the preload API; verify with an IPC handler test
- [ ] 3.2 Extract `usage-accumulator.ts` from `aggregateClaudeUsage` and refactor `claude-source` onto it; verify the existing sessions tests pass and a parity test matches
- [ ] 3.3 Add `git-probe.ts` (branch, dirty count, diff stat, fixed argv, timeout, output cap); verify with temp-repo tests
- [ ] 3.4 Put cost and context usage on the session view (throttled, and on Stop), `null` when unknown; verify with unit tests
- [ ] 3.5 Extract `lib/focus-pane.ts` from `App.tsx` and `AgentOverview.tsx` and switch both callers to it; verify focus still works from both
- [ ] 3.6 Add `claude-sessions-store.ts` and `ClaudeSessionsPanel.tsx` in the sidebar (rows, urgency sort, needs-you vs ready styling, idle ticker, click to focus, empty and disabled states); verify with store and sort tests
- [ ] 3.7 E2E with fleet-drive: two panes running `claude`; screenshot the panel in idle, working, permission and question states; check alignment, truncation, and light and dark themes; confirm click to focus

## 4. Phase 3 - read tools (PR 4)

- [ ] 4.1 Add `claude-sessions/transcript.ts` (normalizer and `TranscriptTail` with a turn index and tool byte ranges) and rebuild `conversation-reader` on it; verify its existing tests pass unchanged plus golden JSONL fixtures
- [ ] 4.2 Add `brief.ts` (goal, todos from TodoWrite and TaskCreate/TaskUpdate, plan, files, commands and failures, last assistant text, pending question, usage, per-item rev, delta, render with a cap); verify that incremental and one-pass builds render the same output on the fixtures
- [ ] 4.3 Add `shared/fleet-tools.ts` (schemas, specs, read and act name lists, capability types); add the read names to `SUBAGENT_TOOL_NAMES`; verify `agent-tools.test.ts` asserts that no act tool is in the subagent list
- [ ] 4.4 Add the orchestrator flag on the Agent pane leaf and on `AgentSendRequest`, a composer toggle, a palette command, a header badge, and the system prompt block; verify tools are only advertised with the flag set, with a `toolSpecsFor` test
- [ ] 4.5 Add `agent/fleet/host.ts`, `capability.ts`, and the cursor part of `ledger-store.ts`; wire `ctx.fleet` in `agent-service` (full for orchestrator turns, read-only pick for its subagents, null otherwise); verify with capability tests
- [ ] 4.6 Implement `fleet_sessions`, `fleet_read` (brief, turns, tool; cursor; epoch reset; untrusted fencing; origin marker checked against `noteInput`), and `fleet_diff` (stat, diff, log, file with path confinement); add dispatch cases and tool labels; verify with tool tests including a spoofed prefix and `.env` refusal
- [ ] 4.7 Add the bundled `fleet-analyst` subagent definition, offered only on orchestrator turns; verify a subagent read does not move the parent cursor
- [ ] 4.8 E2E: orchestrator pane lists and reads a live session, and delegates a deep read to `fleet-analyst`

## 5. Phase 4 - act tools and wakeups (PR 5, may split)

- [ ] 5.1 Manually verify bracketed paste plus a delayed `\r` against the installed Claude Code with multi-line text; record the result in `docs/learnings/`
- [ ] 5.2 Add `claude-sessions/input.ts` (`sendPrompt` refusals, draft tracking on renderer PTY writes, keystroke recency, bracketed paste, acknowledgement via `UserPromptSubmit`) and route the copilot chat send through it; verify each refusal and the ack timeout with unit tests
- [ ] 5.3 Add `PermissionGate.checkFleet`, `fleetGrants`, and `Pending.rules` extended with `fleet`, with grants dropped on session removal; add the `AgentPermissionAsk.fleet` payload and the permission card ("Always for this session"); verify with gate tests and a screenshot of the card
- [ ] 5.4 Add ledger entries (required `why` and `expect`, answered and ended transitions) and `withFleetLedger` placed after the cache breakpoint; verify with ledger tests and that it survives compaction
- [ ] 5.5 Implement `fleet_send` with the rate limiter (20 per 10 min per thread); verify it writes `[orchestrator] …` only when allowed
- [ ] 5.6 Add `agent/fleet/renderer-rpc.ts`, a `PendingSpawnStore` consumed in `PTY_CREATE`, `workspace-store.openTerminalTab` (unfocused, preassigned pane id, worktree fields), and `fleet_spawn` with worktree support; refuse on win32 and WSL; verify the prompt is not in the persisted layout and a restart does not re-run it
- [ ] 5.7 Implement `fleet_wait` (attention events after a cursor, immediate return when idle, abortable, timeout) with an active-waits set; verify with unit tests
- [ ] 5.8 Add the `fleet` message role at all touch points and a digest card; verify session-log round trip and rendering
- [ ] 5.9 Add digest rendering in main (brief delta, pending options, ledger line, caps, cursor advance, wait suppression, chain limit), the `AGENT_FLEET_PULL_DIGEST` and `AGENT_FLEET_SET_MODE` IPC, and the renderer `agent-fleet.ts` store mirroring `agent-schedule.ts`; verify with tests for debounce, hold while busy, and the chain limit
- [ ] 5.10 E2E: an orchestrator prompts a session (approve the card), is woken when it stops, and spawns a worktree session; confirm the paused state at the chain limit

## 6. Phase 5 - permission tool (PR 6)

- [ ] 6.1 Add the `ai.agent.orchestrator.answerPermissions` setting (default off) and its settings UI, with help text noting that Claude's own deny list applies before Fleet sees a request; verify with a settings test
- [ ] 6.2 Implement `fleet_permission` (not advertised when off; deny rules apply even under full access; always-ask commands still ask; answers through the permission broker); verify with gate and tool tests
- [ ] 6.3 E2E: a session requests Bash permission, and the orchestrator answers it with the setting on and is refused by a deny rule

## 7. Wrap-up per PR

- [ ] 7.1 For each PR, run `npm run typecheck`, `npm run lint`, `npm test`, `cd hooks/fleet-copilot-go && go test ./...`, and `ripwire . --quality-delta`; all must pass
