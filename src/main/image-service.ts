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

function isImageGenerationMeta(value: unknown): value is ImageGenerationMeta {
  return (
    value != null &&
    typeof value === 'object' &&
    'id' in value &&
    'status' in value &&
    'createdAt' in value &&
    'provider' in value
  );
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
      /* File doesn't exist or is malformed */
    }
    return { ...DEFAULT_SETTINGS };
  }

  updateSettings(partial: {
    defaultProvider?: string;
    providers?: Record<string, Partial<ImageProviderSettings>>;
  }): void {
    const current = this.getSettings();
    if (partial.defaultProvider) current.defaultProvider = partial.defaultProvider;
    if (partial.providers) {
      for (const [key, val] of Object.entries(partial.providers)) {
        current.providers[key] = { ...current.providers[key], ...val } as ImageProviderSettings;
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
        provider.configure({ ...providerSettings });
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

  generate(opts: {
    prompt: string;
    provider?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    outputFormat?: string;
    numImages?: number;
  }): { id: string } {
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
      providerRequestId: null,
      sourceImage: null
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

  edit(opts: {
    prompt: string;
    images: string[];
    provider?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    outputFormat?: string;
    numImages?: number;
  }): { id: string } {
    const provider = this.getProvider(opts.provider);
    const defaults = this.getProviderDefaults(opts.provider);
    const id = generateId();
    mkdirSync(join(GENERATIONS_DIR, id), { recursive: true });

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
      providerRequestId: null,
      sourceImage: null
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

  retry(id: string): { id: string } {
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

  // ── Startup recovery / Shutdown ─────────────────────────────────────────

  resumeInterrupted(): void {
    for (const meta of this.list()) {
      if ((meta.status === 'queued' || meta.status === 'processing') && meta.providerRequestId) {
        const provider = this.providers.get(meta.provider);
        if (provider) this.pollLoop(meta.id, provider, meta.providerRequestId);
      }
    }
  }

  shutdown(): void {
    for (const controller of this.activePolls.values()) controller.abort();
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
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(GENERATIONS_DIR, id, 'meta.json'), 'utf8')
      );
      if (isImageGenerationMeta(parsed)) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  private writeMeta(id: string, meta: ImageGenerationMeta): void {
    writeFileSync(join(GENERATIONS_DIR, id, 'meta.json'), JSON.stringify(meta, null, 2));
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
