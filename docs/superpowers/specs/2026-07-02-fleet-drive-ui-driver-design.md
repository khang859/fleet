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

In `src/main/index.ts`, dev-gated only (never in a packaged build):

- Before `app.whenReady()`, call `app.commandLine.appendSwitch('remote-debugging-port', String(port))` where `port = Number(process.env.FLEET_DEBUG_PORT ?? 9222)`.
- Bind to loopback; the switch listens on `127.0.0.1` by default, which is the desired scope.
- Set `backgroundThrottling: false` on the dev window's `webPreferences` so CDP screenshots stay live when the window is not frontmost.

The gate reuses the existing dev signal (`FLEET_DEV` / `!app.isPackaged`) already used elsewhere in `index.ts`.

### Driver core

New directory `scripts/drive/`.

- `core.ts` owns connection and page resolution.
  It uses Playwright's `chromium.connectOverCDP('http://127.0.0.1:<port>')`.
  It resolves the main Fleet window among CDP targets by matching the renderer URL and title, since the app also opens copilot, annotate, and web-fetch `BrowserWindow`s.
  It exposes the resolved `page` plus the verb helpers.
- `selectors.ts` implements a compact selector DSL that maps to Playwright locators:
  - `role=button[name=Chat]` maps to `getByRole('button', { name: 'Chat' })`.
  - `testid=<id>` maps to `getByTestId`.
  - `text=<s>` maps to `getByText`.
  - anything else is treated as raw CSS.
- `cli.ts` is the argument parser and command dispatcher, run via `tsx`.

### Command surface

Invoked as `npm run drive -- <verb> [args]`.

- `status` verifies the connection and lists windows and their URLs.
- `screenshot [--selector <sel>] [--out <path>]` writes a full-page or element PNG to `.fleet-drive/screenshots/<timestamp>.png` and prints the path.
- `snapshot` prints the accessibility tree from `page.accessibility.snapshot()` as compact text.
  This is the primary non-image sense of what is on screen.
- `click <sel>` clicks a located element with Playwright auto-waiting.
- `type <sel> <text>` fills or types into a located element.
- `keys <chord>` sends a keyboard chord such as `Meta+K`.
- `eval <js>` evaluates JavaScript in the renderer via `page.evaluate()` and prints the JSON result.

### Renderer dev-store bridge

In dev only (`import.meta.env.DEV`), expose the zustand store on `window.__FLEET__`.
This lets `eval` read ground-truth UI state, for example `__FLEET__.store.getState().theme`, rather than inferring state from scraped DOM.
It is roughly three lines, dev-gated, and never ships in a packaged build.

### Output location

Screenshots land in a gitignored `.fleet-drive/screenshots/` directory at the repo root.
The directory is discoverable by the developer and readable by the agent.
`--out` overrides the default path.

## Foundation for tests later

The connect, page-resolution, verb, and selector logic in `scripts/drive/` is written to be reusable.
When the committed CI end-to-end suite is built later, it swaps `connectOverCDP` for `_electron.launch(<built app>)` and reuses the same verbs, selector DSL, and navigation helpers.
Nothing built in this iteration is throwaway.
This extension point is documented but not implemented now.

## Security and gating

- The remote debugging port is enabled only under the dev gate and is never present in a packaged build.
- The port binds to loopback only.
- The store bridge is behind `import.meta.env.DEV`.
- No new capability is added to the socket server or the packaged app.

## Dependencies and touched files

- New dev dependency: `playwright`.
- `src/main/index.ts`: dev-gated debug port switch and `backgroundThrottling: false` on the dev window.
- New `scripts/drive/` (`core.ts`, `selectors.ts`, `cli.ts`).
- `package.json`: a `drive` script mapping to `tsx scripts/drive/cli.ts`.
- `.gitignore`: ignore `.fleet-drive/`.
- Renderer entry: optional dev-only `window.__FLEET__` store bridge.

## Known caveats

- A fully minimized or occluded window on macOS can still throttle; `backgroundThrottling: false` mitigates this, and Playwright forces a frame on screenshot.
- A full renderer reload creates a new CDP target with the same URL; page resolution matches by URL and title, so reconnect after reload is transparent. HMR module replacement does not reload the page and preserves the target.
- Multiple `BrowserWindow`s exist; page resolution must select the main window deliberately rather than taking the first target.

## Verification

- `npm run typecheck` and `npm run lint` pass.
- With `npm run dev` running, `npm run drive -- status` reports the main window.
- `npm run drive -- screenshot` produces a readable PNG of the current UI.
- `npm run drive -- snapshot` prints a sensible accessibility tree.
- `npm run drive -- click role=button[name=<known control>]` changes the visible UI, confirmed by a follow-up screenshot.
- `npm run drive -- eval "__FLEET__.store.getState()"` returns live store state.
- A packaged build shows no debug port and no `window.__FLEET__`.
