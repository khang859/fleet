## Purpose

Lets the user define the kinds of crew their agency has, such as architects, builders, reviewers or copywriters, and how they work together, and defines how Fleet runs each crew member in a terminal pane within Claude Code and eva usage rules.

## ADDED Requirements

### Requirement: Role definitions

The system SHALL load crew roles from Markdown files with YAML frontmatter in three places: bundled with Fleet, `~/.fleet/crew/roles/` for the user, and `~/.fleet/agency/projects/<project-id>/crew/roles/` for the project.
A role with the same name in a more specific place SHALL replace the less specific one, in the order bundled, user, project.
A role's frontmatter SHALL have:

- `name` - a unique kebab-case name;
- `description` - when to hire this role;
- `runtime` - `claude` or `eva`;
- `model` - optional model name for the runtime;
- `stack` - optional, `true` when the role runs the project's servers and needs a stack slot.

The Markdown body SHALL be the role's instructions.
A role SHALL NOT set deliverables or client approval; the Admiral sets those for each step in the plan.
A file with invalid frontmatter SHALL be skipped and shown with its error in Settings › Agency › Crew.
Changes to a role file SHALL apply to the next plan, without a restart; a running job SHALL use only the roles and playbooks stored with its approved plan.

#### Scenario: Repository overrides a bundled role

- **WHEN** the user imported the repository's `.fleet/crew/roles/reviewer.md` and Fleet bundles a `reviewer` role
- **THEN** the Admiral uses the project's reviewer

#### Scenario: Invalid role

- **WHEN** a role file has `runtime: gpt`
- **THEN** the role is not offered to the Admiral and Settings shows the file with the error

### Requirement: Role editor

Settings › Agency › Crew SHALL edit a role's frontmatter and body, and saving SHALL write the role file in the place it came from.
The Model list SHALL show "Runtime default" first.
For `claude`, the list SHALL offer the names Claude Code takes for `--model` (`opus`, `sonnet`, `haiku`) and SHALL accept a full model id typed by the user.
For `eva`, the list SHALL offer the models that eva's model server lists, with price and context size: OpenRouter's public model list for OpenRouter, or the `/v1/models` list of a local server.
Only models that support tool calls SHALL be offered for `eva`.
A role whose model is no longer listed SHALL show the model as missing, and a plan step that uses it SHALL fail the runtime check.
Runs on SHALL show each runtime with what it runs on and its status from the Runtimes tab.
Beside the model, the editor SHALL say what the role's work counts toward: the job's share of the weekly Claude limit for `claude`, or the job's dollar budget for `eva`.
A role SHALL NOT limit which tools its crew can use; crew SHALL use all the tools their runtime offers, and ask for permission as the runtime's own settings require.
Switching a role's runtime SHALL reset the model to "Runtime default" and show what changed.
The editor SHALL write nothing to the role file until the user clicks Save, and Discard SHALL drop the unsaved changes.

#### Scenario: Pick an eva model

- **WHEN** the user opens the Model list of an eva role and eva uses OpenRouter
- **THEN** the list shows "Runtime default" and the OpenRouter models that support tool calls, each with price per million tokens and context size

#### Scenario: Model removed

- **WHEN** a role uses `deepseek-v4.1` and the model server no longer lists it
- **THEN** the role shows "model missing", and a plan step with that role cannot be approved until the role changes

#### Scenario: Switch a role to eva

- **WHEN** the user switches the Architect, set to Claude Code with `opus`, to eva
- **THEN** the model becomes "Runtime default", a note says what changed, and the role file changes only when the user clicks Save

### Requirement: Playbook definitions

The system SHALL load playbooks from Markdown files in `crew/playbooks/` in the same three places and with the same precedence as roles.
A playbook SHALL have a name, a description of when to use it, and an ordered list of steps.
A step SHALL name a role, how many of that role run in parallel, which steps it waits for, and whether the client approves its output.
A playbook SHALL be rejected if a step names a role that does not exist or if its waits form a cycle.
Fleet SHALL bundle at least these playbooks: Engineering (Architect, client approval, two Builders, Reviewer, QA), Bug fix (Builder, Reviewer, QA), and Launch (Strategist, Copywriter and Designer, client approval, Editor).

#### Scenario: Unknown role

- **WHEN** a playbook step names `role: growth-hacker` and no such role exists
- **THEN** the playbook is not offered and Settings shows the error

### Requirement: Admiral picks the team

