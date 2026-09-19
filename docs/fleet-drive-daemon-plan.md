# fleet-drive: a warm driver instead of one process per command

**State:** built
**Date:** 2026-09-19
**Written against:** `5a080843`, plus the uncommitted `npm run dev` guard and `drive stop` work (`scripts/drive/dev-guard.ts`, `scripts/drive/instance.ts`).
All line numbers below are pinned to that tree. Re-grep before trusting one.
**Origin:** three read-only investigations (code read, timing measurements, prior-art research) run on 2026-09-19.
**Handoff:** not written; the plan was built in the same session.

## As built (2026-09-19)

Everything below was built, with these differences from the plan.
The rest of this document is the plan as it was approved, kept for the reasoning.

- **The client is `scripts/drive/client.mts`, not `client.mjs`.**
  Node 25 runs TypeScript directly (about 45 ms), so the client stays typed and linted.
  `.mts` because `package.json` has no `"type"`, and a `.ts` file makes Node warn on every call.
- **The sharp blank check stays, on a 64x64 copy (about 11 ms).**
  Electron's docs say `document.visibilityState` is always `visible` when `backgroundThrottling` is off, which dev sets, so the check before capture cannot work.
  `stats()` reads its input, not the pipeline, so the shrink is materialized with `toBuffer()` first.
- **`--shot` waits for a quiet DOM, not two frames.**
  Settings mounts a lazy panel a moment after the click, and two frames caught the empty frame before it.
  It now waits until no DOM mutation for 100 ms (at most 2 s), then two frames.
- **A ref gets a 1 s timeout, and a dead ref fails at once.**
  A ref names an element that exists already, so there is nothing to wait for, and a click on a palette row that was closing waited out the full 5 s.
- **Terminal verbs were added:** `term`, `term-send`, `term-key`, `term-wait`.
  They write through `window.fleet.pty.input` and read the xterm buffer from `__FLEET__.terminals`, so Claude Code can be run and checked in a pane.
- **`up` strips `CLAUDECODE` and `CLAUDE_*` from the app's environment.**
  Without that, Claude Code started in a pane inherits the driving agent's child-session marker and turns transcript saving off.
- **`scripts/drive/cli.ts` is gone.** Dispatch lives in `dispatch.ts`, the dev-app lifecycle in `dev-app.ts`.

Measured on the live dev window, median of repeated runs:

| Command | Before | Now (`node scripts/drive/client.mts`) | Now (`npm run drive --`) |
| --- | --- | --- | --- |
| `eval '1+1'` | 601 ms | 60 ms | 161 ms |
| `snapshot` | 599 ms | 63 ms | |
| `click` | 617 ms | 100 ms | |
| `screenshot` | 1454 ms | 149 ms | 248 ms |
| `screenshot --png` | | 936 ms | |

Verified by hand: `up` (10.7 s cold), `restart` (new pid), reattach after restart, restart after a source edit, idle exit, 5 parallel clients on one daemon, a dead ref failing in 65 ms, a 5-step `run` in 499 ms, `cmd settings`, and Claude Code started, waited on and quit in a pane.
After `npm run build`, `out/renderer` has no `__FLEET__`.

## What this is

Agents check UI work by driving the live dev app with `npm run drive -- <verb>`.
Each command feels like loading a web page, and a normal check is 5 to 15 commands, so a single look at the UI takes 10 to 20 seconds.

The time is almost all setup, not work.
Every command starts npm, starts tsx, loads Playwright, connects over CDP, finds the window, and disconnects again.
Measured on the live dev window (DPR 2, 1200x800), median of 5 runs:

| Command | Total | Real work once connected |
| --- | --- | --- |
| `eval '1+1'` | 601 ms | 0.9 ms |
| `snapshot` | 599 ms | 4 ms |
| `click` | 617 ms | 50 ms |
| `screenshot` | 1454 ms | 805 ms PNG encode + 67 ms blank check |

The roughly 590 ms of fixed cost splits into npm about 100 ms, tsx startup and transpile about 180 ms, library imports about 190 ms (Playwright 155 to 230 ms), Node about 30 ms, and connect plus window lookup plus close about 65 ms.

