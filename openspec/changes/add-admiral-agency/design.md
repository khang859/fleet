## Context

See proposal.md for motivation; the specs hold the requirements.
The canvas at https://claude.ai/artifact/14G6yM3dmLdAppbhU8fnM3 (page "Design 3") holds the screens: 3.1 plan, 3.2 running job, 3.3 plan with team, 3.4 crew settings, 3.5 one job across many repos, 3.6 settings changes, 3.7 and 3.9 plan changes, 3.8 crew runtimes.
Its page "Getting started" holds the onboarding screens: 4.1 first run, 4.2 pick a project, 4.3 project setup, 4.4 starter questions, 4.5 ready for a first brief.

The current state that shapes this design:

- **Orchestrator (`add-claude-session-orchestrator`, done, not archived).**
  `src/main/agent/fleet/` has the `fleet_*` tools behind `createFleetCapability` (`capability.ts`).
  `fleet_spawn` (`spawn.ts`) asks the user, makes an optional worktree, asks the renderer for an unfocused tab, and types the prompt through `FleetSpawns`.
  `fleet_send` asks the user for every prompt.
  The ledger is JSON per agent session (`ledger-store.ts`), with a chain limiter and wakeups (`attention.ts`, `digest.ts`).
- **Session registry (`src/main/claude-sessions/`).**
  The Go hook sends events over a unix socket (`hook-server.ts`), parsed by `hook-events.ts` (protocol 1 and 2).
  `FLEET_PANE_ID` maps a session to its pane.
  Transcripts are JSONL files read by `transcript.ts` and summed by `usage-accumulator.ts`.
- **Agent pane.** One engine (`agent-service.ts`) with tools as nullable capabilities on the tool context.
  Main never starts a turn; the renderer pulls due work.
  The model runs on the user's OpenRouter or local endpoint key (`openrouter-secrets.ts`, `safeStorage`).
