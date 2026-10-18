## 1. Phase 1 - Admiral pane and agent mode (PR 1)

- [x] 1.1 Check whether panes in background tabs stay mounted while another tab is shown, with `npm run drive -- up` and an Agent pane in a background tab; write the result in `docs/learnings/`, and add a hidden mount for Admiral panes if they unmount
- [x] 1.2 Add `'admiral'` to `PaneLeaf.paneType` and an `admiralRepo` field in `shared/types.ts`; verify with `npm run typecheck` and a layout-store round-trip test
- [x] 1.3 Add the `agency.enabled` setting (default off) and the "Agency" group in `SettingsNav.tsx` with an `agencyAdmiral` section for model, default budget and monthly cap; verify with a settings test and a screenshot of the nav
- [x] 1.4 Add the "Open Admiral" command and new-pane menu item that resolves the repo root, refuses a non-repo folder, and focuses an existing Admiral for the same repo; verify with renderer store tests and `npm run drive -- cmd`
- [x] 1.5 Add `mode: 'chat' | 'orchestrator' | 'admiral'` to the agent send request, mapped from the saved `agentOrchestrator` flag; verify existing orchestrator tests pass unchanged
- [x] 1.6 Add the Admiral system prompt and an allow-listed tool set (`read`, `glob`, `grep`, `web_fetch`, fleet read tools, agency tools); verify with a test that an Admiral turn is offered no edit, write, bash or background tool
- [x] 1.7 Build `components/admiral/AdmiralPane.tsx` as a pane leaf in `PaneFrame` with the chat on the left, the 380px job sheet on the right, job tabs in the header, and a sheet toggle when narrow; verify with screenshots at wide and narrow widths against canvas boards 3.1 and 3.2
- [x] 1.8 Add `ask_client` and the question card (context, two to four options, recommended pick, free answer), delivered back as a wakeup without blocking; verify with a tool test and by answering a card in the running app
- [x] 1.9 Add the needs-you tab badge and the notification for new questions while the pane is not focused; verify with a store test and a screenshot of the badge

- [x] 1.10 Store one agent session per job plus a lobby session on the leaf, keyed by job id; verify with a store test that a job A wakeup never lands in job B
- [x] 1.11 Resolve repo identity from the realpath of `git rev-parse --git-common-dir` in main, map it to a project member, refuse remote folders, and focus the owning Admiral from a worktree, a submodule or a job workspace; verify with tests using a linked worktree and a submodule
- [x] 1.12 Keep jobs when the pane is deleted, ask keep-or-cancel when closing a pane with running jobs, and list running jobs in the quit guard; verify with quit-guard and store tests
- [x] 1.13 Add question lifecycle: tie questions to plan version and step, withdraw them, mark late answers, and support `dependsOn`; verify with tool tests
- [x] 1.14 Fence crew transcripts, tool results, fetched pages and repo files as untrusted in the Admiral prompt, and refuse any Admiral path that types into a crew pane; verify with a test that injected text cannot change the plan or settings
- [x] 1.15 Keep wakeups queued and retry with backoff on Admiral model errors, then show the "cannot reach its model" card; verify with a test using a failing model client

- [x] 1.16 Build the first-run screen with the Admiral model, crew runtime, and git and GitHub CLI sign-in checks, and disable project picking until a model key is saved; verify with a component test and a screenshot against canvas board 4.1
- [x] 1.17 Build the project picker from workspaces, recent folders, "Open folder" and "Clone from GitHub", with git repos only and per-repo status; verify with tests using a non-repo folder and a repo with no remote, and a screenshot against board 4.2
- [x] 1.18 Add project setup as a read-only Admiral run that returns findings (stack, package manager, worktree setup, checks, required checks, remote), with edit, Import/Ignore for repo `.fleet/` files, saving to `~/.fleet/agency/projects/<project-id>/` and "Share with team" export; verify with a test that setup creates no pane, worktree or branch, and a screenshot against board 4.3
- [x] 1.19 Add the starter questions that write sourced lines to the client file, import rules from `CLAUDE.md` and `AGENTS.md`, and offer the "Open Claude Code here" trust step; verify with a client file test and a screenshot against board 4.4
- [x] 1.20 Add the header project switcher and the empty first-brief state with brief ideas from issues, CI and the changelog; verify with a store test that switching focuses an existing tab, and a screenshot against board 4.5
- [x] 1.21 Add the Admiral chat queue: queued client messages saved at once and added at the next round of a running turn, client messages before wakeups, one turn for the wakeups due for one job with an event line, wakeups kept while the pane is closed, and the lobby-to-job handoff with a link line; verify with store and service tests and with fleet-drive

