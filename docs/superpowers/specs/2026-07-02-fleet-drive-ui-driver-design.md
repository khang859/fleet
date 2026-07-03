# fleet-drive: a Playwright/CDP driver for the live Fleet dev app

**Date:** 2026-07-02
**Status:** Design approved, pending spec review

## Problem

During UI development, neither the developer's AI agent nor the developer can programmatically observe or drive the running Fleet UI.
The only existing automation channel is the Unix socket server and `fleet` CLI (`src/main/socket-command-handler.ts`), and it is terminal-pane-only.
It can create tabs and panes and write to PTYs, but it cannot screenshot the window, read the rendered DOM, or click and type in the React chrome (settings, chat, kanban, the command palette).
Its own `get-output` handler literally returns `"not yet implemented"`.

This missing feedback loop was the main friction during the last UI upgrade.
The goal is to close it before the next one: let the agent launch nothing new, attach to the app the developer is already watching, and see and drive it.

## Key technical unlock

A prior working assumption was that this environment cannot screenshot the Electron app because it lacks the macOS Screen Recording (TCC) permission.
That is true only for display-capture APIs such as the `screencapture` CLI and Electron's `desktopCapturer`, which capture the screen and require TCC.
It is not true for `webContents.capturePage()` or Playwright's `page.screenshot()`, which capture the app's own window buffer through Chromium's compositor and CDP.
Those paths never touch the Screen Recording permission.
Programmatic screenshots of Fleet are therefore fully achievable today; the earlier attempts were simply using the wrong API.

## Goals

- The agent can attach to the live `npm run dev` window and screenshot it, read its accessibility tree, click, type, send key chords, and evaluate JavaScript in the renderer.
- Renderer edits reflected via HMR are visible to the driver with no relaunch.
- The driver drives the exact window the developer is watching, not a separately launched instance.
- The core connect/resolve/verb logic is reusable so a committed CI end-to-end suite can be built later on the same foundation without rework.

## Non-goals (this iteration)

- Main-process control (`electronApplication.evaluate`).
  The attach model is renderer-only by nature; main-process driving belongs to the deferred launch-the-build test path.
- A committed CI end-to-end test suite.
  This iteration builds the iteration tooling and the reusable core only.
- Any capability in packaged builds.
  Everything here is dev-gated and loopback-only.
- A long-running daemon of our own.
  The persistent session is the developer's dev app itself.

## Architecture

### Connection model

The persistent session is the developer's own `npm run dev` window.
We enable the Chrome DevTools Protocol on the dev-mode Electron process.
Each `fleet-drive` command connects over CDP, performs its action, and disconnects.
Screen state persists across commands because it is the real running app, and HMR edits are reflected without relaunch.

There is no daemon lifecycle to manage.
`connectOverCDP` is fast enough that per-command connect and disconnect is acceptable for interactive iteration.

### Main-process change

In `src/main/index.ts`, gated on `IS_FLEET_DEV` only (the signal from `src/shared/constants.ts` set exclusively by the `dev` script, never under `npm start`/`build:unpack`/packaged):

- At module top level, before `app.whenReady()` (line 346), call `app.commandLine.appendSwitch('remote-debugging-port', String(port))`.
  Electron 30+ rejects this flag when passed as a CLI argument, so `appendSwitch` is the required mechanism.
  There is currently zero `app.commandLine` usage in `src/main/`, so there is no conflict.
- Set `backgroundThrottling: false` on the dev window's `webPreferences` so CDP screenshots stay live when the window is not frontmost.

**Port discovery and collision handling.**
A fixed default of 9222 is unsafe in this repo: `IS_FLEET_DEV` skips the single-instance lock (`index.ts:321`), and multiple dev worktrees run simultaneously, so two `npm run dev` instances are normal.
Chromium silently fails to bind a busy port (the app still runs), which would let `fleet-drive` attach to the wrong Fleet instance or to an unrelated Chrome that owns 9222.

Mitigation:

