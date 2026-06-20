# Fleet OpenCode Plugin

Allow opencode agents to use Fleet via a plugin that exposes Fleet CLI commands as opencode tools. The plugin talks directly to Fleet's Unix domain socket (`~/.fleet/fleet.sock`) using the same newline-delimited JSON protocol the `fleet` CLI uses.

## Scope

All Fleet CLI commands **except Pi** — opencode itself is the agent, so Pi integration is not needed. `kanban watch` is also excluded because streaming doesn't fit opencode's request/response tool model.

## File Structure

Single file: `~/.config/opencode/plugins/fleet.ts` — global plugin, auto-loaded for all projects. Uses `@opencode-ai/plugin` for `tool()` and `tool.schema` (Zod), plus Node.js `net` for the socket connection. The `@opencode-ai/plugin` dependency is already available via the existing `~/.config/opencode/package.json`.

## Socket Communication

- **Path:** `~/.fleet/fleet.sock` (prod), fallback to `fleet-dev.sock` if prod not found
- **Protocol:** Newline-delimited JSON, same as the CLI: `{ "id": "uuid", "command": "string", "args": {} }`
- **Connection:** One shared `net.Socket`, created lazily on first tool call
- **Timeout:** 30s per request
- **CLI name mapping:** Follows `COMMAND_MAP` from `fleet-cli.ts` (e.g., `images.generate` → `image.generate`, `images.config` read → `image.config.get`)

## Tool Inventory (29 tools)

### fleet_open
Opens files in Fleet tabs (code, image, PDF, markdown).

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| paths | string[] | yes | File paths to open |

### fleet_annotate
Opens a browser window for web page annotation.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| url | string | no | URL to annotate |
| timeout | number | no | Max seconds (default 300) |

### Images (8 tools)

#### fleet_images_generate
Generate images from a text prompt.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| prompt | string | yes | Text description |
| provider | string | no | Provider ID |
| model | string | no | Model to use |
| resolution | string | no | 0.5K, 1K, 2K, 4K |
| aspectRatio | string | no | e.g. 1:1, 16:9 |
| format | string | no | png, jpeg, webp |
| numImages | number | no | 1-4 |

#### fleet_images_edit
Edit images with a prompt.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| prompt | string | yes | Edit description |
| images | string[] | yes | Image file paths |
| provider | string | no | Provider ID |
| model | string | no | Model to use |
| resolution | string | no | 0.5K, 1K, 2K, 4K |
| aspectRatio | string | no | e.g. 1:1, 16:9 |
| format | string | no | png, jpeg, webp |
| numImages | number | no | 1-4 |

#### fleet_images_status
Check generation status.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| generationId | string | yes | Generation ID |

#### fleet_images_list
List all generations. No arguments.

#### fleet_images_retry
Retry a failed generation.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| generationId | string | yes | Generation ID |

#### fleet_images_config
Read or write image configuration. If any write flag is set, writes; otherwise reads.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| apiKey | string | no | Set API key |
| defaultModel | string | no | Set default model |
| defaultResolution | string | no | Set default resolution |
| defaultOutputFormat | string | no | Set default output format |
| defaultAspectRatio | string | no | Set default aspect ratio |
| provider | string | no | Which provider to configure |
| action | string | no | Action type for model config |
| model | string | no | Model for the action |

#### fleet_images_action
Run an action on an image (e.g. remove-background).

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| actionType | string | yes | Action type |
| source | string | yes | Image path, URL, or gen ref |
| provider | string | no | Provider ID |

#### fleet_images_actions
List available actions.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| provider | string | no | Filter by provider |

### Kanban (18 tools)

#### fleet_kanban_create
Create a new task.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| title | string | yes | Task title |
| body | string | no | Task description |
| assignee | string | no | Assignee profile name |
| priority | number | no | Priority number |
| workspace | string | no | scratch, dir, or worktree |
| repo | string | no | Repo path (required for worktree) |

#### fleet_kanban_swarm
Create a multi-worker swarm.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| goal | string | yes | Swarm goal |
| workers | object[] | yes | Array of {profile, title, skills?} |
| verifier | string | yes | Verifier profile |
| synthesizer | string | yes | Synthesizer profile |
| repo | string | no | Repository path |

#### fleet_kanban_list
List tasks, optionally filtered by status.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| status | string | no | triage, todo, ready, running, blocked, review, done, archived |

#### fleet_kanban_show
Show task details.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| taskId | string | yes | Task ID |

#### fleet_kanban_assign
Assign a task.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| taskId | string | yes | Task ID |
| profile | string | yes | Profile name |

#### fleet_kanban_ready
Mark task as ready. `taskId` required.

#### fleet_kanban_block
Block a task.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| taskId | string | yes | Task ID |
| reason | string | yes | Block reason |

#### fleet_kanban_unblock
Unblock a task. `taskId` required.

#### fleet_kanban_archive
Archive a task. `taskId` required.

#### fleet_kanban_complete
Complete a task.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| taskId | string | yes | Task ID |
| result | string | yes | Completion result |

#### fleet_kanban_comment
Add a comment.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| taskId | string | yes | Task ID |
| comment | string | yes | Comment text |

#### fleet_kanban_link
Link two tasks.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| parentId | string | yes | Parent task ID |
| childId | string | yes | Child task ID |

#### fleet_kanban_unlink
Unlink two tasks. Same args as link.

#### fleet_kanban_log
Show task event log. `taskId` required.

#### fleet_kanban_dispatch
Trigger manual dispatch. No arguments.

#### fleet_kanban_decompose
Decompose a triage task. `taskId` required.

#### fleet_kanban_specify
Specify a triage task. `taskId` required.

## Excluded

- `kanban watch` — streaming doesn't fit opencode's request/response tool model
- All Pi commands — opencode is the agent

## Error Handling

- **Socket not found:** "Fleet app is not running. Start Fleet first."
- **Timeout:** Retry once, then fail with timeout message
- **Fleet error response (ok: false):** Surface the error string
- **Network/connection errors:** Surface as tool output

## Configuration

None needed. Socket path is hardcoded. Plugin works if Fleet is running, reports an error if not.