The Admiral SHALL pick a playbook for each plan, or build steps from roles when no playbook fits.
The plan card SHALL show each step with its role, runtime, model and deliverables.
The Admiral SHALL be able to propose a new role in a plan; a proposed role SHALL be saved in the project's crew folder only when the client approves it.

#### Scenario: Marketing job

- **WHEN** the client briefs a product launch
- **THEN** the plan uses the Launch playbook with Strategist, Copywriter, Designer and Editor steps

#### Scenario: Proposed role

- **WHEN** the Admiral proposes a `data-migrator` role and the client approves the plan
- **THEN** `data-migrator.md` is saved in the project's crew folder before the step starts, and the repository has no new file

### Requirement: Crew runs in Fleet terminal panes

Each crew member SHALL run in its own Fleet terminal pane, in a job worktree or a job scratch folder, and never in the main checkout.
Crew panes SHALL open without taking focus, grouped under the job, and SHALL be reachable from the CREW section.
The Admiral SHALL brief, prompt, read, diff and wait on crew members through the same session tools the Orchestrator uses, with every prompt marked as coming from Fleet and recorded in the job record.
The user SHALL be able to type into any crew pane at any time.

#### Scenario: Hire a builder

- **WHEN** the Engineering playbook reaches its Builder step
- **THEN** two terminal panes open in two new worktrees, each running the Builder's runtime with the step's brief, and both appear in CREW

#### Scenario: User steps in

- **WHEN** the user types into a crew pane
- **THEN** the input reaches the crew member and the Admiral sees it in its next read

### Requirement: Claude Code runtime rules

A `claude` crew member SHALL run as the user's installed, unmodified Claude Code interactive TUI in a terminal pane.
The system SHALL NOT run `claude -p`, `claude --print`, or the Claude Agent SDK for crew work.
The system SHALL NOT read, copy, store, forward or refresh Claude Code login credentials or OAuth tokens, and SHALL NOT set `ANTHROPIC_API_KEY` or similar variables on a `claude` crew pane unless the user set them in their own environment.
The system SHALL deliver prompts to a `claude` crew member only by typing into its terminal.
Folder trust and login prompts in Claude Code SHALL be left for the user to answer.
Before the first `claude` hire in a repository, the plan SHALL include a one-time step for the user to accept Claude Code folder trust.
The system SHALL NOT write the Claude Code config folder or its global state file.
A `claude` crew member SHALL start with an explicit session id chosen by Fleet, the default permission mode, bypass mode disabled, the role's instructions as an addition to the system prompt, and job settings that carry Fleet's hooks.

#### Scenario: Starting a Claude crew member

- **WHEN** the Admiral hires a role with `runtime: claude`
- **THEN** the pane runs `claude` with no print or SDK flag, and the brief is typed into the TUI

#### Scenario: Not signed in

- **WHEN** Claude Code in a crew pane shows its login screen
- **THEN** a WAITING ON YOU card asks the client to sign in in that pane, and Fleet does not type into it

### Requirement: eva runtime

An `eva` crew member SHALL run as eva in a terminal pane, started with the role's instructions, model and goal.
eva SHALL run with the user's own eva settings and environment.
The system SHALL track the eva session as described in `eva-session-tracking`.

#### Scenario: Starting an eva crew member

- **WHEN** the Admiral hires a role with `runtime: eva`
- **THEN** the pane runs eva with the role's model and the step's goal, and the session appears in CREW once eva reports

### Requirement: Crew use your system access

Crew SHALL use the access the user's machine already has: the user's environment, logins and command-line tools, such as `git`, `gh`, `aws` and `vercel`.
Fleet SHALL NOT make keys, store service credentials, or set access rules for crew.
The plan card SHALL say that crew act with the user's own access, and that the Admiral answers their permission prompts.

#### Scenario: Push with the user's login

- **WHEN** a Builder pushes its branch in a repository where the user is signed in to `gh`
- **THEN** the push uses the user's own GitHub login, and Fleet made no key

### Requirement: Permission prompts

