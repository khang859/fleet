## Purpose

Lets a Fleet user read, edit and save Claude Code's user-scope and project-scope configuration - `settings.json`, `settings.local.json` and `CLAUDE.md` - from Fleet's Settings page, with validation, precedence reporting and conflict-safe writes, instead of hand-editing hidden dotfiles outside the app.

## ADDED Requirements

### Requirement: Claude Config settings page

Fleet SHALL provide a Claude Config page in Settings that presents Claude Code's configuration for one selected settings scope at a time.

#### Scenario: Page is reachable from the settings navigation

- **WHEN** the user opens the Settings tab
- **THEN** a "Claude Config" entry appears in the settings navigation
- **AND** selecting it shows the Claude Config page

#### Scenario: Page opens on the user scope

- **WHEN** the Claude Config page is first opened in a session
- **THEN** the User scope is selected
- **AND** the page shows the absolute path of the file that scope resolves to

### Requirement: Scope selection and user-scope path resolution

The page SHALL offer three settings scopes - User, Project and Project local - and SHALL resolve each to a concrete absolute file path before showing any content.

The User scope SHALL resolve to `settings.json` inside the Claude config directory Fleet already assigns to the active workspace, honouring that workspace's `CLAUDE_CONFIG_DIR` override and falling back to Fleet's shared default and then to the home-directory `.claude` folder.

#### Scenario: User scope follows a workspace override

- **GIVEN** the active workspace overrides its Claude config directory to `/Users/me/.claude-work`
- **WHEN** the User scope is selected
- **THEN** the page shows and edits `/Users/me/.claude-work/settings.json`

#### Scenario: User scope falls back to the home directory

- **GIVEN** neither the active workspace nor Fleet's shared default sets a Claude config directory
- **WHEN** the User scope is selected
- **THEN** the page shows and edits `settings.json` inside the `.claude` folder of the user's home directory

### Requirement: Project scope files resolve independently

Claude Code does not read the two project-scope files from the same directory: it reads shared project settings from the session's working directory, and it places project-local settings at the git repository root - or, in a worktree, at the main checkout's root. The page SHALL therefore resolve each project-scope file independently rather than deriving both from one folder.

The Project scope SHALL resolve to `.claude/settings.json` inside a selected **session directory**, preselected as the active pane's working directory.
The Project local scope SHALL resolve to `.claude/settings.local.json` inside the **local-settings root** derived from that session directory:

- the main checkout's root when the session directory is inside a git worktree;
- otherwise the git repository root when the session directory is inside a repository;
- otherwise the session directory itself.

The local-settings root SHALL fall back to the session directory when the resolved root is the user's home directory, when the host platform is Windows, or when the repository root cannot be determined - matching the cases in which Claude Code keeps the local file beside the shared file.

Each resolved path SHALL be displayed, and each SHALL be individually overridable by the user through a folder picker, so a user whose Claude Code version resolves differently is never forced onto Fleet's guess.

#### Scenario: Shared settings follow the session directory, not the repository root

- **GIVEN** the active pane's working directory is `/Users/me/code/app/packages/api`
- **AND** `/Users/me/code/app` is the enclosing git repository root
- **WHEN** the Project scope is selected
- **THEN** the page shows and edits `/Users/me/code/app/packages/api/.claude/settings.json`

#### Scenario: Local settings resolve to the repository root

- **GIVEN** the same session directory `/Users/me/code/app/packages/api`
- **WHEN** the Project local scope is selected
- **THEN** the page shows and edits `/Users/me/code/app/.claude/settings.local.json`

#### Scenario: Local settings in a worktree resolve to the main checkout

- **GIVEN** the session directory is inside a git worktree whose main checkout is `/Users/me/code/app`
- **WHEN** the Project local scope is selected
- **THEN** the page shows and edits `/Users/me/code/app/.claude/settings.local.json`

#### Scenario: Local settings stay beside shared settings on Windows

- **GIVEN** the host platform is Windows
- **WHEN** the Project local scope is selected
- **THEN** the local-settings root is the session directory, so both project files resolve to the same `.claude` directory

