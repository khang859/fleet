# Update Notification Plan

Make long-running Fleet windows find out that a new version exists, and make acting on it a single click that does not destroy running work.

## The problem

Users leave the Fleet window open for days.
Today those users never learn that an update shipped, and the reason is not that the indicator is too quiet - it is that the check never runs.

`src/main/index.ts:1149-1159` calls `checkForUpdates()` exactly once, after first paint, in packaged builds only.
There is no interval timer, no re-check on window focus, and no `powerMonitor` usage anywhere in the repository.
A window opened on Monday is still reporting Monday's answer on Friday.

The release cadence makes this sharp: twelve releases went out between 2026-08-11 and 2026-09-04, roughly one every two to three days.
A week-old window can sit three to five versions behind while showing no indication at all.

The surfacing is the second, smaller problem.
When an update *is* found, `autoDownload` and `autoInstallOnAppQuit` are both left at `electron-updater`'s `true` defaults, so the new version is already downloaded and staged on disk.
The entire user-facing signal for that is a 6px unlabeled pulsing dot beside "Settings" in the sidebar footer (`src/renderer/src/components/Sidebar.tsx:1891-1893`), with the real "Restart to Update" button two clicks deep in Settings then Updates.
`src/renderer/src/App.tsx:547` keeps only a boolean from the status event and discards the version and release notes it carries.

## A latent bug this work must fix

"Restart to Update" calls `updater.quitAndInstall()` at `src/main/index.ts:1140-1144`, which bypasses the quit guard shipped in #554.

On Windows and Linux, `BaseUpdater.quitAndInstall()` (`node_modules/electron-updater/out/BaseUpdater.js:12-26`) runs `install()` first and only then calls `app.quit()`.
Fleet's `close` handler (`src/main/index.ts:363-381`) then sees running agents and calls `event.preventDefault()`, so the "work is still running" dialog appears *after* the installer has already been spawned.
`quitAndInstallCalled` is latched `true` at that point, so cancelling leaves the app running while it is replaced underneath.
On macOS the call reaches native Squirrel and force-quits without a cancellable path at all.

This is currently rare only because almost nobody finds the button.
Making the nudge prominent is precisely what turns a latent bug into a frequent one, so it is in scope here rather than deferred.

## Decisions

| Question | Decision |
| --- | --- |
| Check cadence | Every 4 hours, plus on window focus and on wake from sleep, all behind one 30-minute throttle |
| Nudge surface | Persistent pill in the top drag strip, plus a one-shot toast when the download completes |
| Escalation | Re-toast at most once per 24 hours, or immediately when a newer version supersedes the pending one |
| Install safety | Route the install through Fleet's own `hasRunningWork` / `quitGuard` flow |
| Release notes | Render as Markdown instead of raw text |
| What's new | Clicking the pill opens a dialog with the rendered notes |
| Settings toggle | Out of scope. No new persisted settings key |

Two things are deliberately left alone.

The sidebar dot stays.
It is redundant next to the pill, but it points at the full update UI in Settings and removing it is outside the scope of this request.

No `FleetSettings` subtree is added.
`SettingsStore.get()` and `set()` (`src/main/settings-store.ts:127-275`) are not a generic deep merge - every nested object with its own defaults has to be re-merged explicitly, field by field, and a forgotten line silently drops the new default.
Re-toast bookkeeping does not justify touching that, so it lives in `localStorage` alongside the existing `fleet:last-workspace-id`.

## Architecture

### Main process: one throttled entry point

Three triggers funnel into a single function so that a lid-open which also fires `focus` does not check twice.

```
maybeCheckForUpdates()   <- min 30 minutes between checks
   ^            ^                ^
setInterval   window          powerMonitor
   (4h)       'focus'          'resume'
```

The throttle decision is extracted into `src/main/update-scheduler.ts` as a pure function.
`src/main/index.ts` is over 1500 lines and cannot be imported in isolation for a test.
There is precedent for this shape: `migrateLegacyScrollback` is exported standalone from `settings-store.ts` specifically so it can be unit tested without the real `electron-store`.

`powerMonitor` needs adding to the `electron` import block at `src/main/index.ts:1-13`.
The interval is created next to the existing launch check inside `whenWindowReady` and cleared in `shutdownAll()` (`src/main/index.ts:1482`), matching how `agentScheduleTimer?.stop()` is handled there.

### Main process: install through the quit guard

Set `autoInstallOnAppQuit = false` in the `getUpdater()` setup block so that quit-time installation becomes ours to drive rather than something `electron-updater` does behind us.

Then replace the body of the `UPDATE_INSTALL` handler with:

```ts
async function requestInstallUpdate(): Promise<void> {
  if (hasRunningWork(true) && !(await quitGuard.ask(mainOwnedWork(true)))) return;
  quitConfirmed = true;              // waves the ensuing close handler through
  (await getUpdater()).quitAndInstall();
}
```

This reuses the existing machinery rather than building a parallel one.
`hasRunningWork(true)` (`src/main/index.ts:258-268`) is already the single source of truth for whether agents, subagents or background commands are mid-flight.
Setting `quitConfirmed = true` is what makes the `close` that `quitAndInstall()` triggers internally pass straight through to `ptyManager.killAll()` instead of prompting a second time.
The user is now asked before `install()` spawns anything, which is the whole point.

### Renderer: store, hook, pill, dialog

`src/renderer/src/store/update-store.ts` holds the full `ready` status rather than a boolean.
Three separate places need the version and notes - the pill, the dialog, and the Settings section - so a small zustand store beats prop-drilling through `App.tsx` into `Sidebar`.
This matches the existing `toast-store` and `cwd-store` pattern.

