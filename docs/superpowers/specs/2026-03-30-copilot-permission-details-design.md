# Copilot Panel: Permission Details in Listing View

**Issue:** [khang859/fleet#181](https://github.com/khang859/fleet/issues/181)
**Date:** 2026-03-30

## Problem

When the copilot panel requests a permission, the listing view shows only the tool name (e.g., "Bash"). Users cannot tell what the tool wants to do without navigating to the detail view. This forces pogo-sticking between list and detail views to make informed allow/deny decisions.

## Design

### Approach: Inline summary line

Display `toolName: keyParameter` in the existing permission row, replacing the current tool-name-only text. This provides strong information scent (NNG) without increasing visual noise or vertical space.

### New file: `src/renderer/copilot/src/lib/format-permission.ts`

A pure function `formatPermissionSummary(tool: CopilotToolInfo): { label: string; detail: string }` that:

1. Extracts the most relevant parameter from `toolInput` based on `toolName`
2. Returns a `label` (truncated to ~60 chars for display) and `detail` (full untruncated value for tooltip)

**Tool-to-parameter mapping:**

| toolName pattern | Key field(s) | Display format |
|-----------------|-------------|----------------|
| `bash`, `Bash` | `command` | `bash: <command>` |
| `edit`, `Edit`, `edit_file` | `file_path` or `path` | `edit: <path>` |
| `write`, `Write`, `create_file` | `file_path` or `path` | `write: <path>` |
| `read`, `Read`, `read_file` | `file_path` or `path` | `read: <path>` |
| `glob`, `Glob` | `pattern` | `glob: <pattern>` |
| `grep`, `Grep` | `pattern` | `grep: <pattern>` |
| `WebSearch` | `query` | `search: <query>` |
| `WebFetch` | `url` | `fetch: <url>` |
| Unknown tool | — | `<toolName>` (no detail) |

Matching is case-insensitive. Long values are truncated to 60 characters with `…`.

### Edit: `src/renderer/copilot/src/components/SessionList.tsx`

In the inline permission row (lines 166-196):

- Replace `{perm.tool.toolName}` with `{formatPermissionSummary(perm.tool).label}`
- Update the tooltip to show `formatPermissionSummary(perm.tool).detail` (full untruncated value) instead of just the tool name

### No changes required

- **Types** — `CopilotToolInfo` already carries `toolName` and `toolInput`
- **Backend / IPC** — data is already available, just not displayed
- **Detail view** — already shows full `toolInput` JSON, no changes needed

## UX Rationale

- **NNG Information Scent:** Users get enough cues inline to make allow/deny decisions without navigating away
- **NNG Progressive Disclosure:** Listing shows the essential one-liner; detail view provides the full `toolInput` JSON dump
- **NNG Permission Requests:** Users perform cost-benefit analysis — showing what the tool wants to do enables informed decisions
- **Baymard List Item Information:** Just enough attributes to decide without pogo-sticking; high signal-to-noise ratio
- **Baymard Truncation:** Truncate long values with `…`, full value available on hover (tooltip)

## Scope

- 1 new file (~40 lines)
- 1 edited file (~5 lines changed)
- No backend, IPC, or type changes