#### Scenario: A resolved path can be overridden

- **WHEN** the user picks a different folder for either project scope
- **THEN** that scope re-resolves against the chosen folder
- **AND** the other project scope's resolved path is unchanged

#### Scenario: The resolution rule is disclosed

- **WHEN** either project scope is selected
- **THEN** the page states which rule produced the path and that the rule matches current Claude Code versions
- **AND** offers the folder picker as the way to correct it

#### Scenario: No session directory can be determined

- **GIVEN** no pane is open and no folder has been chosen
- **WHEN** the user selects the Project or Project local scope
- **THEN** the page states that a folder must be chosen and offers the folder picker instead of an editor

### Requirement: Files the page may access

The page SHALL access only the following exact files, resolved by the rules above, and SHALL refuse any request naming a path outside this allowlist:

| Scope | Kind | File |
| --- | --- | --- |
| User | settings | `<claudeConfigDir>/settings.json` |
| User | memory | `<claudeConfigDir>/CLAUDE.md` |
| Project | settings | `<sessionDir>/.claude/settings.json` |
| Project | memory | `<sessionDir>/CLAUDE.md` |
| Project local | settings | `<localSettingsRoot>/.claude/settings.local.json` |

The project memory file is at the project folder's root, not inside its `.claude` directory. There is no project-local memory file.

The page SHALL NOT read or write managed settings, the global config file `~/.claude.json`, or any file not named in this table.

#### Scenario: The project CLAUDE.md is writable

- **WHEN** the user edits the Project scope's CLAUDE.md and saves
- **THEN** `<sessionDir>/CLAUDE.md` is written, even though it is outside `<sessionDir>/.claude`

#### Scenario: A path outside the allowlist is refused

- **WHEN** a write request names a file that is not one of the five allowlisted files for its scope and kind
- **THEN** the write is refused and nothing is written

#### Scenario: Managed settings are not offered

- **WHEN** the user browses the scope picker
- **THEN** no managed-settings scope is offered
- **AND** the page explains that organization-managed settings override these files and are not editable here

### Requirement: Missing configuration files

A configuration file that does not exist SHALL be presented as an empty but usable document rather than as an error, and SHALL be created only when the user saves.

A missing settings file SHALL be initialized in memory as the text `{}`, so the Form view has a parseable document to render.
A missing memory file SHALL be initialized in memory as empty text.
In both cases the document SHALL be marked as not existing on disk.

#### Scenario: The form renders for a settings file that does not exist

- **GIVEN** the resolved settings path has no file on disk
- **WHEN** the scope is selected
- **THEN** the document holds `{}`, the Form view renders with every control unset, and the page labels the file "not created yet"

#### Scenario: An empty settings file is treated the same way

- **GIVEN** the resolved settings file exists but is empty or contains only whitespace
- **WHEN** the scope is selected
- **THEN** the document is treated as `{}` and the Form view renders rather than reporting a parse error

#### Scenario: Saving creates the file and its directory

- **GIVEN** the resolved path has no file on disk and its `.claude` directory does not exist
- **WHEN** the user saves
- **THEN** the directory and the file are created
- **AND** the page reports the file as saved and no longer labels it "not created yet"

### Requirement: Form view for common settings

Each settings scope SHALL offer a Form view with typed controls for the commonly edited settings keys, and every control SHALL show the value currently in that scope's file.

The Form view SHALL cover at least: `model`, `outputStyle`, `effortLevel`, `permissions.defaultMode`, `permissions.allow`, `permissions.ask`, `permissions.deny`, `permissions.additionalDirectories`, `env`, `alwaysThinkingEnabled`, `autoCompactEnabled`, `includeCoAuthoredBy`, `cleanupPeriodDays`, `statusLine` and `enabledPlugins`.

#### Scenario: Toggling a boolean setting

- **GIVEN** the scope's file sets `"alwaysThinkingEnabled": true`
- **WHEN** the user turns that control off and saves
- **THEN** the file on disk contains `"alwaysThinkingEnabled": false`