`src/renderer/src/hooks/use-update-nudge.ts` owns the IPC subscription, writes to the store, and decides when to toast.
The arrival toast reuses the existing action-button shape verbatim from `use-config-restart-toast.ts:37-40`, at a 10 second duration rather than the 4 second default.
No change to `toast-store.ts` is needed: the toast is the transient half of the design and the pill is the persistent half, so the lack of a sticky-toast option does not matter.

A single one-hour interval in the hook re-evaluates whether the 24 hour re-toast is due.
`lastToastedVersion` and `lastToastedAt` persist to `localStorage` so a renderer reload does not restart the nagging.

`src/renderer/src/components/UpdatePill.tsx` renders `v2.113.0` in the 24px top drag strip (`src/renderer/src/App.tsx:834-839`), which today holds only the `?` shortcuts button and is otherwise empty.
That strip costs no new vertical space and does not perturb xterm's flex sizing, which is why it wins over a banner.
It needs `WebkitAppRegion: 'no-drag'` to stay clickable inside the drag region, exactly as `ShortcutsHint.tsx:14` does.

`src/renderer/src/components/WhatsNewDialog.tsx` is the shared `Overlay` component plus the rendered notes plus Restart and Later buttons.

### Markdown

Release notes reach the app as raw Markdown.
`scripts/extract-release-notes.ts` pulls the `## vX.Y.Z` section out of `CHANGELOG.md` and embeds it as `releaseInfo.releaseNotes`, so bullets and bold arrive as written.
`UpdatesSection.tsx:82-84` renders that with `whitespace-pre-wrap`, so today users see literal `-` and `**` characters.

Use `AgentMarkdown` rather than `MarkdownPreview`.
`MarkdownPreview` requires a `baseDir` for resolving local images against the filesystem, which is meaningless for release notes, and it pulls in `workspace-store`.
`AgentMarkdown` takes a plain string, sanitizes URLs through `sanitizeMarkdownUrl`, and carries no filesystem coupling.
External links are already safe regardless: `src/main/index.ts:404-415` intercepts navigation and `window.open` and routes both to the system browser.

## Files

New:

1. `src/main/update-scheduler.ts` - pure throttle decision and interval constants
2. `src/main/__tests__/update-scheduler.test.ts`
3. `src/renderer/src/store/update-store.ts`
4. `src/renderer/src/hooks/use-update-nudge.ts`
5. `src/renderer/src/components/UpdatePill.tsx`
6. `src/renderer/src/components/WhatsNewDialog.tsx`

Modified:

7. `src/main/index.ts` - `powerMonitor` import, interval and focus and resume checks, `autoInstallOnAppQuit = false`, `requestInstallUpdate`, interval teardown in `shutdownAll`
8. `src/renderer/src/App.tsx` - mount the pill and dialog, replace the boolean state with the hook and store
9. `src/renderer/src/components/settings/UpdatesSection.tsx` - render notes as Markdown

Three more were added during the build, each for something only visible once it was on screen:

10. `src/shared/ipc-channels.ts` + `src/preload/index.ts` - a dev-only `UPDATE_SIMULATE` channel, so the nudge can be driven without publishing a release
11. `scripts/drive/fixtures.ts` - `update-ready` and `update-renudge`
12. `src/renderer/src/index.css` - hanging indent for markdown lists

`UpdatesSection` also now reads the status from the store instead of subscribing itself.
It is mounted by opening Settings, which is almost always after the update was found, so a listener of its own only ever heard what arrived later - the page the pill and the sidebar dot point at was offering to check for an update it had already been told about.

## Build order

1. **Detection.** `update-scheduler.ts` and its test, then wire the interval, focus and resume checks in `index.ts`. Verify: the test passes, and the updater log shows a check firing on focus after the throttle window.
2. **Install safety.** `autoInstallOnAppQuit = false` and `requestInstallUpdate`. Verify: with a busy agent pane, triggering install shows the quit dialog, and cancelling leaves the app running with no installer spawned.
3. **Store and hook.** `update-store.ts`, `use-update-nudge.ts`, and the `App.tsx` rewiring. Verify: the toast fires on a simulated `ready` status and does not re-fire on a repeat of the same version.
4. **Pill and dialog.** `UpdatePill.tsx`, `WhatsNewDialog.tsx`. Verify: screenshot via `npm run drive -- screenshot`.
5. **Markdown notes.** `UpdatesSection.tsx`. Verify: changelog bullets render as a list.

## Verification

- `npm run typecheck`, `npm run lint`, and `npm run test` all clean.
- Unit test covers the throttle decision at the boundaries: never checked, just checked, and past the window.
- Manual pass under `npm run dev` against `dev-app-update.yml`, driving the UI with `npm run drive -- screenshot` to confirm the pill sits correctly in the top strip and the dialog renders notes as Markdown.
- Pill checked against both a collapsed and an expanded sidebar, and in light and dark themes.

## Risks

The install path is the risky change.
`quitAndInstall()` behaves differently across platforms - `BaseUpdater` on Windows and Linux, native Squirrel on macOS - and the `quitConfirmed` handoff has to be right or the app either double-prompts or fails to close.
Step 2 is therefore built and verified on its own before any of the UI work lands on top of it.

The 4 hour interval is a background network call.
It is throttled, it is packaged-builds-only like the existing launch check, and a failed check already routes to the `error` state without surfacing anything, so a flaky connection stays silent rather than nagging.
