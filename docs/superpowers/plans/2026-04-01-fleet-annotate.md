# Fleet Annotate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a visual annotation tool into Fleet that lets users click web page elements, add comments, and produce structured JSON+screenshot files that AI agents can read.

**Architecture:** Electron BrowserWindow with persistent session loads target URLs. A preload script injects a vanilla JS element picker (ported from pi-annotate's content.js). The main process captures screenshots via `webContents.capturePage()` and writes results to temp files. The `fleet annotate` CLI command triggers annotation via Fleet's existing Unix socket IPC and prints the result file path to stdout.

**Tech Stack:** Electron BrowserWindow, contextBridge/ipcRenderer (preload), vanilla JS picker UI, Vitest for tests.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/main/annotate-service.ts` | Main process annotation lifecycle: open/reuse BrowserWindow, handle IPC from preload, capture screenshots, crop to element rects, write result JSON + PNGs to temp dir, resolve pending CLI requests |
| `src/preload/annotate.ts` | Preload script for annotation BrowserWindow: exposes `fleetAnnotate` API via contextBridge, bridges picker submit/cancel to main process via ipcRenderer |
| `src/main/annotate-picker.ts` | Picker UI source — vanilla JS string exported as a function. Injected into the annotation BrowserWindow page via `webContents.executeJavaScript()`. Contains all the DOM manipulation: highlights, note cards, toolbar, connectors, ancestor cycling, data capture |
| `src/shared/annotate-types.ts` | TypeScript interfaces: `ElementRect`, `BoxModel`, `AccessibilityInfo`, `ElementSelection`, `AnnotationResult`, `AnnotateRequest`, `AnnotateResponse` |
| `src/main/__tests__/annotate-service.test.ts` | Unit tests for result file generation, screenshot cropping math, selector formatting |
| `src/main/__tests__/fleet-cli-annotate.test.ts` | Unit tests for `fleet annotate` CLI argument parsing and validation |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/ipc-channels.ts` | Add `ANNOTATE_START`, `ANNOTATE_SUBMIT`, `ANNOTATE_CANCEL`, `ANNOTATE_SCREENSHOT` channels |
| `src/main/fleet-cli.ts` | Add `annotate` top-level command in `runCLI()`, add to `HELP_GROUPS`, add validation |
| `src/main/socket-server.ts` | Add `annotate.start` dispatch case, accept `AnnotateService` in constructor |
| `src/main/index.ts` | Instantiate `AnnotateService`, pass to socket server, wire up socket event to trigger annotation |
| `electron.vite.config.ts` | Add `annotate` preload entry |

---

## Task 1: Shared Types

**Files:**
- Create: `src/shared/annotate-types.ts`
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Create annotate types file**

```typescript
// src/shared/annotate-types.ts

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoxModel {
  content: { width: number; height: number };
  padding: { top: number; right: number; bottom: number; left: number };
  border: { top: number; right: number; bottom: number; left: number };
  margin: { top: number; right: number; bottom: number; left: number };
}

export interface AccessibilityInfo {
  role: string | null;
  name: string | null;
  description: string | null;
  focusable: boolean;
  disabled: boolean;
  expanded?: boolean;
  pressed?: boolean;
  checked?: boolean;
  selected?: boolean;
}

export interface ParentContext {
  tag: string;
  id?: string;
  classes: string[];
  styles: Record<string, string>;
}

export interface ElementSelection {
  selector: string;
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: ElementRect;
  attributes: Record<string, string>;
  comment?: string;
  boxModel?: BoxModel;
  accessibility?: AccessibilityInfo;
  keyStyles?: Record<string, string>;
  computedStyles?: Record<string, string>;
  parentContext?: ParentContext;
  cssVariables?: Record<string, string>;
  /** Whether to capture a screenshot for this element */
  captureScreenshot?: boolean;
}

export interface AnnotationResult {
  success: boolean;
  url?: string;
  viewport?: { width: number; height: number };
  context?: string;
  elements?: ElementSelection[];
  cancelled?: boolean;
  reason?: string;
}

export interface AnnotateStartRequest {
  url?: string;
  timeout?: number;
}

export interface AnnotateCompleteResponse {
  resultPath: string;
}
```

- [ ] **Step 2: Add IPC channels**

Add these channels to `src/shared/ipc-channels.ts` after the existing `COPILOT_*` entries:

```typescript
  // Annotate
  ANNOTATE_START: 'annotate:start',
  ANNOTATE_SUBMIT: 'annotate:submit',
  ANNOTATE_CANCEL: 'annotate:cancel',
  ANNOTATE_SCREENSHOT: 'annotate:screenshot',
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/shared/annotate-types.ts src/shared/ipc-channels.ts
git commit -m "feat(annotate): add shared types and IPC channels"
```

---

## Task 2: Annotation Service (Main Process)

**Files:**
- Create: `src/main/annotate-service.ts`
- Create: `src/main/__tests__/annotate-service.test.ts`

- [ ] **Step 1: Write tests for result file generation**

```typescript
// src/main/__tests__/annotate-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeResultFile, cropRect } from '../annotate-service';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import type { AnnotationResult } from '../../shared/annotate-types';

describe('cropRect', () => {
  it('crops element rect with padding, clamped to viewport', () => {
    const result = cropRect(
      { x: 100, y: 200, width: 120, height: 40 },
      20,
      { width: 1440, height: 900 }
    );
    expect(result).toEqual({ x: 80, y: 180, width: 160, height: 80 });
  });

  it('clamps to viewport boundaries', () => {
    const result = cropRect(
      { x: 5, y: 5, width: 100, height: 100 },
      20,
      { width: 200, height: 200 }
    );
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.width).toBeLessThanOrEqual(200);
    expect(result.height).toBeLessThanOrEqual(200);
  });
});

describe('writeResultFile', () => {
  const testResult: AnnotationResult = {
    success: true,
    url: 'https://example.com',
    viewport: { width: 1440, height: 900 },
    context: 'Fix the button',
    elements: [
      {
        selector: '#btn',
        tag: 'button',
        id: 'btn',
        classes: ['primary'],
        text: 'Click me',
        rect: { x: 100, y: 200, width: 120, height: 40 },
        attributes: { type: 'submit' },
        comment: 'Make this blue',
        boxModel: {
          content: { width: 96, height: 24 },
          padding: { top: 8, right: 12, bottom: 8, left: 12 },
          border: { top: 1, right: 1, bottom: 1, left: 1 },
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
        },
        accessibility: {
          role: 'button',
          name: 'Click me',
          description: null,
          focusable: true,
          disabled: false,
        },
        keyStyles: { display: 'flex' },
      },
    ],
  };

  let resultPath: string | null = null;

  afterEach(() => {
    if (resultPath && existsSync(resultPath)) {
      unlinkSync(resultPath);
    }
  });

  it('writes valid JSON to temp file', async () => {
    resultPath = await writeResultFile(testResult, []);
    expect(resultPath).toMatch(/fleet-annotate-.*\.json$/);
    const content = JSON.parse(readFileSync(resultPath, 'utf-8'));
    expect(content.url).toBe('https://example.com');
    expect(content.elements).toHaveLength(1);
    expect(content.elements[0].selector).toBe('#btn');
    expect(content.elements[0].comment).toBe('Make this blue');
  });

  it('includes screenshot paths when provided', async () => {
    const fakeScreenshot = { index: 1, pngBuffer: Buffer.from('fake-png') };
    resultPath = await writeResultFile(testResult, [fakeScreenshot]);
    const content = JSON.parse(readFileSync(resultPath, 'utf-8'));
    expect(content.elements[0].screenshotPath).toMatch(/fleet-annotate-.*-el1\.png$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/annotate-service.test.ts`
Expected: FAIL — `writeResultFile` and `cropRect` not found

- [ ] **Step 3: Implement annotate-service.ts**

```typescript
// src/main/annotate-service.ts
import { BrowserWindow, ipcMain, session } from 'electron';
import { writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import { IPC_CHANNELS } from '../shared/constants';
import type {
  AnnotationResult,
  AnnotateStartRequest,
  ElementRect,
} from '../shared/annotate-types';

const log = createLogger('annotate');
const SCREENSHOT_PADDING = 20;
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;
const DEFAULT_TIMEOUT = 300;

export interface ElementScreenshot {
  index: number;
  pngBuffer: Buffer;
}

/**
 * Compute a crop rectangle with padding, clamped to viewport.
 */
export function cropRect(
  rect: ElementRect,
  padding: number,
  viewport: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.floor(rect.x - padding));
  const y = Math.max(0, Math.floor(rect.y - padding));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + padding));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Write annotation result + screenshots to temp files.
 * Returns the path to the JSON result file.
 */
export async function writeResultFile(
  result: AnnotationResult,
  screenshots: ElementScreenshot[]
): Promise<string> {
  const timestamp = Date.now();
  const basePath = join(tmpdir(), `fleet-annotate-${timestamp}`);
  const jsonPath = `${basePath}.json`;

  // Write screenshot PNGs and attach paths to elements
  const output = {
    ...result,
    elements: result.elements?.map((el, i) => {
      const shot = screenshots.find((s) => s.index === i + 1);
      if (shot) {
        const pngPath = `${basePath}-el${i + 1}.png`;
        // Write synchronously-ish — we await the whole batch below
        return { ...el, screenshotPath: pngPath };
      }
      return el;
    }),
  };

  // Write all screenshot files
  await Promise.all(
    screenshots.map(async (shot) => {
      if (shot.pngBuffer.length > MAX_SCREENSHOT_BYTES) {
        log.warn('screenshot too large, skipping', { index: shot.index });
        return;
      }
      const pngPath = `${basePath}-el${shot.index}.png`;
      await writeFile(pngPath, shot.pngBuffer, { mode: 0o600 });
    })
  );

  await writeFile(jsonPath, JSON.stringify(output, null, 2), { mode: 0o600 });
  return jsonPath;
}

type PendingRequest = {
  resolve: (resultPath: string) => void;
  reject: (err: Error) => void;
  timeoutId: NodeJS.Timeout;
};

/**
 * AnnotateService — manages the annotation BrowserWindow lifecycle.
 *
 * Opens a persistent-session BrowserWindow, injects the picker,
 * captures screenshots, writes results to temp files.
 */
export class AnnotateService extends EventEmitter {
  private window: BrowserWindow | null = null;
  private pending: PendingRequest | null = null;

  constructor() {
    super();
    this.registerIpcHandlers();
  }

  private registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.ANNOTATE_SUBMIT, async (_event, result: AnnotationResult) => {
      await this.handleSubmit(result);
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATE_CANCEL, async (_event, reason?: string) => {
      this.handleCancel(reason ?? 'user');
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATE_SCREENSHOT, async () => {
      return this.captureScreenshot();
    });
  }

  /**
   * Start an annotation session. Returns the result file path.
   */
  async start(request: AnnotateStartRequest): Promise<string> {
    // Cancel any existing session
    if (this.pending) {
      this.handleCancel('replaced');
    }

    const timeout = request.timeout ?? DEFAULT_TIMEOUT;

    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.handleCancel('timeout');
      }, timeout * 1000);

      this.pending = { resolve, reject, timeoutId };

      void this.openWindow(request.url);
    });
  }

  private async openWindow(url?: string): Promise<void> {
    const annotateSession = session.fromPartition('persist:annotate');

    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      if (url) {
        await this.window.loadURL(url);
      }
      await this.injectPicker();
      return;
    }

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const preloadPathJs = join(__dirname, '../preload/annotate.js');
    const preloadPathMjs = join(__dirname, '../preload/annotate.mjs');
    const preloadPath = existsSync(preloadPathJs) ? preloadPathJs : preloadPathMjs;

    this.window = new BrowserWindow({
      width: 1440,
      height: 900,
      title: 'Fleet Annotate',
      webPreferences: {
        preload: preloadPath,
        session: annotateSession,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });

    this.window.on('closed', () => {
      this.window = null;
      this.handleCancel('window_closed');
    });

    if (url) {
      await this.window.loadURL(url);
    } else {
      await this.window.loadURL('about:blank');
    }

    await this.injectPicker();
  }

  private async injectPicker(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;

    // Import the picker source at runtime to keep it as a separate module
    const { getPickerSource } = await import('./annotate-picker');
    await this.window.webContents.executeJavaScript(getPickerSource());
    log.info('picker injected');
  }

  private async captureScreenshot(): Promise<Buffer | null> {
    if (!this.window || this.window.isDestroyed()) return null;
    try {
      const image = await this.window.webContents.capturePage();
      return image.toPNG();
    } catch (err) {
      log.error('screenshot capture failed', { error: String(err) });
      return null;
    }
  }

  private async handleSubmit(result: AnnotationResult): Promise<void> {
    if (!this.pending) return;

    const { resolve, timeoutId } = this.pending;
    clearTimeout(timeoutId);
    this.pending = null;

    try {
      // Capture screenshots for elements that requested them
      const screenshots: ElementScreenshot[] = [];
      if (result.elements && this.window && !this.window.isDestroyed()) {
        const viewport = result.viewport ?? { width: 1440, height: 900 };

        for (let i = 0; i < result.elements.length; i++) {
          const el = result.elements[i];
          if (!el.captureScreenshot) continue;

          // Scroll element into view
          await this.window.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(el.selector)})?.scrollIntoView({ block: 'center' })`
          );
          // Brief delay for scroll to settle
          await new Promise((r) => setTimeout(r, 100));

          const fullPng = await this.captureScreenshot();
          if (!fullPng) continue;

          const crop = cropRect(el.rect, SCREENSHOT_PADDING, viewport);

          // Use nativeImage to crop
          const { nativeImage } = await import('electron');
          const fullImage = nativeImage.createFromBuffer(fullPng);
          const cropped = fullImage.crop(crop);
          screenshots.push({ index: i + 1, pngBuffer: cropped.toPNG() });
        }
      }

      const resultPath = await writeResultFile(result, screenshots);
      log.info('annotation complete', { resultPath, elementCount: result.elements?.length ?? 0 });
      resolve(resultPath);
    } catch (err) {
      log.error('failed to write result', { error: String(err) });
      // Still resolve with an error result file
      const errorResult: AnnotationResult = {
        success: false,
        reason: `Failed to write results: ${String(err)}`,
      };
      try {
        const errorPath = await writeResultFile(errorResult, []);
        resolve(errorPath);
      } catch {
        resolve(''); // last resort
      }
    }

    // Close the annotation window after submission
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
  }

  private handleCancel(reason: string): void {
    if (!this.pending) return;

    const { reject, timeoutId } = this.pending;
    clearTimeout(timeoutId);
    this.pending = null;

    reject(new Error(`Annotation cancelled: ${reason}`));
  }

  destroy(): void {
    if (this.pending) {
      this.handleCancel('shutdown');
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/annotate-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/annotate-service.ts src/main/__tests__/annotate-service.test.ts
git commit -m "feat(annotate): add annotation service with result file writing"
```

---

## Task 3: Preload Script

**Files:**
- Create: `src/preload/annotate.ts`
- Modify: `electron.vite.config.ts`

- [ ] **Step 1: Create the annotate preload script**

```typescript
// src/preload/annotate.ts
import { contextBridge, ipcRenderer } from 'electron';

const IPC = {
  SUBMIT: 'annotate:submit',
  CANCEL: 'annotate:cancel',
  SCREENSHOT: 'annotate:screenshot',
} as const;

contextBridge.exposeInMainWorld('fleetAnnotate', {
  /**
   * Submit annotation results to the main process.
   */
  submit: (result: unknown): Promise<void> => ipcRenderer.invoke(IPC.SUBMIT, result),

  /**
   * Cancel the annotation session.
   */
  cancel: (reason?: string): Promise<void> => ipcRenderer.invoke(IPC.CANCEL, reason),

  /**
   * Request a screenshot from the main process.
   * Returns a base64 data URL or null.
   */
  captureScreenshot: (): Promise<string | null> => ipcRenderer.invoke(IPC.SCREENSHOT),
});
```

- [ ] **Step 2: Add preload entry to electron-vite config**

In `electron.vite.config.ts`, add `annotate` to the preload input:

```typescript
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          copilot: 'src/preload/copilot.ts',
          annotate: 'src/preload/annotate.ts',
        },
        output: { format: 'cjs' }
      }
    }
  },
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload/annotate.ts electron.vite.config.ts
git commit -m "feat(annotate): add preload script and build entry"
```

---

## Task 4: Element Picker (Injected UI)

**Files:**
- Create: `src/main/annotate-picker.ts`

This is the largest task. The picker is a vanilla JS script injected into the annotation BrowserWindow's page via `executeJavaScript()`. It is ported from `reference/pi-annotate/chrome-extension/content.js` (2332 lines) with adaptations:

- Replace `chrome.runtime.sendMessage` with `window.fleetAnnotate.submit/cancel/captureScreenshot`
- Remove Chrome extension guard (`__piAnnotate_` key check) — replaced with Fleet-specific guard
- Remove references to `chrome.runtime.id`
- The picker communicates results back through the preload API instead of Chrome messaging

- [ ] **Step 1: Create annotate-picker.ts**

Export a `getPickerSource()` function that returns the full picker JS as a string. The function wraps the picker in an IIFE.

```typescript
// src/main/annotate-picker.ts

