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
npm run drive -- fixture                        # list the seedable UI states
npm run drive -- fixture <name>                 # put the window in one
```

Screenshots default to `.fleet-drive/screenshots/<timestamp>.png` (gitignored).

## Fixtures

Some UI states are expensive to reach for real.
The "cleared" marker on a tool row only appears once a session has built up tens of thousands of tokens of stale tool output, which is a long agent run and real money spent to look at one word on one row.

A fixture writes that state straight into the store, so the rendering can be checked on its own:

```
npm run drive -- fixture agent-cleared-results
npm run drive -- screenshot --selector main
```

Nothing is persisted - reload the window (`npm run drive -- keys 'Meta+r'`) to clear it.
That makes a fixture safe to run against a real session that happens to be open.

Add one in `fixtures.ts`.
Fixtures are JS source strings, not typed builders, because they are evaluated in the renderer where this directory's imports do not exist.
They should find what they need from `__FLEET__.stores` rather than take arguments, so a fixture cannot be pointed at the wrong pane.

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
