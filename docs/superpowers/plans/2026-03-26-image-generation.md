# Image Generation Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fal.ai image generation to Fleet via CLI commands, with a pinned Images tab for browsing and configuring.

**Architecture:** Standalone `ImageService` in the main process behind a provider abstraction (`ImageProvider` interface). CLI commands go through the socket server, images are stored as files with JSON sidecar metadata under `~/.fleet/images/`. A pinned "Images" tab in the renderer provides a grid gallery, detail view, and settings.

**Tech Stack:** `@fal-ai/client` for fal.ai API, Node.js `fs` for file storage, Zustand for renderer state, React for gallery UI.

**Spec:** `docs/superpowers/specs/2026-03-26-image-generation-design.md`

---

### Task 1: Install dependency and add shared types

**Files:**

- Modify: `package.json`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Install @fal-ai/client**

```bash
npm install @fal-ai/client
```

- [ ] **Step 2: Add image-related types to `src/shared/types.ts`**

Append after the `UpdateStatus` type at the end of the file:

```typescript
// ── Image Generation ────────────────────────────────────────────────────────

export type ImageGenerationStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'timeout';

export type ImageGenerationMode = 'generate' | 'edit';

export type ImageFileEntry = {
  filename: string | null;
  width: number | null;
  height: number | null;
  error?: string;
  providerUrl?: string;
};

export type ImageGenerationMeta = {
  id: string;
  status: ImageGenerationStatus;
  createdAt: string;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  provider: string;
  model: string;
  mode: ImageGenerationMode;
  prompt: string;
  params: {
    resolution?: string;
    aspect_ratio?: string;
    output_format?: string;
    num_images?: number;
  };
  referenceImages: string[];
  images: ImageFileEntry[];
  providerRequestId: string | null;
};

export type ImageSettings = {
  defaultProvider: string;
  providers: Record<string, ImageProviderSettings>;
};

export type ImageProviderSettings = {
  apiKey: string;
  defaultModel: string;
  defaultResolution: string;
  defaultOutputFormat: string;
  defaultAspectRatio: string;
};
```

- [ ] **Step 3: Add IPC channels to `src/shared/ipc-channels.ts`**

Add before the closing `} as const;`:

```typescript
  IMAGES_GENERATE: 'images:generate',
  IMAGES_EDIT: 'images:edit',
  IMAGES_STATUS: 'images:status',
  IMAGES_LIST: 'images:list',
  IMAGES_RETRY: 'images:retry',
  IMAGES_DELETE: 'images:delete',
  IMAGES_CONFIG_GET: 'images:config:get',
  IMAGES_CONFIG_SET: 'images:config:set',
  IMAGES_CHANGED: 'images:changed'
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS — new types are additive, no consumers yet.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/shared/types.ts src/shared/ipc-channels.ts
git commit -m "feat(images): add @fal-ai/client dependency and shared types"
```

---

### Task 2: Create provider abstraction and fal.ai provider

**Files:**

- Create: `src/main/image-providers/types.ts`
- Create: `src/main/image-providers/fal-ai.ts`

- [ ] **Step 1: Create `src/main/image-providers/types.ts`**

```typescript
export type GenerateOpts = {
  model: string;
  prompt: string;
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  numImages?: number;
};

export type EditOpts = {
  model: string;
  prompt: string;
  imageUrls: string[];
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  numImages?: number;
};

export type PollResult =
  | { status: 'queued' }
  | { status: 'processing'; progress?: number }
  | { status: 'completed' }
  | { status: 'failed'; error: string };

export type GenerationResult = {
  images: Array<{ url: string; width: number; height: number }>;
  description?: string;
};

export interface ImageProvider {
  id: string;
  name: string;
  configure(settings: Record<string, unknown>): void;
  submit(opts: GenerateOpts | EditOpts): Promise<{ requestId: string }>;
  poll(requestId: string): Promise<PollResult>;
  getResult(requestId: string): Promise<GenerationResult>;
  cancel(requestId: string): Promise<void>;
}
```

- [ ] **Step 2: Create `src/main/image-providers/fal-ai.ts`**

```typescript
import { fal } from '@fal-ai/client';
import type { ImageProvider, GenerateOpts, EditOpts, PollResult, GenerationResult } from './types';

function isEditOpts(opts: GenerateOpts | EditOpts): opts is EditOpts {
  return 'imageUrls' in opts && Array.isArray(opts.imageUrls);
}

export class FalAiProvider implements ImageProvider {
  id = 'fal-ai';
  name = 'fal.ai';
  private currentModel = 'fal-ai/nano-banana-2';

  configure(settings: Record<string, unknown>): void {
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey : '';
    if (apiKey) {
      fal.config({ credentials: apiKey });
    }
  }

  async submit(opts: GenerateOpts | EditOpts): Promise<{ requestId: string }> {
    const model = opts.model || this.currentModel;
    const isEdit = isEditOpts(opts);
    const endpoint = isEdit && !model.endsWith('/edit') ? `${model}/edit` : model;

    const input: Record<string, unknown> = {
      prompt: opts.prompt
    };
    if (opts.resolution) input.resolution = opts.resolution;
    if (opts.aspectRatio) input.aspect_ratio = opts.aspectRatio;
    if (opts.outputFormat) input.output_format = opts.outputFormat;
    if (opts.numImages) input.num_images = opts.numImages;
    if (isEdit) input.image_urls = opts.imageUrls;

    const result = await fal.queue.submit(endpoint, { input });
    return { requestId: result.request_id };
  }

  async poll(requestId: string): Promise<PollResult> {
    const status = await fal.queue.status(this.currentModel, {
      requestId,
      logs: false
    });

    switch (status.status) {
      case 'IN_QUEUE':
        return { status: 'queued' };
      case 'IN_PROGRESS':
        return { status: 'processing' };
      case 'COMPLETED':
        return { status: 'completed' };
      default:
        return { status: 'failed', error: `Unknown status: ${String(status.status)}` };
    }
  }

  async getResult(requestId: string): Promise<GenerationResult> {
    const result = await fal.queue.result(this.currentModel, { requestId });
    const data = result.data as Record<string, unknown>;
    const rawImages = Array.isArray(data.images) ? data.images : [];

    const images = rawImages
      .filter((img): img is Record<string, unknown> => img != null && typeof img === 'object')
      .map((img) => ({
        url: typeof img.url === 'string' ? img.url : '',
        width: typeof img.width === 'number' ? img.width : 0,
        height: typeof img.height === 'number' ? img.height : 0
      }));

    return {
      images,
      description: typeof data.description === 'string' ? data.description : undefined
    };
  }

  async cancel(requestId: string): Promise<void> {
    await fal.queue.cancel(this.currentModel, { requestId });
  }
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/image-providers/
git commit -m "feat(images): add ImageProvider interface and fal.ai provider"
```

---

### Task 3: Create ImageService

**Files:**

- Create: `src/main/image-service.ts`

- [ ] **Step 1: Create `src/main/image-service.ts`**

