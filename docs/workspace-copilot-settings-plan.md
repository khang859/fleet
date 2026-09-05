# Workspace and Copilot settings implementation plan

Status: Proposed implementation, based on the agreed settings direction.

## Outcome

Make it clear that Workspaces chooses the Claude Code configuration used by new terminals, while Copilot uses Fleet hooks in those configuration folders to receive session updates. Keep custom folders per workspace prominent and fully supported. Allow users to create a workspace from Settings without leaving their active workspace.

Success means a user can identify the folder assigned to any workspace, understand whether it inherits the default, configure Copilot monitoring for that folder, and add a workspace without interrupting current work.

## Product decisions

| Area                         | Behavior                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Default Claude config folder | Move from Copilot to Workspaces, above the workspace list.                                                                       |
| Workspace overrides          | Keep them first-class. Offer “Use default” and “Use custom folder,” with the resolved configured path visible in collapsed rows. |
| Fleet hooks                  | Place setup beside the folder it affects; explain that hooks enable Copilot session updates.                                     |
| Shared folders               | Share hook status and installation. State when an action affects multiple workspaces.                                            |
| Copilot settings             | Keep the overlay toggle, notification sound, and session scope. Add a connection summary linking to workspace configuration.     |
| Add workspace                | Place the action beside the workspace list heading, below the shared default-folder setting.                                     |
| Creation defaults            | Require a name; inherit the default folder; offer a custom folder as an optional choice.                                         |
| Creation from Settings       | Save the workspace, refresh the lists, expand its settings, and keep the current workspace and Settings tab active.              |
| Creation from the sidebar    | Reuse the creation form and persistence logic, then preserve the current switch-to-new-workspace behavior.                       |
| Copilot setup                | Optional after creation. Missing hooks do not make a workspace invalid.                                                          |
| Applying folder changes      | New terminals use the new assignment. Existing terminals retain their environment.                                               |

## Current implementation and constraints

- `src/renderer/src/components/settings/WorkspacesSection.tsx` lists saved workspaces, edits custom folders, and exposes hook actions only for explicit overrides. Its list loads once on mount.
- `src/renderer/src/components/settings/CopilotSection.tsx` owns the default folder input and global hook controls alongside overlay settings. Its hook status is loaded on mount and is not tied to subsequent folder edits.
- `src/renderer/src/components/settings/SettingsTab.tsx` owns section navigation locally. It needs a small navigation callback carrying the target workspace ID for the Copilot link.
- `src/renderer/src/components/Sidebar.tsx` creates a workspace inside `commitNewWorkspace`. It flushes the current workspace, switches to an empty new workspace, and adds a terminal afterward. Persistence of the new workspace currently relies on autosave; this cannot be reused unchanged by Settings.
- `src/main/ipc-handlers.ts` resolves Fleet's terminal configuration in this order: workspace override, Fleet default, then no Fleet-injected override. The latter normally leaves Claude using `~/.claude`; inherited shell environment and Env Sync can affect the terminal's actual environment. Settings must describe the configured assignment, not claim to inspect every running terminal.
- The same main-process file logs and swallows layout-save failures. Creation needs an observable save result before it reports success.
- `src/main/copilot/ipc-handlers.ts` already exposes hook status/install/remove operations for a specified config folder, plus default-folder operations.
- `src/main/settings-store.ts` merges `copilot` at one level. A `workspaceOverrides` patch replaces that entire map; it does not merge workspace entries independently.
- `src/renderer/src/hooks/use-config-restart-toast.ts` currently offers to restart the active workspace's terminals regardless of which workspace was edited. Do not reuse that action unchanged for edits to an inactive workspace.

## Implementation steps

### 1. Establish shared configuration operations

Keep persisted `copilot.claudeConfigDir` and `copilot.workspaceOverrides` keys for this iteration. UI ownership can change without moving stored data or breaking existing configurations. Keep the current terminal precedence and workspace-deletion cleanup.

Add a small shared resolver for the configured folder and its source, used by Workspaces and Copilot summaries. Represent the source explicitly as default or custom; resolve the empty Fleet default to the existing default-folder convention. Do not confuse a Claude user config folder with a repository's project-local `.claude` folder.

Use minimal section patches for scalar updates, such as `{ copilot: { claudeConfigDir: value } }`. Avoid spreading a stale full Copilot settings object. Provide one narrow workspace-override mutation operation that reads the latest map in the main process, sets or removes one entry, and preserves unrelated entries. Keep existing whole-map settings semantics intact for compatibility.

