## Context

See `proposal.md` - Why.

What already exists and shapes the approach:

- `src/shared/claude-config.ts` already resolves which Claude config directory a workspace's terminals get (`resolveClaudeConfig`, `defaultClaudeConfigDir`). The new page must reuse it rather than assume `~/.claude`.
- `src/main/copilot/hook-installer.ts` already reads, mutates and writes the `hooks` block of the same `settings.json` files. Two writers on one file is the central hazard here.
- `src/main/env-editor/env-editor-fs.ts` solves conflict-safe editing of a config file from the settings UI: `readFileSync` plus `mtimeMs`, an `expectedMtimeMs` guard on write, temp-file-plus-`renameSync`, and typed result shapes. Its *structure* is the right template; its *guard* is not strong enough here (see Decision 6).
- `src/renderer/src/components/FileEditorPane.tsx` already builds a CodeMirror 6 editor with lazy-loaded language support, and `@codemirror/lang-json` is already a dependency.
- Settings pages are registered in exactly two places: the `SettingsSection` union plus `NAV_GROUPS` in `SettingsNav.tsx`, and `SECTION_COMPONENTS` in `SettingsTab.tsx`. `SettingsTab` swaps `SectionComponent` on navigation, so a section's component state is destroyed when the user leaves it.
- `IPC_CHANNELS.SHOW_FOLDER_PICKER` and `IPC_CHANNELS.GIT_REPO_ROOT` already exist. `simple-git` is a dependency, so `rev-parse --git-common-dir` is available for worktree resolution.

Constraints from the platform, all confirmed against current Claude Code documentation:

- 142 documented top-level settings keys, growing every release. Nothing hand-written can track that.
- **List keys merge across settings files.** "When you set the same list key, such as `permissions.allow`, in more than one file, Claude Code combines the lists instead of picking one." Four model-related keys (`fallbackModel`, `modelPicker`, `availableModels`, `modelSettings`) have their own rules that are neither merge nor simple override.
- **Deny beats allow across scopes**, in either direction.
- **The two project files are not read from the same directory.** Shared `.claude/settings.json` comes from the session's primary working directory. `.claude/settings.local.json` is placed at the git repository root, or the main checkout's root in a worktree - except outside a repository, when the root is the home directory, on Windows, or on an ownership mismatch, where it stays beside the shared file.
- **Environment variables and CLI flags are not a precedence level** but can still decide the effective value per key (`ANTHROPIC_MODEL` beats the `model` key from any file).
- `permissions.defaultMode` values `auto` and `bypassPermissions` do not take effect from project or local settings.

## Goals / Non-Goals

**Goals:**

- One source of truth for the document being edited, so the Form and Raw views cannot drift apart.
- Key-set preservation: a save from this page changes only the keys the user changed, and never the `hooks` key.
- The settings-key catalogue comes from data, not from hand-written TypeScript.
- Anything the page tells the user about precedence is either correct or explicitly hedged. No confident wrong answers.
- Reuse Fleet's existing config-file editing plumbing where it is strong enough, and say plainly where it is not.

**Non-Goals:**

- Comment or formatting preservation in `settings.json`. These are plain JSON files that Claude Code itself rewrites with `JSON.stringify`.
- Byte-for-byte file preservation of anything. The page reformats what it writes; preservation is defined by parsed value.
- A visual hooks editor, managed settings, `~/.claude.json`, MCP servers, agents, commands or skills.
- Predicting the effective value of a setting in a live session. The page compares three files; it does not read the user's shell or a running session's flags.
- Live validation against a *remote* schema. The schema is vendored.

## Decisions

### 1. Vendor the SchemaStore JSON Schema, do not hand-write a key catalogue

Chosen: bundle `https://www.schemastore.org/claude-code-settings.json` (~225 KB, 142 top-level properties, every one with a description) as `resources/claude-code-settings.schema.json`, plus `scripts/fetch-claude-settings-schema.ts` to refresh it.

Why: it is the only machine-readable, maintained description of the key space. It supplies descriptions for tooltips, enums for dropdowns and completions, and types for validation. A hand-written catalogue would be stale within a release.

Alternatives rejected: a hand-maintained key list (rots immediately); fetching at runtime (makes an offline app depend on the network and lets a third-party host change app behaviour silently).

The schema is advisory, never authoritative: an unknown key is a *warning*, never a blocked save. Claude Code ships keys before SchemaStore catches up.

### 2. Validate with `ajv`, not `codemirror-json-schema`

Chosen: `ajv` for validation, plus a small in-repo CodeMirror completion source that walks the schema.

Why: `codemirror-json-schema` bundles completion and linting, but its last release is v0.8.1 from April 2025 - stale by this project's dependency bar. `ajv` is unambiguously maintained. The completion source is modest: find the caret's JSON path in the syntax tree, look it up in the schema, offer `properties` keys or an `enum` list.

