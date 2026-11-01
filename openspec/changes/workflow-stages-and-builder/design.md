# Workflow stages and builder

**State:** proposed.
**Date:** 2026-11-01.
**Written against:** commit `8c94695d` (`chore: bump version to 2.148.0`).
**Origin:** design talk with the owner, then canvas option 1 (Talk It Out plus Stage Map).
**Handoff:** none yet.
Write one when this is approved and another session picks it up.

All line numbers below are for commit `8c94695d`.
Search for the symbol again if a number has moved.

## What this is

The owner works this way: tell the agent what they want, let it read the code, answer questions until they agree, approve a plan, let it build, start 3 review agents, and open a PR.
Fleet Workflows cannot run this.
All agents start together at `run-manager.ts:365`, and only the judge waits, at `run-manager.ts` `startLastAgent`.
The cost today is that a person does each step by hand in panes, and must remember each prompt.

The editor cannot express the flow either.
`WorkflowEditor.tsx` has one flat list of agents, and errors show only after Save.

## Goals and non-goals

### Goals

1. One workflow file can run the flow above from start to PR.
2. A person can make that file by talking to an agent, or by editing a Stage Map, or both.
3. Claude Code work can use a person's Claude subscription.
4. A person can read a long plan comfortably before any code changes.
5. Every existing workflow file keeps working and stays approved.

### Non-goals

- No model choice. Workflows have no model field, and this change adds none.
- No branches, loops or conditions other than "skip this stage if the board is empty".
- No repeat of review and fix until the board is clean. One pass only in this release.
- No free node canvas.
- No Fleet chat window, Agent SDK or `claude -p` for Claude Code. See requirement 3.
- No talking agents or plan approval in automatic runs. Nobody is there to answer.
- No comments on single lines of a plan.
- No change to the Copilot plan card, which still serves normal sessions.

## Prior art

GitLab pipelines show stages as columns with parallel jobs in each one.
This is the model we copy, because it shows both order and parallel work with no lines.
Attio, HoneyBook and incident.io use step lists with folded summaries.
Those work well, but parallel work is hard to see.

OpenAI, StackAI and Langdock use free node canvases.
This does not transfer, because they have branches and Fleet has none, so lines would add work and no meaning.

Airtable, Lindy and Copy.ai build automations from a chat.
The idea transfers, but their chat window does not, because of requirement 3.

NN/g and Baymard research supports the page structure: few visible fields, step summaries, and checks at the moment of input.
The evidence on prompt-driven builders is early, and NN/g reports no user test for it.

## Locked requirements

These are settled with the owner.
Do not reopen them.
If you think one is wrong, say so and stop.

1. The target flow is: tell, explore, ask until aligned, plan, build, 3 reviewers, PR.
2. The product design is canvas option 1: Talk It Out plus Stage Map.
3. Claude subscriptions work only through the Claude Code terminal app. Fleet must run that real app in a pane for Claude Code work.
4. The agent in the builder pane must know that the pane is special and what its job is.
5. A plan is a large Markdown document, and Fleet must show it as one.
6. The Lead uses Claude Code, and a person answers it in its pane.
7. Reviewers are fresh agents, read only, and run at the same time.
8. The Lead comes back to fix problems, then Fleet opens the PR.
9. Workflows stay TOML files, and a file cannot run until a person approves it.

## What already exists