Use local drafts for folder text and commit deliberate edits on blur or Enter. Browsing commits the selected folder. Switching to “Use default” removes the saved override; custom mode with an empty draft does not persist an ambiguous override. Do not show restart notices or run filesystem checks on every keystroke.

Verification: existing saved settings round-trip unchanged; default/custom resolution is consistent; removing one override preserves others; independent Copilot settings changes are not overwritten.

### 2. Reorganize Workspaces settings

Arrange the page in this order:

1. Intro: “Choose the Claude Code config folder used by new terminals in each workspace.”
2. “Default Claude config folder,” with path input, Browse, default fallback explanation, and Fleet hook status/actions.
3. “Workspace config folders,” with an “Add workspace” action.
4. Workspace rows showing name, Active where applicable, Default or Custom, and the configured path.
5. Expanded workspace controls with the explicit default/custom choice, custom-folder input and Browse, and hook setup for the resolved folder.

Keep the custom-folder feature visible even with Copilot disabled. Show the resolved default path for inheriting workspaces instead of an empty input that requires users to infer its value. Preserve access to custom paths on supported platforms independently of the macOS-only overlay page.

Use a neutral, persistent note: “Folder changes apply to new terminals. Existing terminals keep their current configuration.” For this iteration, use an informational toast without a restart action when a folder changes; avoid restarting an unrelated workspace or expanding this task into terminal lifecycle work.

Verification: a user can identify all workspace folder assignments without expanding rows; selecting default/custom changes only the intended assignment; inherited rows update when the default changes; narrow layouts and long paths remain usable.

### 3. Make hook setup folder-specific and reliable

Use one reusable folder hook-status control for the default folder and expanded workspace rows. Key status by resolved folder, not by workspace ID. Recheck on folder changes and after install/remove; invalidate all visible consumers of the same folder.

Represent checking, installed, not installed, and check failure separately. An unresolved request or failed check must not appear as “Not installed.” Ignore stale responses after the selected folder changes. Disable duplicate actions while an operation is pending and recheck installation after completion rather than setting success optimistically.

Suggested copy:

- Label: “Fleet hooks.”
- Explanation: “Fleet hooks let Copilot receive session status and permission requests from this folder.”
- Actions: “Install Fleet hooks” and “Remove Fleet hooks.”
- Shared scope: “This folder is used by Personal and Work. Hook changes apply to both.”

Keep folder paths visible near actions. Missing hooks should read as optional Copilot setup, not a broken workspace. “Hooks installed” indicates installation status; reserve “Connected” for a verified live connection. Preserve the existing Claude-detection guidance in the connection/setup area.

Reuse existing platform capability checks. Keep configuration editing cross-platform; do not introduce an unsupported Copilot overlay or advertise hook setup where the required runtime is unavailable. Do not auto-install hooks as part of choosing a folder or creating a workspace.

Verification: two workspaces sharing a folder show consistent status; changing one to another folder separates their status; failed/slow checks and installation failures are visible and do not display false success.

### 4. Simplify Copilot and link to workspace setup

Remove the editable default-folder input and separate global hook editor from Copilot. Keep:

- “Show Copilot” with the overlay description.
- “Notification sound.”
- “Sessions to show,” offering “All workspaces” and “Active workspace only.” Map these to the existing `showAllWorkspaces` boolean.

Add “Claude Code connection” with this explanation: “Copilot receives updates through Fleet hooks in each workspace’s Claude config folder.” Show the relevant workspace names, assigned folders, source labels, and hook installation status. With all-workspace scope selected, include all configured workspaces; otherwise show the active workspace. Reuse folder-level status checks for shared paths.

Each workspace entry links to “Manage workspace connection,” opening Workspaces with that row expanded and focused. Pass the workspace ID through Settings navigation state; this must not activate that workspace. If it was deleted, show the current list instead of retaining a stale target.

Verification: scope changes update the summary; each link opens the correct row; navigation leaves the active workspace untouched; changing a folder and returning to Copilot shows fresh status.

### 5. Share workspace creation across both entry points

Extract a small shared creation form and a persistence operation from the sidebar flow. Use the existing dialog primitives and styling. The form contains:

