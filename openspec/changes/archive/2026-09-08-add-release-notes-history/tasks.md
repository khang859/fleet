## 1. Shared parser

- [x] 1.1 Add `ReleaseNote = { version: string; notes: string }` and `parseChangelog(text: string): ReleaseNote[]` in `src/shared/release-notes.ts` - split on `/^## v(.+)$/` lines, version is the capture without the `v`, notes are the trimmed lines up to the next such heading, order preserved as written; verify by writing the tests in 1.2 first and making them pass.
- [x] 1.2 Add `src/shared/__tests__/release-notes.test.ts` covering: prose before the first heading is dropped, one entry per heading in file order, the last section runs to EOF, a heading with no body yields an empty `notes`, a non-version `## ` heading is not treated as a version, and parsing the repository's real `CHANGELOG.md` yields an entry for the current `package.json` version whose notes are non-empty; verify with `npx vitest run src/shared/__tests__/release-notes.test.ts`.

## 2. Build pipeline reuses the parser

- [x] 2.1 Rewire `scripts/extract-release-notes.ts` to select its section via `parseChangelog`, keeping its existing contract - same merged `electron-builder` config output, same hard error and non-zero exit when no entry matches `pkg.version`; verify by running `npx tsx scripts/extract-release-notes.ts <scratch-path>` and diffing the emitted `releaseInfo.releaseNotes` against the output from before the change.
- [x] 2.2 Remove `CHANGELOG.md` from the `files` exclusion list in `electron-builder.yml` and add it to `extraResources` (`from: CHANGELOG.md`, `to: CHANGELOG.md`); verify in task 5.2 against a real packaged build.

## 3. Main process

- [x] 3.1 Add `src/main/release-notes-history.ts`: resolve the changelog at `join(process.resourcesPath, 'CHANGELOG.md')` when `app.isPackaged` and two hops up from the main bundle (`import.meta.url`, counted from `out/main/index.mjs`) otherwise - copy the shape from `bundledDir()` in `src/main/agent/skills/definitions.ts`, do not re-derive it - read, parse via `parseChangelog`, cache for the process lifetime, and resolve to `[]` on any read failure with a log line; verify with a unit test in `src/main/__tests__/` that a missing file yields `[]` and does not throw.
- [x] 3.2 Add `RELEASE_NOTES_HISTORY: 'fleet:release-notes-history'` to `src/shared/ipc-channels.ts` and register `ipcMain.handle(...)` for it in `src/main/index.ts` next to the existing update handlers; verify `npm run typecheck:node` passes.

## 4. Renderer

- [x] 4.1 Expose `getReleaseHistory: async (): Promise<ReleaseNote[]>` on the `updates` namespace in `src/preload/index.ts` via `typedInvoke`; verify `npm run typecheck` passes and `window.fleet.updates.getReleaseHistory` is typed at the call site through `FleetApi`.
- [x] 4.2 In `UpdatesSection.tsx`, fetch the history on mount alongside `getVersion()` and hold it plus an expanded-version `Set<string>` seeded with the installed version; verify with `npm run drive -- eval` that the section's state holds one entry per changelog version.
- [x] 4.3 Replace the single release-notes box with the version list: one disclosure row per history entry (newest first), chevron plus version, body rendered by `AgentMarkdown` when open, the installed version's row expanded and labelled `current`, the whole list in a bounded scroll container; verify with `npm run drive -- screenshot` that the list renders, only the current row is open, and clicking another row expands it.
- [x] 4.4 Render a pending update (`staged`, else a `downloading` status carrying notes) as an expanded entry above the history, labelled with the version it will install, and filter that version out of the history list so it is not shown twice; verify with `npm run drive -- fixture update-ready` followed by a screenshot of Settings > Updates.
- [x] 4.5 Handle the empty and unmatched cases: an empty history renders no list and leaves the rest of the page working, and a running version absent from the history renders the list with every row collapsed and nothing marked current; verify by driving both states with `npm run drive -- eval`.

## 5. Verification

- [x] 5.1 Run `npm run lint`, `npm run typecheck`, and `npx vitest run`; all pass with no new failures.
- [x] 5.2 Build a packaged app (`npm run build` plus the platform target), launch it, and confirm Settings > Updates lists the full history - this is the failure this repo has shipped twice with bundled resource paths, so it must be checked in a packaged build and not only in `npm run dev`; write up anything that goes wrong in `docs/learnings/`.
- [x] 5.3 Add a `release-history` fixture to `scripts/drive/fixtures.ts` describing what a correct Settings > Updates should look like, in the style of the existing `update-ready` entry; verify by running it and reading the described state off a screenshot.
- [x] 5.4 Add a `## vX.Y.Z` entry to `CHANGELOG.md` for the release that carries this change, per the release workflow in `CLAUDE.md`.