## 2. Phase 2 - jobs, plans and results (PR 2)

- [x] 2.1 Add `src/main/agency/store/agency-db.ts` (`~/.fleet/agency.db`, WAL, `user_version` migrations) with tables for jobs, plan versions, steps, crew, questions, results, spend and permission answers; verify with migration and CRUD tests in a temp folder
- [x] 2.2 Add the job state machine (briefing, planned, running, waiting, delivered, closed, cancelled, failed) as a pure reducer that writes each change with time and reason; verify with table-driven tests
- [x] 2.3 Add `job_plan` with the plan card (playbook, steps, roles, budget, and per-step deliverables the Admiral picks as `{kind, label}`, with file and link result cards for anything else) and Approve, Edit and Reject; verify that nothing starts before approval with a tool test, and screenshot against canvas board 3.3
- [x] 2.4 Add plan change requests: a step not in the approved plan creates a new plan version that needs approval; verify with a tool test
- [x] 2.5 Add `job_deliver` and result cards for pr, doc, image, copy and preview, opening files in Fleet panes; verify with renderer tests and a screenshot of each kind
- [x] 2.6 Add `job_update` and the PLAN and THE JOB sheet sections bound to the store; verify with a renderer test and in the running app
- [x] 2.7 Add the client file at `~/.fleet/agency/clients/<repo-hash>.md`, read at job start, with `client_file_propose` and an editor in Settings › Agency › Admiral; verify with a test that an answered preference is not asked again
- [x] 2.8 Add job export to Markdown with env file values left out; verify with a snapshot test
- [x] 2.9 Add cancel and close with the cleanup runner (stop crew panes, remove worktrees with no unmerged commits, report leftovers with Retry); verify with tests using fake worktrees and a failing cleanup step

- [x] 2.10 Make `job_plan` return at once with a plan version id, deliver client actions as wakeups, and make only the newest version approvable; verify with tool tests
- [x] 2.11 Add the full state machine with `closing` and `interrupted` and the transition table from design 14; verify with table-driven tests of every allowed and refused move
- [x] 2.12 Pin a base commit at approval, warn on a dirty main checkout, and add a start point to `worktree-service.ts`; verify with tests that two hires apart start from the same commit
- [x] 2.13 Check deliverables before approval and offer a local branch deliverable when a repo has no GitHub remote or `gh` is not signed in; verify with a test
- [x] 2.14 Add plan change effects (stop removed steps) and show them on the change card with the diff from the approved version, withdrawn questions, delivered results and spend so far, keep `replaces` on the crew record, and refuse a budget below spend; verify with tool tests (Swap on crew cards moved to 3.26, since crew cards come with crew hire)
- [x] 2.15 Count automatic Admiral turns per job, reset on client actions and finished steps, and show the continue card at 20; verify with limiter tests
- [x] 2.16 Add the startup reconcile: mark lost steps `interrupted`, digest to the Admiral, and show Resume or Cancel; verify with a test that seeds a running job and no panes
- [x] 2.17 Show path overlap with other running jobs on the plan card and ask queue or parallel; add the concurrent crew limit (default 4) with a queue; verify with tests
- [x] 2.18 Make cleanup one idempotent runner with a Leftovers list, join on double close, resume at startup, retry when online, and keep worktrees with uncommitted, untracked or unmerged work; verify with tests
- [x] 2.19 Copy delivered files into `~/.fleet/agency/jobs/<id>/results/` in `job_deliver`; verify with a test that close never loses a delivered file
- [x] 2.20 Add client file entry dates and sources, contradiction handling, the outside-change warning and the size-cap cleanup proposal; verify with tests
- [x] 2.21 Refresh PR result cards on show and at close and mark changes after delivery; verify with a test against recorded GitHub responses

