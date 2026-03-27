# Changelog

## v2.13.0

- Added cargo send system: `fleet cargo send` CLI command with env auto-detection, socket dispatch, and explicit file/content support
- Added cargo evaluation sweep with First Officer recovery and safety net
- Added `awaiting-cargo-check` status with all completion points transitioned to use it
- Added cargo raw output streaming to disk via WriteStream
- Added migration 017 for `cargo_checked` column on missions
- Updated all crew prompts and workspace templates with cargo send instructions
- Fixed Cmd+F search box overlap with toolbar (#164)
- Fixed Shift+Click to open links in default browser (#165)
- Fixed `fleet images edit` command for local file paths (#163)
- Fixed test mocks to prevent real API calls

## v2.12.1

- Fixed TUI redraw after hard refresh via SIGWINCH resize trick
- Fixed lint errors and included awaiting-guidance status in listCrew
- Fixed logger mock in pty-manager tests to resolve fake timer conflicts

## v2.12.0

- Added Winston logger system with structured logging, IPC bridge, and daily log rotation
- Added First Officer consultant mode for mid-flight crew guidance
- Added Sentinel guidance sweep to dispatch consultant for stuck crews
- Added file-based prompt composition with mission-type templates and shared modules
- Fixed overlay paste by blurring xterm before focusing overlay input
- Fixed overlay admiral PTY paneId when on Star Command tab
- Fixed sidebar drag-and-drop using wrong indices and double-firing

## v2.11.0

- Converted settings modal to full tab page (#160)
- Added per-action model configuration for image actions (CLI flags + Settings UI)
- Fixed model name display in action settings

## v2.10.0

- Added extensible image actions system for generated images (#159)
- Made sidebar consistent across all tab types (#158)
- Fixed socket single instance lock to prevent multi-instance socket conflicts
- Added generated images to File overlay with scoped tabs

## v2.9.0

- Added fal.ai image generation integration via `fleet images` CLI commands (generate, edit, status, list, retry, config)
- Added pinned Images tab with thumbnail grid gallery, detail view with full metadata, and per-provider settings
- Added styled ImagesTabCard in sidebar with last-generated thumbnail and in-progress badge
- Added Images icon to collapsed sidebar strip
- Added provider abstraction (ImageProvider interface) for future extensibility beyond fal.ai
- Added prompt engineering guide to Fleet CLI skill template
- Changed Admiral reset to regenerate config files (CLAUDE.md, SKILL.md, settings) instead of deleting entire workspace
- Non-blocking image generation: CLI returns immediately, background polling handles download

## v2.8.0

- Added per-mission-type model configuration (crew*model*\* config keys via migration 016)
- Added model config fields to Starbase Settings UI with select dropdowns
- Added analyst_model to CONFIG_DEFAULTS
- Removed stale admiral_model and anthropic_api_key config fields from UI
- Fixed terminal unmount on pane split/close and hidden resize bug

## v2.7.7

- Removed unused elapsed variable from active visualizer loop
- Removed star command crews and sector rendering from fleet visualizer

## v2.7.6

- Added Clipboard History Overlay (Cmd+Shift+H) for quick access to recent clipboard items
- Added toolbar icon for clipboard history (when relevant)
- Fixed terminal focus restoration after pasting from clipboard overlay
- Fixed clipboard polling pause when unfocused for improved battery performance

## v2.7.5

- Fixed missing Cmd+Shift+O keyboard handler for file search overlay

## v2.7.4

- Fixed Station Dormant overlay not appearing after exiting Claude CLI (duplicate ptyManager.onExit call overwrote the admiral exit handler)

## v2.7.3

- Fixed Admiral terminal falling back to bare shell when Claude CLI exits; now shows Station Dormant overlay

## v2.7.2

- Fixed CI release pipeline merging arm64 entry into latest-mac.yml before publishing

## v2.7.1

- Fixed navigator stdio streams not destroyed in error handler, preventing CI hangs
- Fixed repair missions not included in review and fix crew dispatch
- Fixed repair crew SIGTERM incorrectly treated as error despite committed work

## v2.7.0

- Added File Search Overlay for fast file discovery with recent images, sort options (date, name, size), and persistent folder selection
- Added role activity logging through ShipsLog class for improved observability and debugging
- Added keyboard shortcut and command palette entry for file search
- Fixed bracketed paste mode for file path insertion into terminals

## v2.6.7

- Fixed duplicate PTY onExit listener stacking on HMR reloads
- Fixed silent onData callback overwrite on duplicate registration
- Fixed URL scheme validation for shell.openExternal (security)
- Fixed PTY data disposal on exit and flush timer cleanup
- Replaced O(N) PTY data broadcast with O(1) Map-based routing (performance)
- Replaced broad Zustand store subscriptions with granular selectors (performance)
- Removed unnecessary fit() call on click and memoized workspaceToAgents (performance)

## v2.6.6

- Fixed Apple Silicon users receiving the x64 build via auto-update (arm64 and x64 DMGs now published as separate files)
- Fixed node/claude not found on startup check screen due to shell PATH not being enriched in time

## v2.6.5

- Fixed active tab and pane not being restored after app restart
- Fixed split pane inheriting tab's original CWD instead of live CWD
- Fixed workspace switch losing live CWDs
- Fixed undo-close restoring terminal at stale working directory

## v2.6.4

- Fixed double cursor appearing after switching macOS workspaces and returning to a TUI terminal (e.g. Claude Code)

## v2.6.3

- Fixed CI by merging mac jobs into universal build
- Fixed forceDevUpdateConfig guard in main process

## v2.6.2

- Fixed opening external links in system browser
- Fixed missing --original-mission-id warning on repair missions
- Fixed analyst timeout (increased to 30s, configurable, with retry)
- Fixed Linux snap build failure by removing deb target

## v2.6.1

- Added file browser drawer (Cmd+Shift+E)
- Added Analyst service for LLM-powered error classification and PR verdict extraction
- Added Sentinel status wired into the Admiral sidebar
- Combined Admiral role tiles into a single unified command square
- Fixed worktree branch name shown in PR diff stat
- Fixed Sentinel crash from lazy-loading Notification in runtime child process
- Fixed auto-commit failure detection in repair crew cleanup
- Fixed terminal scrollback history no longer serialized on workspace save
- Moved shortcuts `?` button to top bar with OS-aware placement

## v2.6.0

- Fixed issue where restored tabs showed full terminal history on app relaunch
- Release notes in the Updates tab now display as plain text

## v2.5.0

- Initial release notes support