- **Markdown definitions.** `markdown-definitions.ts` loads bundled, user and project folders with project winning; subagents use `.fleet/agents/`.
- **Secrets.** `agent/mcp/secrets.ts`, `env-sync/env-sync-secrets.ts` and `openrouter-secrets.ts` each wrap `safeStorage` over `electron-store`.
- **PTY env.** `PtyManager.create` takes `env` and `envSources` (provenance shown in the env inspector).
- **SQLite.** `better-sqlite3` is used by `learnings/learnings-store.ts`.
- **Tool panes.** `ToolPaneFrame.tsx` is the card for whole-tab tools; `paneType` is `'terminal' | OpenablePaneType | 'agent' | 'ssh-browser'`.
- **eva** stores sessions in `~/.eva/sessions.db` (WAL, `records` table with a growing id).
  It has no hooks, start flags, stable views, or permission answers yet (khang859/eva#9 to #16).

## Goals / Non-Goals

**Goals:**

- The Admiral is the Agent engine with a different prompt and tool set, not a second agent engine.
- Crew are ordinary Fleet terminal panes, so the user can always see and type into them.
- Crew use the user's own access, and the Admiral answers their permission prompts, sending anything outside the plan or hard to undo to the user.
- Each phase ships alone and is useful alone.

**Non-Goals:**

- Sandboxing crew processes or limiting their access. Crew run as the user, with the user's access (see Risks).
- Windows support (same limit as `fleet_spawn`).
- Remote or cloud crew, and crew over SSH.
- Fleet-made service keys, a credential broker, or access rules.
- Kanban or board views.
- Running Claude Code headless in any form.

## Decisions

### 1. Admiral is an Agent engine mode with its own pane

The `admiral` pane is a new React component in `components/admiral/`, rendered as a pane leaf inside `PaneFrame` like the Agent pane, that drives a normal agent session.
The leaf keeps `admiralRepo` and a map from job id to agent session id, plus one lobby session for new briefs.
One agent session per job keeps wakeups and compaction from mixing jobs.
Jobs belong to the repo in `agency.db`, not to the pane: deleting the pane does not delete jobs.
Repo identity is the realpath of `git rev-parse --git-common-dir`, so the main checkout and its worktrees (including crew worktrees) resolve to one member, and each member belongs to one project with one Admiral (decision 16).
The one-per-repo check runs in main, not only in the renderer store.
`agent-service.ts` gets a `mode: 'chat' | 'orchestrator' | 'admiral'` on the send request, replacing the boolean `agentOrchestrator` internally (the leaf field stays for saved layouts).
Admiral mode picks the Admiral system prompt and the tool set: `read`, `glob`, `grep`, `web_fetch`, the fleet read tools, and the new agency tools.
The tool list is built from an allow list, so a tool added to the engine later is not offered to the Admiral by accident.

The Agent engine drops a send while a turn runs (`agent-store.ts` `send` returns when `streamId` is set), and an Admiral is busy often, so Admiral mode adds a queue per thread; other Agent panes keep today's behavior.
A queued client message is saved in the session at once, marked `queued`, and `agent-service.ts` adds it as a user message at the next round of the running turn, between tool rounds.
Wakeups stay in `agency.db` until the renderer pulls them, which it does only when the thread is idle and its queue is empty; all wakeups due for one job run as one turn that opens with an event line.
`job_plan` from the lobby makes the job row and a new agent session seeded with the lobby messages since the last handoff, and writes a link line into the lobby.
The lobby gets the read side of the agency tools across all jobs, and no tool that changes a job.

_Alternative:_ a separate Admiral process or engine.
Rejected: it would duplicate streaming, cost tracking, sessions, compaction and model routing.

### 2. Agency tools

New tools in `shared/agency-tools.ts` with handlers in `src/main/agency/tools/`:

- `job_plan` - propose or revise the plan; it renders a plan card and returns at once with a plan version id; the client's action arrives as a wakeup.
  No tool call ever waits on the client, so the client can always chat, and a quit never leaves a tool call without a result.
- `crew_hire` - start one plan step's crew member; wraps `spawnSession` with a role runtime and job env.
- `crew_send` - prompt a crew member of this job; wraps `sendToSession`.
  It refuses while the pane has a pending permission prompt, and while the crew member is `user-driven`.
- `crew_interrupt` - send Esc to a crew member's running turn.
- `crew_stop` - end a crew member.
- `permission_answer` - answer a crew permission request with allow, deny or ask the client, and a reason (decision 8).
- `ask_client` - add a question card; returns at once with a question id; the answer arrives as a wakeup.
  It takes an optional `dependsOn: { question, option }`, and is tied to a plan version and step.
- `job_deliver` - post a result card, copying files into `~/.fleet/agency/jobs/<id>/results/`; the Admiral sets each plan step's `delivers` as `{kind, label?}` items, a bare kind string is short for `{kind}`, and `file` and `link` are the open-ended kinds, so a new kind of result never needs new Fleet code.
- `job_update` - set step status and post short progress notes.
- `client_file_propose` - propose a client file addition.
- `settings_read` and `settings_change` - read and change project and agency settings (decision 17).

The fleet read tools (`fleet_sessions`, `fleet_read`, `fleet_diff`, `fleet_wait`) are reused as they are, filtered to the job's crew.
For a crew pane that has not reported yet, `fleet_read` returns the last screen text, read only, with env file values replaced, so the Admiral can see a login or trust screen.

Each Admiral turn starts with a job snapshot read from `agency.db`: the approved plan version, base commit, step status, open questions with their options, and budget left.
A wakeup for an answer repeats the full question and options.
This keeps job facts alive through compaction.

Crew report the end of a step with `fleet agency done --status done|blocked|question --summary <text> [--deliver <path>]`, a new `fleet` CLI verb over the existing socket, with `FLEET_PANE_ID` naming the crew member.
A `Stop` with no report means idle, not done.
The Admiral may nudge an idle crew member a set number of times, and then the step becomes `blocked`.
Role instructions tell crew to use it, and to ask questions in their final message instead of with AskUserQuestion, which job settings deny.

### 3. Approval moves from each action to the plan

The Orchestrator asks for every prompt.
An Admiral that asks for every prompt is not autonomous.
So inside an approved job, `crew_hire` and `crew_send` to that job's crew run without a card, as long as the step is in the approved plan.
Anything outside the plan (a new step, a new role, a session not in the job) goes back to the client as a plan change.
The chain limiter still applies, but counted per job instead of since the user last wrote, and reset by any client action and by each step completion.
The default job limit is 20 automatic turns.
At the limit the job goes to `waiting` with a "paused after 20 automatic turns, continue?" card.
All prompts are still written to the ledger with `why` and `expect`.

Authority never comes from text the Admiral reads.
Crew transcripts, tool results, fetched pages and repo files are fenced as untrusted data in the Admiral prompt.
A plan change and a client file change need a client card.
The Admiral answers permission prompts only through `permission_answer` (decision 8), never by typing into a pane.

### 4. Jobs live in SQLite

A new `~/.fleet/agency.db` (better-sqlite3, WAL, `user_version` migrations, like the learnings store) holds jobs, plans and plan versions, steps, crew members, questions, results, spend samples, and permission answers.
The client file is Markdown at `~/.fleet/agency/clients/<repo-hash>.md`, so the user can edit it by hand.

_Alternative:_ JSON files like the ledger.
Rejected: the monthly cap needs queries across jobs, and several writers (tools, the hook server, cleanup) touch the same job.

### 5. One tab per job for crew panes

Each job gets one Fleet tab, labelled with the job name, opened without focus in the Admiral's workspace.
Crew panes are splits inside that tab, labelled `<role> <n>`.
Peek focuses that pane.
The renderer request goes through the existing `openTab` request/reply path in `spawn.ts`, extended with a "split into tab X" form.

Crew panes run the runtime with `exitOnComplete: true`, so no plain shell is left after the runtime exits.
When the runtime exits or the pane closes, Fleet marks the crew member ended, and wakes the Admiral.

Approval pins a base commit per member, shown on the plan card: the member's default branch tip by default, or current HEAD if the client picks it.
A dirty main checkout shows a warning, because uncommitted changes are not in the base.
`worktree-service.ts` gains a start point argument.
Branches are `admiral/<job-id>/<step>-<n>`, with `n` never reused, so a re-hire or a cancelled job never collides.
The plan check fails if a branch named `admiral` exists in any member, since git cannot have both `admiral` and `admiral/...`.

After a job workspace is made (decision 16), Fleet copies the chosen env files and runs each member's setup from `~/.fleet/agency/projects/<project-id>/fleet.agency.toml` (`setup` command, `submodules`, timeout), then the workspace setup, before the crew starts.
A failed setup makes the step `blocked` with the log.
Each job workspace gets its own port block (decision 16), so dev servers do not collide.
A global and per-job limit on concurrent crew (default 4) queues extra steps.

_Alternative:_ truly hidden PTYs with no layout entry.
Rejected: the user would lose the ability to watch or type into crew, and session mapping depends on panes.

### 6. Roles and playbooks reuse the Markdown loader

`src/main/agency/crew/` loads `crew/roles/*.md` and `crew/playbooks/*.md` from `resources/crew/`, `~/.fleet/crew/`, and `~/.fleet/agency/projects/<project-id>/crew/` with `loadDefinitions` and zod frontmatter schemas in `shared/agency-crew.ts`.
Playbook validation checks role names and wait cycles at load time.
Example role:

```markdown
---
name: builder
description: Writes and tests code for one well-scoped step.
runtime: claude
model: sonnet
---

You build one step of an approved plan...
```

Example playbook step list:

```yaml
steps:
  - { id: design, role: architect, gate: client, workspace: new }
  - {
      id: build,
      role: builder,
      count: 2,
      after: [design],
      workspace: new,
      scopes: [server, client]
    }
  - { id: integrate, role: builder, after: [build], workspace: { integrate: [build] } }
  - { id: review, role: reviewer, after: [integrate], workspace: { of: integrate } }
  - { id: qa, role: qa, after: [review], workspace: { of: integrate } }
```

Step workspaces:

- `new` - a fresh worktree from the base commit merged with the branches of the steps in `after`.
- `{ of: <step> }` - read-only use of another step's worktree.
- `{ integrate: [steps] }` - a fresh worktree that merges those steps' branches.

At most one writer per worktree.
A step uses only the committed outputs of the steps in its `after`, so each step commits its output.
A step with `count` > 1 needs disjoint `scopes` and an `integrate` step after it, unless the plan says one PR per builder.

Project settings live in Fleet, not in the repo: `~/.fleet/agency/projects/<project-id>/` holds `fleet.agency.toml` and `crew/`, where `<project-id>` is a hash of the project root (decision 16).
The folder mirrors the repo `.fleet/` layout, so "Share with team" is a copy into the main checkout (never committed), and import is a copy back.
Repo `.fleet/` files are suggestions read from the main checkout at the default branch tip, never from a crew worktree.
They change nothing until the user imports them; Fleet stores the imported hash and shows "newer version in repo" when the default branch differs.
_Alternative:_ rules only in committed `.fleet/` files. Rejected: setup would need a commit before the first job, and anyone with push access could change how crew work.
At approval, the plan stores a snapshot (content and hash) of every role and playbook it uses, and the job uses only that snapshot.

### 7. Runtimes behind one adapter

A `CrewRuntime` adapter has `available()`, `command(role, step, job)`, and `firstPrompt(role, step)`.

- **claude:** the pane command is `claude` with only interactive flags:
  - `--session-id <uuid>` that Fleet picks and stores, so the session maps to the crew member without guessing and can be resumed;
  - `--model` when the role sets one;
  - `--append-system-prompt` with the role body, so it survives `/clear` and compaction;
  - `--permission-mode default`, or `--permission-mode auto` when the client turns on `agency.crew.claude.permissionMode` (only the client turns it on; the Admiral can only turn it off);
  - `--settings <job file>` with: `deny` for AskUserQuestion; `disableBypassPermissionsMode`; Fleet's hook entries with the same command string as a global install, so Claude Code drops duplicates, including a `PermissionRequest` hook that sends each prompt to the Admiral; a `StopFailure` hook; and a `statusLine` command (the Go hook binary's `statusline` verb) that forwards `rate_limits` and `cost` to Fleet and prints the job and step.
    In auto mode the job file also denies `Bash(git push*)`, `Bash(gh pr create*)`, `Bash(gh pr merge*)` and `Bash(gh pr review*)`, and adds `autoMode.hard_deny` with `"$defaults"` and Fleet's boundaries: no pushes or pull requests, no writes outside the working folder and its `--add-dir` folders, no deploys or cloud changes.
    All other permission rules come from the user's own Claude Code settings.
    The step brief is typed as the first prompt through `FleetSpawns`.
    A brief over about 4k characters goes in a brief file in a folder passed with `--add-dir`, and the typed prompt points to it.
    No `-p`, no SDK, no `ANTHROPIC_*` env, and Fleet never writes the Claude config folder or `~/.claude.json`.
    Every flag and settings key here is checked against the Claude Code docs for the minimum supported version before phase 3 ships.
