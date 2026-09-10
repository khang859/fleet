## 1. Dependencies and vendored schema

- [x] 1.1 Add `ajv`, `@codemirror/lint` and `@codemirror/autocomplete` at their latest versions and verify `npm run typecheck` still passes.
- [x] 1.2 Add `scripts/fetch-claude-settings-schema.ts` that downloads `https://www.schemastore.org/claude-code-settings.json` to `resources/claude-code-settings.schema.json`; verify by running `npx tsx scripts/fetch-claude-settings-schema.ts` and confirming the written file parses and has 140+ top-level `properties`.
- [x] 1.3 Commit the fetched schema and confirm it is present in a packaged build.
The schema is imported as a module rather than read from disk at runtime, so the bundler inlines it and no `extraResources` entry is needed; verify with `npm run build` that the built renderer chunk contains a schema key such as `cleanupPeriodDays`.

## 2. Shared scope and path model

- [x] 2.1 Extend `src/shared/claude-config.ts` with `ClaudeConfigScope` (`'user' | 'project' | 'projectLocal'`), `ClaudeFileKind` (`'settings' | 'memory'`), and a pure `resolveClaudeFilePath({ scope, kind, configDir, sessionDir, localSettingsRoot })` implementing the spec's five-row allowlist table and returning `null` for project-local memory. Verify with unit tests in `src/shared/__tests__/claude-config.test.ts` covering all six scope/kind combinations, POSIX and Windows separators, and that project memory resolves to `<sessionDir>/CLAUDE.md` rather than inside `.claude`.
- [x] 2.2 Add `isAllowedClaudeFilePath(path, inputs)` returning true only when `path` equals one of the five derived allowlist entries. Verify with unit tests that a `sessionDir` containing `..`, a sibling file inside `.claude`, and `~/.claude.json` are all refused, and that `<sessionDir>/CLAUDE.md` is accepted.
- [x] 2.3 Add `src/shared/claude-settings-schema.ts` exposing `schemaForPath(path: string[])`, `topLevelKeys()` and `isListKey(path)` over the vendored schema, resolving `$ref`s. Verify with unit tests asserting `schemaForPath(['permissions','defaultMode'])` returns the enum, `isListKey(['permissions','allow'])` is true, and `schemaForPath(['nope'])` is `undefined`.
- [x] 2.4 Add `src/shared/claude-settings-precedence.ts` with `classifyKey(path)` returning `'scalar' | 'list' | 'special'` (special = `fallbackModel`, `modelPicker`, `availableModels`, `modelSettings`) and `describePrecedence(key, { user, project, projectLocal })` returning a merge-aware result: a winning scope for scalars, the contributing scopes for lists, and no verdict for special keys. Verify with unit tests for a scalar in all three scopes, a list in two scopes, a special key, and a key in none.

## 3. Main process file access

- [x] 3.1 Add `src/main/claude-config/claude-config-fs.ts` with `readClaudeFile` returning `{ text, revision: { exists, mtimeMs, size }, exists }`, treating a missing or whitespace-only settings file as the text `{}` and a missing memory file as empty text. Verify with unit tests for a missing file, an empty file, a whitespace-only file and a populated file.
- [x] 3.2 Implement `writeClaudeFile` with the revision check from design Decision 6 - refusing on creation, deletion, and any `mtimeMs`/`size` mismatch, not only a strictly newer mtime - plus `mkdirSync(dirname, { recursive: true })` and temp-file-plus-`renameSync`. Verify with unit tests covering all five revision outcomes, including a replacement whose mtime is older than the loaded revision and one whose mtime is equal but size differs.
- [x] 3.3 Implement `writeClaudeSettings` wrapping `writeClaudeFile`: parse the incoming text, read the current file, substitute the disk's `hooks` value into the document (deleting the key when disk has none), serialize with two-space indent, and return `{ hooksDiscarded: boolean }`. Verify with unit tests that a raw-view edit to `hooks` is discarded, that a disk `hooks` block absent from the incoming text is restored, that an absent-on-disk `hooks` stays absent, and that every other key is written as supplied.
- [x] 3.4 Make the write path re-derive its absolute path from `{ scope, kind, configDir, sessionDir, localSettingsRoot }` and reject anything `isAllowedClaudeFilePath` refuses. Verify with a unit test that a traversal attempt is refused and that the project CLAUDE.md write is accepted.
- [x] 3.5 Add `resolveLocalSettingsRoot(sessionDir)` in `src/main/claude-config/` using `git rev-parse --path-format=absolute --git-common-dir` via `simple-git`, taking the parent of the returned `.git` directory, and falling back to `sessionDir` when the result is the home directory, when `process.platform === 'win32'`, or when the command fails. Verify with unit tests against a temp plain repository, a temp worktree of it (asserting the main checkout root), and a non-repository directory.
- [x] 3.6 Add `CLAUDE_CONFIG_READ`, `CLAUDE_CONFIG_WRITE` and `CLAUDE_CONFIG_RESOLVE_ROOT` to `src/shared/ipc-channels.ts`, register handlers in `src/main/ipc-handlers.ts`, and expose a `claudeConfig` namespace in `src/preload/index.ts` following the existing `envEditor` shape. Verify `npm run typecheck` passes and `window.fleet.claudeConfig` types resolve in the renderer.

