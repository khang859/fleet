## Why

Fleet Workflows start all agents together, and only the judge waits.
This cannot run the way people really work with coding agents: tell an agent what you want, let it read the code, answer its questions, approve its plan, let it build, get reviews, and open a PR.

The editor also cannot express this flow.
It has one flat list of agents and about 23 fields on one page, and it shows errors only after Save.

People also want to make these workflows by talking to an agent.
Claude subscriptions work only in the Claude Code terminal app, so this talk must happen in a real terminal pane, not in a Fleet chat window.

## What Changes

- Add **stages** to the workflow file.
  Stages run in order, and the agents in one stage run at the same time.
  Old files with `agents` and `judge` keep working with no change and stay approved.
- Add per-agent **access**: read only, or change code.
- Add agents that **talk with you** in their pane, with no reminder, and with waiting time that does not count toward the run limit.
- Add **plan approval**.
  A Claude Code agent starts in plan mode.
  A Pi agent starts read only, sends its plan with a new Fleet tool, and gets write tools after approval.
  Fleet shows the whole plan as a full Markdown page, and you approve it or ask for changes.
- Let an agent **come back** in a later stage with the same session.
- Give later agents the plan and the changed code.
- Add the `new-branch` workspace and the `open-pr` finish action.
- Add a **builder pane**.
  Fleet starts the real Claude Code or Pi app with a brief, and tools limited to reading code, asking questions and saving one draft.
- Replace the editor form with a **Stage Map**.
  Columns run in order, and cards in one column run at the same time.
- Add an **Add agent** dialog that asks for a job, a program and what the agent may do.
- Add a **Live** view that uses the same map, and a **Build a feature** starter.

## Capabilities

### New Capabilities

- `workflow-stages`: the stage file format, stage order, per-agent access, talking agents, plan approval, returning agents, handoff between stages, the new workspace and the new finish action.
- `workflow-builder`: making and changing a workflow with an agent in a real terminal pane, with the Stage Map editor and the Add agent dialog.

### Modified Capabilities

None.
Workflows have no spec in `openspec/specs/` yet.

## Impact

- Main process: `src/main/workflows/` (`config`, `run-manager`, `agent-command`, `prompts`, `tools`, `bridge-routes`, `agent-tools`, `index`, `starters`, `guide`, `starts`, `scheduler`, `pr`).
- Shared types: `src/shared/workflows.ts`.
- Renderer: `src/renderer/src/components/workflows/`.
- External tools: `claude`, `pi` and `gh`, all with flags or commands that Fleet already uses, plus `--permission-mode` and `--add-dir` on `claude`.
  `pi` needs no new flags.
  `design.md` section 14 lists the flags for each program.
  Pi has no plan mode, so Fleet adds `fleet_plan_submit` and starts Pi again after approval.
- No new dependencies.
- Design canvas: https://claude.ai/artifact/9RVmea6FZZYy6xvNCmZFhc (private to the owner).