| Need                                          | What already does it                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Start the real app with a brief               | `agentCommandLine`, `agent-command.ts:48`, `--append-system-prompt-file` at `:32`                 |
| Wait for a person at start                    | `message: null` in `AgentCommand`, `agent-command.ts:13`                                          |
| Go on with the same session                   | `resume`, `agent-command.ts:15`, `agentChatHandle` in `shared/workflows.ts`                       |
| Read-only flags                               | `locked` mode, `agent-command.ts:25,34`, but per run, not per agent                               |
| Pane identity that an agent cannot fake       | `FLEET_PANE_ID` and `FLEET_PANE_TOKEN`, `pty-manager.ts:236`                                      |
| Tools limited by pane kind                    | `PaneKind` and `TOOLS`, `tools.ts:4,20`, checked at `bridge-routes.ts:142`                        |
| Read the plan text                            | `tool.toolInput.plan`, `PermissionRequest.tsx:198`, `isPlanApproval` in `format-permission.ts:42` |
| Answer a plan with a mode or a change request | `respondToPermission(id, decision, reason, suggestion, mode)`, `claude-sessions/index.ts:277`     |
| The 3 build modes                             | `PLAN_APPROVAL_CHOICES`, `format-permission.ts:102`                                               |
| Questions are not permission requests         | `asksQuestion`, `phase.ts:119`                                                                    |
| Full Markdown page                            | `MarkdownPreview.tsx`, with tables, code colors and Mermaid                                       |
| Stage order hook                              | `settle` and `startLastAgent` in `run-manager.ts`                                                 |
| Workflow guide text                           | `workflowGuide`, `guide.ts`                                                                       |
| Draft that needs approval                     | `fleet_workflow_create`, `tools.ts`, and approval in `approval.ts`                                |
| Agent picker pattern                          | `AgentPicker`, `CreateWorktreeDialog.tsx:291`                                                     |
| Saved agent definitions                       | `src/main/agent/subagents/definitions.ts`, `.fleet/agents/`, `resources/agents/`                  |
| PR commands                                   | `gh` calls in `pr.ts`                                                                             |

The first design assumed that plan capture needed a new channel.
It does not: the data already reaches main, and `index.ts:341` drops it.

## Alternatives considered

**A Fleet chat window through the Agent SDK or API.**
It gave the best interface, with real buttons in the chat, and the mock used it first.
It lost because it cannot use a Claude subscription, which breaks requirement 3.
Rejected outright.
Do not bring it back as an option that is "only for API users", because two builder surfaces would then drift apart.

**`claude -p` in the background.**
It would make progress easy to parse.
It is rejected outright for the same reason, and it also takes away the terminal where a person answers.

**A normal pane with a slash command or skill that explains the job.**
This needs almost no engine work.
It lost because the pane still has all tools, so the agent can edit code or start a run, and the person must remember the command.
This fails in the permissive direction.
Requirement 4 needs Fleet to set the job, not the person.

**Read-only reviewers through prompt text only.**
This needs no flags, and it fails silently and in the permissive direction, because one bad turn changes code.
Rejected outright.
Access is enforced by tool flags.

**A dependency graph (`depends_on`) in place of stages.**
It can express more flows, but the owner's flow needs none of them.
It adds cycle checks and a harder map to read.
Stages can grow into this later, because a stage list is a simple case of a graph.

**A new engine mode for stage workflows only.**
It would keep `run-manager` untouched, but it gives two run paths to maintain.
Old files normalize to stages instead, so there is one path.

**A terminal drawn inside the Workflows page.**
This matches the mock exactly.
It lost because a pane has one xterm instance, and panes live in workspace tabs.
A workspace tab with two splits gives the same layout with existing code.

**Stage List only (canvas option 2).**
It is cheaper and needs no builder.
The owner chose option 1.
Stage List may return as the phone-width fallback of the map, and not as a separate editor.

**Pi plan approval with an example extension.**
Pi ships a `plan-mode` example, but it is not built in.
It keeps the limit in extension state with `pi.setActiveTools` and a `tool_call` block, and it shows the plan as a list of steps in the terminal.
It lost because the limit depends on extension code, and Fleet needs the whole Markdown document on its own page.
It also needs Pi to start with all tools, because Pi removes tools outside `--tools` at start and cannot add them later.
Section 6 uses that removal as the limit.

## Chosen architecture

### 1. File format (`locked`)

Requirement 9 keeps TOML.
A stage file looks like this:

```toml
name = "Build a feature"
workspace = "new-branch"

[[inputs]]
name = "request"
label = "What do you want to build?"

[[stages]]
name = "Talk, plan and build"

[[stages.agents]]
role = "Lead"
program = "claude"
access = "write"
talks = true
plan = true
prompt = "Read the code first. Ask until we agree. Then write the plan."

[[stages]]
name = "Review"

[[stages.agents]]
role = "Correctness"
program = "pi"
prompt = "Look for logic bugs."

[[stages]]
name = "Fix"
only_with_findings = true

[[stages.agents]]
role = "Lead"
resume = "Lead"
prompt = "Fix the real problems on the board."

[finish]
action = "open-pr"
```