Trade-off: ~150 lines we own instead of a dependency. Accepted, because the alternative is a stale package in the feature's critical path. `@codemirror/lint` and `@codemirror/autocomplete` are first-party CodeMirror 6 packages on the same release train as the 20 already here.

### 3. One document, two projections

Page state holds `{ text, revision, exists }` per scope as the single source of truth. The Raw view binds to `text`. The Form view derives from `JSON.parse(text)` and, on a control change, applies a targeted key edit back into `text`.

Why not "form holds an object, raw holds a string, sync on tab switch": that loses unknown keys on every form save and makes tab switching lossy. Holding text makes key preservation true by construction.

Targeted key edit: parse, set or delete the one path, re-serialize with `JSON.stringify(obj, null, 2)`. Insertion order is preserved for string keys, and a new key lands at the end - the same shape Claude Code's own writes produce. This is a reformat, which is why the spec defines preservation by parsed value rather than bytes.

A missing or whitespace-only settings file loads as the text `{}` so the Form view always has something to render; `exists: false` is tracked separately so the page can label it and so conflict detection knows the file was absent. A missing memory file loads as empty text.

### 4. Two independent project paths, each disclosed and each overridable

Chosen: resolve `sessionDir` and `localSettingsRoot` separately.

- `sessionDir` defaults to the active pane's working directory. Not the repository root - Claude Code reads shared project settings from the session's working directory, so defaulting to the root would edit a file the user's session does not read.
- `localSettingsRoot` derives from `sessionDir` via `git rev-parse --path-format=absolute --git-common-dir`, whose parent is the main checkout root and which therefore handles worktrees and plain repositories in one call. It falls back to `sessionDir` when the result is the home directory, when `process.platform === 'win32'`, or when the command fails.

Both resolved paths are always shown, the rule that produced each is stated, and each has its own folder picker. The ownership-mismatch fallback in Claude Code's rules is not reproduced - it is rare and platform-specific, and the visible path plus the picker is the escape hatch for every case Fleet guesses wrong.

Why disclose rather than silently resolve: these rules changed in v2.1.211 and again in v2.1.246, and Fleet cannot know which Claude Code binary a given terminal runs. A visible path with a correction affordance stays right across versions; a hidden guess does not.

Alternative rejected: one folder for both scopes. It is simpler, and it is wrong - it would point the shared file at the repository root and quietly edit a file the session never reads.

### 5. Scope resolution lives in `src/shared/`, path derivation is re-done in main

Chosen: extend `src/shared/claude-config.ts` with `ClaudeConfigScope`, `ClaudeFileKind` and a pure `resolveClaudeFilePath({ scope, kind, configDir, sessionDir, localSettingsRoot })` returning an absolute path or `null` for the combination with no file (project-local memory). The renderer uses it to *display*; the main process uses the same function to *derive* the path it touches.

Why: this is the split `claude-config.ts`'s own header already describes, and it keeps the renderer from inventing paths the main process would have to trust.

The IPC surface takes `{ scope, kind, configDir, sessionDir, localSettingsRoot }`, never a bare absolute path, and the derived path must equal one of the five allowlisted forms in the spec's table. The allowlist is by exact derived path, so the project memory file at `<sessionDir>/CLAUDE.md` is permitted even though it sits outside `<sessionDir>/.claude`. An earlier draft of this design described the boundary as "inside the `.claude` directory", which would have rejected the project CLAUDE.md the spec requires; the table is the contract.

### 6. A revision token, not a bare mtime

`writeEnvFile`'s guard refuses only a *strictly newer* `mtimeMs`, and skips the check entirely when the file no longer exists. That is adequate for `.env` files and not adequate here, where a restored backup or a hook installer's rewrite can land with an equal or older timestamp.

Chosen: a `ClaudeFileRevision = { exists: boolean; mtimeMs: number; size: number }` captured at read and passed back at write. The write proceeds only when the current state matches the revision on all three fields:

- file absent at read, absent now → proceed (create).
- file absent at read, present now → refuse, report creation.
- present at read, absent now → refuse, report deletion.
- present in both, `mtimeMs` and `size` equal → proceed.
- present in both, either differs → refuse, report external change.

Equal mtime *and* equal size is not a proof of identical content, but same-size same-timestamp different-content is a deliberate adversary rather than an accident. Hashing the file would close it and costs a read of a file we already read; if the size check proves insufficient in practice, a content hash is a drop-in third field. Recorded as a known limit rather than a silent assumption.

`writeClaudeFile` keeps the env editor's temp-file-plus-`renameSync` and adds `mkdirSync(dirname, { recursive: true })`. This is a new function alongside `writeEnvFile`, not a change to it - the env editor's semantics are fine for `.env` and are not this feature's to alter.

