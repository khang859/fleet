# Annotate UI Trigger & Results Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sidebar tab for browsing annotations, a modal for starting new annotations, a PaneToolbar button, persistent storage, and configurable auto-cleanup.

**Architecture:** New `AnnotationStore` in main process stores annotation metadata and files to `~/.fleet/annotations/`. IPC handlers expose list/get/delete/start to the renderer. Renderer gets a Zustand store, sidebar tab with list+detail views, trigger modal, and PaneToolbar button. Follows existing Images tab patterns.

**Tech Stack:** React, Zustand, Tailwind CSS, Lucide icons, Electron IPC.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/main/annotation-store.ts` | Persistent storage for annotation metadata + files in `~/.fleet/annotations/`. CRUD operations, cleanup by retention days. |
| `src/renderer/src/store/annotation-store.ts` | Zustand store for annotation list and detail data in the renderer. |
| `src/renderer/src/components/AnnotateTab.tsx` | Sidebar tab component: list view, detail view, empty state. |
| `src/renderer/src/components/AnnotateModal.tsx` | Modal for starting a new annotation: URL input with clipboard auto-fill. |
| `src/main/__tests__/annotation-store.test.ts` | Unit tests for annotation store CRUD and cleanup. |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/ipc-channels.ts` | Add 5 new annotate UI channels |
| `src/shared/types.ts` | Add `annotate` to `FleetSettings`, add `AnnotationMeta` type, add `'annotate'` to Tab type union |
| `src/shared/constants.ts` | Add `annotate` defaults to `DEFAULT_SETTINGS` |
| `src/main/annotation-store.ts` | New file (listed above) |
| `src/main/annotate-service.ts` | Accept `AnnotationStore`, write results to `~/.fleet/annotations/` instead of tmpdir |
| `src/main/ipc-handlers.ts` | Add annotate IPC handlers (list, get, delete, ui-start) |
| `src/main/index.ts` | Instantiate `AnnotationStore`, pass to `AnnotateService` and IPC handlers, run cleanup on startup |
| `src/preload/index.ts` | Add `annotate` API group |
| `src/renderer/src/store/workspace-store.ts` | Add `ensureAnnotateTab()` like `ensureImagesTab()` |
| `src/renderer/src/App.tsx` | Add annotate tab rendering, mini sidebar icon |
| `src/renderer/src/components/PaneToolbar.tsx` | Add annotate button |

---

## Task 1: Types, IPC Channels, Settings

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: Add AnnotationMeta type to types.ts**

Add after the `FleetSettings` type (after line 128):

```typescript
// ── Annotations ──────────────────────────────────────────────────────────

export type AnnotationMeta = {
  id: string;
  url: string;
  timestamp: number;
  elementCount: number;
  dirPath: string;
};
```

- [ ] **Step 2: Add annotate to FleetSettings**

In the `FleetSettings` type, add after `copilot: CopilotSettings;`:

```typescript
  annotate: {
    retentionDays: number;
  };
```

- [ ] **Step 3: Add 'annotate' to Tab type union**

Change line 15 of types.ts from:
```typescript
  type?: 'terminal' | 'file' | 'image' | 'images' | 'settings';
```
to:
```typescript
  type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate';
```

- [ ] **Step 4: Add IPC channels**

Add to `src/shared/ipc-channels.ts` before `} as const;`:

```typescript
  // Annotate UI
  ANNOTATE_UI_START: 'annotate:ui:start',
  ANNOTATE_COMPLETED: 'annotate:completed',
  ANNOTATE_LIST: 'annotate:list',
  ANNOTATE_GET: 'annotate:get',
  ANNOTATE_DELETE: 'annotate:delete'
```

- [ ] **Step 5: Add default settings**

In `src/shared/constants.ts`, add to `DEFAULT_SETTINGS` after the `copilot` entry:

```typescript
  annotate: {
    retentionDays: 3
  },
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-channels.ts src/shared/constants.ts
git commit -m "feat(annotate): add annotation types, IPC channels, and settings"
```

---

## Task 2: AnnotationStore (Main Process)