A file has `stages`, or `agents`, but not both.
`access` defaults to `read` in a stage file.
The last stage must have one agent when the file has a `finish`, and that agent gets the `last` pane kind.

### 2. Old files become stages in memory (`author's call`)

`agents` becomes stage 1 with `access = "write"`, and `judge` becomes stage 2.
Default access is `write` here because old agents have it today.
The file bytes do not change, so approval hashes still match.
The run page shows these as stages too.

### 3. Stage order (`locked`)

`settle` replaces `startLastAgent` with `startNextStage`.
A stage is over when all its agents are `done` or `skipped`.
A failed agent holds the stage and sets Needs you, as agents do today.
If every agent in a stage is skipped or failed for good, the run ends through the `noWayOn` path.
Stage logic goes in a new `stages.ts` as plain functions, because `run-manager.ts` already has 1121 lines.

### 4. Access per agent (`locked`)

`AgentMode` is computed per agent, not per run, and a run-level lock always wins.
Read only uses the existing `locked` flags for each program, with `AskUserQuestion` added for a talking Claude Code agent.
Section 14 lists the flags.
Read-only agents have no Bash on either program, so they cannot run `git diff`.
Section 7 covers this.

### 5. Talking agents (`author's call`)

`talks = true` turns off the reminder in `onTurnEnd`.
A turn end sets `waiting` and Needs you.
A question from `AskUserQuestion` sends no Stop event, so the hook phase `waitingForInput` must also set Needs you for that agent.
Pi has no question tool.
A Pi agent asks in plain text and ends its turn, so the turn end alone sets Needs you.
`tick` does not add to `activeMs` while the run is `needs-you` and no agent is `working`.
The agent still ends with `fleet_run_finish`.

### 6. Plan approval (`locked` that it exists, `author's call` on storage)

Both programs end in the same place.
Fleet saves each plan as `plans/<n>.md` in the run folder, adds `pendingPlan` to the agent, and shows the same plan page.
`plan = true` needs `access = "write"`, because a read-only agent cannot build its plan.
A run lock refuses a file with a plan agent at start, for the same reason.
`fleet_run_finish` is refused until a person approves the plan, so an agent cannot skip the build.

On Claude Code, `plan = true` adds `--permission-mode plan`.
`onPermission` gets the plan text when the tool is `ExitPlanMode`.
The answer goes through `respondToPermission`, with `mode` for approval and `reason` for changes.
Fleet saves the plan when the request arrives, so an answer given in the pane or in Copilot still keeps it.
Claude Code keeps an old request in `pendingPermissions` after a change request in the pane, so Fleet uses only the latest one.

On Pi, Fleet starts the agent with the read-only flags until a person approves.
The agent sends the whole plan with a new tool, `fleet_plan_submit`, and ends its turn.
The tool refuses any agent that is not a Pi agent with `plan = true` and no approved plan.
A new call replaces the waiting plan, so a person can talk in the pane and get a new version.
A change request goes in through `sendPrompt`, as reminders do at `index.ts:347`.
Approval sets `planApproved`, and `startAgent` opens a new pane on the same session with a fixed message and `--tools +edit,+write,+bash`.
Those names are needed, because Pi otherwise restores the read-only tools from the session.
`planApproved` is saved with the run, so a restart before approval keeps the read-only flags.
Pi has no build modes, so the plan page shows one approve button for it, and only the page can approve.

This limit is strong, because the write tools do not exist in that Pi process.

### 7. Handoff between stages (`author's call`)

`agentBrief` adds the path of the approved plan.
Before a stage with a read-only agent starts, Fleet writes `changes.diff` from the base branch to the run folder.
Every Claude Code agent in a stage file gets `--add-dir <run folder>`, so reading these files needs no permission.
`claudeArgs` puts this flag first, so that it cannot take the message.
Pi needs no flag, because its `read` tool takes an absolute path and has no folder limit.
Pasting the text in the brief lost, because a large diff would fill the prompt.

