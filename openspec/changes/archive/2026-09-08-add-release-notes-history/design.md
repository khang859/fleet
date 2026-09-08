## Context

See `proposal.md` - Why for the motivation. What matters for the approach:

- `CHANGELOG.md` is the single source of release notes in this project.
  `scripts/extract-release-notes.ts` already reads it at build time, finds the `## v${pkg.version}` heading, takes the lines up to the next `## ` heading, and hands that body to `electron-builder` as `releaseInfo.releaseNotes`.
  So the notes a user sees today for a pending update are exactly one changelog section, minus its heading.
- `electron-builder.yml` currently excludes `CHANGELOG.md` from the packaged app (`'!{...,CHANGELOG.md,README.md}'`), so a packaged build has no copy of it.
- The renderer's whole view of updates is `useUpdateStore`, a mirror of an `UpdateSnapshot` pushed from main (`status` plus `staged`).
  That snapshot is per-event and transient by design; the history is neither, so it does not belong in it.
- `UpdatesSection.tsx` renders one notes box, sourced from `staged?.releaseNotes` falling back to a downloading status's notes, through `AgentMarkdown`.
- Reading a bundled file from main has a known failure mode in this repo: paths counted from the source file rather than the `out/main/index.mjs` bundle, and `readdir`/`readFile` unable to walk into `app.asar`.
  Both are documented in `docs/learnings/2026-08-07-bundled-resource-path-from-the-bundle-not-the-source.md` and `docs/learnings/2026-06-28-chat-skills-missing-from-packaged-app.md`, and `src/main/agent/skills/definitions.ts` has the pattern that survives both.

## Goals / Non-Goals

**Goals:**

- One parser, used by both the build script and the app, so the sections the user reads in Settings are split the same way the release pipeline splits them.
- The history reaches the renderer through a plain request/response IPC call, independent of the update snapshot's lifetime.
- The Settings list stays short by default: one row per version, only the installed one open.

**Non-Goals:**

- Fetching anything over the network. The history is what shipped with the build; a version newer than the build is the updater's business and is already carried by `staged`/`downloading`.
- Changing the updater, `update-staging.ts`, `update-scheduler.ts`, the pill, or `WhatsNewDialog`.
- Searching or filtering the history.
- A "what's new since the version I had" diff. The list makes the skipped versions readable; deciding which of them the user had not yet seen would need persisted state and is not part of this change.

## Decisions

### Ship the changelog as an `extraResource`, not inside the asar

`CHANGELOG.md` moves out of the `files` exclusion list and into `extraResources` (`from: CHANGELOG.md, to: CHANGELOG.md`), read at `join(process.resourcesPath, 'CHANGELOG.md')` when packaged and two hops up from the main bundle when not - the same shape as `bundledDir()` in `src/main/agent/skills/definitions.ts`.

Alternative considered: leave it in the asar by only removing the exclusion, and read it through the asar-aware `fs`.
`readFile` does work inside `app.asar` (unlike `readdir` on a directory), so this would function - but every other bundled data file in this app is an `extraResource`, the file is ~100 KB of text that nothing else in the bundle imports, and the resources copy is inspectable in a shipped build when someone has to debug why a version is missing.
Consistency with the existing pattern wins over saving a copy.

Alternative considered: generate a TypeScript module from the changelog at build time and import it.
That removes the path risk entirely, but adds a codegen step to `npm run build` and a generated file to the repo, and puts the notes in the renderer bundle where they inflate every load whether Settings is opened or not.

### One shared parser in `src/shared/`, reused by the build script

`parseChangelog(text): ReleaseNote[]` where `ReleaseNote = { version: string; notes: string }` lives in `src/shared/release-notes.ts`, unit-tested against the real changelog shape.
`scripts/extract-release-notes.ts` then selects `parseChangelog(...).find(e => e.version === pkg.version)` instead of doing its own index scan.

Why bother rewiring the script: the two splits must not drift.
If the script's idea of a section and the app's ever diverge, the notes shown for a pending update and the notes shown for that same version once installed stop matching, which is exactly the confusion this change exists to remove.
The script keeps its own failure behavior - a missing entry for the current version is still a hard error that fails the release build.

The parser stays deliberately dumb: split on lines matching `/^## v(.+)$/`, take the version capture, take the lines until the next such line, trim.
No semver parsing, no sorting - the changelog is already newest-first and the release script prepends to it, so imposing an order would only mask a malformed changelog rather than fix it.

### The history is a request, not part of the update snapshot

New channel `RELEASE_NOTES_HISTORY: 'fleet:release-notes-history'`, handled with `ipcMain.handle`, exposed as `window.fleet.updates.getReleaseHistory(): Promise<ReleaseNote[]>`.
`UpdatesSection` calls it in the same `useEffect` shape it already uses for `getVersion()`.

The snapshot is the wrong carrier: it is pushed on updater events and its two fields are explicitly transient/staged state, whereas the history is constant for the life of the process.
Putting it there would re-send ~100 KB of parsed text on every `download-progress` tick.

Main reads and parses the file once and caches the result for the process lifetime; the file cannot change under a packaged app.
A read failure resolves to `[]` rather than rejecting, so Settings degrades to what it shows today.

### The installed version identifies the "current" row; the pending update sits above the list

The renderer already fetches `getVersion()`; the row whose version equals it is expanded on first render and labelled `current`.
A `staged` (or `downloading`) update is rendered as an entry above the history, expanded, labelled with the version it will install - and filtered out of the history list by version so it cannot appear twice.

That filter matters in one real case: dev builds and any build where the changelog already contains the version being offered.
The pending entry's notes come from the updater, which is the authority for a version this build's changelog may not describe.

### Presentation

A `<details>`-style disclosure per version - a button row with a chevron and the version, and the body rendered by the existing `AgentMarkdown` when open.
Component state is a `Set<string>` of expanded versions seeded with the installed version, held in `UpdatesSection`; nothing about which rows are open is worth persisting.
The list scrolls within a bounded container, as the current single notes box already does, so the Updates page does not grow without limit as releases accumulate.

## Risks / Trade-offs

- **The bundled path is wrong in a packaged build, and the list is silently empty** → this repo has shipped that bug twice (see the two learnings files above).
  Mitigation: copy the resolved-path shape from `skills/definitions.ts` rather than re-deriving it, and verify in a packaged build before the change is called done, not only in `npm run dev`.
- **A malformed or hand-edited changelog produces junk entries** → the parser only recognizes `## vX.Y.Z`; anything else is ignored rather than guessed at, and the unit tests pin the shapes that appear in the real file (prose before the first heading, an empty section, the final section running to EOF).
- **Rewiring `extract-release-notes.ts` breaks the release build** → it is the one script standing between a tag and a published release.
  Mitigation: it keeps its existing contract exactly (same error on a missing entry, same output), the parser is unit-tested first, and the script is exercised by running it against the current version before the change lands.
- **The history grows with every release** → at ~100 KB today and one release every few days this is a bounded, slow-growing text file; the bounded scroll container keeps the UI cost flat, and the one-time parse is cached.
- **The changelog is now user-facing product surface** → entries that were written for a GitHub reader are read inside the app.
  Accepted: they are already shown this way for the pending version, and the same `AgentMarkdown` renderer handles them.

## Migration Plan

No data migration, no persisted state, no schema change.
The change is additive: if the history is empty for any reason, Settings > Updates behaves as it does today.
Rollback is reverting the commit; a build without the `extraResources` entry simply has no history to show.
