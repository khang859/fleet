# Image Actions System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an extensible, config-driven image actions system (starting with background removal) that works in the gallery, file viewer, and CLI.

**Architecture:** Actions are config objects registered per-provider via `getActions()`. A shared executor in `ImageService.runAction()` calls the action's endpoint via sync-mode `fetch`, downloads the result, and creates a new generation entry. The UI surfaces (ImageDetail, ImageViewerPane) and CLI all funnel through the same `runAction` path.

**Tech Stack:** Electron IPC, fal.ai REST API (sync mode), React/Zustand, node-pty socket API

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/main/image-providers/action-types.ts` | Create | `ImageActionConfig` type, `ImageActionInfo` serializable type, output validator |
| `src/main/image-providers/types.ts` | Modify | Add `getActions()` to `ImageProvider` interface |
| `src/main/image-providers/fal-ai.ts` | Modify | Implement `getActions()` returning remove-background config |
| `src/shared/types.ts` | Modify | Extend `ImageGenerationMode`, add `sourceImage` to `ImageGenerationMeta` |
| `src/main/image-service.ts` | Modify | Add `runAction()`, `listActions()`, `resolveSourceImage()` |
| `src/shared/ipc-channels.ts` | Modify | Add `IMAGES_RUN_ACTION` and `IMAGES_LIST_ACTIONS` channels |
| `src/main/index.ts` | Modify | Register new IPC handlers |
| `src/preload/index.ts` | Modify | Expose `runAction` and `listActions` |
| `src/renderer/src/store/image-store.ts` | Modify | Add `runAction`, `actions`, `loadActions` |
| `src/renderer/src/components/ImageGallery/ImageDetail.tsx` | Modify | Add action buttons |
| `src/renderer/src/components/ImageViewerPane.tsx` | Modify | Add action buttons to status bar |
| `src/main/fleet-cli.ts` | Modify | Add `images.action` and `images.actions` command mappings, validation, help |
| `src/main/socket-server.ts` | Modify | Handle `image.action` and `image.actions.list` |

---

### Task 1: Action Config Types

**Files:**
- Create: `src/main/image-providers/action-types.ts`

- [ ] **Step 1: Create the action types file**

```ts
// src/main/image-providers/action-types.ts

export type ImageActionConfig = {
  id: string;
  actionType: string;
  provider: string;
  name: string;
  description: string;
  endpoint: string;
  inputMapping: (imageUrl: string) => Record<string, unknown>;
  outputMapping: (response: unknown) => { url: string; width: number; height: number };
  outputFormat: string;
};

/** Serializable subset sent to the renderer / CLI — no functions */
export type ImageActionInfo = {
  id: string;
  actionType: string;
  provider: string;
  name: string;
  description: string;
};

