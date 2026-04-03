# Changelog

## v2.26.0

- 


## v2.25.2

- **Annotate**: Fix copy path to copy full absolute path so AI agents can find annotation files
- **Annotate**: Fix toolbar annotate button not working when Annotate sidebar tab isn't active

## v2.25.1

- **Annotate**: Make Annotate tab a special non-closable sidebar card with teal accent (matching Images tab treatment)
- **Docs**: Add `fleet annotate` to injected skill documentation

## v2.25.0

### Features

- **Annotate**: Webpage annotation with element picker and UI

### Bug Fixes

- **Tabs**: Make Cmd+1-9 target normal tabs, skip Images and Settings

## v2.24.0

### Features

- **Copilot**: Workspace-scoped sessions — sessions are tagged with the workspace they originated from
- **Copilot**: Workspace filter toggle and labels in session list to view sessions per workspace or all workspaces
- **Copilot**: Active workspace label in session detail header
- **Copilot**: Per-workspace Claude config overrides and custom config directory support
- **Copilot**: Config change UX with toast notifications, inline warnings, and terminal restart prompts
- **Copilot**: Per-workspace hooks UI

### Bug Fixes

- **Copilot**: Survive SIGINT so Stop hook event reaches Fleet
- **Copilot**: Re-apply hooks fix for per-workspace hooks

## v2.23.2

### Bug Fixes

- **Images**: Show pinned Images tab on fresh install — new users were missing the tab because the fresh-install startup path bypassed ensureImagesTab

## v2.23.1

### Bug Fixes

- **Images**: Increase fal.ai poll timeout from 5 to 15 minutes to handle longer queue wait times
- **Images**: Fix endpoint mismatch in fal.ai provider where poll/result/cancel used hardcoded model instead of submitted endpoint

## v2.23.0

### Features

- **Landing**: Add GitHub Pages landing page with auto-resolved download links to latest arm64 dmg

### Improvements

- **Landing**: Convert all images to webp for faster load times
- **Copilot**: Simplify system checks to fleet.sock only, auto-enable copilot on macOS

### Bug Fixes

- **Landing**: Add .nojekyll to bypass Jekyll processing

## v2.22.0

### Features

- **Copilot**: Show permission details inline in session list
- **Copilot**: Add formatPermissionSummary utility
- **Copilot**: Add bioluminescent clockwork owl mascot

### Bug Fixes

- **CI**: Regenerate latest-mac.yml from actual artifacts to prevent sha512 mismatch
- **Images**: Recent images now appear immediately by bypassing Spotlight indexing delay

## v2.21.1

### Bug Fixes

- **Copilot**: Prune stale sessions when Fleet tabs are closed

## v2.21.0

### Features

- **Copilot**: Add armored cybernetic dragon mascot with gold/black theme
- **Copilot**: Flexible animation system — mascots can now define custom frame counts and per-state animations
- **Copilot**: Animation preview in mascot picker with idle/processing/permission/complete state buttons
- **Copilot**: Hover-to-preview in mascot grid (Baymard UX research-informed)

### Improvements

- **Copilot**: Assembly script now supports variable frame counts (not just 9)

## v2.20.0

### Features

- **Copilot**: Replace side panel with centered rich pane overlay
- **Copilot**: Sci-fi CSS frame with glowing teal border, corner accents, and scanline overlay
- **Copilot**: Teleport animation when mascot transitions between floating and pane header

### Fixes

- **Copilot**: Fix mascot becoming unclickable after closing panel (setIgnoreMouseEvents bug)
- **Copilot**: Fix teleport animation not playing (renderer now drives animation timing before window resize)
- **Copilot**: Remove invisible hit area spanning full pane width around mascot

### Improvements

- **Copilot**: Increase font sizes across all copilot UI components for better readability
- **Copilot**: Enlarge header mascot to 96px, centered above pane
- **Copilot**: Remove "Fleet Copilot" label from pane header

## v2.19.3

### Fixes

- **Build**: Fix CI releases missing extraResources (mascots, hooks) — `--config` was replacing electron-builder.yml instead of merging with it

## v2.19.2

### Fixes

- **Mascots**: Fix fleet-asset:// sprites not rendering in packaged builds by using direct readFile instead of net.fetch file:// proxy

## v2.19.1

### Fixes

- **Mascots**: Fix fleet-asset:// protocol not loading sprites in packaged builds by adding full scheme privileges (standard, secure, corsEnabled)

## v2.19.0

### Features

- **Copilot**: Add robot and kraken mascot sprite sheets
- **Copilot**: Extract mascot selection into dedicated view with improved navigation
- **UI**: Replace emoji icons with Lucide React icons in copilot views