#### Scenario: Adding a permission rule

- **WHEN** the user adds `Bash(npm test:*)` to the allow list and saves
- **THEN** the file's `permissions.allow` array contains `Bash(npm test:*)`
- **AND** the entries that were already in the array are unchanged and keep their order

#### Scenario: Clearing a setting removes the key

- **GIVEN** the scope's file sets `"model": "claude-opus-5"`
- **WHEN** the user sets the model control back to its unset or default choice and saves
- **THEN** the `model` key is absent from the file rather than present with an empty or null value

#### Scenario: A key the form does not cover is preserved

- **GIVEN** the scope's file contains keys the Form view has no control for
- **WHEN** the user changes one control in the Form view and saves
- **THEN** every key the form does not cover parses to a value deeply equal to its previous value
- **AND** the relative order of those keys is unchanged

#### Scenario: A value a scope cannot set is flagged

- **GIVEN** the Project or Project local scope is selected
- **WHEN** the user picks `auto` or `bypassPermissions` for `permissions.defaultMode`
- **THEN** the page warns that Claude Code ignores those two values from project and local settings and names the user scope as where to set them
- **AND** still allows the value to be saved

### Requirement: Raw JSON view

Each settings scope SHALL offer a Raw JSON view that edits the whole file as text, with JSON syntax highlighting, completion of setting key names and their enumerated values, and inline diagnostics.

#### Scenario: Syntax error is reported inline

- **WHEN** the raw text is not valid JSON
- **THEN** the editor marks the offending position with a diagnostic describing the parse error
- **AND** saving is blocked while the text does not parse

#### Scenario: Unknown or mistyped key is reported but not blocked

- **GIVEN** the raw text is valid JSON containing a key that is not in the Claude Code settings schema, or a value of the wrong type for a known key
- **THEN** the editor shows a warning diagnostic naming the key
- **AND** saving is still allowed, so a setting newer than the bundled schema can be written

#### Scenario: Completing a key name

- **WHEN** the user begins typing a key name at the top level of the JSON object
- **THEN** matching Claude Code setting names are offered, each with its documented description

#### Scenario: Completing an enumerated value

- **WHEN** the caret is in the value position of a key whose schema declares a fixed set of values, such as `permissions.defaultMode`
- **THEN** the allowed values for that key are offered

### Requirement: Form and raw views share one document

The Form and Raw JSON views of a scope SHALL edit a single in-memory document, so switching between them neither loses nor duplicates an edit.

#### Scenario: Form edit is visible in raw text

- **WHEN** the user changes a control in the Form view and switches to Raw JSON without saving
- **THEN** the raw text shows the changed value

#### Scenario: Raw edit is visible in the form

- **GIVEN** the raw text is valid JSON
- **WHEN** the user edits a form-covered key in Raw JSON and switches to the Form view without saving
- **THEN** the corresponding control shows the new value

#### Scenario: Switching away from unparseable raw text

- **GIVEN** the raw text does not parse as JSON
- **WHEN** the user switches to the Form view
- **THEN** the page keeps the raw text intact, states that the form cannot be shown until the JSON parses, and does not discard the edit

### Requirement: Drafts survive navigation

Unsaved edits and the user's resolved-path choices SHALL survive leaving and returning to the Claude Config page, including a round trip through the Copilot page that the hooks panel links to.

#### Scenario: A draft survives a trip to the Copilot page

- **GIVEN** the user has unsaved edits in the User scope
- **WHEN** the user follows the hooks panel's link to the Copilot page and then returns to Claude Config
- **THEN** the User scope is selected again with the unsaved edits intact and still marked unsaved

#### Scenario: Chosen paths survive navigation

- **GIVEN** the user has overridden the session directory with the folder picker
- **WHEN** the user navigates to another settings page and back
- **THEN** the chosen directory is still in effect

#### Scenario: Drafts are per scope

- **GIVEN** the user has unsaved edits in the Project scope
- **WHEN** the user switches to the User scope and back
- **THEN** the Project scope's unsaved edits are intact
- **AND** the User scope showed its own content, not the Project scope's draft