### 8. Returning agents (`locked`)

`resume = "Lead"` names an agent in an earlier stage.
The file check refuses a name that is not earlier.
The agent uses the program and the access of the named agent, because a session belongs to one program.
The file check refuses a different `program`.
The new `RunAgent` has its own card and state, and takes the chat handle of the named agent at start.
It uses `RETRY_MESSAGE`-style fixed words, never TOML text, as `agent-command.ts:12` requires.

### 9. New workspace and finish (`locked` that they exist, `author's call` on details)

`new-branch` makes a worktree and a branch `fleet/<slug>` from the default branch.
`open-pr` pushes the branch and runs `gh pr create`, with the last agent's summary as the body.
It needs `new-branch`.
If the branch has no commits, or the worktree has work with no commit, the run finishes with a clear problem and opens no PR.
Fleet saves the problem as `run.prProblem`, the run page shows it, and a person can try again.
A PR that opens drops the worktree.
`gh pr create` goes in `pr.ts`, and arguments never come from TOML.

### 10. Builder pane (`locked`)

`PaneKind` gains `builder`, and `PaneIdentity` gains `{ kind: 'builder', project, draftId }`.
Tools for this kind are `fleet_workflow_list`, `fleet_workflow_guide` and a new `fleet_draft_save`.
`fleet_draft_save` takes the whole TOML.
The first save sets the id from the name, and it refuses a file that exists.
Later saves from this pane replace only this draft.
Bad files are refused with the same messages as `fleet_workflow_create`.
Approval works as it does today, so a changed file needs approval again.

The brief says that the only job is this workflow, and it includes `workflowGuide()`.
`message` is `null`, so the person types first in the real app.
Section 14 lists the tool flags.
To change a draft later, Fleet starts the same session with `resume` and the same brief.
Pi gets the same brief, plus one line that tells it to ask in plain text, because it has no question tool.
Pi loads `fleet_draft_save` through the existing `/workflows/tools` list, so the Fleet Pi extension needs no change.

### 11. Builder layout (`author's call`)

A workspace tab has two splits: the terminal pane and a draft pane.
The draft pane reads the file through the existing folder watcher, and shows the Stage Map as read-only summary.
The Program switch sits on the "Make with an agent" start page, because a running pane cannot change program.

### 12. Stage Map editor and Add agent (`locked` for the map, `author's call` for the dialog)

The map replaces `SetupForm` and keeps the File tab.
Add agent is one dialog with two panes, not a wizard: pick a job on the left, and see the filled fields on the right.
Jobs come from built-ins and saved agent definitions.
A job copies its text into the file and keeps no link, because approval must cover the exact prompt.
A saved agent maps to `write` access if its `tools` can edit files.
The dialog warns when two agents in one stage can change code.
Checks show as you edit.

### 13. Live view and plan page (`locked` for the full page, `author's call` for the layout)

Live uses the same map.
The plan page has a section list, the document through `MarkdownPreview`, and an answer panel.
It shows only for the agent that waits, and "Read the plan" opens it later.
The Copilot notice opens this page.

### 14. Flags per program (`author's call`)

Checked against Claude Code 2.1.316 and Pi 1.4.0.

| Job                  | Claude Code                                                             | Pi                                                                      |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Give the brief       | `--append-system-prompt-file <brief>`                                   | `--append-system-prompt <brief>`                                        |
| Go on with a session | `--resume <id>`                                                         | `--session <id>`                                                        |
| Read only            | `--tools Read,Grep,Glob --setting-sources user --strict-mcp-config`     | `--no-approve --tools read,grep,find,ls,fleet_* --exclude-tools mcp__*` |
| Change code          | No flag                                                                 | `--no-approve`, or `--approve` for `team-pr`                            |
| Read the run folder  | `--add-dir <run folder>`, before another flag                           | No flag needed                                                          |
| Talk with a person   | Add `AskUserQuestion` to `--tools`                                      | No flag. The agent asks in plain text                                   |
| Plan first           | `--permission-mode plan`                                                | The read-only flags, then `--no-approve --tools +edit,+write,+bash`     |
| Builder pane         | `--tools Read,Grep,Glob,AskUserQuestion` plus the other read-only flags | The read-only flags                                                     |

