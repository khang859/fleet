# Image Generation Integration

Fleet integration with external image generation services (starting with fal.ai), accessible via the Fleet CLI so AI coding agents can generate and edit images programmatically. Includes a pinned Images tab for browsing, managing, and configuring image generation.

## Goals

- AI agents (e.g., Claude Code) can generate and edit images via `fleet images` CLI commands
- Non-blocking: CLI returns immediately, generation happens in the background
- Pinned Images tab provides a gallery, metadata viewer, and per-provider settings
- Provider-agnostic architecture so we can add services beyond fal.ai later
- Resilient to failures, network issues, and app restarts

## Storage

All image data lives under `~/.fleet/images/`.

### Directory Structure

```
~/.fleet/images/
  settings.json
  generations/
    20260326-143052-a1b2c3/
      image-001.png
      image-002.png
      meta.json
    20260326-150012-d4e5f6/
      image-001.png
      meta.json
```

### settings.json

```json
{
  "defaultProvider": "fal-ai",
  "providers": {
    "fal-ai": {
      "apiKey": "",
      "defaultModel": "fal-ai/nano-banana-2",
      "defaultResolution": "1K",
      "defaultOutputFormat": "png",
      "defaultAspectRatio": "1:1"
    }
  }
}
```

Per-provider settings. Not all providers will have the same fields — each provider defines its own defaults schema. The `defaultProvider` key determines which provider is used when `--provider` is not specified.

### meta.json

```json
{
  "id": "20260326-143052-a1b2c3",
  "status": "completed",
  "createdAt": "2026-03-26T14:30:52.000Z",
  "completedAt": "2026-03-26T14:31:05.000Z",
  "failedAt": null,
  "error": null,
  "provider": "fal-ai",
  "model": "fal-ai/nano-banana-2",
  "mode": "generate",
  "prompt": "A cat in space",
  "params": {
    "resolution": "1K",
    "aspect_ratio": "1:1",
    "output_format": "png",
    "num_images": 1
  },
  "referenceImages": [],
  "images": [
    { "filename": "image-001.png", "width": 1024, "height": 1024 }
  ],
  "providerRequestId": "req_abc123"
}
```

**Status values:** `queued` | `processing` | `completed` | `partial` | `failed` | `timeout`

**Edit mode:** `mode` is `"edit"`, `referenceImages` contains the original paths/URLs used as input.

**Partial success** (e.g., requested 4 images, 2 downloaded):
```json
{
  "status": "partial",
  "images": [
    { "filename": "image-001.png", "width": 1024, "height": 1024 },
    { "filename": null, "error": "Download failed: connection reset", "providerUrl": "https://fal.media/..." }
  ]
}
```

## Provider Abstraction

### ImageProvider Interface

```typescript
interface ImageProvider {
  id: string;                                          // 'fal-ai'
  name: string;                                        // 'fal.ai'
  configure(settings: Record<string, unknown>): void;
  submit(opts: GenerateOpts | EditOpts): Promise<{ requestId: string }>;
  poll(requestId: string): Promise<PollResult>;
  getResult(requestId: string): Promise<GenerationResult>;
  cancel(requestId: string): Promise<void>;
}

type PollResult =
  | { status: 'queued' }
  | { status: 'processing'; progress?: number }
  | { status: 'completed' }
  | { status: 'failed'; error: string };

type GenerationResult = {
  images: Array<{ url: string; width: number; height: number }>;
  description?: string;
};
```

### fal.ai Provider (Initial Implementation)

Uses `@fal-ai/client` library:
- `submit()` → `fal.queue.submit("fal-ai/nano-banana-2", { input })`
- `poll()` → `fal.queue.status("fal-ai/nano-banana-2", { requestId })`
- `getResult()` → `fal.queue.result("fal-ai/nano-banana-2", { requestId })`
- `cancel()` → `fal.queue.cancel("fal-ai/nano-banana-2", { requestId })`

Authentication: `fal.config({ credentials: apiKey })`.

### Adding a New Provider Later

1. Implement `ImageProvider` interface
2. Register in `ImageService.providers` map
3. Add provider-specific settings schema
4. No changes to CLI, storage, or UI needed

## Image Service (Main Process)

**File:** `src/main/image-service.ts`

