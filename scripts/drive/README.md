# fleet-drive

Attach to the live `npm run dev` Fleet window over CDP and drive its UI.
Dev-only (`IS_FLEET_DEV`); never present in packaged builds.

## Usage

Start the app: `npm run dev`.
Then, from the repo root:

```
npm run drive -- status                         # confirm attach + which window
npm run drive -- screenshot [--selector <sel>] [--out <path>]
npm run drive -- snapshot                       # ARIA YAML tree of the page
npm run drive -- click '<sel>'
npm run drive -- type '<sel>' '<text>'
npm run drive -- keys 'Meta+K'                  # renderer shortcuts only
npm run drive -- eval '<js expression>'
```

Screenshots default to `.fleet-drive/screenshots/<timestamp>.png` (gitignored).

## Selectors

`page.locator()` syntax: `role=button[name="Chat"]`, `text=Settings`, raw CSS,
or `testid=<id>` (maps to `getByTestId`).

## eval

Runs in the renderer.
In dev, `window.__FLEET__.stores` exposes zustand stores:

```
npm run drive -- eval "__FLEET__.stores.workspace.getState().activeTabId"
```

Theme is React state, not a store - read it from the DOM.

The expression may be async, and what it resolves to is what gets printed.
That is how to check something that only settles after the UI has moved - a drag, an animation, a round of state:

```
npm run drive -- eval "(async () => { el.dispatchEvent(ev); await new Promise(r => setTimeout(r, 300)); return getComputedStyle(el).transform })()"
```

## Notes

- Each checkout uses a stable per-checkout debug port (override: `FLEET_DEBUG_PORT`).
  Parallel dev worktrees do not collide.
- `keys` reaches renderer DOM handlers only (e.g. ⌘K), not native menu
  accelerators or `globalShortcut`.
- Terminal-pane input stays the `fleet` socket CLI's job.