export function toActionInfo(config: ImageActionConfig): ImageActionInfo {
  return {
    id: config.id,
    actionType: config.actionType,
    provider: config.provider,
    name: config.name,
    description: config.description
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (new file, no consumers yet)

- [ ] **Step 3: Commit**

```bash
git add src/main/image-providers/action-types.ts
git commit -m "feat(images): add ImageActionConfig and ImageActionInfo types"
```

---

### Task 2: Extend ImageProvider Interface and FalAiProvider

**Files:**
- Modify: `src/main/image-providers/types.ts:31-39`
- Modify: `src/main/image-providers/fal-ai.ts`

- [ ] **Step 1: Add getActions to ImageProvider interface**

In `src/main/image-providers/types.ts`, add the import and method:

```ts
// At top of file, add import:
import type { ImageActionConfig } from './action-types';

// Add to the ImageProvider interface (after cancel method, line 38):
  getActions(): ImageActionConfig[];
```

- [ ] **Step 2: Implement getActions in FalAiProvider**

In `src/main/image-providers/fal-ai.ts`, add the import and method:

```ts
// At top, add import:
import type { ImageActionConfig } from './action-types';

// Add method to FalAiProvider class, after the cancel method:
  getActions(): ImageActionConfig[] {
    return [
      {
        id: 'fal-ai:remove-background',
        actionType: 'remove-background',
        provider: 'fal-ai',
        name: 'Remove Background',
        description: 'Remove the background from an image (BRIA RMBG 2.0)',
        endpoint: 'https://fal.run/fal-ai/bria/background/remove',
        inputMapping: (url: string) => ({ image_url: url, sync_mode: true }),
        outputMapping: (response: unknown) => {
          const res = response as { image: { url: string; width: number; height: number } };
          return { url: res.image.url, width: res.image.width, height: res.image.height };
        },
        outputFormat: 'png'
      }
    ];
  }
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/image-providers/types.ts src/main/image-providers/fal-ai.ts
git commit -m "feat(images): add getActions() to ImageProvider, implement remove-background in fal-ai"
```

---

### Task 3: Extend Shared Types

**Files:**
- Modify: `src/shared/types.ts:140,150-170`

- [ ] **Step 1: Extend ImageGenerationMode**

In `src/shared/types.ts`, change line 140 from:

```ts
export type ImageGenerationMode = 'generate' | 'edit';
```

to:

```ts
export type ImageGenerationMode = 'generate' | 'edit' | `action:${string}`;
```

- [ ] **Step 2: Add sourceImage to ImageGenerationMeta**

In `src/shared/types.ts`, add `sourceImage` field to `ImageGenerationMeta` after `providerRequestId` (line 169):

```ts
  providerRequestId: string | null;
  sourceImage: string | null;
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: May have errors where `ImageGenerationMeta` objects are constructed without `sourceImage`. Fix any that appear — add `sourceImage: null` to the object literals in `image-service.ts` `generate()` (around line 166) and `edit()` (around line 223).

- [ ] **Step 4: Fix generate() meta construction**

In `src/main/image-service.ts`, in the `generate` method's meta object (around line 146-166), add after `providerRequestId: null`:

```ts
      providerRequestId: null,
      sourceImage: null
```

- [ ] **Step 5: Fix edit() meta construction**

In `src/main/image-service.ts`, in the `edit` method's meta object (around line 203-224), add after `providerRequestId: null`:

```ts
      providerRequestId: null,
      sourceImage: null
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/main/image-service.ts
git commit -m "feat(images): extend ImageGenerationMode for actions, add sourceImage to meta"
```

---

### Task 4: Add runAction and listActions to ImageService

**Files:**
- Modify: `src/main/image-service.ts`

- [ ] **Step 1: Add imports**

At the top of `src/main/image-service.ts`, add:

```ts
import type { ImageActionConfig } from './image-providers/action-types';
import { toActionInfo } from './image-providers/action-types';
import type { ImageActionInfo } from './image-providers/action-types';
```

(Combine the imports into one line):

```ts
import { toActionInfo, type ImageActionConfig, type ImageActionInfo } from './image-providers/action-types';
```

- [ ] **Step 2: Add listActions method**

Add after the `getProviderDefaults` method (around line 122):

```ts
  // ── Actions ─────────────────────────────────────────────────────────────

  listActions(providerId?: string): ImageActionInfo[] {
    if (providerId) {
      const provider = this.providers.get(providerId);
      if (!provider) return [];
      return provider.getActions().map(toActionInfo);
    }
    const actions: ImageActionInfo[] = [];
    for (const provider of this.providers.values()) {
      actions.push(...provider.getActions().map(toActionInfo));
    }
    return actions;
  }

  private findAction(actionType: string, providerId?: string): { config: ImageActionConfig; apiKey: string } {
    const settings = this.getSettings();
    const id = providerId ?? settings.defaultProvider;
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    const config = provider.getActions().find((a) => a.actionType === actionType);
    if (!config) throw new Error(`Action "${actionType}" not available for provider "${id}"`);
    const apiKey = settings.providers[id]?.apiKey ?? '';
    if (!apiKey) throw new Error(`No API key configured for provider "${id}". Run: fleet images config --api-key <key>`);
    return { config, apiKey };
  }
```

- [ ] **Step 3: Add resolveSourceImage method**

Add after `findAction`:

```ts
  private async resolveSourceImage(source: string): Promise<string> {
    // URL — pass through
    if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('data:')) {
      return source;
    }

    // Generation reference: <generationId>/<filename>
    const genMatch = source.match(/^([^/]+)\/(image-.+)$/);
    if (genMatch) {
      const filePath = join(GENERATIONS_DIR, genMatch[1], genMatch[2]);
      return this.fileToDataUri(filePath);
    }

    // Local file path
    return this.fileToDataUri(source);
  }

  private fileToDataUri(filePath: string): string {
    const data = readFileSync(filePath);
    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mimeType};base64,${data.toString('base64')}`;
  }
```

- [ ] **Step 4: Add runAction method**

Add after `resolveSourceImage`:

```ts
  runAction(opts: {
    actionType: string;
    source: string;
    provider?: string;
  }): { id: string } {
    const { config, apiKey } = this.findAction(opts.actionType, opts.provider);
    const id = generateId();
    mkdirSync(join(GENERATIONS_DIR, id), { recursive: true });

    const meta: ImageGenerationMeta = {
      id,
      status: 'processing',
      createdAt: new Date().toISOString(),
      completedAt: null,
      failedAt: null,
      error: null,
      provider: config.provider,
      model: config.endpoint,
      mode: `action:${config.actionType}`,
      prompt: config.name,
      params: { output_format: config.outputFormat },
      referenceImages: [],
      images: [],
      providerRequestId: null,
      sourceImage: opts.source
    };
    this.writeMeta(id, meta);
    this.emit('changed', id);

    void this.executeAction(id, config, apiKey, opts.source);
    return { id };
  }

  private async executeAction(
    id: string,
    config: ImageActionConfig,
    apiKey: string,
    source: string
  ): Promise<void> {
    try {
      const imageUrl = await this.resolveSourceImage(source);
      const input = config.inputMapping(imageUrl);

      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`API error ${response.status}: ${body}`);
      }

      const result: unknown = await response.json();
      const image = config.outputMapping(result);

      // Download the result image
      const dir = join(GENERATIONS_DIR, id);
      const filename = `image-001.${config.outputFormat}`;
      const filePath = join(dir, filename);

      const imageResponse = await fetch(image.url);
      if (!imageResponse.ok) throw new Error(`Download failed: ${imageResponse.status}`);
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      writeFileSync(filePath, buffer);

      const meta = this.readMeta(id);
      if (!meta) return;
      meta.status = 'completed';
      meta.completedAt = new Date().toISOString();
      meta.images = [{ filename, width: image.width, height: image.height }];
      this.writeMeta(id, meta);
      this.emit('changed', id);
    } catch (err) {
      this.markFailed(id, err instanceof Error ? err.message : String(err));
    }
  }
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS (existing tests should still work with the new `sourceImage: null` field)

- [ ] **Step 7: Commit**

```bash
git add src/main/image-service.ts
git commit -m "feat(images): add runAction(), listActions(), and action executor to ImageService"
```

---

### Task 5: Add IPC Channels and Wire Up Main Process

**Files:**
- Modify: `src/shared/ipc-channels.ts:90-98`
- Modify: `src/main/index.ts:813-840`
- Modify: `src/preload/index.ts:336-367`

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/ipc-channels.ts`, add before the closing `} as const;` (after line 98):

```ts
  IMAGES_RUN_ACTION: 'images:run-action',
  IMAGES_LIST_ACTIONS: 'images:list-actions',
```

- [ ] **Step 2: Register IPC handlers in main process**

In `src/main/index.ts`, add after the `IMAGES_CONFIG_SET` handler (after line 840):

```ts
  ipcMain.handle(
    IPC_CHANNELS.IMAGES_RUN_ACTION,
    (_e, opts: { actionType: string; source: string; provider?: string }) =>
      imageService.runAction(opts)
  );
  ipcMain.handle(IPC_CHANNELS.IMAGES_LIST_ACTIONS, (_e, provider?: string) =>
    imageService.listActions(provider)
  );
```

- [ ] **Step 3: Expose in preload**

In `src/preload/index.ts`, add to the `images` object (after the `onChanged` method, around line 366):

```ts
    runAction: async (opts: {
      actionType: string;
      source: string;
      provider?: string;
    }): Promise<{ id: string }> => typedInvoke(IPC_CHANNELS.IMAGES_RUN_ACTION, opts),
    listActions: async (provider?: string): Promise<Array<{
      id: string;
      actionType: string;
      provider: string;
      name: string;
      description: string;
    }>> => typedInvoke(IPC_CHANNELS.IMAGES_LIST_ACTIONS, provider)
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(images): add IPC channels for runAction and listActions"
```

---

### Task 6: Update Image Store

**Files:**
- Modify: `src/renderer/src/store/image-store.ts`

- [ ] **Step 1: Add action types and methods to the store**

In `src/renderer/src/store/image-store.ts`, update the `ImageStore` type to add:

```ts
type ImageActionInfo = {
  id: string;
  actionType: string;
  provider: string;
  name: string;
  description: string;
};

type ImageStore = {
  generations: ImageGenerationMeta[];
  config: ImageSettings | null;
  actions: ImageActionInfo[];
  isLoaded: boolean;
  loadGenerations: () => Promise<void>;
  loadConfig: () => Promise<void>;
  loadActions: () => Promise<void>;
  generate: (opts: {
    prompt: string;
    provider?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    outputFormat?: string;
    numImages?: number;
  }) => Promise<{ id: string }>;
  edit: (opts: {
    prompt: string;
    images: string[];
    provider?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    outputFormat?: string;
    numImages?: number;
  }) => Promise<{ id: string }>;
  runAction: (opts: {
    actionType: string;
    source: string;
    provider?: string;
  }) => Promise<{ id: string }>;
  retry: (id: string) => Promise<void>;
  deleteGeneration: (id: string) => Promise<void>;
  updateConfig: (partial: Partial<ImageSettings>) => Promise<void>;
};
```

- [ ] **Step 2: Add store implementations**

In the `create<ImageStore>` call, add the new initial state and methods:

```ts
  actions: [],

  loadActions: async () => {
    const actions = await window.fleet.images.listActions();
    set({ actions });
  },

  runAction: async (opts) => {
    const result = await window.fleet.images.runAction(opts);
    return result;
  },
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/store/image-store.ts
git commit -m "feat(images): add runAction and actions to image store"
```

---

### Task 7: Add Action Buttons to ImageDetail

**Files:**
- Modify: `src/renderer/src/components/ImageGallery/ImageDetail.tsx`

- [ ] **Step 1: Add action imports and state**

At the top of `ImageDetail.tsx`, update the import and add state:

```ts
import { useState, useEffect, useCallback } from 'react';
import type { ImageGenerationMeta } from '../../../../shared/types';
import { useImageStore } from '../../store/image-store';
```

- [ ] **Step 2: Add action logic to ImageDetail component**

Inside the `ImageDetail` component function, after the existing handler functions (after `handleCopyPath`), add:

```ts
  const { retry, deleteGeneration, runAction, actions, loadActions } = useImageStore();
  const [runningAction, setRunningAction] = useState<string | null>(null);

  useEffect(() => {
    void loadActions();
  }, [loadActions]);

  const handleAction = useCallback(
    (actionType: string, filename: string) => {
      setRunningAction(actionType);
      const source = `${gen.id}/${filename}`;
      void runAction({ actionType, source }).finally(() => setRunningAction(null));
    },
    [gen.id, runAction]
  );
```

Update the destructuring at the top to remove the old `retry, deleteGeneration` since we now get them from the expanded destructuring above.

- [ ] **Step 3: Add action buttons to the sidebar**

In the sidebar actions section (around line 165, the `<div className="pt-3 border-t ...">` block), add an Actions section before the existing Retry/Copy Path/Delete buttons:

```tsx
          {gen.status === 'completed' && images.length > 0 && actions.length > 0 && (
            <div className="pb-3 border-b border-neutral-800 space-y-2">
              <span className="text-xs text-neutral-500">Actions</span>
              {actions.map((action) => (
                <button
                  key={action.id}
                  className="w-full text-sm bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-3 py-1.5 disabled:opacity-50"
                  disabled={runningAction !== null}
                  onClick={() => handleAction(action.actionType, images[0].filename!)}
                >
                  {runningAction === action.actionType ? 'Processing...' : action.name}
                </button>
              ))}
            </div>
          )}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ImageGallery/ImageDetail.tsx
git commit -m "feat(images): add action buttons to ImageDetail gallery panel"
```

---

### Task 8: Add Action Buttons to ImageViewerPane

**Files:**
- Modify: `src/renderer/src/components/ImageViewerPane.tsx`

- [ ] **Step 1: Add imports and action state**

At the top of `ImageViewerPane.tsx`, add:

```ts
import { useRef, useState, useEffect, useCallback } from 'react';
import { useImageStore } from '../store/image-store';
```

- [ ] **Step 2: Add action logic inside ImageViewerPane component**

Inside the component, after the keyboard shortcuts `useEffect` (around line 194), add:

```ts
  const { actions, loadActions, runAction } = useImageStore();
  const [runningAction, setRunningAction] = useState<string | null>(null);

  useEffect(() => {
    void loadActions();
  }, [loadActions]);

  const handleAction = useCallback(
    (actionType: string) => {
      setRunningAction(actionType);
      void runAction({ actionType, source: filePath }).finally(() => setRunningAction(null));
    },
    [filePath, runAction]
  );
```

- [ ] **Step 3: Add action buttons to the status bar**

In the status bar JSX (the `<div className="flex-shrink-0 flex items-center ...">` block), add after the zoom controls `</div>` (around line 285) but before the closing status bar `</div>`:

```tsx
        {imageSrc && actions.length > 0 && (
          <div className="flex items-center gap-0.5 ml-2">
            <div className="w-px h-3.5 bg-neutral-700 mx-1" />
            {actions.map((action) => (
              <ToolbarButton
                key={action.id}
                onClick={() => handleAction(action.actionType)}
                title={action.description}
              >
                {runningAction === action.actionType ? '...' : action.name}
              </ToolbarButton>
            ))}
          </div>
        )}
```

This goes right after the zoom controls div that closes around line 285, inside the `{imageSrc && (...)}` conditional — but as a sibling to the existing zoom controls div (both wrapped by the status bar flex container).

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ImageViewerPane.tsx
git commit -m "feat(images): add action buttons to ImageViewerPane status bar"
```

---

### Task 9: Add CLI Command Mapping and Validation

**Files:**
- Modify: `src/main/fleet-cli.ts`

- [ ] **Step 1: Add command mappings**

In the `COMMAND_MAP` object (around line 394-400), add after `'images.config': 'image.config.get'`:

```ts
  'images.action': 'image.action',
  'images.actions': 'image.actions.list'
```

- [ ] **Step 2: Add validation**

In the `validateCommand` function's switch statement (around line 663-667), add a new case before the `default:` case:

```ts
    case 'image.action': {
      if (!args.action && !args.id)
        return 'Error: images action requires an action type and source.\n\nUsage: fleet images action <action-type> <source> [--provider <id>]';
      return null;
    }
```

- [ ] **Step 3: Update help text**

In the `HELP_GROUPS.images` string (around line 1108-1137), add to the Commands section:

```
  fleet images action <type> <source>          Run an action on an image (e.g. remove-background)
  fleet images actions                         List available actions
```

And add to the Examples section:

```
  fleet images action remove-background ./photo.png
  fleet images action remove-background ./photo.png --provider fal-ai
  fleet images actions
```

- [ ] **Step 4: Update top-level help**

In `HELP_TOP` (line 702), update the images group description:

```
| images | Generate, edit, and transform AI images. Use when you want to create images from text prompts, edit existing images, run actions like background removal, or check generation status. |
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/fleet-cli.ts
git commit -m "feat(images): add CLI command mapping and help for image actions"
```

---

### Task 10: Add Socket Server Handlers

**Files:**
- Modify: `src/main/socket-server.ts`

- [ ] **Step 1: Add image.action handler**

In `src/main/socket-server.ts`, after the existing `image.delete` case (around line 1170), add:

```ts
      case 'image.action': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const actionType = typeof args.action === 'string' ? args.action : typeof args.id === 'string' ? args.id : undefined;
        if (!actionType) throw new CodedError('image.action requires an action type', 'BAD_REQUEST');
        const source = typeof args.source === 'string' ? args.source : undefined;
        if (!source) throw new CodedError('image.action requires a source image', 'BAD_REQUEST');
        const actionResult = this.imageService.runAction({
          actionType,
          source,
          provider: typeof args.provider === 'string' ? args.provider : undefined
        });
        this.emit('state-change', 'image:changed', { id: actionResult.id });
        return actionResult;
      }

      case 'image.actions.list': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        return this.imageService.listActions(
          typeof args.provider === 'string' ? args.provider : undefined
        );
      }
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/socket-server.ts
git commit -m "feat(images): add socket server handlers for image.action and image.actions.list"
```

---

### Task 11: Full Verification

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors

- [ ] **Step 2: Run linter**

Run: `npm run lint`
Expected: PASS — fix any lint issues that appear

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS — all existing tests still pass

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS — clean build

- [ ] **Step 5: Commit any lint fixes**

If there were lint fixes:

```bash
git add -A
git commit -m "style: fix lint issues from image actions implementation"
```