### 7. Hooks are stripped at the write boundary, not at the form boundary

The earlier draft excluded `hooks` from the Form view's write set. That protects a form save and nothing else: the Raw view edits the whole file, and an Overwrite after a conflict would write back the `hooks` block the page loaded, undoing an installation that happened in between.

Chosen: enforce it in the main process, on every write. `writeClaudeSettings` parses the incoming text, reads the file on disk, and substitutes the disk's `hooks` value into the document - deleting the key when disk has none - before serializing. The renderer cannot opt out, and the rule holds identically for a form save, a raw save, and an overwrite.

The handler returns whether it discarded a differing `hooks` value, so the page can tell the user their hooks edit did not apply and point them at the Copilot page.

Why in main rather than in the renderer: it is the only place both the incoming document and the current disk state are available at the same moment, and it is the boundary a future second caller would also cross.

Consequence for the spec's wording: "byte-for-byte" was the wrong contract, because the whole document is reserialized on every save. The contract is a deep-equal parsed `hooks` value, which is what actually matters to Claude Code.

### 8. Precedence is merge-aware, hedged, and refuses to guess

Chosen: classify each key before reporting on it.

- **List keys** (`permissions.allow`, `permissions.ask`, `permissions.deny`, `permissions.additionalDirectories`, and any key the schema types as an array outside the exception list) → report "combined across N files", name the contributors, never say "overridden".
- **Scalar keys** → report the narrowest scope that sets it, in the order local, project, user.
- **`fallbackModel`, `modelPicker`, `availableModels`, `modelSettings`** → show no winner and link to the setting's documentation. Each has a distinct rule that a three-file comparison cannot express.
- **Deny/allow interaction** → a standing note on the permission lists that a deny rule in any scope blocks a matching allow rule in any scope.

Every notice is labelled as a comparison of the three files on the page, with the explicit caveat that managed settings, `--settings`, CLI flags and environment variables can change the effective value without appearing here. `ANTHROPIC_MODEL` beating the `model` key is the concrete case this caveat exists for.

The form additionally warns, in the project and project-local scopes, that `auto` and `bypassPermissions` do not take effect for `permissions.defaultMode` from those files - a documented dead end that the page would otherwise let the user walk into.

Why hedge rather than model the whole resolution: the honest answer is that Fleet is reading three files, not simulating Claude Code. A confident wrong answer about permissions is worse than a hedged right one.

### 9. Page state lives in a store, not in the section component

`SettingsTab` unmounts a section on navigation, so component-local state dies when the user follows the hooks panel's link to the Copilot page - which the spec requires the page to offer.

Chosen: a `useClaudeConfigStore` zustand store, matching the pattern already used by `useHookStatusStore` and `useWorkspaceListStore`. It holds the selected scope, the resolved and user-overridden directories, and a per-scope document map keyed by resolved path. The section component becomes a view over it and can be unmounted freely.

Keying documents by resolved path rather than by scope means switching the session directory and switching back finds the draft still there, and two scopes that happen to resolve to the same file share one document rather than diverging.

## Risks / Trade-offs

- **A bad write breaks the user's Claude Code setup.** → Atomic rename means the file is never half-written. The revision token means a concurrent writer is reported. `hooks` is substituted from disk on every write path.
- **Equal-mtime, equal-size, different-content escapes conflict detection.** → Accepted and recorded. A content hash is a drop-in third revision field if it ever matters.
- **Fleet's project-path resolution disagrees with the user's Claude Code version.** → Both paths are always visible with the rule that produced them, and both have a folder picker. Fleet's guess is a default, not a claim.
- **The vendored schema goes stale and warns about a valid new key.** → Warnings never block a save. The refresh script makes updating a one-line chore, and the page states the key list is a bundled snapshot.
- **Precedence reporting is still incomplete** - it cannot see managed settings, session flags or environment variables. → Every notice says so. The page never claims to show the effective value.
- **`JSON.parse` / `JSON.stringify` round-trip discards comments and custom formatting.** → Accepted and stated in the page. Reformatting only happens on a save the user initiated.
- **The custom completion source is code we own.** → Advisory UI, not correctness: a missing completion is a papercut, never a bad write. The JSON-path resolution gets unit tests.
- **Editing user-scope settings can lock the user out of their own agent** (a bad `permissions.deny`). → Out of scope to prevent. Fleet validates shape, not semantics.

## Migration Plan

Additive. A new settings page, a new store, new IPC channels, and one new runtime dependency. Nothing existing changes behaviour; `writeEnvFile` is untouched. Rollback is removing the nav entry.

The vendored schema is checked in, so a fresh clone and an offline build both work without running the fetch script.
