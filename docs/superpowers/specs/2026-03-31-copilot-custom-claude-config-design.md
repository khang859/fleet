# Copilot Custom Claude Configuration

## Problem

Users with multiple Claude Code setups (e.g., `~/.claude-moxie`, `~/.claude-personal`) need Fleet's copilot to work with their custom configurations. Currently, Fleet hardcodes `~/.claude/` for hook installation and settings. There's no way to specify a custom `CLAUDE_CONFIG_DIR` or Claude binary path, and no per-workspace override support.

## Design

### Consolidated Copilot Settings

Move all copilot settings from the copilot floating window into the main Settings tab's Copilot section. Remove the settings panel from the copilot floating window entirely.

**Settings → Copilot layout (top to bottom):**

1. **Enable Copilot** — existing toggle, unchanged
2. **Mascot** — sprite picker (moved from copilot window)
3. **Notification Sound** — dropdown (moved from copilot window)
4. **Claude Code Binary Path** — text field + file picker button. Empty = use system PATH. Placeholder: `/usr/local/bin/claude`
5. **Config Directory** — text field + folder picker button. Empty = use `~/.claude/`. Placeholder: `~/.claude`
6. **Claude Code Hooks** — install/uninstall status + button (moved from copilot window)
7. **Workspace Overrides** — collapsible section listing all current workspaces

### Workspace Overrides

Located at the bottom of the Copilot settings section.

- Header: "Workspace Overrides" with description "Override global Claude settings per workspace"
- Lists all existing workspaces by name as collapsible rows
- Each expanded row shows:
  - **Claude Code Binary Path** — text field + file picker (empty = use global default)
  - **Config Directory** — text field + folder picker (empty = use global default)
- Workspaces with active overrides show a small indicator (dot/badge) on the collapsed row
- Empty state: "No workspaces configured"

**Lifecycle:** When a workspace is deleted, its overrides are removed from the settings store automatically.

### Copilot Floating Window Changes

- Remove the settings panel/route from the copilot window entirely
- Remove: notification sound dropdown, hooks install/uninstall, Claude detection status
- Keep: session list, session detail (chat + permissions), mascot display

### Data Model

`CopilotSettings` type additions:

```typescript
type CopilotSettings = {
  enabled: boolean;
  autoEnabled: boolean;
  spriteSheet: string;
  notificationSound: string;
  autoStart: boolean;
  // New fields:
  claudeBinaryPath: string;    // empty = system PATH
  claudeConfigDir: string;     // empty = ~/.claude/
  workspaceOverrides: Record<WorkspaceId, {
    claudeBinaryPath?: string;
    claudeConfigDir?: string;
  }>;
};
```

### Hook Installation

- "Install Hooks" installs into the global config dir (whatever `claudeConfigDir` is set to)
- If any workspace override specifies a different config dir, Fleet installs hooks there too
- When a config dir override is added/changed, Fleet prompts or auto-installs hooks into that directory

### PTY Spawning

When creating a terminal in a workspace:

1. Resolve config dir: workspace override → global setting → default (`~/.claude/`)
2. Resolve binary path: workspace override → global setting → default (`claude` from PATH)
3. Pass `CLAUDE_CONFIG_DIR` env var to the PTY if non-default
4. Use resolved binary path when spawning Claude

### Error Handling

- **Invalid binary path**: Inline validation message on the field if path doesn't exist or isn't executable. Non-blocking.
- **Invalid config dir**: Inline validation message if path doesn't exist. Don't auto-create — user manages their own Claude config dirs.
- **Hooks not installed in custom config dir**: Warning banner in Copilot settings: "Hooks not installed in [dir]. Copilot won't receive events from Claude sessions using this config." With an "Install" button.
