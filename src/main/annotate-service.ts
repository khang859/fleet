import { BrowserWindow, ipcMain, session, nativeImage } from 'electron';
import { writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import { IPC_CHANNELS } from '../shared/constants';
import type { AnnotationResult, AnnotateStartRequest, ElementRect } from '../shared/annotate-types';
import type { AnnotationStore, AnnotationScreenshot } from './annotation-store';

const log = createLogger('annotate');
const SCREENSHOT_PADDING = 20;
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;
const DEFAULT_TIMEOUT = 300;

export interface ElementScreenshot {
  index: number;
  pngBuffer: Buffer;
}

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

export async function writeResultFile(
  result: AnnotationResult,
  screenshots: ElementScreenshot[]
): Promise<string> {
  const timestamp = Date.now();
  const basePath = join(tmpdir(), `fleet-annotate-${timestamp}`);
  const jsonPath = `${basePath}.json`;

  const output = {
    ...result,
    elements: result.elements?.map((el, i) => {
      const shot = screenshots.find((s) => s.index === i + 1);
      if (shot) {
        const pngPath = `${basePath}-el${i + 1}.png`;
        return { ...el, screenshotPath: pngPath };
      }
      return el;
    })
  };

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

export class AnnotateService extends EventEmitter {
  private window: BrowserWindow | null = null;
  private pending: PendingRequest | null = null;
  private annotationStore: AnnotationStore | null = null;
  private currentMode: 'select' | 'draw' = 'select';
  /** Pre-captured element snapshots: index -> cropped PNG buffer */
  private elementSnapshots = new Map<number, Buffer>();

  constructor(annotationStore?: AnnotationStore) {
    super();
    this.annotationStore = annotationStore ?? null;
    this.registerIpcHandlers();
  }

  private registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.ANNOTATE_SUBMIT, async (_event, result: AnnotationResult) => {
      await this.handleSubmit(result);
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATE_CANCEL, (_event, reason?: string) => {
      this.handleCancel(reason ?? 'user');
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATE_SCREENSHOT, async () => {
      return this.captureScreenshot();
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATE_SNAPSHOT_ELEMENT, async (_event, data: {
      index: number;
      viewportRect: ElementRect;
      dpr: number;
    }) => {
      await this.captureElementSnapshot(data.index, data.viewportRect, data.dpr);
    });
  }

  private async captureElementSnapshot(
    index: number,
    viewportRect: ElementRect,
    dpr: number
  ): Promise<void> {
    const fullPng = await this.captureScreenshot();
    if (!fullPng) return;

    const viewport = this.window && !this.window.isDestroyed()
      ? this.window.getBounds()
      : { width: 1440, height: 900 };

    const cssCrop = cropRect(viewportRect, SCREENSHOT_PADDING, viewport);
    const scaledCrop = {
      x: Math.round(cssCrop.x * dpr),
      y: Math.round(cssCrop.y * dpr),
      width: Math.round(cssCrop.width * dpr),
      height: Math.round(cssCrop.height * dpr)
    };

    const fullImage = nativeImage.createFromBuffer(fullPng);
    const imgSize = fullImage.getSize();
    scaledCrop.width = Math.min(scaledCrop.width, imgSize.width - scaledCrop.x);
    scaledCrop.height = Math.min(scaledCrop.height, imgSize.height - scaledCrop.y);
    if (scaledCrop.width <= 0 || scaledCrop.height <= 0) return;

    const cropped = fullImage.crop(scaledCrop);
    this.elementSnapshots.set(index, cropped.toPNG());
    log.info('element snapshot captured', { index });
  }

  async start(request: AnnotateStartRequest): Promise<string> {
    if (this.pending) {
      this.handleCancel('replaced');
    }
    this.elementSnapshots.clear();
    this.currentMode = request.mode ?? 'select';

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
        nodeIntegration: false
      }
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
    const { getPickerSource } = await import('./annotate-picker');
    const modeSetup = `window.__fleetAnnotateMode = ${JSON.stringify(this.currentMode)};`;
    await this.window.webContents.executeJavaScript(modeSetup + getPickerSource());
    log.info('picker injected', { mode: this.currentMode });
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

  private async compositeOverlay(
    pagePng: Buffer,
    overlayDataURL: string
  ): Promise<Buffer> {
    if (!this.window || this.window.isDestroyed()) return pagePng;

    try {
      const pageImage = nativeImage.createFromBuffer(pagePng);
      const pageDataURL = pageImage.toDataURL();

      const compositedDataURL = await this.window.webContents.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            var base = new Image();
            base.onload = function() {
              var canvas = document.createElement('canvas');
              canvas.width = base.naturalWidth;
              canvas.height = base.naturalHeight;
              var ctx = canvas.getContext('2d');
              ctx.drawImage(base, 0, 0);

              var overlay = new Image();
              overlay.onload = function() {
                ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
              };
              overlay.onerror = function() { resolve(null); };
              overlay.src = ${JSON.stringify(overlayDataURL)};
            };
            base.onerror = function() { resolve(null); };
            base.src = ${JSON.stringify(pageDataURL)};
          });
        })()
      `) as string | null;

      if (!compositedDataURL) return pagePng;

      const b64 = compositedDataURL.replace(/^data:image\/png;base64,/, '');
      return Buffer.from(b64, 'base64');
    } catch (err) {
      log.warn('overlay compositing failed, using plain screenshot', { error: String(err) });
      return pagePng;
    }
  }

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

          // Use pre-captured snapshot if available (for transient elements like hover menus)
          const preCapture = this.elementSnapshots.get(i);
          if (preCapture) {
            screenshots.push({ index: i + 1, pngBuffer: preCapture });
            continue;
          }

          // Scroll element into view, wait for repaint, then get fresh viewport-relative rect
          const freshInfo = await this.window.webContents.executeJavaScript(`
            (() => {
              const el = document.querySelector(${JSON.stringify(el.selector)});
              if (!el) return Promise.resolve(null);
              el.scrollIntoView({ block: 'center' });
              return new Promise(resolve => {
                requestAnimationFrame(() => {
                  const r = el.getBoundingClientRect();
                  resolve({ x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 });
                });
              });
            })()
          `) as (ElementRect & { dpr: number }) | null;
          await new Promise((r) => setTimeout(r, 150));

          if (!freshInfo) continue;

          const fullPng = await this.captureScreenshot();
          if (!fullPng) continue;

          // cropRect works in CSS pixels; scale by devicePixelRatio for the actual image
          const cssCrop = cropRect(freshInfo, SCREENSHOT_PADDING, viewport);
          const dpr = freshInfo.dpr;
          const scaledCrop = {
            x: Math.round(cssCrop.x * dpr),
            y: Math.round(cssCrop.y * dpr),
            width: Math.round(cssCrop.width * dpr),
            height: Math.round(cssCrop.height * dpr)
          };
          const fullImage = nativeImage.createFromBuffer(fullPng);
          const imgSize = fullImage.getSize();
          // Clamp to actual image bounds
          scaledCrop.width = Math.min(scaledCrop.width, imgSize.width - scaledCrop.x);
          scaledCrop.height = Math.min(scaledCrop.height, imgSize.height - scaledCrop.y);
          if (scaledCrop.width <= 0 || scaledCrop.height <= 0) continue;
          const cropped = fullImage.crop(scaledCrop);
          screenshots.push({ index: i + 1, pngBuffer: cropped.toPNG() });
        }
      }

      // Save full-page screenshot with drawing overlay composited
      let drawingOverlayPng: Buffer | null = null;
      if (result.canvasOverlay && this.window && !this.window.isDestroyed()) {
        const fullPng = await this.captureScreenshot();
        if (fullPng) {
          drawingOverlayPng = await this.compositeOverlay(fullPng, result.canvasOverlay);
        }
      }

      // Don't persist the canvas overlay data URL in the result JSON
      delete result.canvasOverlay;

      let resultPath: string;
      if (this.annotationStore) {
        const meta = this.annotationStore.add(result, screenshots, drawingOverlayPng);
        resultPath = join(meta.dirPath, 'result.json');
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
          ? join(this.annotationStore.add(errorResult, []).dirPath, 'result.json')
          : await writeResultFile(errorResult, []);
        resolve(errorPath);
      } catch {
        resolve('');
      }
    }

    this.elementSnapshots.clear();

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
