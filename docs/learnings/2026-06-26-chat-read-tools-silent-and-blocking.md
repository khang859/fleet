# Learnings: Chat read-tools were invisible and froze the app (2026-06-26)

## Read-only chat tools emitted no status, so tool use looked frozen

**Problem:** When the chat model called the read-only tools (`read_file`, `glob`,
`search`) — e.g. asking it to "explore a folder" — the UI showed nothing: no
"running tool" pill, just the three-dot thinking indicator, then minutes later
the final answer appeared all at once.

**Root cause:** Only the *gated* tools (`bash`, MCP, web search) and image
generation emitted `CHAT_TOOL_STATUS`. The read tools returned synchronously in
`tool-runner.ts` `dispatch()` with no `emit()` before/after, so the renderer was
never told a tool was running.

**Fix:** Added a `withProgress(ctx, label, fn)` helper in `ChatToolExecutor` that
emits `generating` before and always `done` after (in a `finally`, so the pill
clears even when the tool throws). Wrapped the three read tools with it.

## Synchronous fs walks block the Electron main process (and the PTYs)

**Problem:** Beyond the missing indicator, `glob`/`search` did a fully
**synchronous** directory walk (`readdirSync`/`statSync`/`readFileSync`, up to
`MAX_WALK_FILES = 20_000`). On a large folder this blocked the single-threaded
main-process event loop for seconds — and since Fleet's PTY data flows through
the main process, it froze terminals too. No IPC (not even a status event) could
be flushed during the walk.

**Fix:** Added `walkFilesAsync` (an async generator over `fs/promises`
`readdir`/`stat`) and made `globTool`/`searchTool` async, awaiting `readFile` per
file. Awaiting hands control back to the event loop between filesystem ops, so a
large scan stays responsive. Emit the `generating` status *before* the walk so
the pill paints first.

**Note:** Keep the `@`-mention context path (`buildMentionContext`,
`searchWorkspacePaths`) synchronous — it is bounded and user-initiated, and
making it async would force `ChatService.send()` async (breaks ~13 tests that
read `.userMessage` off the synchronous return). A separate sync `walkFiles` is
kept for it.

**Follow-up (done, #372):** the `@`-mention picker (`searchWorkspacePaths`) now
walks asynchronously via `walkEntriesAsync` (an async twin of `walkEntries`/
`walkFilesAsync`), so a large-workspace scan on keystroke no longer blocks the
main process. Its IPC handler (`CHAT_MENTION_SEARCH`) returns the promise, and
the renderer debounces the search ~150ms with a latest-wins sequence guard so
stale in-flight results can't overwrite newer ones. This path is independent of
the `ChatService.send()` sync constraint, which only governs
`buildMentionContext`.

**Follow-up (not done):** the agentic walk does not check `ctx.signal`, so a Stop
mid-scan won't abort it early (bounded by `MAX_WALK_FILES`). The mention picker's
superseded walks likewise run to completion in the main process (the renderer
just drops their late results); main-side cancellation would need a request-keyed
cancel IPC since `AbortSignal` can't cross IPC directly.

## UI: GeneratingSkeleton was image-only

**Problem:** The one progress component, `GeneratingSkeleton`, renders a 64×64
square image placeholder with copy like "this can take ~30s" and an "Image
error:" label — correct for image generation, wrong for every other tool.

**Fix:** Added a `kind?: 'image'` field to `ChatToolStatusPayload`. Image
generation tags its emits with `kind: 'image'`; everything else omits it. The
renderer shows `GeneratingSkeleton` only for `kind === 'image'` and a new compact
`ToolStatusPill` (spinner + label) otherwise.
