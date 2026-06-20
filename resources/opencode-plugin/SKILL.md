# Fleet Tools

You have access to Fleet tools for controlling the Fleet desktop app. These tools only register when running inside a Fleet terminal (`FLEET_SESSION` env var is set, or the Fleet socket is reachable).

## Image Generation

| Tool | Purpose |
|------|---------|
| `fleet_images_generate` | Generate images from a text prompt. Returns a generation ID. |
| `fleet_images_edit` | Edit images with a prompt and source images. |
| `fleet_images_status` | Check generation status by ID. Poll until complete. |
| `fleet_images_list` | List all generations. |
| `fleet_images_retry` | Retry a failed generation. |
| `fleet_images_action` | Run an action on an image (e.g., remove-background). |
| `fleet_images_actions` | List available image actions. |
| `fleet_images_config` | Show or set image provider configuration. |

### Image Workflow

1. `fleet_images_generate` → get a generation ID
2. `fleet_images_status <id>` → poll until status is "complete"
3. `fleet_open` the resulting image file to view it

## Kanban Board

| Tool | Purpose |
|------|---------|
| `fleet_kanban_create` | Create a new task (starts in "triage" status). |
| `fleet_kanban_swarm` | Create a multi-agent task graph with workers, verifier, and synthesizer. |
| `fleet_kanban_list` | List tasks, optionally filtered by status. |
| `fleet_kanban_show` | Show full task details including body, comments, and links. |
| `fleet_kanban_assign` | Assign a task to a profile. |
| `fleet_kanban_ready` | Mark a triage task as ready for dispatch. |
| `fleet_kanban_block` | Block a task with a reason. |
| `fleet_kanban_unblock` | Unblock a task. |
| `fleet_kanban_archive` | Archive a task (remove from active board). |
| `fleet_kanban_complete` | Complete a task with a result description. |
| `fleet_kanban_comment` | Add a comment to a task. |
| `fleet_kanban_link` | Link a parent to a child task (creates dependency). |
| `fleet_kanban_unlink` | Remove a parent-child link. |
| `fleet_kanban_log` | Show the chronological event history for a task. |
| `fleet_kanban_dispatch` | Trigger the dispatcher to pick up ready tasks. |
| `fleet_kanban_decompose` | Fan a triage task into a graph of child tasks. |
| `fleet_kanban_specify` | Rewrite a triage task into a fuller specification. |

### Kanban Task Lifecycle

```
create (triage) → assign → [decompose/specify] → ready → dispatch → running → complete
                                                              ↓
                                                           block/unblock
```

**Key points:**
- Tasks start in "triage" status. They must be explicitly moved to "ready".
- `fleet_kanban_dispatch` triggers the dispatcher to process ready tasks. Does not auto-run.
- `fleet_kanban_swarm` creates a coordinated multi-worker task. Manual dispatch may be needed after.
- `fleet_kanban_complete` marks done with a result. `fleet_kanban_archive` removes from board entirely.
- `fleet_kanban_decompose` and `fleet_kanban_specify` only work on triage tasks.

### Status Values

`triage`, `todo`, `ready`, `running`, `blocked`, `review`, `done`, `archived`

## File Operations

| Tool | Purpose |
|------|---------|
| `fleet_open` | Open files in Fleet tabs (code, images, markdown, PDF). |
| `fleet_annotate` | Visually annotate a web page. Results saved to a JSON file. |

## Prerequisites

- **Fleet must be running.** Tools connect via `~/.fleet/fleet.sock`.
- **Inside a Fleet terminal** (recommended). Tools only appear when `FLEET_SESSION` is set or the Fleet socket is reachable.
- If Fleet is not running, tool calls return an error.