## 4. Page state store

- [x] 4.1 Add `src/renderer/src/store/claude-config-store.ts` (zustand, following `hook-status-store.ts`) holding the selected scope, the resolved and user-overridden `sessionDir` and `localSettingsRoot`, and a document map keyed by resolved absolute path with `{ text, revision, exists, dirty }`. Verify with unit tests in `src/renderer/src/store/__tests__/` for load, edit, save, scope switch with a dirty document, and that two scopes resolving to one path share a document.
- [x] 4.2 Verify drafts and directory choices survive a section unmount: unit-test that the store retains state across a simulated remount, and confirm in the app by editing, navigating to Copilot, returning, and seeing the edit still marked unsaved.

## 5. Settings page shell

- [x] 5.1 Add `'claudeConfig'` to the `SettingsSection` union and a "Claude Config" item under "Tools & Agents" in `SettingsNav.tsx`, and register `ClaudeConfigSection` in `SECTION_COMPONENTS` in `SettingsTab.tsx`. Verify with `npm run drive -- screenshot` that the entry appears and opens a page.
- [x] 5.2 Build the scope picker and render the resolved absolute path for the selected scope, using `resolveClaudeConfig` for the user scope so a workspace override is honoured. Verify by setting a workspace override in the Workspaces page and screenshotting that this page shows the overridden path.
- [x] 5.3 Build project path resolution: preselect `sessionDir` from the active pane's working directory, derive `localSettingsRoot` through `CLAUDE_CONFIG_RESOLVE_ROOT`, show both paths with the rule that produced each, and give each its own `SHOW_FOLDER_PICKER` override. Verify in a repository subdirectory that the Project scope points at the subdirectory and the Project local scope at the repository root, and that overriding one leaves the other unchanged.
- [x] 5.4 Render the "no folder chosen", "not created yet" and managed-settings-not-editable states. Verify by opening the page with no pane open, and by pointing the project scope at a folder with no `.claude` directory.

## 6. Raw editor

- [x] 6.1 Build `ClaudeConfigRawEditor.tsx` reusing `FileEditorPane`'s extension set with `@codemirror/lang-json`, bound to the store's document text. Verify that typing flips the document's `dirty` flag.
- [x] 6.2 Add the `ajv`-backed lint source: a parse error is an `error` diagnostic that blocks save; an unknown key or wrong-typed value is a `warning` that does not. Verify by pasting broken JSON (save disabled, marker shown) and by adding `"totallyFakeKey": 1` (warning shown, save still enabled).
- [x] 6.3 Add the schema-driven completion source: key names with descriptions at object positions, enum values at value positions, using `syntaxTree` to find the caret's JSON path. Verify with unit tests on the path-resolution helper plus a manual check that `permissions.defaultMode` offers its enum.

## 7. Form view

