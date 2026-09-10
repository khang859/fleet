## Why

Claude Code's behaviour lives in hidden JSON and Markdown files (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/CLAUDE.md`, `./CLAUDE.md`).
Changing any of them today means leaving Fleet, finding a dotfolder in Finder or a shell, and hand-editing JSON with no validation and no idea which scope wins.
Fleet already owns the Claude Code relationship - it installs copilot hooks into `settings.json`, assigns a `CLAUDE_CONFIG_DIR` per workspace, and shows hook status - so it is the natural place to also read and write the rest of that configuration.

## What Changes

- Add a **Claude Config** page to Settings (under "Tools & Agents") that reads and writes Claude Code's user-scope and project-scope config files.
- Scope picker with three settings scopes and their real resolved paths:
  - **User** - `<claudeConfigDir>/settings.json`, where `<claudeConfigDir>` is the folder Fleet already resolves through `resolveClaudeConfig`, not a hard-coded `~/.claude`.
  - **Project** - `<sessionDir>/.claude/settings.json`, where `<sessionDir>` defaults to the active pane's working directory, because Claude Code reads shared project settings from the session's working directory rather than from the repository root.
  - **Project local** - `<localSettingsRoot>/.claude/settings.local.json`, where `<localSettingsRoot>` is the git repository root, or the main checkout's root for a worktree, falling back to `<sessionDir>` outside a repository, at the home directory, or on Windows - matching Claude Code's own placement rules.
- The two project paths resolve independently, are both displayed with the rule that produced them, and each has its own folder picker, so a Claude Code version that resolves differently is never a trap.
- Each settings scope offers two views of the same file:
  - **Form** - typed controls for the keys a developer actually touches: `model`, `permissions.defaultMode`, `permissions.allow` / `ask` / `deny` / `additionalDirectories`, `env`, `outputStyle`, `effortLevel`, `alwaysThinkingEnabled`, `autoCompactEnabled`, `includeCoAuthoredBy`, `cleanupPeriodDays`, `statusLine`, `enabledPlugins`, and a read-only summary of `hooks`.
  - **Raw JSON** - a CodeMirror editor over the whole file with JSON syntax highlighting, key/enum autocomplete and inline validation driven by the published Claude Code settings JSON Schema.
  - The two views edit one in-memory document, so switching tabs never loses an edit and keys the form does not know about survive a form-side save untouched.
- A **CLAUDE.md** tab edits `<claudeConfigDir>/CLAUDE.md` (user) and `<sessionDir>/CLAUDE.md` (project) as Markdown, creating the file on first save when it does not exist. There is no project-local CLAUDE.md.
- Merge-aware precedence hints: a scalar key set in more than one visible scope reports the narrowest file as the winner, while a list key such as `permissions.allow` reports that Claude Code *combines* the lists rather than replacing them. Four model-related keys with their own resolution rules show no verdict. Every hint is labelled as a comparison of these three files only, since managed settings, `--settings`, CLI flags and environment variables can change the effective value without appearing on the page.
- Writes are atomic and conflict-aware: the Env Editor's temp-file-plus-rename, with a stronger guard than its bare `expectedMtimeMs` check. A revision token of `{ exists, mtimeMs, size }` catches creation, deletion and same-or-older-timestamp replacement, not only a strictly newer timestamp.
- The page never touches managed settings, `~/.claude.json`, or the `hooks` block Fleet's copilot installer owns. `hooks` is displayed read-only with a link to the Copilot page, and is substituted from a fresh read of disk on *every* write path - form save, raw save, and overwrite-after-conflict - so neither a raw edit nor a stale overwrite can undo a hook installation.
- Access is restricted to an allowlist of five exact files by scope and kind. The project CLAUDE.md sits at the project root rather than inside `.claude`, so the boundary is defined by that table rather than by a directory prefix.
- Unsaved drafts and chosen folders live in a store rather than in the section component, so following the page's own link to the Copilot page and coming back does not discard an edit.

## Capabilities

### New Capabilities

- `claude-config`: reading, editing, validating and writing Claude Code's user- and project-scope `settings.json`, `settings.local.json` and `CLAUDE.md` files from Fleet's Settings page, including scope resolution, precedence reporting, schema-backed validation and conflict-safe writes.

### Modified Capabilities

None. No existing spec's requirements change.

## Impact

- **New renderer code**: `src/renderer/src/components/settings/ClaudeConfigSection.tsx` plus supporting components (form, raw editor, CLAUDE.md editor); new entries in `SettingsNav.tsx` (`SettingsSection` union, `NAV_GROUPS`) and `SettingsTab.tsx` (`SECTION_COMPONENTS`).
- **New main-process code**: a `claude-config` module for discovery, atomic read/write and scope resolution, wired through `src/shared/ipc-channels.ts`, `src/main/ipc-handlers.ts` and `src/preload/index.ts` following the existing `envEditor` shape.
- **Shared code**: extends `src/shared/claude-config.ts` with scope/path types and the file allowlist; adds shared settings-schema and precedence-classification modules.
- **New renderer store**: `src/renderer/src/store/claude-config-store.ts`, because `SettingsTab` unmounts a section on navigation and component-local drafts would not survive the page's own link to Copilot.
- **Uses existing plumbing**: `IPC_CHANNELS.SHOW_FOLDER_PICKER` for the path overrides, and `simple-git` for `rev-parse --git-common-dir` to find a worktree's main checkout.
- **Dependencies**: one new runtime dependency for JSON Schema validation (`ajv`). CodeMirror, `@codemirror/lang-json`, `@codemirror/lint` and `@codemirror/autocomplete` are already in the tree or are first-party CodeMirror packages on the same release train.
- **Vendored asset**: the Claude Code settings JSON Schema (`https://www.schemastore.org/claude-code-settings.json`, 142 documented top-level keys) is bundled so the editor works offline, with a script to refresh it.
- **Interacts with**: the copilot hook installer, which writes the `hooks` block of the same `settings.json`. The page must re-read from disk after the installer runs and must not clobber it.