- Choose the port as `Number(process.env.FLEET_DEBUG_PORT)` if set, otherwise a port derived per checkout (e.g. a base plus a hash of the repo root) rather than a hard-coded 9222.
- After the window loads, the main process writes the actually-bound port and this checkout's renderer root URL to a per-checkout discovery file (for example `.fleet-drive/session.json`), which the driver reads to find the right instance.
- The driver never trusts the port blindly; see target verification below.

### Driver core

New directory `scripts/drive/`.

- `core.ts` owns connection and page resolution.
  It reads the discovery file to find this checkout's port and renderer root URL, then uses Playwright's `chromium.connectOverCDP('http://127.0.0.1:<port>')`.
  **Target resolution must be a positive match, never a "first localhost page" heuristic**, because the CDP target list also includes:
  - the detached DevTools window (a `devtools://` URL, always open in dev via `index.ts:285`),
  - the copilot window (`copilot.html`, title "Fleet Copilot"),
  - annotate and web-fetch windows, where web-fetch loads arbitrary external URLs.

  Resolution iterates every page across all `browser.contexts()` (Electron may split pages across CDP browser contexts) and selects the one whose URL equals this checkout's `ELECTRON_RENDERER_URL` and whose title is "Fleet".
  Every verb aborts with a clear error if that positive match is not found, so a wrong-instance attach never silently drives the wrong window.
  `core.ts` exposes the resolved `page` plus the verb helpers.
- `selectors.ts` is a thin pass-through.
  Playwright's `page.locator()` already parses `role=button[name="Chat"]`, `text=...`, and raw CSS natively, so no DSL layer is needed for those.
  The only mapping worth keeping is `testid=<id>` to `getByTestId` as a forward-looking convenience; note that there are currently zero `data-testid` attributes in the renderer, so real usage will be role- and text-based.
- `cli.ts` is the argument parser and command dispatcher, run via `tsx`.

### Command surface

Invoked as `npm run drive -- <verb> [args]`.

- `status` verifies the connection and lists windows and their URLs.
- `screenshot [--selector <sel>] [--out <path>]` writes a full-page or element PNG to `.fleet-drive/screenshots/<timestamp>.png` and prints the path.
- `snapshot` prints the ARIA snapshot via `page.locator('body').ariaSnapshot()` (Playwright 1.49+) as compact YAML.
  `page.accessibility.snapshot()` is deprecated and must not be used.
  This YAML tree is the primary non-image sense of what is on screen and is the same representation agent tooling like Playwright MCP uses.
- `click <sel>` clicks a located element with Playwright auto-waiting.
- `type <sel> <text>` fills a located form control via `fill()`.
  This is for React chrome inputs only; terminal-pane input remains the fleet socket CLI's job.
- `keys <chord>` sends a keyboard chord such as `Meta+K`.
  CDP-synthesized keys reach renderer DOM handlers, so renderer shortcuts like the ⌘K palette (a keydown handler in `CommandPalette.tsx`) work; they do not trigger native menu accelerators or `globalShortcut` (none are registered today).
- `eval <js>` evaluates JavaScript in the renderer via `page.evaluate()` and prints the result.
  The verb wraps the expression so it is `JSON.stringify`-ed in-page before returning, since `page.evaluate` return values must be serializable and store state contains action functions.

### Renderer dev-store bridge

In dev only (`import.meta.env.DEV`, the correct renderer signal here since `env.d.ts` references `vite/client`), expose the renderer's zustand stores on `window.__FLEET__`.
There is no single store: `src/renderer/src/store/` holds ~17 stores (`workspace-store`, `chat-store`, `kanban-store`, `settings-store`, and others).
The bridge exposes a named map, `window.__FLEET__ = { stores: { workspace: useWorkspaceStore, chat: useChatStore, settings: useSettingsStore, kanban: useKanbanStore, ... } }`, so `eval` can read ground truth such as `__FLEET__.stores.workspace.getState().activeTabId`.
Note that `theme` is not in a zustand store; it lives in React state in `src/renderer/src/hooks/use-app-theme.ts`, so it is read from the DOM (`documentElement` class/attribute) rather than the store.
The bridge is about 15 lines, dev-gated, and never ships in a packaged build.

