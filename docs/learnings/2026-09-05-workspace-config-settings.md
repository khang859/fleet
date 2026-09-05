# Workspace / Copilot config settings: things that bit during the rebuild

Context: moving the Claude config folder settings from Copilot to Workspaces, and letting a workspace be created from Settings without switching to it.
See `docs/workspace-copilot-settings-plan.md`.

## A workspace created empty is not empty by the time it is activated

`doSwitchWorkspace` in `Sidebar.tsx` gave a workspace its first terminal only when `s.workspace.tabs.length === 0`.
That check was written for the old sidebar flow, which called `switchWorkspace` on an in-memory workspace and then added a terminal unconditionally right after.

Creating a workspace from Settings persists `tabs: []` and does not activate it.
When the sidebar later loads it, `switchWorkspace` runs `applyToolVisibility` first, which seeds the pinned tool tabs (Scratch, Annotate, Sessions).
By the time the `setTimeout` callback runs, `tabs.length` is 3, so the workspace opened with no terminal at all.

The fix is to check for the absence of *unpinned* tabs rather than an empty list:

```ts
if (!s.workspace.tabs.some((tab) => !isPinnedTab(tab))) {
  s.addTab(undefined, window.fleet.homeDir);
}
```

`isPinnedTab` had to be exported from `workspace-store.ts` for this.
Verified in the running app: a workspace created from Settings activates with three tool tabs plus exactly one terminal.

## `bg-fleet-surface-1` does not exist

The dialog panel was written with `bg-fleet-surface-1` and rendered fully transparent - the settings page showed straight through the modal.
The real tokens in `src/renderer/src/index.css` are `--fleet-surface: #15171a`, `--fleet-surface-2: #242629`, `--fleet-surface-3: #3e4043`; there is no `-1`.
Tailwind silently drops an unknown utility, so nothing warns.

Convention for a modal on top of the settings page: panel `bg-fleet-surface` (darkest), inputs `bg-fleet-surface-2` inside it.
Panel and input on the same token makes the input read as flat.

Check any new colour class against `index.css` rather than guessing at the scale.

## Merging one entry of a settings map needs a main-process mutation

`SettingsStore.set` merges `copilot` exactly one level deep, so a patch carrying `workspaceOverrides` replaces the whole map.
Every renderer that wanted to change one workspace therefore had to send back a map it had read earlier, losing anything written in between.

`setWorkspaceOverride(workspaceId, dir | null)` now reads the current map in the process that owns the file and sets or deletes one key.
Confirmed live: changing the Copilot session scope and writing a workspace override in the same session left both values intact on disk.

## Three ESLint promise rules that fight each other in test mocks

A `vi.fn` returning a promise has to satisfy all of:

- `promise-function-async` - a function returning a promise must be `async`
- `require-await` - an `async` function must contain an `await`
- `return-await` - `return await x` is banned outside `try`

So none of `() => Promise.resolve(v)`, `async () => Promise.resolve(v)` or `async () => await x` pass.
The shape that does:

```ts
save: vi.fn(async (): Promise<LayoutSaveResult> => {
  await Promise.resolve();
  return { ok: true };
})
```

This also makes the mock genuinely asynchronous, which matters: after switching a mock from a sync-returning function to a real `async` one, the store's own `.then` chain needed one more tick, and `await Promise.resolve()` in the test was no longer enough to flush it.
`await new Promise((resolve) => setTimeout(resolve, 0))` is the reliable flush.

## A drive selector that matches two nodes types into the wrong one

Verifying the create dialog, `npm run drive -- type 'input[placeholder="/Users/khangnguyen/.claude"]' ...` was run while the Workspaces settings page was open behind the modal.
The settings page's *default folder* input carries the same placeholder, so the locator matched two nodes.
The command printed nothing and the value landed in the settings page's field, which silently rewrote the shared default folder for every workspace.
The new workspace then showed `Inherited`, which read like a regression in the code under test.

Two habits that avoid it:

- Before typing, count the matches: `drive eval "[...document.querySelectorAll('input')].map(i=>({t:i.type,p:i.placeholder,c:i.checked}))"`.
  A single unique match is the only safe state.
- Open a modal from a screen that does not already contain the same controls.
  Driving the create dialog from the sidebar's "New Workspace" button leaves only the dialog's own inputs in the document.

A `drive` verb that produces no `clicked:` / `typed into:` line did not run. Treat a silent command as a failure, not as success.

## Preload and main changes need a full Electron restart

`location.reload()` reloads the renderer only.
A new IPC channel plus its preload method stayed invisible (`window.fleet.settings.ensureConfigDir is not a function`) until the whole app was restarted.
The restart also has to kill the previous Electron completely: a leftover process keeps the CDP port, and the new window logs `bind() failed: Address already in use` and is unreachable to `fleet-drive`.
