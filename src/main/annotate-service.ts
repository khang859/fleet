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
  }

  async start(request: AnnotateStartRequest): Promise<string> {
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
          ? join(
              this.annotationStore['baseDir'],
              this.annotationStore.add(errorResult, []).dirPath,
              'result.json'
            )
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