### Fixes

- **Toolbar**: Refocus terminal after inject fleet skills button click
- **Copilot**: Fix mascot grid responsiveness and CSS layout
- **Copilot**: Remove debounce from toggle expanded to improve responsiveness

### Refactors

- **Mascots**: Replace base64 embedded sprites with static WebP files via fleet-asset:// protocol

## v2.18.0

### Features

- **Copilot**: Add mascot selection to settings with multiple selectable mascots
- **Copilot**: Add armored polar bear mascot option
- **Copilot**: Add mascot sprite assembly script for building sprite sheets from source frames

## v2.17.0

### Features

- **Dev mode**: Allow dev and production Fleet instances to run simultaneously via `FLEET_DEV` env var, using separate socket paths and skipping single-instance lock

### Fixes

- **Images**: Enable scrolling in image gallery grid
- **Copilot**: Move copilot socket from `/tmp` to `~/.fleet/` for consistency with main socket

## v2.16.1

### Fixes

- **Copilot**: Replace boolean service flag with state machine to prevent race conditions on rapid enable/disable toggle
- **Copilot**: Add 5-second timeout to socket server shutdown to prevent hanging on disable
- **Copilot**: Graceful pending socket shutdown (FIN before destroy) when disabling copilot
- **Copilot**: Wrap hook installer filesystem operations in try/catch to prevent unhandled errors
- **Copilot**: Clear session store on disable to prevent stale sessions on re-enable
- **Copilot**: Wrap all lifecycle operations (syncScript, dispose, window create) in try/catch
- **Copilot**: Detect missing Claude Code installation and show actionable guidance in settings and session list
- **Copilot**: Show explanatory text when hooks are not installed instead of just a red badge

## v2.16.0

### Features

- **Copilot**: AI mascot companion — a draggable spaceship sprite that floats over your desktop, shows live agent session status, and expands into an interactive panel
- **Copilot Chat**: View conversation history and send messages to Claude Code sessions directly from the copilot panel
- **Copilot Permissions**: Approve or deny tool permission requests from the copilot UI without switching to the terminal
- **Copilot Settings**: Configure copilot behavior, toggle visibility, and manage session preferences
- **CRT Styling**: Retro CRT bezel frame for the copilot expanded panel with shadcn/ui components
- **Direction-Aware Panel**: Copilot panel expands toward screen center based on sprite position

### Fixes

- Fixed copilot hook to only trigger for Fleet-managed sessions
- Fixed mascot position clamping to screen bounds during drag
- Fixed permission prompts not showing in copilot panel
- Restored dock icon with updated pixel art spaceship
- Fixed copilot panel phantom click double-toggle
- Fixed CRT frame proportions and position clamping

## v2.15.0

### Features

- **Fleet Skills**: AI agent integration via toolbar button — inject Fleet-specific skills into Claude Code and other agents
- **Toolbar Tooltips**: Added Radix tooltips to pane toolbar with inject-skills shortcut hint

### Fixes

- Fixed OS-appropriate path separators for fleet skills path
- Fixed images tab existence check across all workspaces
- Fixed worktree removal confirmation when shell exits in worktree tab

### Docs

- Updated fleet skills with image prompt best practices and missing CLI options

## v2.14.1

### Changes

- Removed Star Command system

## v2.14.0

### Features

- **Worktree Management**: Create, manage, and organize git worktrees directly from Fleet with visual group headers, collapsible groups, and persistent layout
- **Worktree Lifecycle**: Automated worktree creation with conflict detection, safe removal with undo, and support for renaming worktrees and group headers
- **Activity Detection**: Real-time tracking of terminal activity with visual badges, silence timers, and foreground process detection to identify when agents are working
- **Activity Indicators**: Tabs now show activity status with reduced-motion support and off-screen summary badges in the sidebar
- **Image Protocol**: Improved image loading performance with `fleet-image://` protocol replacing base64 IPC
### Fixes

- Fixed file search overlay scroll jumping when opening
- Improved drag and drop behavior to prevent cross-group reordering and duplicate drop indicators
- Fixed sidebar tab contrast and group header styling
- Corrected activity state persistence to prevent clearing on tab focus
- Fixed tab restoration with proper CWD persistence across workspace saves
- Improved git worktree detection to use live working directory
- Enhanced worktree removal resilience and branch conflict avoidance

### Removed

- Removed Star Command system (starbase, crews, missions, sectors, comms, cargo, protocols, admiral, navigator, first officer)
- Removed fleet CLI commands: sectors, missions, crew, comms, cargo, log, protocols, config
- Removed system dependency check screen (AppPreChecks)
- Kept fleet CLI commands: images, open

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
