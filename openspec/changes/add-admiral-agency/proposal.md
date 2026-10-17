## Why

Fleet can already watch and prompt Claude Code sessions through the Orchestrator, but the user still has to be the project manager: split the work, pick who does what, answer permission prompts, and check every result.
We want Fleet to work like a small software agency.
The user is the client and talks to one person, the Admiral.
The Admiral plans the job, runs a crew of agents, and only comes back with questions and results.
A kanban board was tried before and rejected, so the interface is a conversation plus a live job sheet (design 3 in the canvas at https://claude.ai/artifact/14G6yM3dmLdAppbhU8fnM3).
The canvas also holds the getting-started screens.

## What Changes

- Add a new pane type, `admiral`: a chat on the left and a 380px job sheet on the right.
  - The sheet shows THE JOB, WAITING ON YOU, PLAN, CREW and SPEND.
  - Job tabs sit in the pane header.
  - There is one Admiral per project. A project is one repo or a workspace of many repos, such as an umbrella repo with submodules.
- Add a getting-started flow: first-run checks, a project picker, a read-only project setup, starter questions, and a project switcher.
- Add an Admiral agent mode on the existing Agent engine.
  - It has no edit, write or shell tools.
  - It reads the repo, writes a plan, hires crew, and checks their work through the existing `fleet_*` session tools.
  - A new `ask_client` tool shows a question card with options and a recommended pick, and does not block the crew.
  - Questions are batched, and the Admiral keeps a client file of the user's standing preferences.
  - The Admiral can read and change settings at any time. A change that adds no money or reach applies at once with Undo. A change that adds more, such as a higher budget or an env file for crew, needs the user's OK on a card. The Admiral's own key stays with the user.
- Add jobs: brief, plan, approval, run, delivery, and close.
  - One job can change any number of the project's repos in one job workspace, with one linked PR per repo, merges in member order, and an umbrella pointer bump PR.
  - A PR is ready only when its required checks pass and its review bots have reviewed it.
  - Each job workspace gets its own block of ports, and a stack slots limit stops two jobs from using a fixed port at the same time.
  - The user picks which untracked `.env` files crew get. Fleet copies them and redacts their values.
  - A plan names the playbook, the crew, what each step hands back, and a budget.
  - Nothing runs until the user approves the plan.
  - Results come back as cards: a PR, a doc, an image, copy, or a preview link.
- Add crew roles and playbooks as Markdown files in `~/.fleet/crew/` (user) and the project's folder in Fleet, with bundled defaults.
  - Project settings (setup and crew) are stored in Fleet, so no commit is needed. "Share with team" exports them to `.fleet/` in the repo, and a teammate's `.fleet/` files are suggestions the user imports.
  - A role says when to hire it, its runtime (`claude` or `eva`), its model and its instructions. The Admiral sets each step's deliverables in the plan.
  - A playbook is an ordered list of steps that use roles, for example Engineering, Bug fix and Launch.
- Run `claude` roles only as the unmodified Claude Code TUI in Fleet terminal panes, signed in by the user.
  - Fleet never runs `claude -p` or the Agent SDK for crew work, and never reads, copies or forwards the Claude login.
  - The Admiral itself runs on the user's OpenRouter or local model key, never on the Claude subscription.
- Run `eva` roles as eva in Fleet terminal panes, and track them like Claude sessions.
  - Fleet gets eva state from eva lifecycle hooks and reads transcripts from eva's `sessions.db` through stable read-only views.
  - This depends on eva issues khang859/eva#9, #10 and #13. #12 lets the Admiral answer eva permission prompts; without it, the user answers them in the eva pane. #11, #14, #15, #16 and #18 to #24 make it better but are not required.
- Crew use the access the user's machine already has.
  - Crew run with the user's own environment, logins and tools, such as `git`, `gh`, `aws` and `vercel`.
  - Fleet makes no keys and stores no service credentials.
  - Each runtime keeps its own permission prompts. The Admiral answers them through the runtime's permission hook.
  - The Admiral allows what fits the approved plan, and asks the user about anything outside the plan or hard to undo, such as a production deploy, a delete, a push to main or a merge.
  - Every permission answer is written to the job record.
- Add budgets: a spend cap per job and a monthly cap, with live spend in the job sheet.
- Add a Settings nav group "Agency" with Admiral and Crew.

## Capabilities

### New Capabilities

- `admiral-pane`: the `admiral` pane type, its chat and job sheet layout, question cards, plan and result cards, and the Admiral agent mode with its tool set and limits.
- `agency-jobs`: the job lifecycle from brief to close, plan approval, the client file, budgets and spend, and the job record.
- `agency-crew`: crew role and playbook definitions, how the Admiral hires crew, the `claude` and `eva` runtimes, including the Claude Code compliance rules, the user's system access, and how the Admiral answers permission prompts.
- `eva-session-tracking`: tracking eva sessions in Fleet panes through eva hooks and eva's `sessions.db` views.

### Modified Capabilities

None.
The `agent-orchestrator` and `claude-session-tracking` capabilities from the in-flight change `add-claude-session-orchestrator` are not in `openspec/specs/` yet.
This change uses their tools and registry as they are, and adds new requirements in its own capabilities instead of changing theirs.

## Impact

- **Depends on:** `add-claude-session-orchestrator` (all tasks done, not archived), and eva issues khang859/eva#9, #10 and #13.
- **Main process:**
  - new `src/main/agency/` (jobs, crew loader, permission answers, eva tracking);
  - `agent/agent-service.ts` and `agent/tools/` for the Admiral mode and its tool set;
  - `agent/fleet/spawn.ts` gains a role runtime and job environment, behind the Admiral;
  - `pty-manager.ts` for port variables on crew panes;
  - `claude-sessions/` registry learns about eva sessions through a second source.
- **Shared types:** new `shared/agency-*.ts`, `paneType: 'admiral'` in `shared/types.ts`, new IPC channels.
- **Renderer:** new `components/admiral/`, an `admiral` store, and new Settings sections under an "Agency" group in `SettingsNav.tsx`.
- **New files in user repos:** none unless the user picks "Share with team", which writes `.fleet/crew/*.md` and `.fleet/fleet.agency.toml`, both safe to commit.
- **New dependencies:** none planned beyond the existing `better-sqlite3`, `safeStorage` and `yaml`; a TOML parser (`smol-toml`) for `fleet.agency.toml`.
- **External services:** Fleet reads checks, reviews and PRs from GitHub through the user's own `gh` login.
- **Security:** crew act with the user's own access, and this is not a sandbox.
  This is limited by plan approval, the runtimes' own permission prompts, and the Admiral's permission answers, which send anything outside the plan or hard to undo to the user.
- **Policy:** Claude Code is only ever run as the user's own interactive TUI.
- **Delivery:** separate PRs per phase: 1 pane and Admiral mode, 2 jobs and plans, 3 crew and playbooks, 4 eva tracking, 5 permission answers, 6 budgets.