Pi has no `--permission-mode`, no `--add-dir`, and no built-in question tool.
`--no-approve` ignores project `.pi` files, but `AGENTS.md` and `CLAUDE.md` still load, so a reviewer keeps the project rules.
The agent cannot widen `--tools`, because Pi removes other tools at start.

The spike changed three things.
`--add-dir` takes many values, so a message after it is read as a folder, and the agent starts with no message.
Pi restores the old tool list on resume when `--tools` is not set, so the approval restart must name the write tools.
Pi can stop at a trust question before Fleet sees a session, so every Pi agent in a stage file has a trust flag.
Old files keep their flags, so `AgentMode` gains `write` for stage files.
The build needed no `plan-approved` mode, because the approval sets `planApproved` on the agent.
`docs/learnings/workflow-agent-flags-spike.md` has all the results.

## Call-site audit

| Site                                                     | Change | Why                                                |
| -------------------------------------------------------- | ------ | -------------------------------------------------- |
| `config.ts` `WorkflowFile`, `checkRules`                 | Yes    | Stages, access, resume and new rules               |
| `shared/workflows.ts`                                    | Yes    | New types, `RunAgent` fields                       |
| `run-manager.ts` `identify`                              | Yes    | Builder panes                                      |
| `run-manager.ts` `newRun`, `launch`, `settle`, `noWayOn` | Yes    | Stage order                                        |
| `run-manager.ts` `onTurnEnd`, `onPermission`, `tick`     | Yes    | Talking agents and plans                           |
| `run-manager.ts` `modeOf`, `briefOf`, `startAgent`       | Yes    | Per-agent mode, stages, resume, Pi approval        |
| `agent-command.ts`                                       | Yes    | Plan mode, access, add-dir, per program            |
| `prompts.ts` `agentBrief`                                | Yes    | Plan and diff paths                                |
| `tools.ts`, `agent-tools.ts`                             | Yes    | Builder kind, and the two new tools                |
| `agent-tools.ts` `finish`                                | Yes    | Refuse a finish before plan approval               |
| `bridge-routes.ts:97`                                    | Yes    | `run: kind !== 'outside'` is wrong for `builder`   |
| `index.ts:337`, `:503`, `electron.ts:66`                 | Yes    | Pass plan text, mode and reason                    |
| `starts.ts` `programChecks`                              | Yes    | Plan on Windows, run lock, `gh` for `open-pr`      |
| `scheduler.ts`                                           | Yes    | Refuse rules for files with talking or plan agents |
| `guide.ts`, `starters.ts`                                | Yes    | Stages and the new starter                         |
| `workflow-toml.ts`                                       | Yes    | Read and write stages                              |
| `WorkflowEditor.tsx`                                     | Yes    | Stage Map                                          |
| `RunDetail.tsx`, `RunSheet.tsx`                          | Yes    | Live map, plan page, steps                         |
| `workflow-review.ts`, `ReviewSections.tsx`               | Yes    | The approval modal shows stages                    |
| `approval.ts`                                            | No     | It hashes file bytes, so format is no concern      |
| `catalog.ts`, `folder-watcher.ts`                        | No     | They read files by name                            |
| `board.ts`, `report.ts`                                  | No     | Stages do not change the board or the report       |
| `posting.ts`                                             | No     | `post-pr` stays as it is                           |
| `power.ts`, `run-store.ts` format                        | No     | `writePrompt` already takes a name                 |
| `PlanMarkdown.tsx`, `PermissionRequest.tsx`              | No     | Normal sessions keep the card                      |
| `resources/pi-extensions/fleet.js`                       | No     | It loads tools by list, and reads `run` from Fleet |

## File manifest

New:

- `src/main/workflows/stages.ts`: stage state and order, as plain functions.
- `src/main/workflows/builder.ts`: builder panes, drafts and brief.
- `src/shared/workflow-jobs.ts`: built-in jobs.
- `src/renderer/src/components/workflows/StageMap.tsx`: map for edit and Live.
- `src/renderer/src/components/workflows/AddAgentDialog.tsx`: Add agent.
- `src/renderer/src/components/workflows/PlanPage.tsx`: plan page.
- `src/renderer/src/components/workflows/BuilderStart.tsx`: start page for the builder.
- `src/renderer/src/components/workflows/DraftPane.tsx`: draft beside the terminal.
- Tests next to each file in `__tests__/`.