Singleton initialized at app startup. Holds a `Map<string, ImageProvider>` (initially just `fal-ai`).

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `generate(opts)` | `{ id }` | Submit to provider queue, start background poll, return immediately |
| `edit(opts)` | `{ id }` | Validate reference images, submit, start background poll |
| `getStatus(id)` | `meta` | Read meta.json for a generation |
| `list()` | `meta[]` | Scan generations/ directory |
| `retry(id)` | `{ id }` | Resubmit a failed/timeout generation |
| `delete(id)` | `void` | Remove generation directory |
| `getSettings()` | `settings` | Read settings.json |
| `updateSettings(partial)` | `void` | Merge into settings.json, reconfigure providers |

### Background Poll Lifecycle

- Each active generation tracked in a `Map<string, AbortController>`
- Poll interval: start at 1s, backoff to 5s
- Timeout: 5 minutes max per generation
- On completion: download images to disk, update meta.json status, emit `state-change` event `image:changed`
- On failure/timeout: update meta.json with error, emit event
- On app quit: abort all active polls gracefully
- On app startup: scan `generations/` for `queued` or `processing` entries, resume polling using stored `providerRequestId`

### Failure Handling

| Failure | Behavior |
|---------|----------|
| Network failure mid-poll | Mark `failed`, store error, retry-able |
| Download failure | Store provider URL in meta.json, mark `partial` or `failed`, allow retry of just the download |
| Invalid API key (401) | Mark `failed`, error: "Invalid API key" |
| Rate limited (429) | Mark `failed`, error: "Rate limited", retry-able |
| Partial download | Store what succeeded, mark `partial`, allow retry of missing images |
| Disk write failure | Mark `failed`, error describes IO problem |
| Reference image not found (edit) | Reject synchronously before submitting to provider |
| Queue timeout (>5min) | Mark `timeout`, retry-able |

## CLI Commands

### Command Mapping

| CLI Syntax | Socket Command | Description |
|------------|---------------|-------------|
| `fleet images generate --prompt ...` | `image.generate` | Generate image(s) from prompt |
| `fleet images edit --prompt ... --images ...` | `image.edit` | Edit image(s) with prompt + references |
| `fleet images status <id>` | `image.status` | Check generation status |
| `fleet images list` | `image.list` | List all generations |
| `fleet images retry <id>` | `image.retry` | Retry failed/timeout generation |
| `fleet images config` | `image.config.get` | Show current config |
| `fleet images config --api-key ...` | `image.config.set` | Update config |

### Generate

```bash
fleet images generate \
  --prompt "A cat in space" \
  --provider fal-ai \              # optional, uses defaultProvider
  --model fal-ai/nano-banana-2 \   # optional, uses provider default
  --resolution 2K \                 # optional, uses provider default
  --aspect-ratio 16:9 \            # optional, uses provider default
  --format png \                    # optional, uses provider default
  --num-images 2                    # optional, default 1
```

Returns immediately:
```
Submitted: 20260326-143052-a1b2c3
```

### Edit

```bash
fleet images edit \
  --prompt "Make the cat wear a hat" \
  --images ./photo1.png ./photo2.png \
  --provider fal-ai \
  --model fal-ai/nano-banana-2/edit \   # auto-appends /edit if omitted
  --resolution 1K
```

Validates reference images exist before submitting. Returns immediately with ID.

### Status

```bash
$ fleet images status 20260326-143052-a1b2c3
status: completed
path: ~/.fleet/images/generations/20260326-143052-a1b2c3
images: image-001.png
```

### List

```bash
$ fleet images list
ID                          STATUS      MODE      MODEL                   PROMPT
20260326-143052-a1b2c3      completed   generate  fal-ai/nano-banana-2    A cat in space
20260326-150012-d4e5f6      processing  edit      fal-ai/nano-banana-2    Make the cat wear...
```

### Config

```bash
$ fleet images config
defaultProvider: fal-ai
fal-ai:
  apiKey: sk-***redacted***
  defaultModel: fal-ai/nano-banana-2
  defaultResolution: 1K
  defaultOutputFormat: png
  defaultAspectRatio: 1:1

$ fleet images config --api-key sk-xxx
$ fleet images config --default-resolution 2K
$ fleet images config --provider fal-ai --api-key sk-xxx
```

### Validation

- `generate`: `--prompt` required
- `edit`: `--prompt` and `--images` required; local files verified before sending
- `status` / `retry`: positional `<id>` required
- No API key configured: `Error: fal.ai API key not configured. Run: fleet images config --api-key <key>`

## Socket Server

### New Dispatch Cases