### Requirement: CLAUDE.md editing

The page SHALL offer a CLAUDE.md view for the user scope and for the project scope, editing `CLAUDE.md` in the resolved Claude config directory and `CLAUDE.md` at the root of the selected session directory respectively.

#### Scenario: Editing the user CLAUDE.md

- **WHEN** the user selects the User scope's CLAUDE.md view, changes the text and saves
- **THEN** `CLAUDE.md` in the resolved Claude config directory contains the new text

#### Scenario: Project local scope offers no CLAUDE.md view

- **WHEN** the Project local scope is selected
- **THEN** no CLAUDE.md view is offered for it, because Claude Code defines no local-scope CLAUDE.md

### Requirement: Merge-aware precedence reporting

The page SHALL report how a key set in more than one visible scope resolves, using the rule that applies to that key rather than assuming every key is overridden by the narrowest scope.

For scalar keys the page SHALL name the narrowest scope that sets the key as the winner, in the order local, then project, then user.
For list keys, which Claude Code combines across files instead of replacing, the page SHALL report that the lists are combined and name every scope contributing entries. This includes `permissions.allow`, `permissions.ask`, `permissions.deny` and `permissions.additionalDirectories`.
For `fallbackModel`, `modelPicker`, `availableModels` and `modelSettings`, whose resolution does not follow either rule, the page SHALL show no winner and SHALL link to the setting's documentation instead of guessing.

Every precedence statement SHALL be labelled as a comparison of these three files only, and SHALL note that managed settings, `--settings`, command-line flags and environment variables can change the effective value without appearing here.

#### Scenario: A scalar key is overridden by a narrower scope

- **GIVEN** `model` is set in the user file and also in the project local file
- **WHEN** the user views the `model` control in the User scope
- **THEN** the page indicates that the project local file overrides this value and names that file

#### Scenario: A list key is reported as combined, not overridden

- **GIVEN** `permissions.allow` has entries in the user file and different entries in the project local file
- **WHEN** the user views the allow list in the User scope
- **THEN** the page states that the lists are combined and that both files' entries apply
- **AND** does not state that either file overrides the other

#### Scenario: A deny rule anywhere is reported as winning

- **GIVEN** `permissions.allow` in the user file matches a call that `permissions.deny` in the project file also matches
- **WHEN** the user views either list
- **THEN** the page states that a deny rule in any scope blocks a matching allow rule in any scope

#### Scenario: A key with its own resolution rule shows no winner

- **WHEN** the user views `fallbackModel` or `modelSettings` in a scope that sets it
- **THEN** the page shows no override or combined notice for that key and links to its documentation

#### Scenario: The scope of the comparison is disclosed

- **WHEN** any precedence notice is shown
- **THEN** it is labelled as comparing only the three files on this page
- **AND** notes that managed settings, session flags and environment variables are not accounted for

#### Scenario: A key is set in only one scope

- **GIVEN** `model` is set only in the user file
- **WHEN** the user views the `model` control in the User scope
- **THEN** no override notice is shown for that key

### Requirement: Conflict detection against the loaded revision

Saving SHALL compare the file on disk against the revision the document was loaded from, and SHALL refuse the write when they differ. The loaded revision SHALL capture whether the file existed, and its modification time and byte size when it did, so that creation, deletion and same-or-older-timestamp replacement are all detected rather than only a strictly newer timestamp.

#### Scenario: A newer modification is detected

- **GIVEN** the file was loaded into the page
- **AND** another program has since modified it, leaving a newer modification time
- **WHEN** the user saves
- **THEN** the write is refused and the page reports the external change

#### Scenario: A replacement with an unchanged or older timestamp is detected

- **GIVEN** the file was loaded into the page
- **AND** another program has since replaced it with different content whose modification time is not newer, for example by restoring a backup
- **WHEN** the user saves
- **THEN** the write is refused and the page reports the external change

#### Scenario: Deletion after load is detected