Two more costs hide in normal use.
A wrong selector in `click` or `type` waits for Playwright's 30 s default timeout before it fails.
And seeing the result of an action is always a second command, which pays the setup again.

## Goals and non-goals

Goals:

1. `eval`, `snapshot`, `click`, `type` and `keys` cost close to their real work, not 600 ms.
2. A screenshot costs under 150 ms by default.
3. Several steps, and "act then look", run in one call.
4. Agents can reach an app state by name (a palette command) instead of clicking through the UI to get there.
5. A bad selector fails in seconds, not 30.
6. Every existing verb and its syntax keeps working, because about 25 docs and learnings files quote them.

Non-goals:

- No MCP server. The CLI is what agents already use, and a daemon behind it gives the same warm connection.
- No sweep to add `data-testid` across the UI. Only one exists today; adding them is separate work.
- No exposure of more zustand stores (toast, annotation, cwd, workspaceList, hookStatus). Add one when a task needs it.
- No "UI has settled" signal from the app. `--shot` waits two animation frames, which covers the common case.
- No video or screencast.
- No driving of native menus or `globalShortcut`. `keys` still reaches renderer handlers only.
- No change to the packaged app. All of this stays dev-only.

## Prior art

`@playwright/cli` (Microsoft) keeps a persistent session, attaches to Electron with `attach --cdp=<url>`, gives snapshots with element refs (`click e15`), and runs a multi-step Playwright script in one call with `run-code`.
vercel-labs `agent-browser` does the same with a Rust client, and adds a compact interactive-only snapshot, a `batch` verb, and JPEG screenshots with a quality setting.
Playwright MCP keeps a warm connection too, but waits 500 ms to settle after each action and returns a full snapshot in every response, which is heavy on tokens.