- [x] 7.1 Build `ClaudeConfigForm.tsx` with controls for `model`, `outputStyle`, `effortLevel`, `permissions.defaultMode`, `alwaysThinkingEnabled`, `autoCompactEnabled`, `includeCoAuthoredBy` and `cleanupPeriodDays`, sourcing labels and enums from the vendored schema. Verify each control reflects the value in a fixture file, and that a fixture of `{}` renders every control unset.
- [x] 7.2 Build the list editors for `permissions.allow`, `permissions.ask`, `permissions.deny` and `permissions.additionalDirectories`, and the key/value editors for `env` and `enabledPlugins`. Verify adding, editing and removal, and that existing entries keep their order.
- [x] 7.3 Implement the targeted key edit (`setKey` / `deleteKey` over the parsed object, reserialized with two-space indent) so clearing a control removes the key. Verify with a unit test that round-trips a fixture containing a `hooks` block, a `statusLine` object and three unknown keys, asserting every untouched key is deeply equal and in the same relative order, and only the edited key differs.
- [x] 7.4 Warn in the Project and Project local scopes that `auto` and `bypassPermissions` for `permissions.defaultMode` do not take effect from those files, while still allowing the save. Verify by selecting each value in each project scope and screenshotting the warning.
- [x] 7.5 Render `hooks` as a read-only summary of configured events with a link that calls `onNavigate('copilot')`. Verify by screenshotting the user scope on a machine with Fleet hooks installed.
- [x] 7.6 Render the "cannot show the form, JSON does not parse" state and confirm switching to Raw preserves the broken text. Verify manually.

## 8. Precedence reporting

- [x] 8.1 Load all three scopes on page open and render per-key notices from `describePrecedence`: an override notice for scalars, a "combined across these files" notice for lists, and no verdict for the four special keys. Verify with fixtures where `model` is set in user and local (override notice naming the local file) and `permissions.allow` has entries in both (combined notice, no override wording).
- [x] 8.2 Add the standing note on the permission lists that a deny rule in any scope blocks a matching allow rule in any scope. Verify by screenshot.
- [x] 8.3 Label every precedence notice as a three-file comparison that excludes managed settings, `--settings`, CLI flags and environment variables. Verify by screenshot that the caveat is present wherever a notice is.

## 9. CLAUDE.md, saving and refresh

- [x] 9.1 Add the CLAUDE.md tab for the user and project scopes (Markdown CodeMirror editor, same store and save plumbing), writing `<configDir>/CLAUDE.md` and `<sessionDir>/CLAUDE.md`, and omit the tab for project local. Verify by editing and saving both files and confirming the contents on disk.
- [x] 9.2 Wire save (button plus Cmd+S while the page is focused) through `claudeConfig.write` with the loaded revision, and surface each refusal outcome distinctly: modified, replaced, deleted, and created-since-load. Verify each by manipulating the file from a shell between load and save, including a `touch -t` restore with an older timestamp.
- [x] 9.3 Implement Reload (adopt disk content, clear dirty, refresh the revision) and Overwrite (re-issue the write against the current revision). Verify that an Overwrite issued after Fleet's hook installer ran writes the installer's `hooks` block, not the block the page had loaded.
- [x] 9.4 Surface a notice when `writeClaudeSettings` reports `hooksDiscarded`, telling the user their hooks edit was not applied and linking to the Copilot page. Verify by editing `hooks` in the Raw view and saving.
- [x] 9.5 Surface `missingDir` and generic write failures as an inline error naming the path, keeping the editor's text. Verify by making a `.claude` directory read-only and saving.
- [x] 9.6 Re-read the current scope from disk on page focus when the document is clean, and show a "changed on disk" banner instead of replacing the text when it is dirty. Verify both: install hooks from the Copilot page and return with a clean document (content updates), and again with a dirty document (edits kept, banner shown).

## 10. Verification

- [x] 10.1 Run `npm run lint`, `npm run typecheck` and `npx vitest run` and confirm all pass with no new warnings.
- [ ] 10.2 Run `ripwire . --quality-delta` and confirm it exits zero.
Not satisfied as written.
The run reports no finding introduced by this change, but it exits 2 on a pre-existing floor: 10 gating findings that were already worse before this work, the first being dead code `joinPath` at `src/renderer/src/lib/shell-utils.ts:24` (was=0 now=0).
Fixing pre-existing dead code is out of this change's scope.
- [x] 10.3 End-to-end pass with `npm run dev` plus `npm run drive`: for each of the three scopes, screenshot the Form view, the Raw view and a save; confirm alignment, spacing and empty states match the rest of Settings, and fix any visual defect found.
- [x] 10.4 Add a learnings note under `docs/learnings/` for anything that went wrong during implementation.
