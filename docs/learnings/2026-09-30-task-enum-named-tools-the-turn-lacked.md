# The `task` tool named tools the turn did not have

Found in the Phase 3 end-to-end run of the Orchestrator's read tools, with a regular Agent pane and a real `claude` session in another pane.

## What happened

A regular Agent pane, asked about the user's Claude Code sessions, replied that "the tool list for subagents includes `fleet_sessions`, `fleet_read` and `fleet_diff`" and considered dispatching a subagent to reach them.
The fleet tools were correctly kept out of the turn's own tool list, but the `task` spec's `tools` parameter was an enum of every name in `SUBAGENT_TOOL_NAMES`.
Adding the read-only fleet tools to that list for `fleet-analyst` put them in front of every pane.

The same enum already named tools no child gets.
The image tool is never handed to a subagent, and `web_fetch` is gone when the user turns web reading off, yet both were listed.
The model spotted the image one itself: "the `task` tools enum includes `image`, but no `image` tool is described to me".

Two smaller things turned up in the same run.
When orchestrator mode was switched off mid-conversation, the model saw its own earlier fleet calls in the history with no tools behind them and took it for a fault.
And the fleet tool rows showed the `<session-data>` fence, which is written for the model, as a stray `</session-data>` line under a diff.

## How it was fixed

- `buildTaskSpec` takes the tools a child dispatched this turn would actually get, worked out by the same `toolSpecsFor` call `runTask` makes, so the enum and the child cannot drift.
- `SubagentManager.dispatch` refuses a fleet tool named in `tools` outside orchestrator mode, and drops the fleet tools from a definition that has no list of its own.
- A turn with the mode off whose history holds a fleet call gets a short "Orchestrator mode is off" block in the system prompt.
- `fence` and `unfence` live together in `shared/fleet-tools.ts`, and the tool row unfences fleet results before drawing them.

## How it was checked

`agent-service-fleet.test.ts` asserts that a regular pane's `task` spec names no `fleet_` tool and no `image`, that dispatch refuses a fleet tool from a regular pane, and that the mode-off block appears only when the history used a fleet tool.
The same questions were asked again in the running app, and the model listed no fleet tool and no image tool.

## Takeaways

- A schema enum is part of what the model is told. Hiding a tool from the tool list while naming it in another tool's parameters still advertises it.
- Derive a list of "what the child gets" from the code that gives it, not from a constant beside it.
- Ask the model what it can see. It reports inconsistencies in its own tool list plainly, and a unit test only checks the ones you thought of.