Each runtime SHALL keep its own permission prompts under the user's own permission settings, and SHALL NOT run in a mode that bypasses them.
When a crew member asks for permission, Fleet SHALL send the request to the Admiral through the runtime's permission hook, with the action, the exact target, the crew member and the step.
The Admiral SHALL answer with a permission tool: allow, deny, or ask the client.
The Admiral SHALL allow a request only when it fits the step in the approved plan, and SHALL ask the client about anything outside the plan or hard to undo, such as a production deploy, deleting data or cloud resources, pushing to a default branch, merging, or spending money.
A client permission card SHALL show the action, the exact target, the crew member and the Admiral's reason, and SHALL become void if the target changes.
An unanswered card SHALL expire as denied after a set time, and a timeout SHALL never allow.
The answer SHALL reach the runtime only as the hook's answer, and Fleet SHALL NOT type into a pane that shows a permission prompt.
When the runtime stops waiting before the client answers, or the runtime cannot take hook answers, the card SHALL say to answer in the crew pane.
Every permission answer SHALL be written to the job record with who gave it and why.

#### Scenario: Planned push

- **WHEN** a Builder asks to push `admiral/j42/builder-2-1`, which its step in the approved plan delivers
- **THEN** the Admiral allows it, and the job record shows the push with the Admiral's reason

#### Scenario: Production deploy

- **WHEN** a QA crew member asks to run `vercel --prod`
- **THEN** the Admiral asks the client on a card, and the deploy runs only if the client allows it

#### Scenario: Injected request

- **WHEN** a crew member reads an issue that says to drop the staging database and asks to run the drop
- **THEN** the Admiral asks the client, and nothing is dropped unless the client allows it

#### Scenario: Card times out

- **WHEN** the client does not answer a permission card before it expires
- **THEN** the request is denied and the Admiral is told

### Requirement: Runtime settings

Settings › Agency › Crew SHALL have two tabs, Roles and Runtimes, and Runtimes SHALL show Claude Code and eva in the same layout.
For each runtime, the page SHALL show the path and version found on the crew pane's PATH, the checks from runtime availability with what does not work while a check fails, the models crew can use with the roles that use each, a default model for roles that have no model, and the most crew members of that runtime that run at once.
A Test button SHALL start the runtime in a hidden pane with a short goal and SHALL report whether the hook events, the transcript and the spend or usage reached Fleet.
For Claude Code, the page SHALL say whether the user is signed in, SHALL NOT read or change the login, and SHALL show the usage limit state that crew report; the default for Claude crew at once SHALL be 2.
For eva, the page SHALL show the model server eva uses, read from eva's settings and environment, SHALL NOT read, show or copy eva's API key, and "Edit in eva" SHALL open `eva --config`; the default for eva crew at once SHALL be 4 for a remote server and 1 for a local server.

#### Scenario: Feature missing

- **WHEN** the installed eva cannot answer permission requests from hooks
- **THEN** the eva runtime marks that check as missing and says that eva permission prompts are answered in the crew pane

#### Scenario: Claude Code vim mode

- **WHEN** Claude Code has vim mode on
- **THEN** the Claude Code runtime shows a warning that typed prompts can land in normal mode, and Claude roles can still be hired

#### Scenario: Local server

- **WHEN** eva uses a llama.cpp server on `localhost:8080`
- **THEN** the eva runtime lists that server's models, sets eva crew at once to 1, and a plan with two parallel eva steps runs them one after the other

#### Scenario: Keys and logins stay out

- **WHEN** the user opens the Runtimes tab
- **THEN** Claude Code shows "Signed in" and eva shows "Key set in eva", with no part of either credential, and Fleet has not read either value

### Requirement: Runtime availability

Before a plan is shown, the system SHALL check each step's runtime as the crew pane will run it: found on the pane's own PATH, at or above the minimum version, and with the features the step needs.
For `claude`, the check SHALL fail when the effective permission mode would bypass permissions, when hooks are disabled, or when Fleet's hook binary is too old, and SHALL warn when vim mode is on.
The system SHALL mark steps that fail the check, and a plan with a failed step SHALL NOT be approvable until it is fixed or the step is changed.
Agency SHALL NOT be offered on Windows.

#### Scenario: eva missing

- **WHEN** a plan uses an eva role and eva is not on PATH
- **THEN** the step shows "eva not installed" and Approve is disabled

#### Scenario: eva too old

- **WHEN** the installed eva has no hook support
- **THEN** the step shows "eva too old" with the minimum version, and Approve is disabled

### Requirement: Crew files from the repository

