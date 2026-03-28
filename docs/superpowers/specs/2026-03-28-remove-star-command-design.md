# Remove Star Command System

## Goal

Completely remove the Star Command system (starbase, crews, missions, sectors, comms, cargo, protocols, navigator, first officer, admiral) from Fleet. Keep only the core terminal multiplexer + image generation + file opening features.

## Scope

### Files to Delete

**Frontend components (`src/renderer/src/components/star-command/`)** — 18 files:
- `Avatar.tsx`, `CrtFrame.tsx`, `StationHub.tsx`, `StatusBar.tsx`, `LogsPanel.tsx`
- `CrewPanel.tsx`, `CrewChips.tsx`, `CommsPanel.tsx`, `MemoPanel.tsx`, `MissionsPanel.tsx`
- `AdmiralSidebar.tsx`, `StarCommandScene.tsx`, `DependencyCheckScreen.tsx`
- `scene-utils.ts`, `sc-sprite-atlas.ts`, `sc-sprite-loader.ts`
- `__tests__/scene-utils.test.ts`, `__tests__/LogsPanel.test.ts`

**Frontend top-level star command files:**
- `src/renderer/src/components/StarCommandTab.tsx`
- `src/renderer/src/components/StarCommandConfig.tsx`
- `src/renderer/src/store/star-command-store.ts`

**Backend starbase directory (`src/main/starbase/`)** — 36 files:
- All services: `db.ts`, `sector-service.ts`, `crew-service.ts`, `mission-service.ts`, `comms-service.ts`, `cargo-service.ts`, `protocol-service.ts`, `config-service.ts`, `retention-service.ts`, `supply-route-service.ts`, `ships-log.ts`
- Agents: `navigator.ts`, `first-officer.ts`, `hull.ts`, `admiral-state-detector.ts`, `admiral-process.ts`, `analyst.ts`, `sentinel.ts`
- Infra: `migrations.ts`, `lockfile.ts`, `reconciliation.ts`, `worktree-manager.ts`, `error-fingerprint.ts`, `available-memory.ts`, `conventional-commits.ts`
- Prompts directory: all `.md` files under `src/main/starbase/prompts/`
- `workspace-templates.ts`

**Backend starbase runtime files (`src/main/`):**
- `starbase-runtime-core.ts`
- `starbase-runtime-socket-services.ts`
- `starbase-runtime-client.ts`
- `starbase-runtime-process.ts`

**Tests:**
- `src/main/__tests__/conventional-commits.test.ts`
- `src/main/__tests__/workspace-templates.test.ts`
- `src/main/__tests__/runtime-message-shape.test.ts`
- `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts`
- `src/renderer/src/components/star-command/__tests__/LogsPanel.test.ts`

**Scripts:**
- `scripts/assemble-star-command-sprites.ts`

**Docs (all star-command-related):**
- `docs/star-command.md`
- `docs/star-command-visual-prompts.md`
- `docs/star-command-chart-prompts.md`
- `docs/star-command-diagrams.mermaid`
- `star-command-asset-prompts.md` (root)
- All `docs/superpowers/specs/` files referencing star command (20+ files)
- All `docs/superpowers/plans/` files referencing star command (20+ files)

### Integration Points to Clean Up

**`src/shared/types.ts`** — Remove star command types (StarCommand tab type, starbase-related interfaces)

**`src/main/index.ts`** — Remove:
- Starbase imports and initialization
- Admiral process creation
- Starbase bootstrap logic
- `starbaseLog` logger

**`src/main/ipc-handlers.ts`** — Remove starbase/star-command IPC handlers

**`src/main/pty-manager.ts`** — Remove star command references

**`src/main/layout-store.ts`** — Remove star command tab type handling

**`src/main/socket-command-handler.ts`** — Remove:
- All starbase service imports and fields
- `setStarbaseServices()`, `setPhase2Services()`, `setRuntimeClient()`
- All starbase command cases (`sectors`, `add-sector`, `config-get`, `config-set`, `deploy`, `recall`, `crew`, `missions`)

**`src/main/socket-server.ts`** — Remove admiral-related handling

**`src/main/event-bus.ts`** — Remove:
- `admiral-state-change` event type
- `starbase-changed` event type

**`src/renderer/src/App.tsx`** — Remove star command tab rendering

**`src/renderer/src/components/Sidebar.tsx`** — Remove star command sidebar entry

**`src/renderer/src/hooks/use-terminal.ts`** — Remove star command references

**`src/renderer/src/components/FileSearchOverlay.tsx`** — Remove star command references

**`src/renderer/src/components/ClipboardHistoryOverlay.tsx`** — Remove star command references

**`src/preload/index.ts`** — Remove starbase runtime IPC bridge

**`src/shared/ipc-api.ts`** — Remove starbase IPC API types

### Fleet CLI Cleanup (`src/main/fleet-cli.ts`)

**Remove CLI command groups:** sectors, missions, crew, comms, cargo, log, protocols, config

**Keep CLI command groups:** images, open

**Clean up:**
- `COMMAND_MAP` — remove all entries except `images.*`
- `validateCommand()` — remove all cases except image-related
- `HELP_TOP` — rewrite to only reference images and open
- `HELP_GROUPS` — remove all entries except `images` and `open`
- `runCLI()` formatting — remove starbase-specific output formatting
- Remove `formatOutput` cases for removed commands

### Runtime `.fleet/` Cleanup

Remove code that creates/manages `~/.fleet/starbases/` directory (SQLite databases for starbase state). The `~/.fleet/bin/`, `~/.fleet/logs/`, `~/.fleet/images/` directories are unrelated and stay.

## Approach

Delete dedicated files first, then clean integration points, then verify with typecheck/lint. Git history preserves everything.

## Out of Scope

- Removing `~/.fleet/starbases/` from users' machines (they can delete manually)
- Any new features to replace star command
- Changes to the core terminal multiplexer functionality