/**
 * Returns the element picker source code as a string.
 * This gets injected into the annotation BrowserWindow's page
 * via webContents.executeJavaScript().
 *
 * Port of reference/pi-annotate/chrome-extension/content.js
 * adapted for Fleet's preload API (window.fleetAnnotate).
 */
export function getPickerSource(): string {
  return `(${pickerIIFE.toString()})()`;
}

function pickerIIFE(): void {
  // ── Guard against double injection ──
  const LOADED_KEY = '__fleetAnnotate_loaded';
  if ((window as any)[LOADED_KEY]) return;
  (window as any)[LOADED_KEY] = true;

  // ── Constants ──
  const SCREENSHOT_PADDING = 20;
  const TEXT_MAX_LENGTH = 500;
  const Z_INDEX_CONNECTORS = 2147483643;
  const Z_INDEX_MARKERS = 2147483644;
  const Z_INDEX_HIGHLIGHT = 2147483645;
  const Z_INDEX_PANEL = 2147483646;
  const Z_INDEX_TOOLTIP = 2147483647;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const ALT_KEY_LABEL = IS_MAC ? '⌥' : 'Alt';

  // ── Helpers ──
  function escapeHtml(str: any): string {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function isPickerElement(el: Element | null): boolean {
    if (!el) return false;
    if ((el as HTMLElement).id?.startsWith('fleet-annotate-')) return true;
    const cls = el.className;
    if (!cls) return false;
    const clsStr = typeof cls === 'string' ? cls : (cls as any).baseVal || '';
    return clsStr.split(/\s+/).some((c: string) => c.startsWith('fa-'));
  }

  // ... (Full port of content.js follows — this is ~2000 lines)
  // Key changes from pi-annotate:
  //
  // 1. Submit handler calls:
  //    (window as any).fleetAnnotate.submit(result)
  //    instead of chrome.runtime.sendMessage({ type: 'ANNOTATIONS_COMPLETE', ... })
  //
  // 2. Cancel handler calls:
  //    (window as any).fleetAnnotate.cancel(reason)
  //    instead of chrome.runtime.sendMessage({ type: 'CANCEL', ... })
  //
  // 3. Screenshot capture calls:
  //    The picker sets captureScreenshot: true on elements
  //    and the main process handles actual capture.
  //    (No chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }))
  //
  // 4. Element IDs/classes prefixed with 'fleet-annotate-' and 'fa-'
  //    instead of 'pi-' to avoid conflicts.
  //
  // 5. No requestId tracking — single-session model.
  //
  // 6. Activation is immediate on injection (no START_ANNOTATION message).

  // PORT THE FULL PICKER FROM reference/pi-annotate/chrome-extension/content.js
  // with the adaptations listed above. The picker should:
  // - Create highlight overlay, tooltip, toolbar panel, markers, notes container, SVG connectors
  // - Handle mousemove (highlight), click (select), alt+scroll (ancestor cycle)
  // - Multi-select via shift+click or toolbar toggle
  // - Note cards: draggable, comment textarea, screenshot toggle, connector SVG
  // - Debug mode toggle for computed styles, parent context, CSS variables
  // - Toolbar: expand/collapse all, multi toggle, debug toggle, context textarea, submit/cancel
  // - Esc to cancel, Cmd+Shift+P to toggle
  // - On submit: collect all element data + comments, call window.fleetAnnotate.submit()
  // - On cancel: call window.fleetAnnotate.cancel()

  // The actual implementation should be a direct port with the substitutions above.
  // Reference: reference/pi-annotate/chrome-extension/content.js (2332 lines)
}
```

**Implementation note:** The actual porting work involves going through `reference/pi-annotate/chrome-extension/content.js` line by line. The core logic (DOM manipulation, element picking, note cards, data capture) stays identical. Only the communication layer changes (5 substitutions listed above). The implementer should:

1. Copy `content.js` into the `pickerIIFE` function body
2. Replace all `chrome.runtime.sendMessage` calls per the substitution table
3. Replace all `pi-` prefixes with `fleet-annotate-` / `fa-`
4. Remove the `chrome.runtime.id` guard
5. Make activation immediate (remove the `START_ANNOTATION` message listener, call `activate()` directly at the end)
6. Remove the `chrome.runtime.onMessage` listener for `START_ANNOTATION`/`CANCEL`

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/annotate-picker.ts
git commit -m "feat(annotate): add element picker UI (ported from pi-annotate)"
```

---

## Task 5: CLI Command — `fleet annotate`

**Files:**
- Modify: `src/main/fleet-cli.ts`
- Create: `src/main/__tests__/fleet-cli-annotate.test.ts`

- [ ] **Step 1: Write CLI tests**

```typescript
// src/main/__tests__/fleet-cli-annotate.test.ts
import { describe, it, expect } from 'vitest';
import { validateCommand, getHelpText } from '../fleet-cli';

describe('fleet annotate CLI', () => {
  describe('getHelpText', () => {
    it('returns annotate help text', () => {
      const help = getHelpText(['annotate', '--help']);
      expect(help).toContain('fleet annotate');
      expect(help).toContain('annotation');
    });
  });

  describe('validateCommand', () => {
    it('returns null for annotate.start with no args (current tab)', () => {
      const error = validateCommand('annotate.start', {});
      expect(error).toBeNull();
    });

    it('returns null for annotate.start with url', () => {
      const error = validateCommand('annotate.start', { url: 'https://example.com' });
      expect(error).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/fleet-cli-annotate.test.ts`
Expected: FAIL — help text doesn't contain 'annotate'

- [ ] **Step 3: Add annotate to COMMAND_MAP**

In `src/main/fleet-cli.ts`, add to `COMMAND_MAP`:

```typescript
const COMMAND_MAP: Record<string, string> = {
  // Images
  'images.generate': 'image.generate',
  'images.edit': 'image.edit',
  'images.status': 'image.status',
  'images.list': 'image.list',
  'images.retry': 'image.retry',
  'images.config': 'image.config.get',
  'images.action': 'image.action',
  'images.actions': 'image.actions.list',
  // Annotate
  'annotate.start': 'annotate.start',
};
```

- [ ] **Step 4: Add annotate help text**

Add to `HELP_GROUPS`:

```typescript
  annotate: `# fleet annotate

Open visual annotation mode to select and annotate web page elements.

## When to use

Use \`fleet annotate\` when you want to visually point out UI elements for an AI agent
to fix. Opens a browser window where you can click elements, add comments, and capture
screenshots. Results are written to a JSON file that agents can read.

## Usage

  fleet annotate [url]
  fleet annotate [url] --timeout <seconds>

## Arguments

  [url]       URL to annotate. If omitted, opens a blank page.
  --timeout   Max seconds to wait for annotation (default: 300).

## Examples

\\\`\\\`\\\`bash
fleet annotate https://localhost:3000
fleet annotate https://example.com --timeout 600
fleet annotate
\\\`\\\`\\\``,
```

Also update `HELP_TOP` to add annotate to the commands table:

```
| annotate | Visually annotate web page elements for AI agents. |
```

- [ ] **Step 5: Add annotate command handling in runCLI**

In `runCLI()`, add a top-level `annotate` handler after the `open` block (before `images config`):

```typescript
  // ── Top-level "annotate" command ──────────────────────────────────────────
  if (group === 'annotate') {
    // URL is optional first positional arg
    const url = action && !action.startsWith('--') ? action : undefined;
    const allArgs = url ? rest : [action, ...rest].filter(Boolean);
    const parsedArgs = parseArgs(allArgs);
    const timeout = typeof parsedArgs.timeout === 'string' ? Number(parsedArgs.timeout) : undefined;

    const command = 'annotate.start';
    const args: Record<string, unknown> = {};
    if (url) args.url = url;
    if (timeout) args.timeout = timeout;

    const cli = new FleetCLI(sockPath);
    try {
      const response = opts?.retry
        ? await cli.sendWithRetry(command, args)
        : await cli.send(command, args);
      if (!response.ok) {
        return `Error: ${response.error ?? 'Unknown error'}`;
      }
      if (isRecord(response.data) && typeof response.data.resultPath === 'string') {
        return response.data.resultPath;
      }
      return toStr(response.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOENT')) {
        return 'Fleet is not running';
      }
      return `Error: ${msg}`;
    }
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/fleet-cli-annotate.test.ts`
Expected: PASS

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli-annotate.test.ts
git commit -m "feat(annotate): add fleet annotate CLI command"
```

---

## Task 6: Socket Server Handler

**Files:**
- Modify: `src/main/socket-server.ts`

- [ ] **Step 1: Add AnnotateService to socket server constructor**

Update the constructor to accept an optional `AnnotateService`:

```typescript
import type { AnnotateService } from './annotate-service';

// In the class:
constructor(
  private socketPath: string,
  private imageService?: ImageService,
  private annotateService?: AnnotateService,
) {
  super();
}
```

- [ ] **Step 2: Add annotate.start dispatch case**

Add in the `dispatch` method's switch, before the `default` case:

```typescript
      // ── Annotate ──────────────────────────────────────────────────────────────
      case 'annotate.start': {
        if (!this.annotateService) throw new CodedError('Annotate service not available', 'UNAVAILABLE');
        const url = typeof args.url === 'string' ? args.url : undefined;
        const timeout = typeof args.timeout === 'number'
          ? args.timeout
          : typeof args.timeout === 'string'
            ? Number(args.timeout)
            : undefined;
        const resultPath = await this.annotateService.start({ url, timeout });
        return { resultPath };
      }
```

Note: The `dispatch` method's return type is `unknown`, but it currently isn't `async`. Since `annotateService.start()` returns a `Promise`, update the `dispatch` method signature to return `Promise<unknown>`:

```typescript
private async dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/socket-server.ts
git commit -m "feat(annotate): add annotate.start socket dispatch handler"
```

---

## Task 7: Wire Up in Main Process

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Import and instantiate AnnotateService**

Add import near the top of `src/main/index.ts`:

```typescript
import { AnnotateService } from './annotate-service';
```

Add instantiation after the `imageService` setup (around line 57):

```typescript
const annotateService = new AnnotateService();
```

- [ ] **Step 2: Pass annotateService to SocketSupervisor**

The `SocketSupervisor` wraps `SocketServer`. Find where `SocketSupervisor` is constructed (line ~284):

```typescript
socketSupervisor = new SocketSupervisor(SOCKET_PATH, imageService);
```

Change to:

```typescript
socketSupervisor = new SocketSupervisor(SOCKET_PATH, imageService, annotateService);
```

Also update `SocketSupervisor` to pass `annotateService` through. Check `src/main/socket-supervisor.ts` — it creates `SocketServer` instances internally. Update its constructor and the `SocketServer` instantiation to pass `annotateService`.

- [ ] **Step 3: Update socket-supervisor.ts**

In `src/main/socket-supervisor.ts`, update the constructor to accept and forward `annotateService`:

```typescript
import type { AnnotateService } from './annotate-service';

// Update constructor:
constructor(
  private socketPath: string,
  private imageService?: ImageService,
  private annotateService?: AnnotateService,
) { ... }

// Update where SocketServer is created (find the new SocketServer() call):
new SocketServer(this.socketPath, this.imageService, this.annotateService)
```

- [ ] **Step 4: Clean up on app quit**

Add cleanup in the `app.on('before-quit')` or `app.on('will-quit')` handler (find it in `index.ts`):

```typescript
annotateService.destroy();
```

If no quit handler exists, add one after the `app.whenReady()` block:

```typescript
app.on('will-quit', () => {
  annotateService.destroy();
});
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/main/socket-supervisor.ts
git commit -m "feat(annotate): wire annotate service into main process"
```

---

## Task 8: Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (fix any lint errors)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS — all three targets (main, preload, renderer) build successfully.

- [ ] **Step 5: Commit any fixes**

If any fixes were needed:

```bash
git add -A
git commit -m "fix(annotate): fix lint and build issues"
```

---

## Task 9: Manual Testing

**Files:** None (testing only)

- [ ] **Step 1: Launch Fleet in dev mode**

Run: `npm run dev`

- [ ] **Step 2: Test CLI command with URL**

In a Fleet terminal, run:

```bash
fleet annotate https://example.com
```

Verify:
- A new BrowserWindow opens showing example.com
- The picker UI is visible (highlight on hover, toolbar at bottom)
- Click an element — note card appears
- Type a comment in the note card
- Click Submit
- The CLI prints a file path like `/tmp/fleet-annotate-XXXXX.json`
- Read the JSON file — verify it contains the element data, selector, comment

- [ ] **Step 3: Test CLI command without URL**

```bash
fleet annotate
```

Verify: BrowserWindow opens to `about:blank`

- [ ] **Step 4: Test cancel**

```bash
fleet annotate https://example.com
```

Press Esc in the annotation window. Verify CLI exits with non-zero code.

- [ ] **Step 5: Test multi-select**

Open annotation on a page, shift+click multiple elements, add comments to each, submit. Verify all elements appear in the result JSON.

- [ ] **Step 6: Test screenshots**

Toggle the 📷 button on a note card, submit. Verify a PNG file exists at the `screenshotPath` in the JSON and is a valid image.

- [ ] **Step 7: Test session persistence**

1. `fleet annotate https://some-site-with-login.com`
2. Log in via the annotation browser
3. Close the window
4. `fleet annotate https://some-site-with-login.com`
5. Verify you're still logged in (cookies persisted)