- [x] 2.22 Add workspace projects: `projects` and `project_members` tables, detection from `.gitmodules` or a folder of repos in the picker with members that can be left out, missing submodule checkout, and per-member setup findings with member order; verify with tests on a fixture umbrella with three submodules and a fixture folder of two repos
- [x] 2.23 Add job workspaces across members: per-member base commits, one branch name in every changed member, umbrella worktree with member worktrees in the submodule paths, read-only members never pushed, and per-member cleanup; verify with tests that a step changing two of three members gets the right checkouts and branches
- [x] 2.24 Deliver one linked PR per changed member, merge one at a time in member order after checks on the updated base, and open the umbrella pointer bump PR last; verify with a test against recorded GitHub responses
- [x] 2.25 Find required checks and review bots at setup, wait for both before a PR is ready, send bot comments to the fix step, and show open comments on the result card; verify with tests against recorded GitHub responses
- [x] 2.27 Add `settings_read` and `settings_change` over a zod schema of every setting key, with kinds `apply`, `approve` and `client-only` chosen by key and direction, change cards with Undo, settings change cards with per-change Approve, `settings_history`, and "Changed by the Admiral" with Undo in Settings; verify with tool tests that a widening change never applies without a card and that an injected request only opens a card
- [x] 2.28 Add "Ask the Admiral" to each Settings › Agency page and to project setup, opening the project's Admiral with the page and request; verify with `npm run drive` steps and screenshots

Phase 2 notes:

- 2.23: the job workspace builder is done and tested; crew hire in Phase 3 (3.6, 3.15) is what calls it.
- 2.24: member PRs merge with squash in member order; a PR whose checks ran before the last merge gets one rerun, and the umbrella bump PR merges last.
- 2.24: a merge run ends when its job leaves `delivered`, and Accept is refused while a merge runs.
- 2.25: there is no separate fix step kind; new bot comments go to the Admiral, fenced, naming the step that delivered the PR, and Phase 3 crew briefs carry them.
- 2.25: a required check not started 15 minutes after the newest commit is an Admiral event that leads to `ask_client`.
- 2.25: open comments are unresolved threads a bot started, outdated ones included; they show on the card and do not block the merge.
- 2.25: Merge is off while any open PR waits on a required check or a review bot.
- The end-to-end run in a fixture workspace (was 2.26) moved to 3.27, since it needs crew hire to open the PRs.

## 3. Phase 3 - crew roles, playbooks and runtimes (PR 3)

- [x] 3.1 Add zod frontmatter schemas for roles and playbooks in `shared/agency-crew.ts`; verify with schema tests for valid and invalid files
- [x] 3.2 Add `src/main/agency/crew/` loaders over `loadDefinitions` for `resources/crew/`, `~/.fleet/crew/` and `~/.fleet/agency/projects/<project-id>/crew/`, with role-name and wait-cycle checks; verify with loader tests for precedence, unknown roles and cycles, and check `resources/crew/` ships in a packaged build per `docs/learnings/2026-06-28-chat-skills-missing-from-packaged-app.md`
- [x] 3.3 Write the bundled roles (architect, builder, reviewer, qa, strategist, copywriter, designer, editor) and playbooks (engineering, bug-fix, launch); verify they load with no errors in a test
- [x] 3.4 Add the `CrewRuntime` adapter with `claude` and `eva` implementations and an availability check that disables Approve for a missing runtime; verify with unit tests of the built command lines, including that `claude` never gets `-p`, `--print` or `ANTHROPIC_*` env
- [x] 3.5 Extend the renderer `openTab` request with "split into job tab" so each job has one unfocused tab of crew panes; verify with a renderer test and a screenshot
- [x] 3.6 Add `crew_hire` and `crew_send` over `spawnSession` and `sendToSession`, auto-approved only for steps in the approved plan, with job-scoped chain and rate limits; verify with tool tests for in-plan, out-of-plan and limit cases
- [x] 3.7 Add the CREW sheet section with role, runtime, status and peek that focuses the pane; verify in the running app
- [ ] 3.8 Let the Admiral propose a new role in a plan and save it in the project's crew folder only on approval; verify with a tool test
- [ ] 3.9 Add Settings › Agency › Crew (role and playbook lists, source, errors, open file) matching canvas boards 3.4 and 3.4b, with the role editor: runtime cards with status, a runtime switch that resets the model, Save and Discard, the Model list per runtime (Claude Code names, eva server models with tool calls, missing-model state); verify with a screenshot and a round trip to the role file
- [ ] 3.25 Add the Runtimes tab to Settings › Agency › Crew matching canvas board 3.8: for Claude Code and eva the path, version, checks, models with roles, default model, crew at once and the Test button; the Claude Code login state without reading it; eva's model server without its key; verify with a test that no credential reaches the renderer, and with a screenshot
- [ ] 3.26 Add Swap on crew cards with "Continue its work" (same workspace, handoff brief) and "Start over" (new branch), stop-before-start, and an Admiral-proposed swap on `limited`; verify with tool tests for swap-continue, swap-restart, the proposed swap, and a role edit that does not reach a running job
- [ ] 3.27 End to end (was 2.26): in a fixture workspace modeled on `Fola-Fi/fola-journey` (umbrella, three submodules, SSH submodule URLs, fixed Postgres port), brief a change across two members, approve, and see linked PRs and the bump PR; verify with `npm run drive` steps and screenshots
- [ ] 3.10 End to end: brief a small bug fix in a test repo, approve the plan, and see a Claude Code Builder start in a TUI pane, get its brief typed in, and a Reviewer follow; verify with `npm run drive` steps and screenshots

