# fleet-drive: driving the live UI over CDP

## What / why

For a long time agents could not see or control the running Fleet UI during development.
The assumed blocker was that this environment lacks macOS Screen Recording (TCC) permission, so `screencapture` fails.

The key realization: that permission only gates *display* capture (`screencapture` CLI, Electron `desktopCapturer`).
It does **not** gate `webContents.capturePage()` or Playwright's `page.screenshot()`, which render the app's own window buffer through Chromium's compositor / CDP.
So programmatic screenshots of Fleet were always possible - we were just using the wrong API.

`fleet-drive` (`scripts/drive/`, `npm run drive -- <verb>`) attaches over CDP to the live `npm run dev` window and can screenshot, snapshot (ARIA tree), click, type, send key chords, and eval in the renderer.
See `scripts/drive/README.md`.

## Gotchas hit during implementation

**1. `page.evaluate` + tsx/esbuild `keepNames` = `ReferenceError: __name is not defined`.**
A *named* function or arrow-assigned-to-const *inside* the `page.evaluate(() => { ... })` callback gets instrumented by esbuild's `keepNames` with a `__name(fn, "name")` call.
That helper is defined in the Node module scope, not in the browser context the callback runs in, so it throws at runtime.
Fix: keep the evaluate callback free of named inner functions - inline anonymous arrows and plain statements only.
(This passed typecheck and lint; only the live eval verb surfaced it. Verify runtime, not just static checks.)

**2. `JSON.stringify(...) ?? fallback` trips `no-unnecessary-condition`.**
TS types `JSON.stringify` as returning `string`, but at runtime it returns `undefined` for `undefined`/functions/symbols.
So a `?? String(value)` fallback looks "unnecessary" to the type-aware lint rule, and control-flow narrowing defeats a `const x: string | undefined = ...` annotation.
A typed wrapper function fixes lint but reintroduces gotcha #1 inside `page.evaluate`.
Resolution: drop the `??`, rely on `try/catch` (for circular refs), and accept that a rare undefined-returning expr prints `"undefined"`.

**3. Per-checkout debug port, not a fixed 9222.**
`IS_FLEET_DEV` skips the single-instance lock, so multiple dev worktrees run at once.
Chromium silently fails to bind a busy port, which would let the driver attach to the wrong instance.
`deriveDebugPort` hashes the checkout path to a stable per-checkout port, the main process writes `.fleet-drive/session.json` (port + renderer URL), and `attach()` does a **positive** match on the renderer URL + `title === 'Fleet'` (excluding the copilot window, detached DevTools, and web-fetch windows) so a wrong-instance attach fails loudly instead of driving the wrong window.

**4. Worktrees start with no `node_modules`.**
A fresh Fleet worktree needs `npm install` before any `npm run` / vitest works; there is no shared/symlinked `node_modules`.

## Gotchas hit while using it

**5. `pkill -f "electron-vite dev"` orphans the Electron app, and the driver keeps talking to the orphan.**
It kills the wrapper and the vite node process, not the Electron they spawned.
The orphan keeps running the *old* main bundle and keeps its `session.json` port, so a restarted dev server rebuilds `out/main/index.mjs` while `npm run drive` is still driving the stale window.
The symptom is maddening: the source is right, `grep` finds the new code in `out/main/index.mjs`, tests pass, and the live app keeps showing the old behaviour through a brand-new agent session.
Kill the app too before restarting:

```bash
pkill -f "electron-vite"; pkill -f "out/main/index.mjs"; pkill -f "electron/dist/Electron"
```

Then confirm nothing survived - `npm run drive -- snapshot` should fail with `ECONNREFUSED` - *before* starting the new server.
A driver that still attaches after the kill is attached to something you did not just build.

**Rule of thumb:** when a main-process change refuses to show up in the live window, do not re-read the source. Prove the process is new first.