Modified: the sites marked Yes above.

## Build sequence

1. **Spike the unknowns in the real app.**
   Start `claude` by hand with the planned flags.
   Check that `ExitPlanMode` arrives through the permission path with `--permission-mode plan`, that approval with `mode` works, that `AskUserQuestion` works with `--tools`, that `--add-dir` reads need no permission, that the Fleet tools load, and which event marks a waiting question.
   Start `pi` by hand with the Pi flags in section 14.
   Check that a read-only agent cannot edit, that it reads a file in the run folder with no stop, that it can resume with other flags and keep its talk, that the write tools work after that resume, that `fleet_draft_save` and `fleet_plan_submit` load, that `sendPrompt` reaches an idle Pi, and that a turn end sets Needs you with no reminder.
   Verify: write the result in `docs/learnings/`, and change this design if a check fails.
   Done on 2026-11-01. See section 14.
2. **File format and normalize.**
   Verify: unit tests for valid files, each new error, and every existing starter.
3. **Stage order.**
   Verify: unit tests with fake panes in `run-manager.test.ts`, and all existing run tests pass with no edit.
4. **Access per agent.**
   Verify: `agent-command.test.ts` covers each flag set, and a real read-only pane refuses an edit.
5. **Talking agents and the limit.**
   Verify: unit tests, and a real run stays Needs you for more than 60 minutes of limit time with no cut-off.
6. **Plan approval in the engine.**
   Verify: on Claude Code and on Pi, a real run saves the plan, and approval and a change request both work.
   A real Pi agent cannot edit before approval, and can edit after it.
7. **Handoff and returning agents.**
   Verify: a real reviewer reads `plans/1.md` and `changes.diff` with no permission stop, and a real Lead resumes with its context.
8. **Workspace and finish.**
   Verify: `pr.test.ts`, plus a real PR on a test repo, and the no-commit case.
9. **Builder pane and tool.**
   Verify: `tools.test.ts`, `bridge-routes.test.ts`, and a real pane cannot edit code or run a workflow, and can save.
10. **Stage Map, Add agent and draft pane.**
    Verify: component tests, and `npm run drive` screenshots at normal and narrow width.
11. **Live view and plan page.**
    Verify: `npm run drive` with a plan of 300 lines, with tables, code and long paths.
12. **Starter, guide and approval modal.**
    Verify: `guide.test.ts`, and the starter passes the file check.
13. **Whole flow.**
    Verify: one run in the dev app from tell to open PR on a test repo, on a Claude subscription.
14. **Quality.**
    Verify: `npm run typecheck`, `npm run lint`, `npm test`, `cd hooks/fleet-copilot-go && go test ./...`, and `ripwire . --quality-delta`.

Steps 1 to 9 come before any UI, because a wrong guess on program flags changes the file format and the screens.

## Test plan

- **File format:** both shapes refused together, unknown `resume` target, `resume` to a later stage, `open-pr` with no `new-branch`, last stage with two agents and a finish, `plan = true` with `read` access, and `resume` with another program. Failure mode: an old file stops loading.
- **Compatibility:** each old starter normalizes, and its hash and approval do not change. Failure mode: a silent need to approve again.
- **Stage order:** a later stage never starts early, a failed agent holds its stage, `only_with_findings` skips, and resume after a restart starts the right stage. Failure mode: reviewers read half-built code.
- **Access:** read-only flags per agent on each program, and a run lock wins over `access = "write"`. Failure mode: permissive access.
- **Command order:** `--add-dir` never comes right before the message, and every Pi agent in a stage file has a trust flag. Failure mode: an agent that waits with no message.
- **Talking agents:** no reminder, no time counted while waiting, and time counts again after a reply. Failure mode: a cut-off during a long talk.
- **Plan:** every version saved, answers from the page, the pane and Copilot all clear the wait. Failure mode: a run that waits forever.
- **Pi plan:** read-only flags until approval, including after an app restart, write flags after it, and `fleet_plan_submit` refused for other agents. Failure mode: code changes before approval.
- **Plan finish:** `fleet_run_finish` refused before approval on both programs, and a locked run with a plan agent refused at start. Failure mode: a skipped build.
- **Builder:** a builder pane cannot call `fleet_workflow_run` or a board tool, cannot replace another file, and an outside pane cannot call `fleet_draft_save`. Failure mode: permissive access.
- **Automatic rules:** a file with talking agents cannot get a rule. Failure mode: a run that waits for nobody.
- **UI:** map edits round-trip through `workflow-toml.ts` and the File tab shows the same file.