Role, playbook and setup files in a repository's `.fleet/` folder SHALL be suggestions only, read from the main checkout at the default branch tip, never from a crew worktree.
A repository file SHALL change no job until the user imports it, at project setup or in Settings › Agency; the import SHALL copy the file into the project's folder in Fleet and SHALL show its content.
When an imported file changes on the default branch, Settings SHALL show that a newer version exists, and the project's copy SHALL NOT change until the user imports again.
The user SHALL be able to export the project's crew files and setup to `<repo>/.fleet/` to share them with a team; Fleet SHALL write them to the main checkout and SHALL NOT commit them.
An approved plan SHALL store the exact content of every role and playbook it uses.

#### Scenario: Cloned repository

- **WHEN** the user opens an Admiral in a freshly cloned repository that ships its own `builder.md`
- **THEN** the bundled or user builder is used until the user imports the repository file

#### Scenario: Crew edits a role

- **WHEN** a crew member changes `.fleet/crew/roles/builder.md` in its worktree
- **THEN** no job uses that change, and if it lands on the default branch, Settings shows a newer version for the user to import

### Requirement: Existing agents and skills

Project setup SHALL find the agent files and skills that members already have, such as `CLAUDE.md`, `AGENTS.md`, `.claude/agents/`, `.claude/skills/` and `.opencode/agents/`.
Setup SHALL offer to import each agent file as a project role.
Skills SHALL stay in the repository, and the Admiral SHALL be told which skills each crew member's runtime can load from its working folder, so a plan can name them.
`CLAUDE.md` and `AGENTS.md` SHALL stay in the repository for crew runtimes to read, and SHALL NOT change any role or plan.

#### Scenario: Import a reviewer agent

- **WHEN** setup finds `.opencode/agents/journey-domain-reviewer.md` and the user imports it
- **THEN** a project role `journey-domain-reviewer` is saved in the project's crew folder

#### Scenario: Plan uses a skill

- **WHEN** the client asks for a QA pass in `fola-journey`
- **THEN** the plan's QA step names the `journey-qa-sweep` skill

### Requirement: Step workspaces

Each playbook step SHALL declare its workspace: a new job workspace, read-only use of another step's workspace, or a new job workspace that merges named steps' branches.
A job workspace SHALL hold one worktree for each member the step needs, and a one-repository project SHALL have a job workspace of one worktree.
A worktree SHALL have at most one writing crew member.
A step SHALL see only the committed outputs of the steps it waits for, and each step SHALL commit its output in each member it changes.
A step with more than one crew member SHALL give each a separate scope and SHALL be followed by a merging step, unless the plan says it delivers one PR per crew member.

#### Scenario: Two builders

- **WHEN** the Engineering playbook runs two Builders
- **THEN** each works in its own job workspace on its own scope, and an integrate step merges both branches in each member before review

#### Scenario: Architect hands off

- **WHEN** the Architect commits a design doc and the Builders start
- **THEN** each Builder's job workspace contains the design doc

### Requirement: Branch names and worktree setup

Crew branches SHALL be named `admiral/<job-id>/<step>-<n>`, where `n` is never reused within a job, and a step SHALL use the same branch name in every member it changes.
The plan check SHALL fail when any member has a branch named exactly `admiral`.
Each member SHALL be able to set a setup command, submodule checkout and a setup timeout for new worktrees, and a workspace SHALL be able to set one more setup command that runs from the job workspace root after the members are set up.
These settings SHALL be saved in `~/.fleet/agency/projects/<project-id>/fleet.agency.toml` and found during project setup.
The system SHALL run setup before the crew member starts, and a failed setup SHALL make the step `blocked` with its log.

#### Scenario: Re-hire after failure

- **WHEN** the Admiral re-hires a failed Builder step with the client's OK
- **THEN** the new crew member gets a new branch number and no collision occurs

#### Scenario: Setup fails

- **WHEN** `pnpm install` fails in a new worktree of `journey-api`
- **THEN** the step is `blocked`, the log is shown, and the crew member does not start

### Requirement: Environment files for crew

Project setup SHALL list the untracked environment files in each member's main checkout, such as `.env`, `.env.local` and `.env.test`, and SHALL show only their variable names, never their values.
The user SHALL choose which files crew get, and no file SHALL be chosen by default.
The system SHALL copy each chosen file into each new worktree of that member at the same path before setup runs, and SHALL NOT link to the user's file, so a crew change never reaches the user's checkout.
A chosen file SHALL be copied only when git ignores that path in the worktree; otherwise the step SHALL be `blocked` with the reason.
Fleet SHALL replace each value of a chosen file with a placeholder in text the Admiral reads and in Fleet logs, so the Admiral never sees the values.
The plan card SHALL list the chosen files each step gets.

