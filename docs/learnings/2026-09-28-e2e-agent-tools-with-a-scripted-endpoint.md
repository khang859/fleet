# E2E-testing Agent pane tools with a scripted endpoint

## Context

The background-command card needed an end-to-end check: the model calls `bash` with `background: true`, the card appears, the user stops a job, and the model is told who stopped it.
Doing that with a real model means loading a multi-GB local model or spending OpenRouter tokens, and the model may not call the tool you want.

## What worked

A ~100-line Node server in the scratchpad that speaks just enough OpenAI-compatible HTTP:

- `GET /v1/models` returns one model, so the endpoint validates.
- `POST /v1/chat/completions` streams SSE `chat.completion.chunk`s.
  A user message `BG: cmd1 ;; cmd2` becomes one `bash` tool call per command with `background: true`.
  `TOOL: <name> <json args>` becomes any other tool call, e.g. `TOOL: bash_output {"id":"bg_3"}`.
  Anything else gets a plain text reply.

Then, through `fleet-drive eval`, add a local endpoint `{ id: 'ep_mock', baseUrl: 'http://127.0.0.1:18765', enabled: true, lastKnownModels: [{ wireId: 'mock', name: 'mock' }] }` to `settings.ai.agent.localEndpoints` and set `coding.model` to `local:ep_mock/mock`.
Save the original `ai.agent` first and restore it at the end, and delete the test session with `window.fleet.agent.deleteSession`.

## Gotchas

- **Fleet appends a note as a trailing user message** ("Note from Fleet, not from the user: ..."), so the mock must look for the last user message that contains its trigger, not only the last message.
- **The title request also contains the user's text** (`User: BG: ...`), so only trigger a tool call when the request carries `tools`, and stop once a `tool` message follows the trigger.
- **The new-agent folder dialog does not accept a typed absolute path.** Use `__FLEET__.stores.workspace.getState().openAgentPane('<dir>')` instead.
- **The composer is `textarea[aria-label="Message the agent"]`.** A bare `textarea` selector matches a hidden xterm helper first.
- **`pkill -f mock-llm.mjs` kills the shell that runs it**, because that shell's own command line contains the pattern. Kill by port instead: `lsof -ti tcp:18765 | xargs -r kill`.
- **The side column has hysteresis** (`SIDE_COLUMN_MIN_PANE_PX` to open, `SIDE_COLUMN_KEEP_PX` to stay open), so re-expanding the sidebar does not necessarily bring the chip back. `Split Right` reliably makes the pane narrow.