## Baseline to hold

Measured on commit `8c94695d` on 2026-11-01:

- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0.
- `npm test`: 368 files, 4847 tests, all passed.
- `cd hooks/fleet-copilot-go && go test ./...`: ok.

## Known risks

**Terms of use.**
Checked on 2026-11-01. This is a reading of the terms, not legal advice.
The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective Oct 8, 2025), section 3, item 7, forbid access "through automated or non-human means, whether through a bot, script, or otherwise".
The exception is an Anthropic API key, or use that Anthropic explicitly permits.
The [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance) says that plan limits assume "ordinary, individual usage".
It also says that an end user can sign in to the unmodified Claude Code binary with their own subscription.
Fleet fits that part: it runs the unmodified binary, and it never touches the login.
A Lead or a builder has a person with it, so it is close to ordinary use.
A reviewer on Claude Code runs with no person, and neither page plainly permits this on a subscription.
This is true of today's workflows too.
The starter keeps Pi for reviewers.
A person who wants Claude Code reviewers should use an API key, or ask Anthropic through the sales link on the legal page.

**Pi plan is a Fleet feature.**
Pi knows nothing of plans, so an agent can forget `fleet_plan_submit` and only write its plan in the chat.
The brief tells it to use the tool, and the agent cannot change code or finish until it does.
The run then waits for a person, and the person must tell it in the pane.

**The Pi approval opens a new pane.**
A person sees the pane change at approval, and anything typed but not sent in the old pane is lost.
The session stays the same, so the talk is not lost.

**Program flags can change.**
The plan depends on `--tools`, `--permission-mode`, `--add-dir` and hook behavior in Claude Code 2.1.316.
It also depends on `--tools` with `+name`, `--exclude-tools`, `--no-approve`, `--session` and extension events in Pi 1.4.0.
A change can break plan capture or a tool limit with no error.
Step 1 and a real-app test reduce this, but they do not remove it.

**The Lead must commit.**
Reviewers and `open-pr` read commits, so uncommitted work is invisible to them.
The brief tells the Lead to commit, and the plan gate does not enforce it.
Decision: Fleet checks only at `open-pr`, and a stage end stays free of this check.
A stage-end check would stop a Lead that is right to leave work for the Fix stage.
So reviewers can still read a change with no commit, through `changes.diff`, which is `git diff <base>` and has work with no commit.

**Windows.**
Claude Code has no Fleet tools there (`starts.ts:122`), so the builder and `fleet_run_finish` do not work with it.
The start page offers Pi, and the checks stop the run.

**Pi questions.**
Pi agents ask in plain text, so a person gets no choice buttons.
The turn end is the only signal, so a Pi agent that asks and keeps working does not show Needs you.

**Project `.pi` files do not load.**
Stage-file Pi agents use `--no-approve`, so they never stop at Pi's trust question.
The cost is that project `.pi` extensions, skills and settings do not load in those agents.
`AGENTS.md` and `CLAUDE.md` still load.

**Claude Code trust question.**
A repo that nobody trusted yet stops Claude Code at a trust question, and Fleet shows no session.
A worktree of a trusted repo does not stop.
The risk stays for a repo that a person has never opened in Claude Code.

**Shared worktree.**
Reviewers and the Lead use one folder.
Stage order prevents overlap, but a person can still type in a kept pane.

**Comments in TOML.**
`workflow-toml.ts` rewrites the file with `stringify`, so the map loses comments.
This already happens today, but more people will now mix the File tab and the map.