| Command | Args | Returns |
|---------|------|---------|
| `image.generate` | prompt, provider?, model?, resolution?, aspectRatio?, outputFormat?, numImages? | `{ id }` |
| `image.edit` | prompt, images, provider?, model?, resolution? | `{ id }` |
| `image.status` | id | Full meta.json contents |
| `image.list` | — | Array of all meta.json contents |
| `image.retry` | id | `{ id }` |
| `image.delete` | id | `void` |
| `image.config.get` | — | Settings (API key redacted) |
| `image.config.set` | provider?, apiKey?, defaultModel?, defaultResolution?, defaultAspectRatio?, defaultOutputFormat? | `void` |

All mutating commands emit `state-change` event `image:changed`.

## IPC & Preload Bridge

### New IPC Channels

- `images:generate`
- `images:edit`
- `images:status`
- `images:list`
- `images:retry`
- `images:delete`
- `images:config:get`
- `images:config:set`
- `images:changed` (event, main → renderer)

### Preload API

```typescript
window.fleet.images = {
  generate: (opts) => ipcRenderer.invoke('images:generate', opts),
  edit: (opts) => ipcRenderer.invoke('images:edit', opts),
  getStatus: (id) => ipcRenderer.invoke('images:status', id),
  list: () => ipcRenderer.invoke('images:list'),
  retry: (id) => ipcRenderer.invoke('images:retry', id),
  delete: (id) => ipcRenderer.invoke('images:delete', id),
  getConfig: () => ipcRenderer.invoke('images:config:get'),
  setConfig: (partial) => ipcRenderer.invoke('images:config:set', partial),
  onChanged: (cb) => { ipcRenderer.on('images:changed', cb); return () => ipcRenderer.removeListener('images:changed', cb); },
}
```

## Renderer

### Zustand Store

**File:** `src/renderer/src/store/image-store.ts`

```typescript
{
  generations: ImageGeneration[];
  config: ImageSettings | null;
  isLoaded: boolean;
  loadGenerations: () => Promise<void>;
  loadConfig: () => Promise<void>;
  generate: (opts) => Promise<{ id: string }>;
  edit: (opts) => Promise<{ id: string }>;
  retry: (id: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
  updateConfig: (partial) => Promise<void>;
}
```

Subscribes to `window.fleet.images.onChanged` for live updates — refetches the changed generation's meta.json on each event.

### Pinned Images Tab

Tab type: `'images'`. Always present in sidebar, not closeable. Shows gallery icon with badge count for in-progress generations.

**Three sub-views:**

#### Grid View (default)
- Thumbnail grid, newest first
- Each card: thumbnail (first image), status indicator, prompt (truncated), model, timestamp
- Queued/processing: spinner overlay
- Failed/timeout: error icon, clickable
- Partial: warning badge

#### Detail View (click a card)
- Large image preview with carousel if multiple images
- Full metadata sidebar: prompt, model, provider, resolution, aspect ratio, format, timestamps, reference images (as clickable thumbnails for edits), provider request ID, status + error
- Actions: retry, delete, open in Finder/Explorer, copy path

#### Settings Sub-tab
- Provider selector (dropdown, just fal.ai for now)
- Per-provider settings:
  - API key (password input with show/hide toggle)
  - Default model (dropdown)
  - Default resolution (dropdown: 0.5K, 1K, 2K, 4K)
  - Default output format (dropdown: png, jpeg, webp)
  - Default aspect ratio (dropdown: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9)

## Dependencies

New npm dependency: `@fal-ai/client` — installed in the main process (Node.js). Not bundled into the renderer.

## Files to Create/Modify

### New Files
- `src/main/image-service.ts` — ImageService singleton
- `src/main/image-providers/types.ts` — ImageProvider interface and shared types
- `src/main/image-providers/fal-ai.ts` — fal.ai provider implementation
- `src/renderer/src/store/image-store.ts` — Zustand store
- `src/renderer/src/components/ImageGallery/ImageGallery.tsx` — pinned tab root
- `src/renderer/src/components/ImageGallery/ImageGrid.tsx` — thumbnail grid
- `src/renderer/src/components/ImageGallery/ImageDetail.tsx` — detail view with metadata
- `src/renderer/src/components/ImageGallery/ImageSettings.tsx` — settings sub-tab

### Modified Files
- `src/shared/types.ts` — add image-related types (ImageGeneration, ImageSettings, etc.)
- `src/shared/ipc-channels.ts` — add `images:*` channels
- `src/preload/index.ts` — add `window.fleet.images` namespace
- `src/main/index.ts` — initialize ImageService
- `src/main/socket-server.ts` — add `image.*` dispatch cases
- `src/main/fleet-cli.ts` — add `images` command group (mapping, validation, formatting)
- `src/renderer/src/App.tsx` — add pinned Images tab
- `package.json` — add `@fal-ai/client` dependency