- **GIVEN** the file existed when it was loaded
- **AND** it has since been deleted
- **WHEN** the user saves
- **THEN** the write is refused and the page reports that the file no longer exists, offering to create it

#### Scenario: Creation after load is detected

- **GIVEN** the file did not exist when the scope was loaded
- **AND** another program has since created it
- **WHEN** the user saves
- **THEN** the write is refused and the page reports the new file, offering to show it before overwriting

#### Scenario: Reload adopts the file on disk

- **GIVEN** a save was refused because the file changed externally
- **WHEN** the user chooses to reload
- **THEN** the editor shows the file's current content, the document is marked saved, and the loaded revision matches disk

#### Scenario: A failed write leaves the file intact

- **WHEN** a save fails partway
- **THEN** the file on disk is either its previous content or the complete new content, never a truncated or partial file

#### Scenario: An unwritable location is reported

- **GIVEN** the resolved path cannot be written, for example because its parent directory was removed or is read-only
- **WHEN** the user saves
- **THEN** the page reports the failure with the path and the reason, and keeps the user's edits in the editor

### Requirement: Hooks are never written by this page

Fleet's copilot hook installer owns the `hooks` key of these settings files. The page SHALL display that key read-only and SHALL never write a `hooks` value that differs from the one on disk at the moment of the write, whichever view the user edited in.

At save time the page SHALL take the `hooks` value from a fresh read of the file on disk and substitute it into the document being written, discarding any `hooks` value the in-memory document carries. When the file on disk has no `hooks` key, the written document SHALL have none either. This substitution SHALL apply to saves from the Raw JSON view and to an Overwrite chosen after a conflict, not only to Form-view saves.

Preservation is by parsed value, not by byte sequence: the page reformats the document it writes, so the requirement is that the written `hooks` value parses deeply equal to the one on disk.

#### Scenario: Hooks survive a Form-view save

- **GIVEN** the file contains a `hooks` block installed by Fleet's copilot hook installer
- **WHEN** the user changes an unrelated setting in the Form view and saves
- **THEN** the `hooks` value in the saved file parses deeply equal to the value that was on disk before the save

#### Scenario: An edit to hooks in the Raw view is discarded at save

- **GIVEN** the file on disk contains a `hooks` block
- **WHEN** the user edits or deletes the `hooks` key in the Raw JSON view and saves
- **THEN** the saved file's `hooks` value parses deeply equal to the value on disk, not to what the user typed
- **AND** the page tells the user that the hooks edit was not applied and directs them to the Copilot page

#### Scenario: Overwrite after hook installation does not restore stale hooks

- **GIVEN** the page loaded a file before Fleet's hook installer wrote a new `hooks` block to it
- **WHEN** the user saves, is told the file changed externally, and chooses Overwrite
- **THEN** the written file carries the `hooks` block the installer wrote, not the block the page had loaded
- **AND** every other key is the user's edited value

#### Scenario: Hooks absent on disk stay absent

- **GIVEN** the file on disk has no `hooks` key
- **WHEN** the user saves from either view
- **THEN** the saved file has no `hooks` key

#### Scenario: Hooks are presented read-only

- **WHEN** the user views a scope whose file contains a `hooks` block
- **THEN** the page summarises the configured hook events without offering controls to edit them
- **AND** offers a link to the Copilot page

### Requirement: Reloading after an external write

The page SHALL re-read the current scope's file from disk when it regains focus after Fleet itself may have written it, so a change made by Fleet's hook installer is not presented as stale content.

#### Scenario: Hook installation is picked up

- **GIVEN** the Claude Config page has the user scope loaded
- **WHEN** the user installs copilot hooks from the Copilot page and returns to the Claude Config page
- **AND** the loaded document has no unsaved edits
- **THEN** the page shows the file including the newly written `hooks` block

#### Scenario: A dirty document is not silently replaced

- **GIVEN** the loaded document has unsaved edits
- **AND** the file changed on disk while the page was away
- **WHEN** the page regains focus
- **THEN** the edits are kept and the page shows that the file changed on disk, offering to reload