**Files:**
- Create: `src/main/annotation-store.ts`
- Create: `src/main/__tests__/annotation-store.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/main/__tests__/annotation-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AnnotationStore } from '../annotation-store';

const TEST_DIR = join(tmpdir(), `fleet-annotation-store-test-${Date.now()}`);

describe('AnnotationStore', () => {
  let store: AnnotationStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new AnnotationStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('starts with empty list', () => {
    expect(store.list()).toEqual([]);
  });

  it('adds an annotation and lists it', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      viewport: { width: 1440, height: 900 },
      context: 'Fix button',
      elements: [
        {
          selector: '#btn',
          tag: 'button',
          id: 'btn',
          classes: ['primary'],
          text: 'Click',
          rect: { x: 0, y: 0, width: 100, height: 40 },
          attributes: {}
        }
      ]
    };
    const meta = store.add(result, []);
    expect(meta.url).toBe('https://example.com');
    expect(meta.elementCount).toBe(1);

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(meta.id);
  });

  it('gets annotation detail', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: []
    };
    const meta = store.add(result, []);
    const detail = store.get(meta.id);
    expect(detail).not.toBeNull();
    expect(detail?.url).toBe('https://example.com');
  });

  it('deletes an annotation', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: []
    };
    const meta = store.add(result, []);
    store.delete(meta.id);
    expect(store.list()).toHaveLength(0);
    expect(store.get(meta.id)).toBeNull();
  });

  it('cleans up old annotations', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: []
    };
    const meta = store.add(result, []);
    // Manually backdate the timestamp
    const index = store.list();
    index[0].timestamp = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    store.saveIndex(index);

    store.cleanup(3); // 3 day retention
    expect(store.list()).toHaveLength(0);
  });

  it('preserves recent annotations during cleanup', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: []
    };
    store.add(result, []);
    store.cleanup(3);
    expect(store.list()).toHaveLength(1); // still recent
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/annotation-store.test.ts`
Expected: FAIL — `AnnotationStore` not found

- [ ] **Step 3: Implement AnnotationStore**

```typescript
// src/main/annotation-store.ts
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import type { AnnotationMeta } from '../shared/types';
import type { AnnotationResult } from '../shared/annotate-types';

const log = createLogger('annotation-store');
const INDEX_FILE = 'index.json';
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;

export interface AnnotationScreenshot {
  index: number;
  pngBuffer: Buffer;
}

export class AnnotationStore extends EventEmitter {
  private indexPath: string;

  constructor(private baseDir: string) {
    super();
    mkdirSync(baseDir, { recursive: true });
    this.indexPath = join(baseDir, INDEX_FILE);
  }

  list(): AnnotationMeta[] {
    if (!existsSync(this.indexPath)) return [];
    try {
      const raw = readFileSync(this.indexPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as AnnotationMeta[];
    } catch {
      return [];
    }
  }

  get(id: string): (AnnotationResult & { screenshotPaths?: string[] }) | null {
    const meta = this.list().find((m) => m.id === id);
    if (!meta) return null;
    const resultPath = join(this.baseDir, meta.dirPath, 'result.json');
    if (!existsSync(resultPath)) return null;
    try {
      const raw = readFileSync(resultPath, 'utf-8');
      return JSON.parse(raw) as AnnotationResult & { screenshotPaths?: string[] };
    } catch {
      return null;
    }
  }

  add(result: AnnotationResult, screenshots: AnnotationScreenshot[]): AnnotationMeta {
    const timestamp = Date.now();
    const id = `ann-${timestamp}-${randomUUID().slice(0, 8)}`;
    const dirPath = id;
    const fullDir = join(this.baseDir, dirPath);
    mkdirSync(fullDir, { recursive: true });

    // Write screenshot PNGs
    const screenshotPaths: string[] = [];
    for (const shot of screenshots) {
      if (shot.pngBuffer.length > MAX_SCREENSHOT_BYTES) {
        log.warn('screenshot too large, skipping', { index: shot.index });
        continue;
      }
      const pngPath = join(fullDir, `el${shot.index}.png`);
      writeFileSync(pngPath, shot.pngBuffer, { mode: 0o600 });
      screenshotPaths.push(pngPath);
    }

    // Build result with screenshot paths on elements
    const outputResult = {
      ...result,
      elements: result.elements?.map((el, i) => {
        const shot = screenshots.find((s) => s.index === i + 1);
        if (shot) {
          return { ...el, screenshotPath: join(fullDir, `el${i + 1}.png`) };
        }
        return el;
      })
    };

    // Write result.json
    writeFileSync(join(fullDir, 'result.json'), JSON.stringify(outputResult, null, 2), {
      mode: 0o600
    });

    const meta: AnnotationMeta = {
      id,
      url: result.url ?? 'unknown',
      timestamp,
      elementCount: result.elements?.length ?? 0,
      dirPath
    };

    const index = this.list();
    index.unshift(meta);
    this.saveIndex(index);
    this.emit('changed');

    return meta;
  }

  delete(id: string): void {
    const index = this.list();
    const entry = index.find((m) => m.id === id);
    if (!entry) return;

    const fullDir = join(this.baseDir, entry.dirPath);
    if (existsSync(fullDir)) {
      rmSync(fullDir, { recursive: true, force: true });
    }

    this.saveIndex(index.filter((m) => m.id !== id));
    this.emit('changed');
  }

  cleanup(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const index = this.list();
    const toDelete = index.filter((m) => m.timestamp < cutoff);

    for (const entry of toDelete) {
      const fullDir = join(this.baseDir, entry.dirPath);
      if (existsSync(fullDir)) {
        rmSync(fullDir, { recursive: true, force: true });
      }
    }

    if (toDelete.length > 0) {
      this.saveIndex(index.filter((m) => m.timestamp >= cutoff));
      log.info('cleaned up old annotations', { count: toDelete.length });
    }
  }

  saveIndex(index: AnnotationMeta[]): void {
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/annotation-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/annotation-store.ts src/main/__tests__/annotation-store.test.ts
git commit -m "feat(annotate): add persistent annotation store"
```