Phase 3 notes (decisions made while building):

- A role is `name`, `description`, `runtime` (`claude` default, or `eva`), optional `model` and `stack`, in a strict frontmatter so a misspelt key is an error. Playbook steps are `id`, `role`, `count`, `after`, `gate: client`, `workspace` (`new`, `{of}`, `{integrate}`) and `scopes`.
- A playbook is checked at load: its wait graph (with workspace reads), its roles, that a step waits for any step whose output it works in, and that `count` > 1 has one scope per member and a later integrate step. A bad playbook is left out and listed with the file errors.
- The approval keeps a snapshot of the roles and playbook in `plan_versions.snapshot_json` (the column v3 already had), so no migration was needed. A plan whose step names a role the crew does not have gets an `unknown-role` block.
- The Admiral gets the crew roles and playbooks in its round note, in a fence, since crew files can come from a teammate's repository.
- 3.14: an imported file keeps the project copy until the client takes the repository's newer version (`updates`); setup shows "Newer in the repo" with a diff. Setup is onboarding only, so Settings > Agency > Crew (3.9) shows the same row for a project already set up.
- Crew panes are unfocused splits in one job tab. The job `--settings` file carries the global hook command, including `PermissionRequest` and `StopFailure`; the Admiral answers permission prompts in Phase 5.
- Limits: nudge 2, stuck after 10 minutes with no hook event, step wall clock 90 minutes, and per-runtime limits (claude 2, eva 4 remote or 1 local) under the job and global limit of 4.
- The live setup file for 3.16 is the project folder's `fleet.agency.toml`, not the repository's `.fleet/` copy.
- 3.4: a step's runtime is its own, else its role's. The plan check runs the availability check only for the runtimes a plan uses, and a missing or too old runtime is a `runtime-unavailable` block, so Approve stays off.
- 3.12: the job file also sets `editorMode: normal`, since it outranks a user's vim mode. Only managed settings can turn vim back on, which is a warning.
- 3.13: a bypass `defaultMode` is a warning, not a block, because `disableBypassPermissionsMode` is a lock the strictest file wins. `disableAllHooks` is a block: Fleet does not override that choice from the job file.
- 3.21: Fleet never reads `~/.claude.json`. It learns that a folder is trusted when a Claude Code session reports from it (`claude_trust`, v7). The plan card offers "Open Claude Code there" for an untrusted folder. Trust carries to worktrees, as checked end to end.
- eva has no `--model` flag, so a model goes in `CHAT_MODEL`. A crew statusLine waits for 6.4.
- 3.6: a step has at most one live crew member, and each hire gets a new workspace. A hire for an `interrupted` step whose last member was lost at restart resumes it with `--resume` in the same worktree, conversation and label.
- 3.6: every typed prompt starts with `[admiral]`. `crew_send` to eva is refused until Phase 4 can track its turns. Crew acts are refused while the job has a `chain_limit` hold.
- 3.17: exit code 0 or a close by the client marks the step `stopped`, any other exit `failed`. The Admiral gets a `rehire` card (Hire again / Leave it) and a wakeup. `crew_stop` leaves the step `running`, so the Admiral may hire again.
- 3.5: job tabs are dropped at startup, since their panes do not outlive Fleet.
- 3.20: long briefs go as a file. The hook sends only a sha256 of the trimmed prompt (protocol 3), never the text. A typed prompt with a different hash fails the send, and it is not typed again. A hash Claude Code submits on its own (a scheduled task, a subagent report) does not count. The first prompt goes as a CLI argument, not typed, so it is not compared. An older hook with no hash acknowledges as before.
- 3.15: a plan step has `workspace` (`new` by default, `{of}`, `{integrate}`) and an optional `scope`. A `new` step merges its `after` steps' branches, and `{integrate}` merges the ones it names. A conflict aborts the merge, names the files, and fails the hire.
- 3.15: an `{of}` step works in the other step's worktree and is told to change and commit nothing. The scope rule covers only code steps: steps that hand back a branch or PR, or whose branch a later step merges. Two such steps side by side in a shared member need different scopes.
- 3.16: setup runs once per new workspace, member setups in member order, then the workspace setup at the root for an umbrella or folder project. Each run has its own timeout and log under `jobs/<id>/setup/`, and the first failure fails the hire with the last 12 lines. A crew member in a one-member step of an umbrella starts in that member's folder.