#### Scenario: Pick env files

- **WHEN** the user chooses `journey-api/.env` and leaves out `journey-client/.env.local`
- **THEN** new `journey-api` worktrees get a copy of `.env`, and new `journey-client` worktrees get no environment file

### Requirement: Ports and stack slots

Project setup SHALL find the port settings of each member: `PORT`, port variables in runner scripts and environment files, such as `JOURNEY_API_PORT`, and host ports in Docker Compose files.
Each job workspace that runs servers SHALL get its own block of free ports, and each port variable SHALL be set to a distinct port in that block in the crew pane's environment.
Each job workspace SHALL get its own Docker Compose project name, so containers of different jobs never share names.
The job sheet SHALL show the local address of each server a crew member starts.
A host port that is fixed in a file and that no port variable moves, such as Postgres on `5432:5432`, SHALL make the project's stack slots default to 1, and the user SHALL be able to change stack slots in the project's settings.
Each role SHALL declare whether it runs the stack, and a step that runs the stack SHALL hold a stack slot while it runs; other such steps SHALL wait with the reason shown.
A fixed port that a process outside the job uses SHALL count as a taken slot, and the system SHALL NOT stop a process it did not start.

#### Scenario: Two jobs and one slot

- **WHEN** two jobs in `fola-journey` each have a QA step that runs the stack and the project has one stack slot
- **THEN** the second QA step waits with "Waiting for a stack slot" until the first one ends, and the Builders of both jobs keep working

#### Scenario: Port variables

- **WHEN** a job workspace of `fola-journey` starts
- **THEN** its crew pane has `JOURNEY_API_PORT`, `JOURNEY_CLIENT_PORT` and the other port variables set to free ports in the job's block, not 3030 and 3000

### Requirement: Step completion

A crew member SHALL report the end of its step to Fleet with a status of done, blocked or question, a summary, and optional deliverable paths.
A turn that ends without a report SHALL count as idle, not done.
The Admiral SHALL be able to nudge an idle crew member a limited number of times, after which the step SHALL become `blocked`.
Crew questions SHALL come in the crew member's report or final message, and runtime question dialogs SHALL be turned off for crew.

#### Scenario: Idle, not done

- **WHEN** a Builder ends a turn with "Want me to also add tests?" and no report
- **THEN** the step stays running and the Admiral answers or nudges

### Requirement: Crew states

The CREW section SHALL show these states in addition to the session phase:

- `needs you` - the crew member has not reported within 60 seconds of start, for example at a login or trust screen; a WAITING ON YOU card SHALL offer Peek, and Fleet SHALL NOT type into it;
- `limited` - the runtime hit a usage or rate limit; nothing SHALL be sent to it before the reset time, and new hires of the same runtime SHALL pause;
- `user-driven` - the user typed into the pane, cancelled its turn, cleared it or changed its mode; the Admiral SHALL NOT send to it until the user hands it back;
- `stuck` - no progress for a set time, or past the step's time limit; the Admiral SHALL be woken.

The Admiral SHALL be able to read the last screen text of a crew pane that has not reported, read-only, with the values of chosen environment files replaced.

#### Scenario: Usage limit

- **WHEN** Claude Code in a crew pane hits its usage limit
- **THEN** the crew member shows `limited` with the reset time and the Admiral does not prompt it

#### Scenario: User takes over

- **WHEN** the user runs `/clear` in a crew pane
- **THEN** the crew member shows `user-driven` and the Admiral stops prompting it until the user hands it back from CREW

### Requirement: Crew member end

When a crew member's runtime exits, its pane closes, or it crashes, the system SHALL end the crew member, mark its step stopped or failed, and wake the Admiral.
The crew pane SHALL NOT stay open as a shell after the runtime exits.
The Admiral SHALL NOT re-hire that step without the client's OK.

#### Scenario: User closes a crew tab

- **WHEN** the user closes the job tab while two crew members run
- **THEN** both steps show "stopped by you", and the Admiral asks the client what to do

### Requirement: Prompt delivery check

The system SHALL compare the prompt a runtime reports as submitted with the text Fleet typed, and SHALL treat a mismatch as a failed send without retrying on its own.
A brief longer than the safe paste size SHALL be passed as a file the crew member can read.

#### Scenario: Mangled prompt

- **WHEN** the submitted prompt does not match the typed brief
- **THEN** the send is reported as failed to the Admiral and is not retried
