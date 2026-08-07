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

## File Operations

| Tool | Purpose |
|------|---------|
| `fleet_open` | Open files in Fleet tabs (code, images, markdown, PDF). |
| `fleet_annotate` | Visually annotate a web page. Results saved to a JSON file. |

## Prerequisites

- **Fleet must be running.** Tools connect via `~/.fleet/fleet.sock`.
- **Inside a Fleet terminal** (recommended). Tools only appear when `FLEET_SESSION` is set or the Fleet socket is reachable.
- If Fleet is not running, tool calls return an error.