- Workspace name, trimmed and required.
- Claude config source, initially “Use default,” with the current default path shown.
- Optional custom folder input and Browse when “Use custom folder” is selected.
- Explicit “Create workspace” and “Cancel” actions; do not create on blur.

Prevent duplicate submission. Cancel or a blank name must not create a workspace or write an override. Preserve current name-uniqueness behavior instead of inventing a new restriction.

Separate persistence from activation:

1. Generate the workspace ID once per submission and persist a workspace using the existing layout model.
2. Save the optional custom-folder override before any new terminal can spawn.
3. Report success only after required writes succeed; propagate persistence failures to the form. Keep the same workspace ID on retries so a partial failure cannot create duplicates. Handle a saved layout plus failed override explicitly, preserving the draft and identifying the incomplete configuration.
4. Notify a shared workspace-list refresh mechanism used by Settings and the sidebar. Reuse an existing subscription if available; otherwise introduce a small shared list hook/store with explicit invalidation for create, rename, and delete, rather than polling.
5. From Settings, expand the saved row and keep the current workspace active. Do not spawn a PTY for the inactive workspace.
6. From the sidebar, flush the outgoing workspace using existing live-CWD handling, activate the saved workspace, and preserve existing default tool/terminal initialization.

Verify the first activation of a workspace created from Settings. It must receive the normal tools and initial terminal exactly once, with its saved config assignment already available. Adapt the existing activation/initialization path where needed rather than duplicating pane construction in the settings form.

Verification: creation from Settings persists across relaunch without changing the active workspace, tab, or terminals; the sidebar reflects it immediately; creation from the sidebar still switches; cancellation and repeated submission are safe; failed writes are reported; a custom folder is available before the first terminal starts.

## Expected code areas

| Area                                | Files                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Settings layout and navigation      | `src/renderer/src/components/settings/WorkspacesSection.tsx`, `CopilotSection.tsx`, `SettingsTab.tsx`             |
| Workspace creation and list refresh | `src/renderer/src/components/Sidebar.tsx`, shared creation form/helper, shared list hook/store                    |
| Activation and initialization       | `src/renderer/src/store/workspace-store.ts`; inspect `src/renderer/src/App.tsx` autosave/restore interactions     |
| Config updates and status           | Small renderer resolver/hook control, `src/renderer/src/store/settings-store.ts`                                  |
| Persistence and IPC                 | `src/main/ipc-handlers.ts`, `src/main/settings-store.ts`, relevant shared types/channels and preload declarations |
| Hook queries                        | `src/main/copilot/ipc-handlers.ts`, `src/preload/copilot.ts` only as required by shared controls                  |
| Regression coverage                 | Existing settings/workspace test suites and focused tests alongside new shared operations                         |

Keep changes limited to these flows. No new configuration-profile library, workspace deletion UI, workspace reordering, automatic hook installation, storage migration, or Copilot platform expansion is required.

## Validation and completion

Add focused behavioral tests for config inheritance and override removal, preservation of concurrent independent settings edits, shared-folder hook status and stale results, workspace creation without activation, duplicate submission, persistence failure, and first activation using the selected config. Exercise existing workspace identity/default-tool tests when adjusting activation.

Manually verify these scenarios in Fleet:

- Existing user settings load with the same default and custom assignments.
- Copilot disabled: custom folders and workspace creation remain available.
- Two workspaces share a folder: hook changes update both summaries.
- Default folder changes: inherited rows update, custom rows retain their paths.
- Edit an inactive workspace: no current terminals restart.
- Create from Settings, close/reopen the app, then activate the new workspace.
- Create from the sidebar: outgoing work and live working directories are preserved.
- A custom-folder workspace starts its first terminal with the intended Fleet config assignment.
- New vs. existing terminals behave as described after a folder change.
- All-workspace and active-only Copilot summaries link to the correct settings rows.
- Keyboard submission/cancellation, loading and error states, long paths, and narrow windows work.
- Non-macOS settings retain workspace configuration and creation without exposing the macOS overlay.

Run focused tests for the affected behavior, then `npm run typecheck`, `npm run lint`, and `npm run build`. Follow the repository's Node/Electron native-module rebuild guidance when switching between tests and a running app. Record unexpected bugs and their fixes in `docs/learnings/`.

Completion requires the UI and persisted behavior to agree: Workspaces owns folder choices, Copilot makes its dependency clear, custom folders remain easy to use, and creating a workspace from Settings does not interrupt current work.
