## Why

Fleet ships roughly one release every two or three days, and the only release notes a user can ever see are the ones for the single version `electron-updater` is currently offering.
Once an update is installed the notes are gone: `staged` is cleared, the pill disappears, and Settings > Updates falls back to a version number and a button.
Someone who was several versions behind - the normal case for a window that stays open for days - installs one update and never learns what changed in the versions it skipped past.
`CHANGELOG.md` holds all of it and is explicitly excluded from the packaged build, so today the answer only exists on GitHub.

## What Changes

- Ship `CHANGELOG.md` with the packaged app as an `extraResource`, so the full history travels with the build and is readable offline.
- Add a shared parser that splits the changelog into per-version sections (`## vX.Y.Z` heading plus its body), and a main-process reader that loads and caches it.
- Add an IPC channel and `window.fleet.updates.getReleaseHistory()` so the renderer can ask for that history.
- Replace the single release-notes box in Settings > Updates with a collapsible list of every version, newest first, rendered as markdown through the existing `AgentMarkdown`.
- Expand the entry for the installed version by default, and mark it `current`.
- Keep the existing behavior for an update that is staged or downloading: its notes come from the updater (they describe a version this build's changelog does not know about yet), and its entry is shown above the history, expanded, marked as the pending version.
- Add a `fleet-drive` fixture and unit tests for the parser so the section splitting is verified against the real changelog shape.

## Capabilities

### New Capabilities

- `release-notes`: The app carrying its own release-note history, and Settings > Updates presenting every version's notes rather than only the pending one.

### Modified Capabilities

None. `openspec/specs/` is empty, so update behavior has no spec today; this change introduces the first one and it covers only the history surface, not the updater itself.

## Impact

- `electron-builder.yml`: `CHANGELOG.md` moves out of the exclusion list and into `extraResources`.
- `src/shared/`: new changelog parser module and its types; `ipc-channels.ts` and `ipc-api.ts` gain one channel and one method.
- `src/main/`: new changelog reader resolving the bundled path (packaged vs dev, the pattern used by `agent/skills/definitions.ts`); one `ipcMain.handle` registration in `index.ts`.
- `src/preload/index.ts`: one method added to the `updates` namespace.
- `src/renderer/src/components/settings/UpdatesSection.tsx`: the release-notes block becomes a version list.
- No change to `electron-updater` wiring, `update-staging.ts`, `update-scheduler.ts`, the update pill, or `WhatsNewDialog`.
- No new dependencies. The parser is a string split over a file already in the repo.