```typescript
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  ImageGenerationMeta,
  ImageGenerationStatus,
  ImageSettings,
  ImageProviderSettings,
  ImageFileEntry
} from '../shared/types';
import type { ImageProvider, GenerateOpts, EditOpts } from './image-providers/types';
import { FalAiProvider } from './image-providers/fal-ai';

const IMAGES_DIR = join(homedir(), '.fleet', 'images');
const GENERATIONS_DIR = join(IMAGES_DIR, 'generations');
const SETTINGS_PATH = join(IMAGES_DIR, 'settings.json');

const DEFAULT_SETTINGS: ImageSettings = {
  defaultProvider: 'fal-ai',
  providers: {
    'fal-ai': {
      apiKey: '',
      defaultModel: 'fal-ai/nano-banana-2',
      defaultResolution: '1K',
      defaultOutputFormat: 'png',
      defaultAspectRatio: '1:1'
    }
  }
};

const POLL_INITIAL_MS = 1000;
const POLL_MAX_MS = 5000;
const POLL_TIMEOUT_MS = 300_000; // 5 minutes

function generateId(): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-T:.Z]/g, '')
    .slice(0, 14);
  const rand = randomBytes(3).toString('hex');
  return `${ts}-${rand}`;
}

export class ImageService extends EventEmitter {
  private providers = new Map<string, ImageProvider>();
  private activePolls = new Map<string, AbortController>();

  constructor() {
    super();
    mkdirSync(GENERATIONS_DIR, { recursive: true });

    const falProvider = new FalAiProvider();
    this.providers.set(falProvider.id, falProvider);

    this.configureProviders();
  }

  // ── Settings ────────────────────────────────────────────────────────────

  getSettings(): ImageSettings {
    try {
      const raw = readFileSync(SETTINGS_PATH, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed != null && typeof parsed === 'object') {
        return { ...DEFAULT_SETTINGS, ...(parsed as Partial<ImageSettings>) };
      }
    } catch {
      // File doesn't exist or is malformed
    }
    return { ...DEFAULT_SETTINGS };
  }

  updateSettings(partial: Partial<ImageSettings>): void {
    const current = this.getSettings();
    if (partial.defaultProvider) current.defaultProvider = partial.defaultProvider;
    if (partial.providers) {
      for (const [key, val] of Object.entries(partial.providers)) {
        current.providers[key] = { ...current.providers[key], ...val };
      }
    }
    writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2));
    this.configureProviders();
  }

  private configureProviders(): void {
    const settings = this.getSettings();
    for (const [id, provider] of this.providers) {
      const providerSettings = settings.providers[id];
      if (providerSettings) {
        provider.configure(providerSettings as unknown as Record<string, unknown>);
      }
    }
  }

  private getProvider(providerId?: string): ImageProvider {
    const settings = this.getSettings();
    const id = providerId ?? settings.defaultProvider;
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown image provider: ${id}`);
    return provider;
  }

  private getProviderDefaults(providerId?: string): ImageProviderSettings {
    const settings = this.getSettings();
    const id = providerId ?? settings.defaultProvider;
    return settings.providers[id] ?? DEFAULT_SETTINGS.providers['fal-ai'];
  }

  // ── Generate ────────────────────────────────────────────────────────────

  async generate(opts: {
    prompt: string;
    provider?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    outputFormat?: string;
    numImages?: number;
  }): Promise<{ id: string }> {
    const provider = this.getProvider(opts.provider);
    const defaults = this.getProviderDefaults(opts.provider);
    const id = generateId();
    const dir = join(GENERATIONS_DIR, id);
    mkdirSync(dir, { recursive: true });

    const model = opts.model ?? defaults.defaultModel;
    const resolution = opts.resolution ?? defaults.defaultResolution;
    const aspectRatio = opts.aspectRatio ?? defaults.defaultAspectRatio;
    const outputFormat = opts.outputFormat ?? defaults.defaultOutputFormat;

    const meta: ImageGenerationMeta = {
      id,
      status: 'queued',
      createdAt: new Date().toISOString(),
      completedAt: null,
      failedAt: null,
      error: null,
      provider: provider.id,
      model,
      mode: 'generate',
      prompt: opts.prompt,
      params: {
        resolution,
        aspect_ratio: aspectRatio,
        output_format: outputFormat,
        num_images: opts.numImages ?? 1
      },
      referenceImages: [],
      images: [],
      providerRequestId: null
    };

    this.writeMeta(id, meta);

    const genOpts: GenerateOpts = {
      model,
      prompt: opts.prompt,
      resolution,
      aspectRatio,
      outputFormat,
      numImages: opts.numImages
    };

    this.submitAndPoll(id, provider, genOpts);
    return { id };
  }

  // ── Edit ────────────────────────────────────────────────────────────────

  async edit(opts: {
    prompt: string;
    images: string[];
    provider?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    outputFormat?: string;
    numImages?: number;
  }): Promise<{ id: string }> {
    const provider = this.getProvider(opts.provider);
    const defaults = this.getProviderDefaults(opts.provider);
    const id = generateId();
    const dir = join(GENERATIONS_DIR, id);
    mkdirSync(dir, { recursive: true });

    const model = opts.model ?? defaults.defaultModel;
    const resolution = opts.resolution ?? defaults.defaultResolution;
    const aspectRatio = opts.aspectRatio ?? defaults.defaultAspectRatio;
    const outputFormat = opts.outputFormat ?? defaults.defaultOutputFormat;

    const meta: ImageGenerationMeta = {
      id,
      status: 'queued',
      createdAt: new Date().toISOString(),
      completedAt: null,
      failedAt: null,
      error: null,
      provider: provider.id,
      model,
      mode: 'edit',
      prompt: opts.prompt,
      params: {
        resolution,
        aspect_ratio: aspectRatio,
        output_format: outputFormat,
        num_images: opts.numImages ?? 1
      },
      referenceImages: opts.images,
      images: [],
      providerRequestId: null
    };

    this.writeMeta(id, meta);

    const editOpts: EditOpts = {
      model,
      prompt: opts.prompt,
      imageUrls: opts.images,
      resolution,
      aspectRatio,
      outputFormat,
      numImages: opts.numImages
    };

    this.submitAndPoll(id, provider, editOpts);
    return { id };
  }

  // ── Status / List / Delete ──────────────────────────────────────────────

  getStatus(id: string): ImageGenerationMeta | null {
    return this.readMeta(id);
  }

  list(): ImageGenerationMeta[] {
    if (!existsSync(GENERATIONS_DIR)) return [];
    const entries = readdirSync(GENERATIONS_DIR, { withFileTypes: true });
    const metas: ImageGenerationMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = this.readMeta(entry.name);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return metas;
  }

  delete(id: string): void {
    const dir = join(GENERATIONS_DIR, id);
    if (existsSync(dir)) {
      const controller = this.activePolls.get(id);
      if (controller) controller.abort();
      rmSync(dir, { recursive: true, force: true });
      this.emit('changed', id);
    }
  }

  // ── Retry ───────────────────────────────────────────────────────────────

  async retry(id: string): Promise<{ id: string }> {
    const meta = this.readMeta(id);
    if (!meta) throw new Error(`Generation not found: ${id}`);
    if (meta.status !== 'failed' && meta.status !== 'timeout' && meta.status !== 'partial') {
      throw new Error(`Cannot retry generation with status: ${meta.status}`);
    }

    const provider = this.getProvider(meta.provider);

    meta.status = 'queued';
    meta.error = null;
    meta.failedAt = null;
    meta.completedAt = null;
    meta.images = [];
    meta.providerRequestId = null;
    this.writeMeta(id, meta);

    const isEdit = meta.mode === 'edit';
    const opts = isEdit
      ? ({
          model: meta.model,
          prompt: meta.prompt,
          imageUrls: meta.referenceImages,
          resolution: meta.params.resolution,
          aspectRatio: meta.params.aspect_ratio,
          outputFormat: meta.params.output_format,
          numImages: meta.params.num_images
        } satisfies EditOpts)
      : ({
          model: meta.model,
          prompt: meta.prompt,
          resolution: meta.params.resolution,
          aspectRatio: meta.params.aspect_ratio,
          outputFormat: meta.params.output_format,
          numImages: meta.params.num_images
        } satisfies GenerateOpts);

    this.submitAndPoll(id, provider, opts);
    return { id };
  }

  // ── Startup recovery ───────────────────────────────────────────────────

  resumeInterrupted(): void {
    const metas = this.list();
    for (const meta of metas) {
      if ((meta.status === 'queued' || meta.status === 'processing') && meta.providerRequestId) {
        const provider = this.providers.get(meta.provider);
        if (provider) {
          this.pollLoop(meta.id, provider, meta.providerRequestId);
        }
      }
    }
  }

  // ── Shutdown ────────────────────────────────────────────────────────────

  shutdown(): void {
    for (const controller of this.activePolls.values()) {
      controller.abort();
    }
    this.activePolls.clear();
  }

  // ── Internal: submit + poll ─────────────────────────────────────────────

  private submitAndPoll(id: string, provider: ImageProvider, opts: GenerateOpts | EditOpts): void {
    void (async () => {
      try {
        const { requestId } = await provider.submit(opts);
        const meta = this.readMeta(id);
        if (meta) {
          meta.providerRequestId = requestId;
          meta.status = 'processing';
          this.writeMeta(id, meta);
          this.emit('changed', id);
        }
        this.pollLoop(id, provider, requestId);
      } catch (err) {
        this.markFailed(id, err instanceof Error ? err.message : String(err));
      }
    })();
  }

  private pollLoop(id: string, provider: ImageProvider, requestId: string): void {
    const controller = new AbortController();
    this.activePolls.set(id, controller);

    void (async () => {
      let delay = POLL_INITIAL_MS;
      const startTime = Date.now();

      while (!controller.signal.aborted) {
        if (Date.now() - startTime > POLL_TIMEOUT_MS) {
          this.markStatus(id, 'timeout', 'Generation timed out after 300s');
          break;
        }

        await new Promise((r) => setTimeout(r, delay));
        if (controller.signal.aborted) break;
        delay = Math.min(delay * 1.5, POLL_MAX_MS);

        try {
          const poll = await provider.poll(requestId);

          if (poll.status === 'completed') {
            await this.downloadResults(id, provider, requestId);
            break;
          } else if (poll.status === 'failed') {
            this.markFailed(id, poll.error);
            break;
          }
          // queued or processing — continue polling
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('401') || msg.includes('Unauthorized')) {
            this.markFailed(id, 'Invalid API key. Run: fleet images config --api-key <key>');
            break;
          }
          if (msg.includes('429') || msg.includes('rate limit')) {
            this.markFailed(id, 'Rate limited by provider. Try again later.');
            break;
          }
          // Network error — keep retrying within timeout
        }
      }

      this.activePolls.delete(id);
    })();
  }

  private async downloadResults(
    id: string,
    provider: ImageProvider,
    requestId: string
  ): Promise<void> {
    try {
      const result = await provider.getResult(requestId);
      const meta = this.readMeta(id);
      if (!meta) return;

      const dir = join(GENERATIONS_DIR, id);
      const format = meta.params.output_format ?? 'png';
      const imageEntries: ImageFileEntry[] = [];
      let hasFailure = false;

      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        const filename = `image-${String(i + 1).padStart(3, '0')}.${format}`;
        const filePath = join(dir, filename);

        try {
          const response = await fetch(img.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          writeFileSync(filePath, buffer);

          imageEntries.push({ filename, width: img.width, height: img.height });
        } catch (dlErr) {
          hasFailure = true;
          imageEntries.push({
            filename: null,
            width: img.width,
            height: img.height,
            error: `Download failed: ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`,
            providerUrl: img.url
          });
        }
      }

      meta.images = imageEntries;
      if (hasFailure && imageEntries.some((e) => e.filename != null)) {
        meta.status = 'partial';
      } else if (hasFailure) {
        meta.status = 'failed';
        meta.error = 'All image downloads failed';
        meta.failedAt = new Date().toISOString();
      } else {
        meta.status = 'completed';
        meta.completedAt = new Date().toISOString();
      }

      this.writeMeta(id, meta);
      this.emit('changed', id);
    } catch (err) {
      this.markFailed(id, `Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Internal: meta helpers ──────────────────────────────────────────────

  private readMeta(id: string): ImageGenerationMeta | null {
    const metaPath = join(GENERATIONS_DIR, id, 'meta.json');
    try {
      const raw = readFileSync(metaPath, 'utf8');
      return JSON.parse(raw) as ImageGenerationMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(id: string, meta: ImageGenerationMeta): void {
    const metaPath = join(GENERATIONS_DIR, id, 'meta.json');
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  private markFailed(id: string, error: string): void {
    this.markStatus(id, 'failed', error);
  }

  private markStatus(id: string, status: ImageGenerationStatus, error: string): void {
    const meta = this.readMeta(id);
    if (!meta) return;
    meta.status = status;
    meta.error = error;
    meta.failedAt = new Date().toISOString();
    this.writeMeta(id, meta);
    this.emit('changed', id);
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/image-service.ts
git commit -m "feat(images): add ImageService with generate, edit, retry, and background polling"
```

---

### Task 4: Wire ImageService into socket server dispatch

**Files:**

- Modify: `src/main/socket-server.ts`

- [ ] **Step 1: Add ImageService to constructor and ServiceRegistry**

The `SocketServer` needs access to the `ImageService`. Since `ImageService` is not part of the Starbase `ServiceRegistry`, we pass it separately. Add an optional `imageService` property.

At the top of `src/main/socket-server.ts`, add the import:

```typescript
import type { ImageService } from './image-service';
```

Modify the `SocketServer` constructor to accept an optional `ImageService`:

```typescript
  constructor(
    private socketPath: string,
    private services: ServiceRegistry | AsyncServiceRegistry,
    private imageService?: ImageService
  ) {
    super();
  }
```

- [ ] **Step 2: Add image dispatch cases**

In the `dispatch()` method, before the `default:` case in the switch statement, add:

```typescript
      // ── Images ──────────────────────────────────────────────────────────────
      case 'image.generate': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
        if (!prompt) throw new CodedError('image.generate requires a prompt', 'BAD_REQUEST');
        const result = await this.imageService.generate({
          prompt,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          aspectRatio: typeof args.aspectRatio === 'string' || typeof args['aspect-ratio'] === 'string'
            ? (typeof args.aspectRatio === 'string' ? args.aspectRatio : String(args['aspect-ratio']))
            : undefined,
          outputFormat: typeof args.format === 'string' ? args.format : undefined,
          numImages: typeof args['num-images'] === 'string' ? Number(args['num-images']) : undefined
        });
        this.emit('state-change', 'image:changed', { id: result.id });
        return result;
      }

      case 'image.edit': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const editPrompt = typeof args.prompt === 'string' ? args.prompt : undefined;
        if (!editPrompt) throw new CodedError('image.edit requires a prompt', 'BAD_REQUEST');
        const rawImages = args.images;
        const images = Array.isArray(rawImages)
          ? rawImages.filter((x): x is string => typeof x === 'string')
          : typeof rawImages === 'string'
            ? [rawImages]
            : [];
        if (images.length === 0) throw new CodedError('image.edit requires --images', 'BAD_REQUEST');
        const editResult = await this.imageService.edit({
          prompt: editPrompt,
          images,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          aspectRatio: typeof args.aspectRatio === 'string' || typeof args['aspect-ratio'] === 'string'
            ? (typeof args.aspectRatio === 'string' ? args.aspectRatio : String(args['aspect-ratio']))
            : undefined,
          outputFormat: typeof args.format === 'string' ? args.format : undefined,
          numImages: typeof args['num-images'] === 'string' ? Number(args['num-images']) : undefined
        });
        this.emit('state-change', 'image:changed', { id: editResult.id });
        return editResult;
      }

      case 'image.status': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const statusId = typeof args.id === 'string' ? args.id : undefined;
        if (!statusId) throw new CodedError('image.status requires an id', 'BAD_REQUEST');
        const meta = this.imageService.getStatus(statusId);
        if (!meta) throw new CodedError(`Generation not found: ${statusId}`, 'NOT_FOUND');
        return meta;
      }

      case 'image.list': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        return this.imageService.list();
      }

      case 'image.retry': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const retryId = typeof args.id === 'string' ? args.id : undefined;
        if (!retryId) throw new CodedError('image.retry requires an id', 'BAD_REQUEST');
        const retryResult = await this.imageService.retry(retryId);
        this.emit('state-change', 'image:changed', { id: retryResult.id });
        return retryResult;
      }

      case 'image.delete': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const deleteId = typeof args.id === 'string' ? args.id : undefined;
        if (!deleteId) throw new CodedError('image.delete requires an id', 'BAD_REQUEST');
        this.imageService.delete(deleteId);
        this.emit('state-change', 'image:changed', { id: deleteId });
        return { deleted: true };
      }

      case 'image.config.get': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const settings = this.imageService.getSettings();
        // Redact API keys
        const redacted = { ...settings, providers: { ...settings.providers } };
        for (const [key, val] of Object.entries(redacted.providers)) {
          redacted.providers[key] = {
            ...val,
            apiKey: val.apiKey ? `${val.apiKey.slice(0, 4)}***` : ''
          };
        }
        return redacted;
      }

      case 'image.config.set': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const providerId = typeof args.provider === 'string' ? args.provider : undefined;
        const providerKey = providerId ?? this.imageService.getSettings().defaultProvider;
        const providerUpdate: Record<string, unknown> = {};
        if (typeof args['api-key'] === 'string') providerUpdate.apiKey = args['api-key'];
        if (typeof args['default-model'] === 'string') providerUpdate.defaultModel = args['default-model'];
        if (typeof args['default-resolution'] === 'string') providerUpdate.defaultResolution = args['default-resolution'];
        if (typeof args['default-output-format'] === 'string') providerUpdate.defaultOutputFormat = args['default-output-format'];
        if (typeof args['default-aspect-ratio'] === 'string') providerUpdate.defaultAspectRatio = args['default-aspect-ratio'];
        if (Object.keys(providerUpdate).length > 0) {
          this.imageService.updateSettings({
            providers: { [providerKey]: providerUpdate as Partial<import('../shared/types').ImageProviderSettings> as import('../shared/types').ImageProviderSettings }
          });
        }
        this.emit('state-change', 'image:changed', {});
        return { updated: true };
      }
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/socket-server.ts
git commit -m "feat(images): add image.* dispatch cases to socket server"
```

---

### Task 5: Initialize ImageService in main process and wire IPC

**Files:**

- Modify: `src/main/index.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Import and instantiate ImageService in `src/main/index.ts`**

Add import near the top with other imports:

```typescript
import { ImageService } from './image-service';
```

Add after the other singleton instantiations (around line 58, after `runtimeClient`):

```typescript
const imageService = new ImageService();
```

- [ ] **Step 2: Pass imageService to SocketServer**

Find where `SocketServer` is instantiated (inside the `SocketSupervisor` creation). The `SocketSupervisor` creates `SocketServer` internally — we need to find how services are passed. Look at `socket-supervisor.ts` to understand how to add `imageService`.

The `SocketSupervisor` wraps `SocketServer`. Update the `SocketSupervisor` constructor call to pass `imageService`. This depends on how `SocketSupervisor` creates the `SocketServer`. The simplest approach: pass `imageService` through.

In `src/main/index.ts`, find the `SocketSupervisor` creation and pass `imageService` as an additional argument. The exact location depends on how the supervisor is initialized — look for `new SocketSupervisor(` and add `imageService` to the constructor args.

- [ ] **Step 3: Register IPC handlers for images**

In `src/main/ipc-handlers.ts` or directly in `src/main/index.ts`, add IPC handlers that delegate to `imageService`:

```typescript
ipcMain.handle(IPC_CHANNELS.IMAGES_GENERATE, async (_e, opts) => imageService.generate(opts));
ipcMain.handle(IPC_CHANNELS.IMAGES_EDIT, async (_e, opts) => imageService.edit(opts));
ipcMain.handle(IPC_CHANNELS.IMAGES_STATUS, async (_e, id: string) => imageService.getStatus(id));
ipcMain.handle(IPC_CHANNELS.IMAGES_LIST, async () => imageService.list());
ipcMain.handle(IPC_CHANNELS.IMAGES_RETRY, async (_e, id: string) => imageService.retry(id));
ipcMain.handle(IPC_CHANNELS.IMAGES_DELETE, async (_e, id: string) => imageService.delete(id));
ipcMain.handle(IPC_CHANNELS.IMAGES_CONFIG_GET, async () => {
  const settings = imageService.getSettings();
  const redacted = { ...settings, providers: { ...settings.providers } };
  for (const [key, val] of Object.entries(redacted.providers)) {
    redacted.providers[key] = { ...val, apiKey: val.apiKey ? `${val.apiKey.slice(0, 4)}***` : '' };
  }
  return redacted;
});
ipcMain.handle(IPC_CHANNELS.IMAGES_CONFIG_SET, async (_e, partial) => {
  imageService.updateSettings(partial);
});
```

- [ ] **Step 4: Forward imageService `changed` events to renderer**

In `src/main/index.ts`, after creating `imageService`, add:

```typescript
imageService.on('changed', (id: string) => {
  const windowRef = mainWindow;
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.webContents.send(IPC_CHANNELS.IMAGES_CHANGED, { id });
  }
});
```

- [ ] **Step 5: Resume interrupted generations on startup**

In the app `ready` handler (after the window is created and services are initialized), add:

```typescript
imageService.resumeInterrupted();
```

- [ ] **Step 6: Shutdown on quit**

In the `before-quit` handler, add:

```typescript
imageService.shutdown();
```

- [ ] **Step 7: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/main/ipc-handlers.ts
git commit -m "feat(images): wire ImageService into main process with IPC handlers"
```

---

### Task 6: Add preload bridge for images

**Files:**

- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add image types to preload imports**

Add to the import from `'../shared/ipc-api'` (or add a new import from `'../shared/types'`):

```typescript
import type { ImageGenerationMeta, ImageSettings } from '../shared/types';
```

- [ ] **Step 2: Add `images` namespace to `fleetApi`**

Add before the closing `};` of the `fleetApi` object (before the `shell` namespace):

```typescript
  images: {
    generate: async (opts: {
      prompt: string;
      provider?: string;
      model?: string;
      resolution?: string;
      aspectRatio?: string;
      outputFormat?: string;
      numImages?: number;
    }): Promise<{ id: string }> => typedInvoke(IPC_CHANNELS.IMAGES_GENERATE, opts),
    edit: async (opts: {
      prompt: string;
      images: string[];
      provider?: string;
      model?: string;
      resolution?: string;
      aspectRatio?: string;
      outputFormat?: string;
      numImages?: number;
    }): Promise<{ id: string }> => typedInvoke(IPC_CHANNELS.IMAGES_EDIT, opts),
    getStatus: async (id: string): Promise<ImageGenerationMeta | null> =>
      typedInvoke(IPC_CHANNELS.IMAGES_STATUS, id),
    list: async (): Promise<ImageGenerationMeta[]> => typedInvoke(IPC_CHANNELS.IMAGES_LIST),
    retry: async (id: string): Promise<{ id: string }> =>
      typedInvoke(IPC_CHANNELS.IMAGES_RETRY, id),
    delete: async (id: string): Promise<void> => typedInvoke(IPC_CHANNELS.IMAGES_DELETE, id),
    getConfig: async (): Promise<ImageSettings> => typedInvoke(IPC_CHANNELS.IMAGES_CONFIG_GET),
    setConfig: async (partial: Partial<ImageSettings>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.IMAGES_CONFIG_SET, partial),
    onChanged: (callback: (payload: { id: string }) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.IMAGES_CHANGED, callback)
  },
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(images): add window.fleet.images preload bridge"
```

---

### Task 7: Add CLI commands for images

**Files:**

- Modify: `src/main/fleet-cli.ts`

- [ ] **Step 1: Add command mappings to `COMMAND_MAP`**

Add to the `COMMAND_MAP` object:

```typescript
  // Images
  'images.generate': 'image.generate',
  'images.edit': 'image.edit',
  'images.status': 'image.status',
  'images.list': 'image.list',
  'images.retry': 'image.retry',
  'images.config': 'image.config.get',
```

- [ ] **Step 2: Update `parseArgs` to support `--images` as array**

In the `parseArgs` function, modify the flag accumulation logic. Currently only `--depends-on` accumulates into arrays. Update the condition to also accumulate `--images`:

Change the condition on line 153 from:

```typescript
        if (key === 'depends-on') {
```

To:

```typescript
        if (key === 'depends-on' || key === 'images') {
```

- [ ] **Step 3: Add validation cases**

Add to the `validateCommand` function's switch statement:

```typescript
    case 'image.generate':
      if (!args.prompt)
        return 'Error: images generate requires --prompt.\n\nUsage: fleet images generate --prompt "description"';
      return null;

    case 'image.edit': {
      if (!args.prompt)
        return 'Error: images edit requires --prompt.\n\nUsage: fleet images edit --prompt "description" --images <file1> [file2 ...]';
      if (!args.images)
        return 'Error: images edit requires --images.\n\nUsage: fleet images edit --prompt "description" --images <file1> [file2 ...]';
      // Validate local files exist
      const imageFiles = Array.isArray(args.images) ? args.images : [args.images];
      for (const img of imageFiles) {
        if (typeof img !== 'string') continue;
        // Skip URLs
        if (img.startsWith('http://') || img.startsWith('https://')) continue;
        const resolved = resolve(img);
        if (!existsSync(resolved)) {
          return `Error: file not found: ${img}`;
        }
      }
      return null;
    }

    case 'image.status':
    case 'image.retry':
      if (!args.id) return `Error: images ${command === 'image.status' ? 'status' : 'retry'} requires an ID.\n\nUsage: fleet images ${command === 'image.status' ? 'status' : 'retry'} <generation-id>`;
      return null;
```

- [ ] **Step 4: Handle `images config` with args as set**

In `runCLI`, add special handling for `images config` before the standard command mapping. The config command uses the same CLI syntax but routes to either `get` or `set` based on whether flags are provided:

Add this before the `if (!group || !action)` check in `runCLI`:

```typescript
// ── Images config (get or set based on flags) ──────────────────────────
if (group === 'images' && action === 'config') {
  const configArgs = parseArgs(rest.filter((t) => t !== '--quiet' && t !== '--format'));
  const hasSetFlags = Object.keys(configArgs).some((k) =>
    [
      'api-key',
      'default-model',
      'default-resolution',
      'default-output-format',
      'default-aspect-ratio',
      'provider'
    ].includes(k)
  );
  const command = hasSetFlags ? 'image.config.set' : 'image.config.get';
  const cli = new FleetCLI(sockPath);
  try {
    const response = opts?.retry
      ? await cli.sendWithRetry(command, configArgs)
      : await cli.send(command, configArgs);
    if (!response.ok) return `Error: ${response.error ?? 'Unknown error'}`;
    if (command === 'image.config.set') return 'Configuration updated.';
    // Format config output
    if (isRecord(response.data)) {
      const lines: string[] = [];
      const data = response.data as Record<string, unknown>;
      if (data.defaultProvider) lines.push(`defaultProvider: ${toStr(data.defaultProvider)}`);
      const providers = data.providers;
      if (isRecord(providers)) {
        for (const [name, val] of Object.entries(providers)) {
          lines.push(`${name}:`);
          if (isRecord(val)) {
            for (const [k, v] of Object.entries(val)) {
              lines.push(`  ${k}: ${toStr(v)}`);
            }
          }
        }
      }
      return lines.join('\n');
    }
    return toStr(response.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}
```

- [ ] **Step 5: Add images-specific output formatting**

Add after the `comms.check` special formatting in `runCLI`:

```typescript
// ── image.generate / image.edit formatting ──────────────────────────────
if (
  (command === 'image.generate' || command === 'image.edit') &&
  isRecord(data) &&
  typeof data.id === 'string'
) {
  return `Submitted: ${data.id}`;
}

// ── image.status formatting ─────────────────────────────────────────────
if (command === 'image.status' && isRecord(data)) {
  const lines: string[] = [];
  lines.push(`status: ${toStr(data.status)}`);
  if (data.status === 'completed' || data.status === 'partial') {
    lines.push(`path: ~/.fleet/images/generations/${toStr(data.id)}`);
    if (Array.isArray(data.images)) {
      const filenames = data.images
        .filter(
          (img): img is Record<string, unknown> => isRecord(img) && typeof img.filename === 'string'
        )
        .map((img) => img.filename);
      if (filenames.length > 0) lines.push(`images: ${filenames.join(', ')}`);
    }
  }
  if (data.error) lines.push(`error: ${toStr(data.error)}`);
  return lines.join('\n');
}

// ── image.list formatting ───────────────────────────────────────────────
if (command === 'image.list') {
  if (!Array.isArray(data) || data.length === 0) return 'No images found.';
  const rows = data
    .filter((d): d is Record<string, unknown> => isRecord(d))
    .map((d) => ({
      ID: toStr(d.id),
      STATUS: toStr(d.status),
      MODE: toStr(d.mode),
      MODEL: toStr(d.model),
      PROMPT: toStr(d.prompt).slice(0, 40) + (toStr(d.prompt).length > 40 ? '...' : '')
    }));
  return formatTable(rows);
}
```

- [ ] **Step 6: Add help text for images**

Add to the `HELP_GROUPS` object:

```typescript
images: `\n# fleet images\n
Manage AI image generation.

## Commands

  fleet images generate --prompt "..."         Generate image(s) from a text prompt
  fleet images edit --prompt "..." --images <file1> [file2 ...]  Edit images with a prompt
  fleet images status <id>                     Check generation status
  fleet images list                            List all generations
  fleet images retry <id>                      Retry a failed generation
  fleet images config                          Show current configuration
  fleet images config --api-key <key>          Set fal.ai API key

## Options (generate/edit)

  --provider <id>         Image provider (default: fal-ai)
  --model <model>         Model to use (default: fal-ai/nano-banana-2)
  --resolution <res>      0.5K, 1K, 2K, or 4K (default: 1K)
  --aspect-ratio <ratio>  e.g. 1:1, 16:9, 9:16 (default: 1:1)
  --format <fmt>          png, jpeg, or webp (default: png)
  --num-images <n>        1-4 (default: 1)

## Examples

\\\`\\\`\\\`bash
fleet images generate --prompt "A cat in space" --resolution 2K
fleet images edit --prompt "Add a hat" --images ./cat.png
fleet images config --api-key sk-xxx
\\\`\\\`\\\``;
```

- [ ] **Step 7: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/fleet-cli.ts
git commit -m "feat(images): add fleet images CLI commands"
```

---

### Task 8: Add pinned Images tab type and ensure it exists

**Files:**

- Modify: `src/shared/types.ts` — add `'images'` to tab type union
- Modify: `src/main/layout-store.ts` — add `ensureImagesTab`

- [ ] **Step 1: Add `'images'` to Tab type union**

In `src/shared/types.ts`, update the `type` field in `Tab`:

```typescript
  type?: 'terminal' | 'star-command' | 'crew' | 'file' | 'image' | 'images';
```

Also update `PaneLeaf.paneType`:

```typescript
  paneType?: 'terminal' | 'file' | 'image' | 'images';
```

- [ ] **Step 2: Add `ensureImagesTab` to `LayoutStore`**

In `src/main/layout-store.ts`, add after `ensureStarCommandTab`:

```typescript
  ensureImagesTab(workspaceId: string, cwd: string): void {
    const workspace = this.load(workspaceId);
    if (!workspace) return;

    const hasImages = workspace.tabs.some((t) => t.type === 'images');
    if (hasImages) return;

    const paneId = randomUUID();
    const imagesTab: Tab = {
      id: randomUUID(),
      label: 'Images',
      labelIsCustom: true,
      cwd,
      type: 'images',
      splitRoot: { type: 'leaf', id: paneId, cwd }
    };

    // Insert after star-command tab if it exists, otherwise at the start
    const starIdx = workspace.tabs.findIndex((t) => t.type === 'star-command');
    if (starIdx !== -1) {
      workspace.tabs.splice(starIdx + 1, 0, imagesTab);
    } else {
      workspace.tabs.unshift(imagesTab);
    }

    this.save(workspace);
  }
```

- [ ] **Step 3: Call `ensureImagesTab` wherever `ensureStarCommandTab` is called**

Find all call sites of `ensureStarCommandTab` in `src/main/index.ts` and `src/main/ipc-handlers.ts` and add `ensureImagesTab` immediately after each one with the same arguments.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/layout-store.ts src/main/index.ts src/main/ipc-handlers.ts
git commit -m "feat(images): add pinned Images tab type and ensureImagesTab"
```

---

### Task 9: Create Zustand image store

**Files:**

- Create: `src/renderer/src/store/image-store.ts`

- [ ] **Step 1: Create the store**

```typescript
import { create } from 'zustand';
import type { ImageGenerationMeta, ImageSettings } from '../../../shared/types';

type ImageStore = {
  generations: ImageGenerationMeta[];
  config: ImageSettings | null;
  isLoaded: boolean;
  loadGenerations: () => Promise<void>;
  loadConfig: () => Promise<void>;
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
  retry: (id: string) => Promise<void>;
  deleteGeneration: (id: string) => Promise<void>;
  updateConfig: (partial: Partial<ImageSettings>) => Promise<void>;
};

export const useImageStore = create<ImageStore>((set) => ({
  generations: [],
  config: null,
  isLoaded: false,

  loadGenerations: async () => {
    const generations = await window.fleet.images.list();
    set({ generations, isLoaded: true });
  },

  loadConfig: async () => {
    const config = await window.fleet.images.getConfig();
    set({ config });
  },

  generate: async (opts) => {
    const result = await window.fleet.images.generate(opts);
    // Will be updated via onChanged event
    return result;
  },

  edit: async (opts) => {
    const result = await window.fleet.images.edit(opts);
    return result;
  },

  retry: async (id) => {
    await window.fleet.images.retry(id);
  },

  deleteGeneration: async (id) => {
    await window.fleet.images.delete(id);
    set((state) => ({
      generations: state.generations.filter((g) => g.id !== id)
    }));
  },

  updateConfig: async (partial) => {
    await window.fleet.images.setConfig(partial);
    const config = await window.fleet.images.getConfig();
    set({ config });
  }
}));
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/image-store.ts
git commit -m "feat(images): add Zustand image store"
```

---

### Task 10: Create ImageGallery components

**Files:**

- Create: `src/renderer/src/components/ImageGallery/ImageGallery.tsx`
- Create: `src/renderer/src/components/ImageGallery/ImageGrid.tsx`
- Create: `src/renderer/src/components/ImageGallery/ImageDetail.tsx`
- Create: `src/renderer/src/components/ImageGallery/ImageSettings.tsx`

This is the largest task. Each component is self-contained.

- [ ] **Step 1: Create `ImageSettings.tsx`**

```typescript
import { useState, useEffect } from 'react';
import { useImageStore } from '../../store/image-store';

const RESOLUTIONS = ['0.5K', '1K', '2K', '4K'];
const FORMATS = ['png', 'jpeg', 'webp'];
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];

export function ImageSettings(): React.JSX.Element {
  const { config, loadConfig, updateConfig } = useImageStore();
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  if (!config) {
    return <div className="p-4 text-neutral-400">Loading settings...</div>;
  }

  const provider = config.providers[config.defaultProvider];
  if (!provider) {
    return <div className="p-4 text-neutral-400">No provider configured.</div>;
  }

  const handleApiKeySave = (): void => {
    if (!apiKeyInput) return;
    void updateConfig({
      providers: {
        [config.defaultProvider]: { ...provider, apiKey: apiKeyInput }
      }
    });
    setApiKeyInput('');
  };

  return (
    <div className="p-4 space-y-4 max-w-md">
      <h3 className="text-sm font-medium text-neutral-200">Image Generation Settings</h3>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Provider</label>
          <div className="text-sm text-neutral-200 bg-neutral-800 rounded px-3 py-1.5">
            {config.defaultProvider}
          </div>
        </div>

        <div>
          <label className="block text-xs text-neutral-400 mb-1">API Key</label>
          <div className="flex gap-2">
            <input
              type={apiKeyVisible ? 'text' : 'password'}
              className="flex-1 bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700 focus:border-cyan-500 outline-none"
              placeholder={provider.apiKey ? '••••••••' : 'Enter API key'}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleApiKeySave(); }}
            />
            <button
              className="text-xs text-neutral-400 hover:text-neutral-200 px-2"
              onClick={() => setApiKeyVisible(!apiKeyVisible)}
            >
              {apiKeyVisible ? 'Hide' : 'Show'}
            </button>
            <button
              className="text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded px-3 py-1.5"
              onClick={handleApiKeySave}
            >
              Save
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs text-neutral-400 mb-1">Default Model</label>
          <div className="text-sm text-neutral-200 bg-neutral-800 rounded px-3 py-1.5">
            {provider.defaultModel}
          </div>
        </div>

        <div>
          <label className="block text-xs text-neutral-400 mb-1">Default Resolution</label>
          <select
            className="w-full bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700"
            value={provider.defaultResolution}
            onChange={(e) => void updateConfig({
              providers: { [config.defaultProvider]: { ...provider, defaultResolution: e.target.value } }
            })}
          >
            {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs text-neutral-400 mb-1">Default Format</label>
          <select
            className="w-full bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700"
            value={provider.defaultOutputFormat}
            onChange={(e) => void updateConfig({
              providers: { [config.defaultProvider]: { ...provider, defaultOutputFormat: e.target.value } }
            })}
          >
            {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs text-neutral-400 mb-1">Default Aspect Ratio</label>
          <select
            className="w-full bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700"
            value={provider.defaultAspectRatio}
            onChange={(e) => void updateConfig({
              providers: { [config.defaultProvider]: { ...provider, defaultAspectRatio: e.target.value } }
            })}
          >
            {ASPECT_RATIOS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `ImageGrid.tsx`**

```typescript
import { useMemo } from 'react';
import type { ImageGenerationMeta } from '../../../../shared/types';

type ImageGridProps = {
  generations: ImageGenerationMeta[];
  onSelect: (id: string) => void;
};

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  switch (status) {
    case 'queued':
    case 'processing':
      return <span className="absolute top-2 right-2 w-3 h-3 bg-cyan-400 rounded-full animate-pulse" />;
    case 'failed':
    case 'timeout':
      return <span className="absolute top-2 right-2 w-3 h-3 bg-red-400 rounded-full" />;
    case 'partial':
      return <span className="absolute top-2 right-2 w-3 h-3 bg-amber-400 rounded-full" />;
    default:
      return <></>;
  }
}

export function ImageGrid({ generations, onSelect }: ImageGridProps): React.JSX.Element {
  const sorted = useMemo(
    () => [...generations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [generations]
  );

  if (sorted.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
        No images yet. Generate one with:<br />
        <code className="mt-2 text-xs bg-neutral-800 rounded px-2 py-1">
          fleet images generate --prompt "..."
        </code>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4 overflow-y-auto">
      {sorted.map((gen) => {
        const firstImage = gen.images.find((img) => img.filename);
        const thumbSrc = firstImage?.filename
          ? `fleet-local://images/generations/${gen.id}/${firstImage.filename}`
          : undefined;

        return (
          <button
            key={gen.id}
            className="relative bg-neutral-800 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-cyan-500 transition-all aspect-square group"
            onClick={() => onSelect(gen.id)}
          >
            {thumbSrc ? (
              <img
                src={thumbSrc}
                alt={gen.prompt}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-neutral-600">
                {gen.status === 'queued' || gen.status === 'processing' ? (
                  <svg className="w-8 h-8 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : (
                  <span className="text-2xl">!</span>
                )}
              </div>
            )}
            <StatusBadge status={gen.status} />
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <p className="text-xs text-white truncate">{gen.prompt}</p>
              <p className="text-xs text-neutral-400">{gen.model.split('/').pop()}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

Note: The `fleet-local://` protocol for loading local images needs to be registered in the main process, OR we use the existing `file.readBinary` IPC. The simpler approach is to use a `data:` URI loaded via IPC. An implementor should check which approach the existing `image` tab type uses for displaying local images and follow the same pattern.

- [ ] **Step 3: Create `ImageDetail.tsx`**

```typescript
import type { ImageGenerationMeta } from '../../../../shared/types';
import { useImageStore } from '../../store/image-store';

type ImageDetailProps = {
  generation: ImageGenerationMeta;
  onBack: () => void;
};

export function ImageDetail({ generation, onBack }: ImageDetailProps): React.JSX.Element {
  const { retry, deleteGeneration } = useImageStore();
  const gen = generation;
  const images = gen.images.filter((img) => img.filename);
  const failedImages = gen.images.filter((img) => !img.filename);

  const handleRetry = (): void => { void retry(gen.id); };
  const handleDelete = (): void => { void deleteGeneration(gen.id); onBack(); };
  const handleCopyPath = (): void => {
    void navigator.clipboard.writeText(`~/.fleet/images/generations/${gen.id}`);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-neutral-800">
        <button
          className="text-neutral-400 hover:text-white text-sm"
          onClick={onBack}
        >
          &larr; Back
        </button>
        <span className="text-sm text-neutral-500">{gen.id}</span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Image preview */}
        <div className="flex-1 flex items-center justify-center bg-neutral-950 p-4 overflow-auto">
          {images.length > 0 ? (
            <div className="flex gap-4 flex-wrap justify-center">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={`fleet-local://images/generations/${gen.id}/${img.filename}`}
                  alt={`Generated image ${i + 1}`}
                  className="max-w-full max-h-[70vh] rounded-lg object-contain"
                />
              ))}
            </div>
          ) : (
            <div className="text-neutral-500 text-sm">
              {gen.status === 'queued' || gen.status === 'processing'
                ? 'Generating...'
                : 'No images available'}
            </div>
          )}
        </div>

        {/* Metadata sidebar */}
        <div className="w-72 border-l border-neutral-800 overflow-y-auto p-4 space-y-3">
          <div>
            <span className="text-xs text-neutral-500">Status</span>
            <p className={`text-sm ${gen.status === 'completed' ? 'text-green-400' : gen.status === 'failed' || gen.status === 'timeout' ? 'text-red-400' : 'text-cyan-400'}`}>
              {gen.status}
            </p>
          </div>

          <div>
            <span className="text-xs text-neutral-500">Prompt</span>
            <p className="text-sm text-neutral-200">{gen.prompt}</p>
          </div>

          <div>
            <span className="text-xs text-neutral-500">Provider</span>
            <p className="text-sm text-neutral-200">{gen.provider}</p>
          </div>

          <div>
            <span className="text-xs text-neutral-500">Model</span>
            <p className="text-sm text-neutral-200">{gen.model}</p>
          </div>

          <div>
            <span className="text-xs text-neutral-500">Mode</span>
            <p className="text-sm text-neutral-200">{gen.mode}</p>
          </div>

          {gen.params.resolution && (
            <div>
              <span className="text-xs text-neutral-500">Resolution</span>
              <p className="text-sm text-neutral-200">{gen.params.resolution}</p>
            </div>
          )}

          {gen.params.aspect_ratio && (
            <div>
              <span className="text-xs text-neutral-500">Aspect Ratio</span>
              <p className="text-sm text-neutral-200">{gen.params.aspect_ratio}</p>
            </div>
          )}

          {gen.params.output_format && (
            <div>
              <span className="text-xs text-neutral-500">Format</span>
              <p className="text-sm text-neutral-200">{gen.params.output_format}</p>
            </div>
          )}

          <div>
            <span className="text-xs text-neutral-500">Created</span>
            <p className="text-sm text-neutral-200">{new Date(gen.createdAt).toLocaleString()}</p>
          </div>

          {gen.completedAt && (
            <div>
              <span className="text-xs text-neutral-500">Completed</span>
              <p className="text-sm text-neutral-200">{new Date(gen.completedAt).toLocaleString()}</p>
            </div>
          )}

          {gen.referenceImages.length > 0 && (
            <div>
              <span className="text-xs text-neutral-500">Reference Images</span>
              <div className="space-y-1 mt-1">
                {gen.referenceImages.map((ref, i) => (
                  <p key={i} className="text-xs text-neutral-400 truncate">{ref}</p>
                ))}
              </div>
            </div>
          )}

          {gen.error && (
            <div>
              <span className="text-xs text-neutral-500">Error</span>
              <p className="text-sm text-red-400">{gen.error}</p>
            </div>
          )}

          {failedImages.length > 0 && (
            <div>
              <span className="text-xs text-neutral-500">Failed Downloads</span>
              {failedImages.map((img, i) => (
                <p key={i} className="text-xs text-red-400">{img.error}</p>
              ))}
            </div>
          )}

          {gen.providerRequestId && (
            <div>
              <span className="text-xs text-neutral-500">Request ID</span>
              <p className="text-xs text-neutral-400 font-mono">{gen.providerRequestId}</p>
            </div>
          )}

          {/* Actions */}
          <div className="pt-3 border-t border-neutral-800 space-y-2">
            {(gen.status === 'failed' || gen.status === 'timeout' || gen.status === 'partial') && (
              <button
                className="w-full text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded px-3 py-1.5"
                onClick={handleRetry}
              >
                Retry
              </button>
            )}
            <button
              className="w-full text-sm bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-3 py-1.5"
              onClick={handleCopyPath}
            >
              Copy Path
            </button>
            <button
              className="w-full text-sm bg-red-900/50 hover:bg-red-800/50 text-red-300 rounded px-3 py-1.5"
              onClick={handleDelete}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `ImageGallery.tsx`**

```typescript
import { useState, useEffect } from 'react';
import { useImageStore } from '../../store/image-store';
import { ImageGrid } from './ImageGrid';
import { ImageDetail } from './ImageDetail';
import { ImageSettings } from './ImageSettings';

type View = 'grid' | 'detail' | 'settings';

export function ImageGallery(): React.JSX.Element {
  const { generations, isLoaded, loadGenerations } = useImageStore();
  const [view, setView] = useState<View>('grid');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void loadGenerations();
  }, [loadGenerations]);

  // Subscribe to live updates
  useEffect(() => {
    const cleanup = window.fleet.images.onChanged(() => {
      void loadGenerations();
    });
    return cleanup;
  }, [loadGenerations]);

  const selectedGeneration = selectedId
    ? generations.find((g) => g.id === selectedId) ?? null
    : null;

  if (!isLoaded) {
    return <div className="flex-1 flex items-center justify-center text-neutral-500">Loading...</div>;
  }

  const inProgressCount = generations.filter(
    (g) => g.status === 'queued' || g.status === 'processing'
  ).length;

  return (
    <div className="flex flex-col h-full bg-neutral-900">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 pt-2 border-b border-neutral-800">
        <button
          className={`px-3 py-1.5 text-sm rounded-t ${
            view === 'grid' || view === 'detail'
              ? 'bg-neutral-800 text-white'
              : 'text-neutral-400 hover:text-neutral-200'
          }`}
          onClick={() => { setView('grid'); setSelectedId(null); }}
        >
          Gallery
          {inProgressCount > 0 && (
            <span className="ml-1.5 bg-cyan-500 text-white text-xs rounded-full px-1.5 py-0.5">
              {inProgressCount}
            </span>
          )}
        </button>
        <button
          className={`px-3 py-1.5 text-sm rounded-t ${
            view === 'settings'
              ? 'bg-neutral-800 text-white'
              : 'text-neutral-400 hover:text-neutral-200'
          }`}
          onClick={() => setView('settings')}
        >
          Settings
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {view === 'settings' && <ImageSettings />}
        {view === 'grid' && (
          <ImageGrid
            generations={generations}
            onSelect={(id) => { setSelectedId(id); setView('detail'); }}
          />
        )}
        {view === 'detail' && selectedGeneration && (
          <ImageDetail
            generation={selectedGeneration}
            onBack={() => { setSelectedId(null); setView('grid'); }}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/ImageGallery/
git commit -m "feat(images): add ImageGallery, ImageGrid, ImageDetail, and ImageSettings components"
```

---

### Task 11: Wire Images tab into App.tsx and Sidebar

**Files:**

- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add Images tab rendering to App.tsx**

Import the `ImageGallery` component:

```typescript
import { ImageGallery } from './components/ImageGallery/ImageGallery';
```

In the tab content rendering (where `tab.type === 'star-command'` is checked), add an additional condition:

```tsx
{tab.type === 'star-command' ? (
  <StarCommandTab />
) : tab.type === 'images' ? (
  <ImageGallery />
) : (
  <PaneGrid ... />
)}
```

- [ ] **Step 2: Add Images tab card to Sidebar.tsx**

Add a pinned Images tab section after the Star Command section, following the same pattern. Add before the crew tabs section:

```tsx
{
  /* Images tab (pinned, not closeable) */
}
{
  workspace.tabs
    .filter((tab) => tab.type === 'images')
    .map((tab) => (
      <div
        key={tab.id}
        className={`
        flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-md text-sm min-h-[36px] transition-colors
        ${
          tab.id === activeTabId
            ? 'bg-neutral-700 text-white border-l-2 border-cyan-500'
            : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border-l-2 border-transparent'
        }
      `}
        onClick={() => setActiveTab(tab.id)}
      >
        <svg
          className="w-4 h-4 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        <span className="truncate">Images</span>
      </div>
    ));
}
{
  workspace.tabs.filter((t) => t.type === 'images').length > 0 && (
    <div className="h-px bg-neutral-800 mx-1 my-1" />
  );
}
```

- [ ] **Step 3: Hide sidebar when Images tab is active (same as Star Command)**

Update the `isStarCommand` check that controls sidebar visibility to also include images:

```typescript
const isFullScreenTab = useMemo(() => {
  const tab = workspace.tabs.find((t) => t.id === activeTabId);
  return tab?.type === 'star-command' || tab?.type === 'images';
}, [workspace.tabs, activeTabId]);
const showSidebar = !isFullScreenTab || sidebarManualOpen;
```

Note: The exact variable name may differ — look for the existing `isStarCommand` variable and rename/extend it.

- [ ] **Step 4: Run typecheck and build**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "feat(images): wire Images tab into App.tsx and Sidebar"
```

---

### Task 12: Handle local image loading in renderer

**Files:**

- Modify: `src/main/index.ts` (register protocol) OR use existing `file.readBinary` IPC

The `ImageGrid` and `ImageDetail` components reference images via `fleet-local://` URLs. We need to either:

**Option A:** Register a custom Electron protocol to serve local files (cleanest for `<img src=...>`).

**Option B:** Load images as base64 data URIs via the existing `window.fleet.file.readBinary` IPC call.

- [ ] **Step 1: Check which approach the existing image viewer uses**

Look at how `paneType: 'image'` tabs load and display local images. Follow the same pattern.

- [ ] **Step 2: Implement image loading**

If using a custom protocol, register it in main process `app.whenReady()`:

```typescript
import { protocol } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

protocol.registerFileProtocol('fleet-local', (request, callback) => {
  const url = request.url.replace('fleet-local://', '');
  const filePath = join(homedir(), '.fleet', url);
  callback({ path: filePath });
});
```

If using `file.readBinary`, update the `ImageGrid` and `ImageDetail` components to load images via IPC and convert to data URIs with a `useEffect` + `useState` pattern.

- [ ] **Step 3: Run the app and verify images display**

```bash
npm run dev
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(images): add local image loading for gallery"
```

---

### Task 13: Wire SocketSupervisor to pass ImageService

**Files:**

- Modify: `src/main/socket-supervisor.ts`

- [ ] **Step 1: Check how SocketSupervisor creates SocketServer**

Read `src/main/socket-supervisor.ts` to understand how it wraps `SocketServer`. The supervisor likely instantiates `SocketServer` in its constructor or a `start()` method.

- [ ] **Step 2: Pass imageService through SocketSupervisor to SocketServer**

Add an `imageService` parameter to the `SocketSupervisor` constructor and forward it to the `SocketServer` constructor.

- [ ] **Step 3: Update the SocketSupervisor instantiation in `src/main/index.ts`**

Pass the `imageService` instance when creating the `SocketSupervisor`.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/socket-supervisor.ts src/main/index.ts
git commit -m "feat(images): wire ImageService through SocketSupervisor to SocketServer"
```

---

### Task 14: Full build and manual verification

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Fix any lint errors.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: PASS — full build completes.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Verify:

1. Images tab appears pinned in sidebar below Star Command
2. Images tab shows empty state with CLI hint
3. Settings sub-tab shows API key input, resolution/format/aspect ratio dropdowns
4. `fleet images config --api-key <your-key>` sets the key
5. `fleet images generate --prompt "A cat in space"` returns a generation ID immediately
6. `fleet images status <id>` shows progress
7. `fleet images list` shows the generation
8. Image appears in the gallery when generation completes
9. Clicking a card shows the detail view with metadata
10. Retry button works on failed generations

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(images): address build and lint issues"
```