### Output location

Screenshots land in a gitignored `.fleet-drive/screenshots/` directory at the repo root.
The directory is discoverable by the developer and readable by the agent.
`--out` overrides the default path.

## Foundation for tests later

The connect, page-resolution, verb, and selector logic in `scripts/drive/` is written to be reusable.
When the committed CI end-to-end suite is built later, it can swap `connectOverCDP` for `_electron.launch(<built app>)` and reuse the same verbs, selectors, and navigation helpers.
The verb and selector reuse is solid; the launch-path swap itself is subject to Playwright/Electron compatibility verification at that time.
`_electron` is officially experimental, and `electron.launch()` has had breakage against Electron 30+ (Playwright passing `--remote-debugging-port=0` as a CLI arg that newer Electron rejects, tracked in playwright#39008).
This extension point is documented but not implemented now.

## Security and gating

- The remote debugging port is enabled only under `IS_FLEET_DEV` and is never present in a packaged build.
- The port binds to loopback only. Since Chrome 111, browser-origin attacks are additionally blocked because Chromium rejects `Origin`-bearing WebSocket upgrades to the debug endpoint without `--remote-allow-origins`.
- The store bridge is behind `import.meta.env.DEV`.
- No new capability is added to the socket server or the packaged app.

**Residual risk, stated honestly.**
Loopback-only is necessary but not sufficient: any local process can attach to the debug port and, through `eval`, reach the renderer's `window.fleet` preload API, which can spawn PTYs (i.e. run arbitrary commands).
This is the same accepted posture as running Chrome with a debug port on a trusted dev machine, and it exists only in the dev-serve workflow, but it is a real residual risk rather than something loopback fully settles.

## Dependencies and touched files

- New dev dependency: `playwright` (no browser download needed for `connectOverCDP` since Playwright 1.38).
- `src/main/index.ts`: `IS_FLEET_DEV`-gated debug port switch, per-checkout port selection, discovery-file write, and `backgroundThrottling: false` on the dev window.
- New `scripts/drive/` (`core.ts`, `selectors.ts`, `cli.ts`). `tsconfig.node.json` already includes `scripts/**/*`, so these are typechecked by `typecheck:node`.
- `package.json`: a `drive` script mapping to `tsx scripts/drive/cli.ts`.
- `.gitignore`: ignore `.fleet-drive/` (screenshots and `session.json`).
- Renderer entry: dev-only `window.__FLEET__` store-map bridge, wiring the real store hooks from `src/renderer/src/store/`.

## Known caveats

- A fully minimized or hidden window on macOS can still return a blank capture despite `backgroundThrottling: false` (which pins `visibilityState` but does not guarantee compositor frames; see electron#39104 and electron#2610). The `screenshot` verb should detect an all-blank/empty image and advise un-minimizing the window rather than returning it silently.
- A full renderer reload keeps the same CDP `targetId`; combined with per-command reconnect, reload is transparent. HMR module replacement does not reload the page at all.
- Multiple `BrowserWindow`s and a detached DevTools target exist; page resolution must positively match the main window (this checkout's renderer URL + title "Fleet") rather than taking the first target.

## Verification

- `npm run typecheck` and `npm run lint` pass.
- With `npm run dev` running, `npm run drive -- status` reports the main window.
- `npm run drive -- screenshot` produces a readable PNG of the current UI.
- `npm run drive -- snapshot` prints a sensible ARIA YAML tree.
- `npm run drive -- click role=button[name=<known control>]` changes the visible UI, confirmed by a follow-up screenshot.
- `npm run drive -- eval "__FLEET__.stores.workspace.getState().activeTabId"` returns live store state.
- Starting a second dev worktree does not cause `fleet-drive` to attach to the wrong instance (verified via the discovery file + positive target match).
- A packaged build shows no debug port and no `window.__FLEET__`.