What transfers is the shape: one warm connection held by a background process, a thin client, refs from the snapshot, batching, and cheap screenshots.
What does not transfer is the tool itself.
None of them know which window is the main Fleet window (`scripts/drive/core.ts:39-55` matches the dev renderer URL and the `Fleet` title, and skips copilot, DevTools and web-fetch windows).
None of them run our fixtures or know `__FLEET__`.
agent-browser also has an open bug where refs are lost when it reconnects to an existing browser over `--cdp` (vercel-labs/agent-browser#1892), which is exactly our setup.

## Locked requirements

1. Build our own driver on stock Playwright (option A). Do not adopt `@playwright/cli`, agent-browser or Playwright MCP.
2. Dev-only. Nothing new reaches a packaged build, the same rule as `__FLEET__` today (`src/renderer/src/main.tsx:84`).

Do not reopen these. If you think one is wrong, say so and stop.

## What already exists

| Needed | Already does it |
| --- | --- |
| Find the main Fleet window over CDP | `attach()` in `scripts/drive/core.ts:39` |
| Per-checkout CDP port, no collisions between worktrees | `deriveDebugPort` in `src/shared/drive-session.ts:17`, switch at `src/main/index.ts:507` |
| Know which app pid owns the session | session file written at `src/main/index.ts:470` |
| Know whether a dev app is up, without Playwright | `runningDevInstance()` in `scripts/drive/instance.ts` |
| Stop the dev app cleanly, past the quit dialog | `stopDevInstance()` in `scripts/drive/cli.ts` |
| Renderer never throttled while in the background | `backgroundThrottling: !IS_FLEET_DEV` at `src/main/index.ts:362` |
| All verbs as functions of a `Page` | `scripts/drive/verbs.ts` |
| Named app actions with an `execute()` | `createCommandRegistry()` at `src/renderer/src/lib/commands.ts:65`, used by the palette at `src/renderer/src/components/CommandPalette.tsx:103` |
| Dev-only renderer bridge | `window.__FLEET__` at `src/renderer/src/main.tsx:84-101`, typed at `src/renderer/src/env.d.ts:17` |
| Refs in a snapshot, and a selector for them | Playwright `ariaSnapshot({ mode: 'ai' })` and the `aria-ref=` selector (Playwright 1.63; the repo pins `^1.61.1`) |

The verbs are already pure functions of a `Page`.
That is what makes this cheap: the daemon holds the `Page`, and the verbs do not change.

## Alternatives considered

**Adopt `@playwright/cli` with a small Fleet skill.**
It would give warm sessions and refs for almost no code.
It lost because it cannot pick the main Fleet window, cannot run our fixtures, and would be a second driving stack beside `scripts/drive` that agents have to choose between.
It is the fallback if the daemon turns out to be more trouble than it is worth.

**Keep one process per command, but make it lighter.**
Point `drive` at a precompiled `.mjs` instead of tsx, and load Playwright and sharp lazily.
Measured, this saves only about 280 ms, so an `eval` still costs over 300 ms.
It does not fix the step-by-step flow, and refs cannot work without a warm connection.
It lost because it removes less than half the cost and nothing else.
Its cheap parts (a plain JS client, lazy imports) are folded into the chosen design.

**An automation server inside the Electron main process.**
Main would expose a local endpoint that clicks, snapshots (`webContents.capturePage()`) and evaluates, with no Playwright at all.
This is the fastest possible design.
It lost because it rebuilds what Playwright already does well (actionability checks, ARIA snapshots, selector engines), and it puts test surface inside the app's own main bundle, where a dev-only guard mistake ships to users.
**Rejected outright:** do not put a command endpoint in the main process, even behind `IS_FLEET_DEV`.

**Batching as a Node script run inside the daemon, with `page` in scope** (like `run-code`).
It is the most powerful batching form.
It lost for the default path because agents already know the verb syntax, and a script that gets the raw `page` bypasses the timeouts and window checks the verbs apply.
`eval` still covers arbitrary logic in the renderer.

**Playwright MCP.**
It lost on the 500 ms settle after each action and on token cost, and it has the same window-targeting gap as the CLI.

## The chosen architecture

### 1. A background daemon holds the connection (locked)

`scripts/drive/daemon.ts` attaches once with the existing `attach()`, keeps `{ browser, page }`, and serves requests over a local socket as newline-delimited JSON: `{ id, verb, args }` in, `{ id, ok, output | error }` out.
It dispatches to the existing functions in `verbs.ts`, so verb behavior is defined in one place.

When the browser emits `disconnected` (the app quit or restarted), the daemon drops the connection and reattaches on the next request.

### 2. Daemon lifecycle (author's call)

The client starts the daemon when none answers, as a detached process with its output in `.fleet-drive/daemon.log`.
The daemon writes `.fleet-drive/daemon.json` with its pid and socket path, and the client reads that file instead of deriving the path.
The socket lives in `os.tmpdir()`, not in the checkout, because macOS limits socket paths to 104 bytes and worktree paths under `.claude/worktrees/` already come close.
On Windows the path is a named pipe (`\\.\pipe\fleet-drive-<hash>`); Node's `net` handles both.

Only one daemon per checkout: a second one that finds the socket answering exits at once.
The daemon exits after 15 minutes with no request.

The daemon records the modification time of every file in `scripts/drive/` when it starts.
If any file changed, it exits before it handles the next request, and the client starts a fresh one and retries.
This repo has already lost real time to a stale process answering for new code (`docs/learnings/2026-09-08-a-stale-electron-process-fakes-a-passing-verification.md`), and a daemon that keeps running old verb code would be the same trap in a new place.

### 3. A thin client (author's call)

`npm run drive` points at `scripts/drive/client.mjs`: plain JavaScript run by Node, with no tsx and no Playwright import.
It parses the arguments, sends one request, prints the output, and exits with the daemon's status.
Verbs that need no app (`help`, the fixture list, `stop`) stay in the client.

`npm run drive` itself costs about 100 ms (measured npm overhead), so that path cannot go below about 130 ms.
`node scripts/drive/client.mjs <verb>` skips npm, and the README will say so for agents that call it often.
These totals are estimates from the measured parts, not measurements; step 3 of the build sequence measures them.

### 4. Faster screenshots (author's call)

The default becomes JPEG at quality 85 and device scale.
Measured, JPEG q80 at device scale takes about 66 to 79 ms against 805 ms for the PNG, and keeps the 2x detail that pixel-level review needs.
`--png` keeps the exact lossless image for the cases where JPEG artifacts would matter.

The sharp blank check (67 ms) is replaced with a check before capture: `document.visibilityState` plus the window's minimized state.
Whether a minimized window reports `hidden` with background throttling off is not verified yet; step 2 checks it, and if it does not, the sharp check stays but runs on a small downscaled copy.

### 5. Short timeouts (locked, from goal 5)

The daemon sets a 5 s default timeout on the page, overridable per call with `--timeout <ms>`.
A bad selector then fails in 5 s with Playwright's own "waiting for locator" message.

### 6. Refs in snapshots (author's call)

`snapshot --refs` uses `ariaSnapshot({ mode: 'ai' })`, and the result lines carry `[ref=e12]`.
Any selector argument that matches `e<number>` becomes `aria-ref=e<number>`.
Plain `snapshot` keeps today's output so existing notes stay true.

Refs live in Playwright's injected script inside the page, created per connection, which is why they need the daemon at all.
They also die when React replaces the element, and each new snapshot replaces the old set.
A dead ref must fail with "ref e12 is gone, take a new snapshot", not with a timeout.

### 7. Batching and act-then-look (author's call)

`drive run [file]` reads verb lines from a file or stdin, in the same syntax as the command line, and runs them in order on the warm connection.
It prints each step's output and stops at the first failure, naming the line.

Every action verb accepts `--shot`: after the action it waits two animation frames, takes a screenshot, and prints its path.
That turns the most common pair of commands into one.

### 8. App actions by name (author's call)

`__FLEET__.commands` returns `createCommandRegistry()` (a function, because commands read current state).
`drive cmd` lists command ids and labels, and `drive cmd <id>` runs that command's `execute()`.
The palette commands already cover the `fleet:*` overlay events, so no separate `emit` is added.
Remote-host commands (`createRemoteHostCommands`) are left out; they depend on saved hosts.

### 9. `drive up` and `drive restart` (author's call)

`drive up` starts `npm run dev` detached, writes its output to `.fleet-drive/dev.log`, and waits until the window is attachable, then prints the pid.
If the app is already up it prints the pid and does nothing, like the new `predev` guard.
`drive restart` is `stop` then `up`, and it checks that the new pid differs from the old one.

This goes past the speed goals, but it closes the other half of today's problem.
Agents lose track of a dev server because they own a background shell; with `up` there is nothing to own.
And `restart` is the safe way to load new main-process code, the step that the 2026-09-08 learning got wrong by hand.

## Call-site audit

| Site | Change |
| --- | --- |
| `package.json` `drive` script | Point at `node scripts/drive/client.mjs` |
| `package.json` `playwright` | `^1.61.1` to `^1.63.0` for `mode: 'ai'` |
| `scripts/drive/cli.ts` | Split: request dispatch moves to the daemon, argument parsing moves to the client. Removed when empty |
| `scripts/drive/verbs.ts` | Screenshot defaults, blank check, `--shot`, refs, timeouts |
| `scripts/drive/core.ts` | No change; the daemon calls `attach()` as is |
| `scripts/drive/selectors.ts` | Add the `e<number>` to `aria-ref=` mapping |
| `scripts/drive/fixtures.ts` | No change; fixtures are strings run through `evalExpr` |
| `scripts/drive/instance.ts`, `dev-guard.ts` | No change; `up` and `restart` reuse them |
| `scripts/drive/__tests__/verbs.test.ts` | Update if the blank check changes shape |
| `src/renderer/src/main.tsx:84-101` | Add `commands` to `__FLEET__` |
| `src/renderer/src/env.d.ts:17` | Type for `commands` |
| `src/main/index.ts` | No change |
| `src/preload/index.ts` | No change |
| `scripts/drive/README.md`, `CLAUDE.md` | New verbs, `node` client path, JPEG default, `up`/`restart` |
| Docs and learnings that quote `npm run drive -- <verb>` | No change; the syntax is kept |
| `.gitignore` | No change; `.fleet-drive/` is already ignored |

## File manifest

New:

- `scripts/drive/daemon.ts`: holds the connection, serves requests, handles lifecycle.
- `scripts/drive/client.mjs`: thin client, starts the daemon when needed.
- `scripts/drive/protocol.ts`: request and response types shared by both sides.
- `scripts/drive/run-script.ts`: splits `drive run` lines into verb and arguments, with quotes.
- Tests for the protocol, the line splitter and the ref mapping.

Modified: the rows marked with a change in the call-site audit.

## Build sequence

The uncertain parts come first: whether the daemon stays attached across app restarts, and whether refs survive in practice.

1. **Bump Playwright to 1.63.**
   Verify: drive tests pass, and `status`, `snapshot`, `screenshot` work against the live app.
2. **Screenshot defaults and timeouts,** still one process per command.
   Verify: the timing bench shows the screenshot action under 150 ms. Read a JPEG and check that 1 px borders stay sharp. Minimize the window and confirm the blank warning still fires. A bad selector fails in about 5 s.
3. **Daemon and thin client,** existing verbs only.
   Verify: median `npm run drive -- eval '1+1'` over 10 runs, target under 150 ms; the same through `node scripts/drive/client.mjs`, target under 60 ms. Restart the app and confirm the next command reattaches. Edit a file in `scripts/drive/` and confirm the next command runs the new code. Run two clients at once and confirm both answer. Leave it idle and confirm the daemon exits.
4. **Refs.**
   Verify: `snapshot --refs`, then `click e<N>` on the Settings button opens Settings. After a re-render, the old ref fails with the "take a new snapshot" message, not a timeout.
5. **`run` and `--shot`.**
   Verify: a 5-step script (open settings, switch a tab, screenshot, close, snapshot) runs in one call, and the total time is reported. A failing line stops the script and is named.
6. **`__FLEET__.commands` and `drive cmd`.**
   Verify: `drive cmd` lists the palette ids, and `drive cmd <settings id>` opens Settings. After `npm run build`, `grep -r "__FLEET__" out/renderer` finds nothing.
7. **`drive up` and `drive restart`.**
   Verify: `up` twice gives one app. `restart` gives a new pid, and the log shows fresh main-process startup lines.
8. **Docs.**
   Verify: every command in the README runs as written.

## Test plan

- Protocol: a request round-trips; a thrown verb error becomes `ok: false` with the message; a malformed line is rejected without killing the daemon.
- Line splitter: single and double quotes, escaped quotes, empty lines, `#` comments. This is the part where a quoting bug fails silently, by clicking the wrong selector.
- Ref mapping: `e12` maps to `aria-ref=e12`; `text=e12` and `#e12` are left alone.
- Daemon lifecycle (integration, needs the live app, run by hand in steps 3 and 7): reattach after restart, restart after a source edit, idle exit, single instance.
- Screenshot: the existing blank-detection tests stay green, or are rewritten if the check moves.

## Baseline to hold

Measured on `5a080843` plus the uncommitted guard work, 2026-09-19:

- Tests: 3378 passed, 38 failed, 3416 total.
  All 38 failures are in four learnings test files (`learnings-store`, `learnings-mcp-server`, `learnings-search-service`, `learnings-backfill`).
  They share one cause: `better-sqlite3` was rebuilt for Electron by `predev` and the tests run on Node (`NODE_MODULE_VERSION 140` against `141`).
  This is environment, not code, and it comes back after every `npm run dev`; see `docs/learnings/2026-05-30-better-sqlite3-abi-mismatch.md`.
- Typecheck: passes.
- Lint: exits 0.
- Drive tests: 5 passed.
- Timings: the table in "What this is".

## Known risks

**The daemon is a new long-lived process in a repo that keeps getting hurt by long-lived processes.**
The source-change check, the idle exit and the single-instance rule are there for this, but a daemon that survives in a state nobody expects is the most likely way this goes wrong.
`drive status` should print the daemon's pid and start time, so a stale one is visible.

**Refs may be less stable than they look.**
React re-renders replace elements often, and any new snapshot drops every earlier ref.
If refs turn out to die between most consecutive commands, they add confusion rather than speed, and step 4 is the place to find that out and drop them.

**JPEG can hide a one-pixel problem.**
Quality 85 is usually enough, but a faint border or a subpixel gap can blur.
`--png` exists for this, and agents doing pixel-level review need to know to use it.

**The minimized-window check is unproven.**
If `visibilityState` does not report a minimized window, the sharp fallback keeps the warning but gives back part of the saving.

**The npm floor stays.**
`npm run drive` cannot go below about 130 ms.
Agents only get the full win if they call the client with `node` directly, and that depends on the docs being read.

**Windows is untested.**
The named-pipe path is written for it, but this plan is verified on macOS only.