---

## Task 3: Integrate AnnotationStore with AnnotateService

**Files:**
- Modify: `src/main/annotate-service.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Update AnnotateService to accept AnnotationStore**

In `src/main/annotate-service.ts`, update the constructor and `handleSubmit`:

Add import:
```typescript
import type { AnnotationStore, AnnotationScreenshot } from './annotation-store';
```

Update constructor:
```typescript
export class AnnotateService extends EventEmitter {
  private window: BrowserWindow | null = null;
  private pending: PendingRequest | null = null;
  private annotationStore: AnnotationStore | null = null;

  constructor(annotationStore?: AnnotationStore) {
    super();
    this.annotationStore = annotationStore ?? null;
    this.registerIpcHandlers();
  }
```

Update `handleSubmit` — replace the `writeResultFile` call with `annotationStore.add()`:

```typescript
  private async handleSubmit(result: AnnotationResult): Promise<void> {
    if (!this.pending) return;

    const { resolve, timeoutId } = this.pending;
    clearTimeout(timeoutId);
    this.pending = null;

    try {
      const screenshots: AnnotationScreenshot[] = [];
      if (result.elements && this.window && !this.window.isDestroyed()) {
        const viewport = result.viewport ?? { width: 1440, height: 900 };

        for (let i = 0; i < result.elements.length; i++) {
          const el = result.elements[i];
          if (!el.captureScreenshot) continue;

          await this.window.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(el.selector)})?.scrollIntoView({ block: 'center' })`
          );
          await new Promise((r) => setTimeout(r, 100));

          const fullPng = await this.captureScreenshot();
          if (!fullPng) continue;

          const crop = cropRect(el.rect, SCREENSHOT_PADDING, viewport);
          const fullImage = nativeImage.createFromBuffer(fullPng);
          const cropped = fullImage.crop(crop);
          screenshots.push({ index: i + 1, pngBuffer: cropped.toPNG() });
        }
      }

      let resultPath: string;
      if (this.annotationStore) {
        const meta = this.annotationStore.add(result, screenshots);
        resultPath = join(this.annotationStore['baseDir'], meta.dirPath, 'result.json');
      } else {
        resultPath = await writeResultFile(result, screenshots);
      }

      log.info('annotation complete', { resultPath, elementCount: result.elements?.length ?? 0 });
      resolve(resultPath);
    } catch (err) {
      log.error('failed to write result', { error: String(err) });
      const errorResult: AnnotationResult = {
        success: false,
        reason: `Failed to write results: ${String(err)}`
      };
      try {
        const errorPath = this.annotationStore
          ? join(this.annotationStore['baseDir'], this.annotationStore.add(errorResult, []).dirPath, 'result.json')
          : await writeResultFile(errorResult, []);
        resolve(errorPath);
      } catch {
        resolve('');
      }
    }

    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
  }
```

Add `join` import from `path` if not already present.

- [ ] **Step 2: Update index.ts to create AnnotationStore and pass it**

Add import:
```typescript
import { AnnotationStore } from './annotation-store';
```

Add after `const annotateService = new AnnotateService();`:
```typescript
const ANNOTATIONS_DIR = join(homedir(), '.fleet', 'annotations');
const annotationStore = new AnnotationStore(ANNOTATIONS_DIR);
```

Update `AnnotateService` instantiation:
```typescript
const annotateService = new AnnotateService(annotationStore);
```

Add cleanup on startup (after `imageService.resumeInterrupted()`):
```typescript
  // Clean up old annotations based on retention settings
  const retentionDays = settingsStore.get().annotate?.retentionDays ?? 3;
  annotationStore.cleanup(retentionDays);
```

- [ ] **Step 3: Run typecheck and tests**

Run: `npm run typecheck && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/annotate-service.ts src/main/index.ts
git commit -m "feat(annotate): integrate annotation store with service"
```

---

## Task 4: IPC Handlers + Preload API

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add IPC handlers**

In `src/main/ipc-handlers.ts`:

Add imports:
```typescript
import type { AnnotationStore } from './annotation-store';
import type { AnnotateService } from './annotate-service';
```

Add `annotationStore` and `annotateService` parameters to `registerIpcHandlers()`. Add after the last parameter in the function signature.

Add handler block after the worktree handlers:

```typescript
  // ── Annotate ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.ANNOTATE_LIST, () => {
    return annotationStore.list();
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATE_GET, (_event, id: string) => {
    return annotationStore.get(id);
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATE_DELETE, (_event, id: string) => {
    annotationStore.delete(id);
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATE_UI_START, async (_event, args: { url?: string; timeout?: number }) => {
    const resultPath = await annotateService.start({
      url: args.url,
      timeout: args.timeout
    });
    return { resultPath };
  });
```

- [ ] **Step 2: Update index.ts to pass new params to registerIpcHandlers**

In `src/main/index.ts`, update the `registerIpcHandlers()` call to pass `annotationStore` and `annotateService` as additional arguments.

Also forward `ANNOTATE_COMPLETED` events from the annotation store to the renderer:

```typescript
annotationStore.on('changed', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.ANNOTATE_COMPLETED);
  }
});
```

- [ ] **Step 3: Add preload API**

In `src/preload/index.ts`, add an `annotate` property to the `fleetApi` object (before the closing of the object, around line 287):

```typescript
    annotate: {
      list: async () => typedInvoke<AnnotationMeta[]>(IPC_CHANNELS.ANNOTATE_LIST),
      get: async (id: string) => typedInvoke<unknown>(IPC_CHANNELS.ANNOTATE_GET, id),
      delete: async (id: string) => typedInvoke<void>(IPC_CHANNELS.ANNOTATE_DELETE, id),
      start: async (args: { url?: string; timeout?: number }) =>
        typedInvoke<{ resultPath: string }>(IPC_CHANNELS.ANNOTATE_UI_START, args),
      onCompleted: (callback: () => void) => onChannel(IPC_CHANNELS.ANNOTATE_COMPLETED, callback)
    },
```

Add the `AnnotationMeta` import at the top of the preload file:
```typescript
import type { AnnotationMeta } from '../shared/types';
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(annotate): add IPC handlers and preload API"
```

---

## Task 5: Renderer Zustand Store

**Files:**
- Create: `src/renderer/src/store/annotation-store.ts`

- [ ] **Step 1: Create the store**

```typescript
// src/renderer/src/store/annotation-store.ts
import { create } from 'zustand';
import type { AnnotationMeta } from '../../../shared/types';

type AnnotationDetail = {
  success: boolean;
  url?: string;
  viewport?: { width: number; height: number };
  context?: string;
  elements?: Array<{
    selector: string;
    tag: string;
    id: string | null;
    classes: string[];
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    attributes: Record<string, string>;
    comment?: string;
    screenshotPath?: string;
    boxModel?: {
      content: { width: number; height: number };
      padding: { top: number; right: number; bottom: number; left: number };
      border: { top: number; right: number; bottom: number; left: number };
      margin: { top: number; right: number; bottom: number; left: number };
    };
    accessibility?: {
      role: string | null;
      name: string | null;
      focusable: boolean;
      disabled: boolean;
    };
    keyStyles?: Record<string, string>;
  }>;
};

type AnnotationStore = {
  annotations: AnnotationMeta[];
  isLoaded: boolean;
  loadAnnotations: () => Promise<void>;
  getDetail: (id: string) => Promise<AnnotationDetail | null>;
  deleteAnnotation: (id: string) => Promise<void>;
  startAnnotation: (url?: string) => Promise<{ resultPath: string }>;
};

export const useAnnotationStore = create<AnnotationStore>((set) => ({
  annotations: [],
  isLoaded: false,

  loadAnnotations: async () => {
    const annotations = await window.fleet.annotate.list();
    set({ annotations, isLoaded: true });
  },

  getDetail: async (id: string) => {
    const result = await window.fleet.annotate.get(id);
    return result as AnnotationDetail | null;
  },

  deleteAnnotation: async (id: string) => {
    await window.fleet.annotate.delete(id);
    set((state) => ({
      annotations: state.annotations.filter((a) => a.id !== id)
    }));
  },

  startAnnotation: async (url?: string) => {
    const result = await window.fleet.annotate.start({ url });
    return result;
  }
}));
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/annotation-store.ts
git commit -m "feat(annotate): add renderer annotation store"
```

---

## Task 6: Annotate Modal

**Files:**
- Create: `src/renderer/src/components/AnnotateModal.tsx`

- [ ] **Step 1: Create the modal component**

```tsx
// src/renderer/src/components/AnnotateModal.tsx
import { useState, useEffect, useRef } from 'react';
import { X, Crosshair } from 'lucide-react';
import { useAnnotationStore } from '../store/annotation-store';

interface AnnotateModalProps {
  open: boolean;
  onClose: () => void;
}

function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

export function AnnotateModal({ open, onClose }: AnnotateModalProps) {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const startAnnotation = useAnnotationStore((s) => s.startAnnotation);

  useEffect(() => {
    if (!open) return;
    // Auto-fill from clipboard
    navigator.clipboard
      .readText()
      .then((text) => {
        if (looksLikeUrl(text)) {
          setUrl(text.trim());
        }
      })
      .catch(() => {
        // Clipboard access denied — leave empty
      });
    // Focus input after a tick
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  if (!open) return null;

  const handleStart = () => {
    const trimmed = url.trim();
    onClose();
    void startAnnotation(trimmed || undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleStart();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="relative w-[480px] bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Crosshair size={18} className="text-cyan-400" />
            <h2 className="text-base font-medium text-white">New Annotation</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-white rounded hover:bg-neutral-800"
          >
            <X size={16} />
          </button>
        </div>

        {/* URL input */}
        <div className="mb-4">
          <label className="block text-sm text-neutral-400 mb-1.5">URL</label>
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Leave empty to open a blank page
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-neutral-400 hover:text-white rounded-md hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            className="px-3 py-1.5 text-sm bg-cyan-600 text-white rounded-md hover:bg-cyan-500"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/AnnotateModal.tsx
git commit -m "feat(annotate): add annotation trigger modal"
```

---

## Task 7: Annotate Sidebar Tab

**Files:**
- Create: `src/renderer/src/components/AnnotateTab.tsx`

- [ ] **Step 1: Create the tab component**

```tsx
// src/renderer/src/components/AnnotateTab.tsx
import { useState, useEffect } from 'react';
import { ArrowLeft, Crosshair, Trash2, Copy, ClipboardCopy, ChevronDown, ChevronRight } from 'lucide-react';
import { useAnnotationStore } from '../store/annotation-store';
import { AnnotateModal } from './AnnotateModal';
import { useToastStore } from '../store/toast-store';

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type AnnotationDetail = Awaited<ReturnType<ReturnType<typeof useAnnotationStore.getState>['getDetail']>>;

export function AnnotateTab() {
  const { annotations, isLoaded, loadAnnotations, getDetail, deleteAnnotation, startAnnotation } =
    useAnnotationStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnnotationDetail>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedElements, setExpandedElements] = useState<Set<number>>(new Set());
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    void loadAnnotations();
    const unsub = window.fleet.annotate.onCompleted(() => {
      void loadAnnotations();
    });
    return unsub;
  }, [loadAnnotations]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void getDetail(selectedId).then(setDetail);
  }, [selectedId, getDetail]);

  const handleCopyPath = (id: string) => {
    const meta = annotations.find((a) => a.id === id);
    if (!meta) return;
    void navigator.clipboard.writeText(meta.dirPath);
    addToast('Path copied to clipboard');
  };

  const toggleElement = (index: number) => {
    setExpandedElements((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // ── Detail View ──
  if (selectedId && detail) {
    return (
      <div className="h-full flex flex-col bg-neutral-950 text-white">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800">
          <button
            onClick={() => setSelectedId(null)}
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{detail.url ?? 'Unknown URL'}</div>
            <div className="text-xs text-neutral-500">
              {detail.elements?.length ?? 0} elements
              {detail.viewport && ` · ${detail.viewport.width}×${detail.viewport.height}`}
            </div>
          </div>
          <button
            onClick={() => handleCopyPath(selectedId)}
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800"
            title="Copy path"
          >
            <ClipboardCopy size={14} />
          </button>
          <button
            onClick={() => {
              void deleteAnnotation(selectedId);
              setSelectedId(null);
            }}
            className="p-1 text-neutral-400 hover:text-red-400 rounded hover:bg-neutral-800"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {/* Context */}
        {detail.context && (
          <div className="px-3 py-2 border-b border-neutral-800">
            <div className="text-xs text-neutral-500 mb-1">Context</div>
            <div className="text-sm text-neutral-300">{detail.context}</div>
          </div>
        )}

        {/* Elements */}
        <div className="flex-1 overflow-y-auto">
          {detail.elements?.map((el, i) => (
            <div key={i} className="border-b border-neutral-800">
              {/* Element header — always visible */}
              <button
                onClick={() => toggleElement(i)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-neutral-900 text-left"
              >
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan-900 text-cyan-300 text-xs flex items-center justify-center">
                  {i + 1}
                </span>
                {expandedElements.has(i) ? (
                  <ChevronDown size={12} className="text-neutral-500" />
                ) : (
                  <ChevronRight size={12} className="text-neutral-500" />
                )}
                <code className="text-xs text-neutral-300 truncate flex-1">{el.selector}</code>
                <span className="text-xs text-neutral-600">{el.tag}</span>
              </button>

              {/* Expanded detail */}
              {expandedElements.has(i) && (
                <div className="px-3 pb-3 pl-10 space-y-1.5">
                  {el.comment && (
                    <div className="text-sm text-amber-300">"{el.comment}"</div>
                  )}
                  {el.text && (
                    <div className="text-xs text-neutral-400">
                      Text: <span className="text-neutral-300">{el.text}</span>
                    </div>
                  )}
                  {el.boxModel && (
                    <div className="text-xs text-neutral-400">
                      Box: {el.rect.width}×{el.rect.height}
                      {' (pad: '}
                      {el.boxModel.padding.top} {el.boxModel.padding.right}{' '}
                      {el.boxModel.padding.bottom} {el.boxModel.padding.left})
                    </div>
                  )}
                  {el.accessibility && (
                    <div className="text-xs text-neutral-400">
                      A11y: role={el.accessibility.role ?? 'none'}
                      {el.accessibility.name && ` name="${el.accessibility.name}"`}
                      {el.accessibility.focusable && ' focusable'}
                    </div>
                  )}
                  {el.keyStyles && Object.keys(el.keyStyles).length > 0 && (
                    <div className="text-xs text-neutral-400">
                      Styles:{' '}
                      {Object.entries(el.keyStyles)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ')}
                    </div>
                  )}
                  {el.screenshotPath && (
                    <img
                      src={`fleet-image://${el.screenshotPath}`}
                      alt={`Element ${i + 1}`}
                      className="mt-1 rounded border border-neutral-700 max-w-full max-h-40 object-contain"
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <AnnotateModal open={modalOpen} onClose={() => setModalOpen(false)} />
      </div>
    );
  }