- [x] 3.11 Check every Claude Code flag and settings key in design 7 (`--session-id`, `--append-system-prompt`, `--permission-mode`, `--settings`, `--add-dir`, `disableBypassPermissionsMode`, `PermissionRequest`, `StopFailure`) against the Claude Code docs through Context7, and record the minimum version in `docs/learnings/`
- [x] 3.12 Build the job `--settings` file (AskUserQuestion denied, `disableBypassPermissionsMode`, Fleet hooks with the global command string including `PermissionRequest` and `StopFailure`); verify with snapshot tests
- [x] 3.13 Deepen `available()`: the pane's own PATH and shell, `--version` minimums, bypass mode, `disableAllHooks`, hook protocol, vim warning; verify with unit tests
- [x] 3.14 Add the project folder `~/.fleet/agency/projects/<project-id>/` (hash of repo identity) with `fleet.agency.toml` and `crew/`; import repo `.fleet/` files from the default branch of the main checkout with a diff, store the imported hash and show "newer version in repo", export with "Share with team" without committing, and snapshot into the approved plan; verify with tests that a crew edit, a fresh clone and a teammate's new commit change nothing until import
- [x] 3.15 Add step workspaces (`new`, `of`, `integrate`), one writer per worktree, scopes for `count` > 1, and merging of `after` branches; verify with tests on a temp repo
- [x] 3.16 Name branches `admiral/<job-id>/<step>-<n>`, fail the plan check on a branch named `admiral`, run `.fleet/fleet.agency.toml` setup with a timeout, and run each member's setup and the workspace setup; verify with tests
- [x] 3.17 Run crew with `exitOnComplete: true`, and on exit or close mark the step, and wake the Admiral; verify with a pty-manager test that no shell is left
- [ ] 3.18 Add `fleet agency done` over the socket, idle-versus-done handling and the nudge limit; verify with socket and tool tests
- [ ] 3.19 Add crew states `needs you`, `limited`, `user-driven` and `stuck`, the read-only last-screen read, and `crew_interrupt` and `crew_stop`; verify with registry and tool tests
- [x] 3.20 Compare `UserPromptSubmit` text with the typed prompt, fail on mismatch, and pass long briefs as a file via `--add-dir`; verify with input tests
- [x] 3.21 Add the one-time folder trust step and check end to end whether trust carries down to new worktrees; record the result in `docs/learnings/`
- [ ] 3.22 Find port variables and fixed host ports at setup, give each job workspace a free port block, set port variables in the pane env, show server addresses on the job sheet, and hold stack slots for `stack: true` steps; verify with tests for two jobs and one slot and a port held by an outside process
- [ ] 3.23 List untracked env files with names only, copy the chosen ones into new worktrees with mode 600, block paths git does not ignore, and add values to the env redaction; verify with tests that a crew edit never changes the user's file
- [ ] 3.24 Find `CLAUDE.md`, `AGENTS.md`, `.claude/agents`, `.claude/skills` and `.opencode/agents` at setup, import agent files as roles, and tell the Admiral which skills each working folder exposes; verify with loader tests and check in Claude Code which skills load from a member subfolder, recording the result in `docs/learnings/`

## 4. Phase 4 - eva session tracking (PR 4, needs khang859/eva#9, #10, #13, and #12 for hook permission answers)

