## 0. Baseline and spike

- [x] 0.1 Record the baseline in `design.md`
- [x] 0.2 Spike in the real app: plan mode, approval with a mode, `AskUserQuestion` with `--tools`, `--add-dir`, Fleet tools, and the event for a waiting question
- [x] 0.2a Spike Pi with the flags in `design.md` section 14: read-only limit, a run-folder read, resume with write flags that keeps the talk, `fleet_draft_save`, `fleet_plan_submit`, `sendPrompt` to an idle Pi, a turn end with no reminder, and the trust question for an agent that changes code
- [x] 0.3 Write the spike results in `docs/learnings/`, and update `design.md` if a check failed

## 1. File format

- [x] 1.1 Add stage types to `src/shared/workflows.ts`
- [x] 1.2 Add `stages`, `access`, `talks`, `plan`, `resume` and `only_with_findings` to `config.ts`
- [x] 1.3 Add the file rules to `checkRules`, with a clear message for each, and refuse `plan = true` with `read` access and `resume` with another program
- [x] 1.4 Normalize old files to stages in memory
- [x] 1.5 Test that every old starter loads, and that its approval does not change

## 2. Stage order

- [x] 2.1 Add `stages.ts` with plain functions for stage state
- [x] 2.2 Replace `startLastAgent` with `startNextStage`
- [x] 2.3 Handle `only_with_findings`, failed stages and `noWayOn`
- [x] 2.4 Make run resume start the right stage
- [x] 2.5 Add stage tests, and keep all old run tests unchanged

## 3. Access per agent

- [x] 3.1 Compute `AgentMode` per agent, with the run lock on top
- [x] 3.2 Add the flag sets for both programs to `agent-command.ts` and its tests, with `--add-dir` first and `--no-approve` on every stage-file Pi agent
- [x] 3.3 Check in real Claude Code and Pi panes that a read-only agent cannot edit

## 4. Talking agents

- [x] 4.1 Turn off the reminder for `talks = true`
- [x] 4.2 Set Needs you on a turn end on both programs, and on a waiting Claude Code question
- [x] 4.3 Stop the limit while the run only waits for a person
- [x] 4.4 Add tests, then run a real wait past the limit

## 5. Plan approval

- [x] 5.1 Start with `--permission-mode plan` for `plan = true`
- [x] 5.2 Pass the plan text from `index.ts` to `run-manager.ts`
- [x] 5.3 Save each plan version in the run folder, and add `pendingPlan`
- [x] 5.4 Extend `answerPermission` with a mode and a reason
- [x] 5.5 Clear the wait for answers from the page, the pane and Copilot, use only the latest request, and check an approval in the pane
- [x] 5.6 Add `fleet_plan_submit`, and refuse it for all agents but a Pi agent with `plan = true` and no approved plan
- [x] 5.7 Start a Pi plan agent read only, and save `planApproved` with the run
- [x] 5.8 Start Pi again on the same session with `--tools +edit,+write,+bash` after approval, and send a change request through `sendPrompt`
- [x] 5.9 Refuse `fleet_run_finish` before approval on both programs, and refuse a locked run with a plan agent
- [x] 5.10 Check in a real pane that Pi cannot edit before approval and can edit after it

## 6. Handoff and returning agents

- [x] 6.1 Add the plan path and the diff path to `agentBrief`
- [x] 6.2 Write `changes.diff` before a stage with a read-only agent
- [x] 6.3 Add `--add-dir` for read-only Claude Code agents
- [x] 6.4 Start a `resume` agent with the named agent's chat handle
- [x] 6.5 Check in a real run that Claude Code and Pi reviewers read both files with no stop

## 7. Workspace and finish

- [x] 7.1 Add `new-branch` and make its worktree and branch
- [x] 7.2 Add `open-pr` to `pr.ts`, with no TOML text in arguments
- [x] 7.3 Handle a branch with no commits, and decide on the clean-tree check
- [x] 7.4 Add the `gh` and Windows checks to `starts.ts`
- [x] 7.5 Refuse automatic rules for files with talking or plan agents

## 8. Builder pane

- [x] 8.1 Add the `builder` pane kind and identity, and fix `bridge-routes.ts:97`
- [x] 8.2 Add `fleet_draft_save`, and let it replace only this pane's draft
- [x] 8.3 Add the builder brief with `workflowGuide()`
- [x] 8.4 Start the pane with `message: null` and the builder tools for each program, and add the plain-text question line for Pi
- [x] 8.5 Reopen a draft with `resume` and the same brief
- [x] 8.6 Test that the pane cannot edit code, run a workflow or replace another file

## 9. Editor

- [x] 9.1 Read and write stages in `workflow-toml.ts`
- [x] 9.2 Add `StageMap.tsx` in place of `SetupForm`, and keep the File tab
- [x] 9.3 Add the job list from built-ins and saved agents
- [x] 9.4 Add `AddAgentDialog.tsx`, with the two-writers warning and the rule that plan approval needs change-code access
- [x] 9.5 Show file checks as a person edits
- [x] 9.6 Check with `npm run drive` at normal and narrow width

## 10. Builder UI

- [x] 10.1 Add `BuilderStart.tsx` with the Program choice
- [x] 10.2 Open the workspace tab with the terminal and `DraftPane.tsx`
- [x] 10.3 Update the draft when the file changes
- [x] 10.4 Show that a Windows person must use Pi or the editor

## 11. Live view and plan page

- [x] 11.1 Use `StageMap.tsx` in `RunDetail.tsx`
- [x] 11.2 Add `PlanPage.tsx` with `MarkdownPreview`, the section list and the answer panel, with one approve button for Pi
- [x] 11.3 Add "Read the plan" after approval
- [x] 11.4 Open the plan page from the notice
- [x] 11.5 Check a plan of 300 lines with `npm run drive`

## 12. Starter and docs

- [x] 12.1 Add the Build a feature starter, with Pi reviewers
- [x] 12.2 Update `guide.ts`
- [x] 12.3 Show stages in the approval modal

## 13. Done

- [x] 13.1 Run the whole flow in the dev app on a Claude subscription, from tell to open PR. The last step used a stand-in `gh` and a local `origin`, so no real GitHub PR was made
- [x] 13.2 Check Anthropic's terms for unattended Claude Code panes, and tell the owner the result. See "Known risks" in `design.md`
- [x] 13.3 Run `npm run typecheck`, `npm run lint`, `npm test` and the Go hook tests
- [x] 13.4 Run `ripwire . --quality-delta`. It still exits 2. The rows that stay are in `docs/learnings/2026-11-01-workflow-stages-and-builder.md`