  // ── List View ──
  return (
    <div className="h-full flex flex-col bg-neutral-950 text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <Crosshair size={16} className="text-cyan-400" />
          <span className="text-sm font-medium">Annotations</span>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="px-2.5 py-1 text-xs bg-cyan-600 text-white rounded hover:bg-cyan-500"
        >
          New
        </button>
      </div>

      {/* List or empty state */}
      {!isLoaded ? (
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
          Loading...
        </div>
      ) : annotations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-neutral-500">
          <Crosshair size={32} className="text-neutral-700" />
          <p className="text-sm">No annotations yet</p>
          <button
            onClick={() => setModalOpen(true)}
            className="px-3 py-1.5 text-xs bg-cyan-600 text-white rounded hover:bg-cyan-500"
          >
            New Annotation
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {annotations.map((ann) => (
            <button
              key={ann.id}
              onClick={() => setSelectedId(ann.id)}
              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-neutral-900 border-b border-neutral-800/50 text-left"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-neutral-200 truncate">
                  {ann.url}
                </div>
                <div className="text-xs text-neutral-500">
                  {timeAgo(ann.timestamp)} · {ann.elementCount} element
                  {ann.elementCount !== 1 ? 's' : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <AnnotateModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/AnnotateTab.tsx
git commit -m "feat(annotate): add annotate sidebar tab with list and detail views"
```

---

## Task 8: Wire into App Layout

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/hooks/use-pane-navigation.ts`

- [ ] **Step 1: Add ensureAnnotateTab to workspace-store.ts**

Add after the `ensureImagesTab` function (around line 70):

```typescript
/** Ensure workspace has a pinned Annotate tab; mutates and returns the workspace */
function ensureAnnotateTab(workspace: Workspace): Workspace {
  if (workspace.tabs.some((t) => t.type === 'annotate')) return workspace;
  const cwd = workspace.tabs[0]?.cwd ?? '/';
  const annotateTab: Tab = {
    id: generateId(),
    label: 'Annotate',
    labelIsCustom: true,
    cwd,
    type: 'annotate',
    splitRoot: createLeaf(cwd)
  };
  // Insert after images tab if present, otherwise prepend
  const imagesIdx = workspace.tabs.findIndex((t) => t.type === 'images');
  const insertIdx = imagesIdx >= 0 ? imagesIdx + 1 : 0;
  const tabs = [...workspace.tabs];
  tabs.splice(insertIdx, 0, annotateTab);
  return { ...workspace, tabs };
}
```

Then find where `ensureImagesTab` is called (in the workspace loading/creation logic) and chain `ensureAnnotateTab`:

Search for `ensureImagesTab(` and after each call, chain `ensureAnnotateTab`. For example:
```typescript
workspace = ensureAnnotateTab(ensureImagesTab(workspace));
```

- [ ] **Step 2: Add tab rendering in App.tsx**

In the tab content rendering block (around line 683), add before the PaneGrid fallback:

```tsx
{tab.type === 'images' ? (
  <ImageGallery />
) : tab.type === 'annotate' ? (
  <AnnotateTab />
) : tab.type === 'settings' ? (
  <SettingsTab />
) : (
  <PaneGrid ... />
)}
```

Import at top of App.tsx:
```typescript
import { AnnotateTab } from './components/AnnotateTab';
```

- [ ] **Step 3: Add mini sidebar icon for Annotate tab**

After the Images pinned icon block (around line 550), add a similar block for the Annotate tab:

```tsx
{/* Annotate pinned icon */}
{workspace.tabs
  .filter((t) => t.type === 'annotate')
  .map((tab) => {
    const isAnnotateActive = tab.id === activeTabId;
    return (
      <MiniSidebarTooltip label="Annotate" key={tab.id}>
        <button
          onClick={() => setActiveTab(tab.id)}
          className={`p-1.5 rounded transition-colors ${
            isAnnotateActive
              ? 'bg-cyan-900/40 ring-1 ring-cyan-500/30'
              : 'hover:bg-neutral-800'
          }`}
        >
          <Crosshair
            size={16}
            className={isAnnotateActive ? 'text-cyan-400' : 'text-cyan-400/40'}
          />
        </button>
      </MiniSidebarTooltip>
    );
  })}
{workspace.tabs.some((t) => t.type === 'annotate') && (
  <div className="w-6 h-px bg-neutral-800 my-0.5" />
)}
```

Import `Crosshair` from lucide-react at the top.

- [ ] **Step 4: Exclude annotate tab from pane navigation**

In `src/renderer/src/hooks/use-pane-navigation.ts`, update the filter (line 13):

```typescript
return tabs.filter((t) => t.type !== 'images' && t.type !== 'settings' && t.type !== 'annotate');
```

- [ ] **Step 5: Exclude annotate from mini sidebar file/terminal loop**

In `App.tsx`, update the filter around line 557:

```typescript
.filter(
  (t) =>
    t.type !== 'images' &&
    t.type !== 'settings' &&
    t.type !== 'annotate'
)
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/App.tsx src/renderer/src/hooks/use-pane-navigation.ts
git commit -m "feat(annotate): wire annotate tab into app layout and sidebar"
```

---

## Task 9: PaneToolbar Button

**Files:**
- Modify: `src/renderer/src/components/PaneToolbar.tsx`

- [ ] **Step 1: Add annotate button to PaneToolbar**

Add `onAnnotate` to the component props interface:

```typescript
onAnnotate?: () => void;
```

Add a button before the close button (last in the toolbar), wrapped in a conditional like the skills button:

```tsx
{onAnnotate && (
  <ToolbarTooltip label="Annotate webpage">
    <button
      onClick={(e) => {
        e.stopPropagation();
        onAnnotate();
      }}
    >
      <Crosshair size={14} />
    </button>
  </ToolbarTooltip>
)}
```

Import `Crosshair` from lucide-react.

- [ ] **Step 2: Pass onAnnotate from parent**

Find where `PaneToolbar` is rendered (in `PaneGrid.tsx` or `App.tsx`). Pass an `onAnnotate` callback that opens the annotation modal. This requires lifting the modal state up or using a global state.

The simplest approach: add a `annotateModalOpen` state to the workspace store or use a simple event bus. For now, use a module-level event approach:

Create a tiny event hook in `AnnotateModal.tsx`:

```typescript
// Add at module level in AnnotateModal.tsx
let openModalFn: (() => void) | null = null;
export function openAnnotateModal() {
  openModalFn?.();
}
```

In the `AnnotateModal` component, register the function:
```typescript
useEffect(() => {
  openModalFn = () => setInternalOpen(true);
  return () => { openModalFn = null; };
}, []);
```

Then in the parent, import `openAnnotateModal` and pass it as `onAnnotate`.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/PaneToolbar.tsx src/renderer/src/components/AnnotateModal.tsx
git commit -m "feat(annotate): add annotate button to pane toolbar"
```

---

## Task 10: Settings UI

**Files:**
- Modify: `src/renderer/src/components/SettingsTab.tsx` (or wherever settings are rendered)

- [ ] **Step 1: Add annotate retention setting**

Find the Settings tab component. Add an "Annotations" section with a number input:

```tsx
{/* Annotations */}
<div className="space-y-3">
  <h3 className="text-sm font-medium text-neutral-300">Annotations</h3>
  <div className="flex items-center justify-between">
    <label className="text-sm text-neutral-400">
      Delete annotations older than
    </label>
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={1}
        max={365}
        value={settings.annotate?.retentionDays ?? 3}
        onChange={(e) => {
          const days = Math.max(1, Math.min(365, Number(e.target.value) || 3));
          void updateSettings({ annotate: { retentionDays: days } });
        }}
        className="w-16 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm text-white text-center"
      />
      <span className="text-sm text-neutral-400">days</span>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SettingsTab.tsx
git commit -m "feat(annotate): add retention days setting"
```

---

## Task 11: Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run lint and fix**

Run: `npm run lint`
Fix any errors in files we touched.

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(annotate): fix lint and build issues"
```