- [ ] 4.1 Add a `--runtime eva` argument and protocol 3 fields (`runtime`, `db_path`, `last_record_id`) to the Go hook; verify with Go tests and `npm run build:hook` for darwin and linux
- [ ] 4.2 Accept protocol 3 in `hook-events.ts` and store `runtime` on registry sessions, ignoring unknown protocols with one log line; verify with parser and registry tests
- [ ] 4.3 Add `EvaTranscriptSource` that opens `sessions.db` read-only, checks the `transcript_v1` view version, and reads records after the cursor into `SessionTranscript`; verify with tests against a fixture database made from eva's schema
- [ ] 4.4 Fall back to phase-only tracking with an "update eva" message when views are missing; verify with a fixture without views
- [ ] 4.5 Send eva permission requests to the Admiral and return its answer through the Go hook's reply, with "answer in pane" when eva cannot take hook answers; verify with a hook-server test and a Go test
- [ ] 4.6 End to end: hire an eva role in a test repo and see it in CREW, read its turns, and wake the Admiral on `Stop`; verify with `npm run drive` steps

- [ ] 4.7 Accept eva `db_path` only for eva's own database, and read with `fileMustExist`, a busy timeout and one short transaction per read; verify with tests
- [ ] 4.8 Never pass eva's bypass flag, use the user's eva permission settings, and resume eva by session id; verify with command-line tests

## 5. Phase 5 - permission answers (PR 5)

- [ ] 5.1 Add a `PermissionRequest` hook entry to the crew `--settings` and a Go hook verb that holds the request on the socket for up to 300 seconds; verify with Go tests and a hook-server test
- [ ] 5.2 Add `permission_answer` (allow, deny or ask the client, with a reason) and the Admiral prompt rules for in-plan, out-of-plan and hard-to-undo requests, and put permission requests ahead of other wakeups; verify with tool tests and prompt tests over recorded requests
- [ ] 5.3 Add the permission card in WAITING ON YOU, bound to its exact target, expiring as denied, switching to "answer in pane" after the hook hold, and sent straight to the client while the Admiral is paused; block typing into a pane that shows a permission prompt; verify with tests and a screenshot against canvas board 3.2
- [ ] 5.4 Write every permission answer to `agency.db` with who answered and why, show it as a chat line, and include it in the job export; verify with store tests
- [ ] 5.5 Add the env value Redactor (ANSI strip, chunk hold-back) over `fleet_read`, transcripts, agency tool output and the logger; verify with tests for a value split across chunks
- [ ] 5.6 End to end: a Claude Code Builder asks to push its branch and the Admiral allows it, and a QA crew member asks to deploy to production and the client gets a card; verify with `npm run drive` steps and screenshots

## 6. Phase 6 - budgets and spend (PR 6)

- [ ] 6.1 Add the spend sampler for Admiral cost, Claude crew usage from the status line `rate_limits` (and `cost` when no `rate_limits`), and eva cost when reported; verify with tests using fake sessions
- [ ] 6.2 Enforce the job budget and monthly cap before `crew_hire` and `crew_send`, with the 80% notice and the raise-or-stop card; verify with tool tests
- [ ] 6.3 Add the SPEND sheet section with per-crew spend, estimate markers and the warning color; verify with a screenshot

- [ ] 6.4 Split the dollar meter from the subscription usage meter, add the `statusline` verb to the Go hook and the `statusLine` entry in crew `--settings`, split weekly-percentage rises across jobs, add the per-job weekly share and the 5-hour and weekly reserve settings, with presets and a validated Custom value for both budgets in Settings, the starter question and the plan card, require acceptance for unknown-cost steps, and state that cloud costs are not counted; verify with Go tests for the verb, tests with fake `rate_limits` for the split and the reserve, and a screenshot
- [ ] 6.5 Reserve budget in one SQLite transaction before crew acts and Admiral turns, stop at 100%, interrupt at 120%, and reset the monthly cap in local time; verify with concurrency tests

## 7. Release

- [ ] 7.1 Turn `agency.enabled` on by default and write user docs for the Admiral, project setup, import and "Share with team", including that crew are not sandboxed; verify docs build and the setting default test
- [ ] 7.2 Run `npm run typecheck`, `npm run lint`, `npm test`, the Go hook tests and `ripwire . --quality-delta` with no new problems