- **eva:** the pane command is `eva --session-id <id> --name <job/role> --goal <brief> --model <model> --instructions <role file>` (eva #13, #15 and the new issues), with eva hooks pointed at Fleet's hook binary (eva #9).
  Fleet passes `-b` only when the client turns on `agency.crew.eva.permissionMode`, and then with `--permissions <file>` that denies `bash(git push*)`, `bash(gh pr create*)`, `bash(gh pr merge*)` and `bash(gh pr review*)`.
  Otherwise eva uses the user's own permission settings.
  Without eva #12, eva asks in its own pane, and the card says to answer there.
  Later prompts use bracketed paste.

`available()` resolves the binary with the pane's own shell and PATH, reads `--version`, and checks a minimum version and the needed capabilities per runtime.
It refuses `claude` when the effective permission mode would be bypass, when `disableAllHooks` is set, or when the hook binary is older than protocol 2.
It warns when Claude Code vim mode is on, since typed text in NORMAL mode runs as commands.

Before the first `claude` hire in a repo, the plan shows a one-time trust step: Fleet opens Claude Code in the repo's worktree base so the user accepts folder trust.
Task 3.10 checks whether trust carries down to new worktrees; if not, the plan card says each `claude` hire needs one click.

Prompt delivery is checked: Fleet compares the `UserPromptSubmit` text with what it typed, and a mismatch is a failed send with no automatic retry.

Crew states beyond the session phase:

- `limited` - a `StopFailure` with a rate or usage limit; Fleet sends nothing to it before the reset time, pauses new `claude` hires, and the Admiral may propose an eva swap as a plan change;
- `user-driven` - the user typed into the pane, pressed Esc, ran `/clear`, or changed the mode; the Admiral does not send to it until the user hands it back from CREW;
- `stuck` - no transcript growth for a set time, or past the step's wall-clock limit; this wakes the Admiral, which can interrupt or stop it;
- `needs-you` - not reported within 60 seconds of start; a WAITING ON YOU card says "needs you in its pane" with Peek, and Fleet does not type into it.

The job files live under Fleet's app data folder, never in the worktree.

### 8. Crew use the user's access, and the Admiral answers permission prompts

Crew panes get the user's environment, like any Fleet terminal pane, so `git`, `gh`, `aws` and other tools use the user's own logins.
Fleet makes no keys and stores no service credentials.

Each runtime keeps its own permission prompts.
Claude Code's `PermissionRequest` hook and eva's permission hook (eva #12) send each request to Fleet's Go hook binary, which holds it on the socket while Fleet decides.
Fleet wakes the job's Admiral with the request: the action, the exact target (command, file, branch or URL), the crew member and the step.
Permission requests go before other wakeups, because crew wait on them.
The Admiral answers with `permission_answer({ request, decision: 'allow' | 'deny' | 'ask_client', reason })`.
Its prompt says to allow what the step in the approved plan needs, to ask the client about anything outside the plan or hard to undo (production deploys, deletes of data or cloud resources, pushes to a default branch, merges, spending money), and to deny what goes against the plan.
`ask_client` posts a permission card in WAITING ON YOU with the request and the Admiral's reason.
A card binds to its exact target and is void if the target changes.
An unanswered card expires as denied after a set time, and a timeout never allows.
The Go hook holds a request for 300 seconds; after that the runtime falls back to its own prompt in the pane, and the card switches to "answer in pane".
Fleet never types into a pane that shows a permission prompt.
Each answer goes to `agency.db` with who answered and why, and shows in the chat as one short line, such as "Allowed Builder 2: git push admiral/j42/builder-2-1 · fits step 3".

This is the Admiral's judgment, not a lock.
The approved plan, client cards for risky requests, and the deny rules in the user's own Claude Code and eva settings are what stand between crew and a mistake.

The client can trade the Admiral's judgment for speed, per runtime, in Settings > Agency > Crew:

- Claude Code auto mode: the auto-mode classifier judges each call that the rules do not settle, with Fleet's `hard_deny` boundaries. Calls it blocks fire `PermissionDenied`, not `PermissionRequest`, so they never reach the Admiral, and calls it allows leave no job-log record.
- eva bypass: every call runs unasked except the push and pull request deny rules. eva's `PermissionRequest` hook never fires, so no eva crew request reaches the Admiral. eva has no classifier and no rule for "outside the worktree", so writes outside the worktree and deploys are not held.

### 9. Env file values stay hidden

Fleet replaces the values of chosen env files with `[redacted:env]` in text the Admiral reads (`fleet_read`, transcripts, tool output) and in Fleet logs.
It runs after ANSI strip and line unwrap, and holds back the longest value length minus one character on streams, so a value split across PTY chunks still matches.

### 10. eva tracking as a second event source

The Go hook binary gets a `--runtime eva` argument.
Fleet writes a hooks file per crew member that calls it, and starts eva with `--hooks <file>` (khang859/eva#43).
Fleet never reads or writes eva's `config.toml`, which holds the API key.
When the installed eva has no `--hooks`, the runtime check warns, and eva crew show `needs you` because they never report.
The wire event becomes protocol 4 with optional `runtime` and `db_path`; protocols 1 to 3 stay accepted, and a higher one is ignored with one warning per version.
Fleet keeps its own read cursor per session, because eva saves some records without a hook event.
The registry stores `runtime` on the session.
Fleet accepts `db_path` only when its realpath equals the resolved `$EVA_HOME/sessions.db` or `~/.eva/sessions.db`, because any local process can send a hook payload.
An `EvaTranscriptSource` opens `db_path` with better-sqlite3 `readonly` and `fileMustExist` and a busy timeout, checks for the `transcript_v1` view (eva #10), and reads `WHERE session_id = ? AND id > ? ORDER BY id` in one short transaction per read, so it never blocks eva's WAL checkpoints.
Reads happen when a reader asks, with no file watch or timer.
A turn or a tool call is a span of positions in its source: byte offsets in a Claude Code transcript, record ids in eva's database.
It returns the same `SessionTranscript` shape `brief.ts` and `read.ts` use.
For permission requests the Go hook waits for Fleet's answer on the socket and prints it in the Claude Code form, which eva also takes (eva #12).

### 11. Spend

Two meters, never mixed:

- **Dollars** - real money: the Admiral's model cost from the agent engine, API-key crew, and eva when it reports cost (eva #11), or a token-based estimate when eva reports only tokens.
  The job budget and monthly cap count dollars.
- **Subscription usage** - for Claude crew on the user's subscription, from the `rate_limits` object Claude Code passes to its status line (`five_hour` and `seven_day`, each with `used_percentage` and `resets_at`; checked in Claude Code 2.1.302).
  Fleet sets `statusLine` in each crew's `--settings` to the Go hook binary, which forwards the JSON over the socket. Fleet never reads the Claude login or calls Claude's servers.
  The percentages are account-wide, so a job's share is the rise in `seven_day.used_percentage` while its Claude crew work, split evenly across jobs with Claude crew working at that time, and marked as an estimate.
  A job's subscription budget is a share of the week (default 10%). A reserve keeps room for the user: no new Claude work while `five_hour` is at or above 80% or `seven_day` at or above 90% (settings); the step waits for `resets_at`.
  No `rate_limits` after the first response means Claude Code is on an API key, and `cost.total_cost_usd` counts as dollars.
  _Alternative:_ estimate usage from transcript token counts. Rejected: Fleet cannot know the limit, so a token count says nothing about how close the user is to it.

A step with unknown cost needs explicit acceptance on the plan card, plus a turn or time cap.
The plan says that cloud costs (Neon compute, Vercel builds, AWS) are not counted.

A spend sampler writes to `agency.db` on each session change.
The budget check and an estimated reservation run in one SQLite transaction before each `crew_hire`, `crew_send` and Admiral wakeup turn, so parallel jobs cannot both pass the monthly cap.
At 100% no new work starts, and the Admiral runs no wakeup turns except to answer the client.
At a hard limit of 120%, running crew turns and Admiral turns are interrupted.
The cap is soft by up to one running turn below the hard limit, and the overshoot is shown.
The monthly cap resets at 00:00 on the 1st in the user's local timezone, shown in Settings.

### 13. Restart, quit and pane close

Crew PTYs die when Fleet quits, and the attention log is in memory.
At startup, each job that is not closed is reconciled: steps with no live pane become `interrupted`, and the Admiral gets a digest (worktree git state, last turn).
The client gets a Resume / Cancel card; nothing resumes on its own.
Resume relaunches each crew member in its worktree with `claude --resume <session-id>` (still the interactive TUI) or eva resume by id.
The quit guard lists running jobs as quit work items.
Closing the Admiral pane with running jobs asks "keep running, Admiral paused" or "cancel jobs".
While the Admiral is paused, permission requests go straight to the client as cards, shown by the job's tab badge and notifications.

A failed Admiral turn (model error, rate limit) keeps its wakeups queued and retries with backoff.
After the retries, the job goes to `waiting` with a "Admiral cannot reach its model" card.
With no model key, no job starts, and the pane links to Settings.

### 14. Job states and cleanup

The job state machine has a transition table:

| From               | To                          | When                                                                                |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------- |
| briefing           | planned                     | the Admiral proposes a plan                                                         |
| planned            | running                     | the client approves the newest plan version                                         |
| planned            | briefing                    | the client rejects the plan                                                         |
| running            | waiting                     | every remaining step waits on the client, the chain limit, the budget, or the model |
| waiting            | running                     | the blocker clears                                                                  |
| running            | delivered                   | every step is done and results are posted                                           |
| delivered          | running                     | the client asks for a follow-up inside the plan, or approves a plan change          |
| delivered          | closing                     | the client accepts                                                                  |
| any open state     | closing                     | the client cancels, or the job fails                                                |
| closing            | closed, cancelled or failed | cleanup ends                                                                        |
| running or waiting | interrupted                 | Fleet restarts with live steps                                                      |
| interrupted        | running or closing          | the client picks Resume or Cancel                                                   |

A closed job is read-only; a follow-up opens a new job linked to it.
`closing` refuses `crew_hire` and `crew_send`.

Cleanup is one idempotent runner over the resources recorded in `agency.db` before they are created.
A second cancel or close joins the running cleanup, and an unfinished cleanup resumes at startup.
Leftovers stay in a Leftovers list until cleaned or dismissed, and cleanup retries when Fleet is back online.
Cleanup never removes a worktree with uncommitted or untracked changes, or with unmerged commits.

### 15. Plans that meet other work

When a plan is proposed while another job in the repo is running, the plan card lists the paths both jobs touch, and the Admiral asks whether to queue or run in parallel.
A plan change card lists the crew it stops: removed steps are stopped.
A change can come from the client (chat, Swap on a crew card, plan edit) or from the Admiral (for example on `stuck` or `limited`), and is always a new plan version with a diff against the approved one.
A swap stops the old crew member first, so a worktree never has two writers.
"Continue its work" hires the replacement into the same step workspace and branch, with a handoff brief built from the step brief, an Admiral summary of the old transcript, `git diff <base>` per member, and the step's open questions; "Start over" is a normal re-hire with a new branch number.
The old crew member's `crew_member` row stays with its spend and transcript link, and the new one points to it with `replaces`.
The pre-approval check also checks deliverables: `pr` needs a GitHub remote and a signed-in `gh`; otherwise the plan offers a `branch` deliverable, a local branch with its diff.
Changes in a worktree or in the main checkout that the Admiral did not order are treated as the client's, and are not reverted without asking.

### 16. Workspace projects and job workspaces

A project is one repo or a workspace of members, so a change across repos is one job.
Canvas boards 4.2 and 4.3 show a workspace project, and board 3.5 shows one job across many repos.
Real projects look like `Fola-Fi/fola-journey`: an umbrella repo with five submodules, a `./journey` runner, `JOURNEY_*_PORT` variables, Postgres on a fixed port, per-repo `.env` files and a review bot.

**Project model.**
`agency.db` gets `projects(id, root, kind)` with `kind` = `repo`, `submodules` or `folder`, and `project_members(project_id, name, path, git_common_dir, remote, default_branch, position)`.
`position` is the member order from setup: package dependencies between members (a `package.json` dependency on another member's package name), then the umbrella last.
Repo identity (decision 1) resolves a path to a member, then to its project.

**Job workspace.**
A step's workspace is `~/.fleet/agency/jobs/<id>/ws/<step>-<n>/`, laid out like the project root.
For `submodules`, it is a worktree of the umbrella at its base; each member the step needs is a `git worktree add` from that member's main checkout into the submodule path, so nothing is cloned again.
The umbrella then sees each member worktree as a changed submodule, which is what the pointer bump step commits.
For `folder`, the root is a plain folder with one member worktree per child name.
Members the step does not name are left out, unless setup marks them needed for the stack.
The crew pane's working folder is the workspace root, or the member folder when the step touches one member, so the runtime loads that member's `CLAUDE.md` and skills.

**Delivery.**
Each changed member gets the same branch name and its own PR, with a "Part of job" list linking the others.
Merges run one at a time in `position` order, and each waits for the PR's checks on its updated base.
For `submodules`, a last step opens an umbrella PR on `admiral/<job-id>/bump` that moves each changed submodule to its merged squash commit.
Cleanup runs per member worktree with the rules in decision 14, and the umbrella worktree last.

**Checks and review bots.**
Setup reads required status checks from branch protection and finds review bots from the bot authors of reviews on the last 20 merged PRs.
They are saved in `fleet.agency.toml` under `[[members]]` as `required_checks` and `review_bots`, for example `["greptile-apps[bot]"]`.
`job_deliver` for a PR waits until required checks pass and each bot reviewed the head commit, and sends bot comments to the fix step or the Admiral.

**Ports and stack slots.**
Setup finds port variables by name (`PORT`, `*_PORT`) in runner scripts and env files, and fixed host ports in Compose files.
Fleet keeps `port_blocks(job_id, step, start, size)` and gives each job workspace a free block of 20 ports from 41000 up, checked with a bind test, and sets each port variable and a per-job `COMPOSE_PROJECT_NAME` in the pane env.
A fixed host port sets `stack_slots = 1` in `fleet.agency.toml`; a per-project semaphore lets only that many `stack: true` steps run at once, and a port held by a process outside Fleet counts as taken.

**Env files.**
`[[env_files]]` entries (`member`, `path`) in `fleet.agency.toml` name the files the user chose.
Fleet copies each file with mode 600 into new worktrees of its member, refuses a path git does not ignore, and adds every value to the env redaction (decision 9).
A copy, not a symlink, so a crew edit never changes the user's file.

**Existing agents and skills.**
Setup lists `.claude/agents/*.md` and `.opencode/agents/*.md` and maps their frontmatter to a project role.
Skills stay in place; the Admiral gets the skill names each crew member's working folder exposes.

_Alternative:_ linked jobs, one job per repo with a shared approval and budget.
Rejected: runner scripts and cross-repo checks need all members side by side in one folder, and the umbrella pointer bump needs one worktree that sees every member's commits.
_Alternative:_ symlink env files from the main checkout, as `scripts/wt-setup.sh` does.
Rejected: a crew edit would change the user's own file.

### 17. The Admiral edits settings through one tool

Agency settings are many: setup per member, ports, env files, checks, budgets, roles and playbooks.
The Admiral helps the client manage them, at setup and at any later time.
`shared/agency-settings.ts` holds a zod schema for every setting key, so `settings_change({ changes: [{ key, value }], reason })` is typed and refuses unknown keys.
The handler compares each value with the current one and picks the kind: `apply` (gives no more money or reach), `approve` (gives more) or `client-only` (the Admiral model and key, and `agency.enabled`).
The kind comes from the key and the direction of the change, never from the Admiral, so an injected instruction can at most open a card.
`apply` writes at once and posts a change card with Undo; `approve` posts a settings change card and returns at once, like `job_plan`; `client-only` returns an error with the Settings page to open.
`agency.db` gets `settings_history(id, project_id, at, actor, key, before, after, reason)`; Undo writes a new row with the old value.
Settings pages read the newest row per key to show "Changed by the Admiral".
Each Settings › Agency page has "Ask the Admiral", which opens the project's Admiral with the page and the request.
Approved plans keep their snapshot (decision 6), so a settings change reaches a running job only through a plan change card.
_Alternative:_ every Admiral settings change needs approval. Rejected: setup and check fixes are frequent and add no money or reach, and a card for each one would bury the cards that matter.

### 12. Settings

`SettingsNav.tsx` gets an "Agency" group with `agencyAdmiral` and `agencyCrew`.
The Crew page has two tabs, Roles and Runtimes, because Claude Code and eva are two answers to the same "Runs on" choice and need the same checks.
The screens follow canvas boards 3.4, 3.6 and 3.8.
The crew Model list reuses `models-catalog.ts`: OpenRouter's public model list, filtered to models whose `supported_parameters` include `tools`; for a local eva server, Fleet reads its `/v1/models` without a key.
The eva page reads only the `provider` and server address from `$EVA_HOME/config.toml` (or `~/.eva/config.toml`) and the matching environment variables, through a parser that drops every other key before the value reaches the renderer, so an API key never leaves the file.
The crew limit is one semaphore per runtime, next to the stack-slot one.

## Risks / Trade-offs

- [Crew run with the user's own access, so a crew member can reach anything the user can] → Plan approval, the runtimes' own prompts and the user's deny rules, and the Admiral sending risky or out-of-plan requests to the client; the docs say clearly this is not a sandbox. A sandboxed runtime is a later change.
- [The Admiral allows a harmful request, because it misjudges it or crew output steers it] → Requests outside the plan or hard to undo go to the client, crew output is fenced as untrusted, and every answer is logged with its reason.
- [Admiral loops and burns money] → Per-job chain limit with a continue card, a reserved budget check before each act and turn, the 80% warning, and the 120% hard stop.
- [The Admiral is steered by injected text in a README or crew output] → Untrusted fencing, and plan and settings changes need a client card.
- [A cloned repo changes how crew work through its own `.fleet/` files] → Repo files change nothing until the user imports them.
- [Many Claude crew members look like non-ordinary usage of a subscription] → Claude only on few high-value roles by default in bundled playbooks, eva on bulk roles, and Settings shows how many Claude crew a job will start.
- [Admiral turns only run while its pane is mounted, since main never starts turns] → Verify background-tab mounting early (task 1.x); if not mounted, keep a hidden mount for Admiral panes like terminals.
- [eva changes its schema] → Read only versioned views, check the version, and fall back to phase-only tracking.
- [Cleanup misses a worktree or container after a crash] → Resources are recorded in `agency.db` before creation, and leftovers stay listed until cleaned or dismissed.
- [Claude Code flags or settings keys change between versions] → `available()` checks a minimum version, and phase 3 starts with a docs check of every flag.
- [Older Fleet versions open a layout with an `admiral` pane] → They show the existing unknown-pane fallback; no data is lost because jobs live in `agency.db`.

## Migration Plan

- Ship behind `agency.enabled` (default off) until phase 5, then default on.
- No data migration: `agency.db` and the client files are new.
- Rollback: turn the setting off; the Admiral pane shows a disabled notice, and no crew starts.
- eva features turn on by capability check, so an old eva keeps working for phase tracking once hooks exist.

## Open Questions

- The default Admiral model and default job budget. They are settings, so they can be picked during phase 1.
- The exact eva hook payload and flag names, which follow khang859/eva#9, #13 and #15 and the follow-up issues #18 to #24 as they land.
- The default nudge count, no-progress time, step wall-clock limit and permission card expiry. They are settings with defaults picked in phase 3.
