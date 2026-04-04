import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync
} from 'fs';
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- persisted JSON, shape validated by Array.isArray
      return parsed as AnnotationMeta[];
    } catch {
      return [];
    }
  }

  get(id: string): (AnnotationResult & { screenshotPaths?: string[] }) | null {
    const meta = this.list().find((m) => m.id === id);
    if (!meta) return null;
    const resultPath = join(meta.dirPath, 'result.json');
    if (!existsSync(resultPath)) return null;
    try {
      const raw = readFileSync(resultPath, 'utf-8');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- persisted JSON
      return JSON.parse(raw) as AnnotationResult & {
        screenshotPaths?: string[];
      };
    } catch {
      return null;
    }
  }

  add(
    result: AnnotationResult,
    screenshots: AnnotationScreenshot[],
    drawingOverlayPng?: Buffer | null
  ): AnnotationMeta {
    const timestamp = Date.now();
    const id = `ann-${timestamp}-${randomUUID().slice(0, 8)}`;
    const dirPath = join(this.baseDir, id);
    const fullDir = dirPath;
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

    // Write full-page drawing overlay if present
    let drawingOverlayPath: string | undefined;
    if (drawingOverlayPng && drawingOverlayPng.length <= MAX_SCREENSHOT_BYTES) {
      drawingOverlayPath = join(fullDir, 'drawing.png');
      writeFileSync(drawingOverlayPath, drawingOverlayPng, { mode: 0o600 });
    }

    // Build result with screenshot paths on elements
    const outputResult = {
      ...result,
      screenshotPaths,
      drawingOverlayPath,
      elements: result.elements?.map((el, i) => {
        const shot = screenshots.find((s) => s.index === i + 1);
        if (shot) {
          return { ...el, screenshotPath: join(fullDir, `el${i + 1}.png`) };
        }
        return el;
      })
    };

    // Write result.json
    writeFileSync(
      join(fullDir, 'result.json'),
      JSON.stringify(outputResult, null, 2),
      { mode: 0o600 }
    );

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

    if (existsSync(entry.dirPath)) {
      rmSync(entry.dirPath, { recursive: true, force: true });
    }

    this.saveIndex(index.filter((m) => m.id !== id));
    this.emit('changed');
  }

  cleanup(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const index = this.list();
    const toDelete = index.filter((m) => m.timestamp < cutoff);

    for (const entry of toDelete) {
      if (existsSync(entry.dirPath)) {
        rmSync(entry.dirPath, { recursive: true, force: true });
      }
    }

    if (toDelete.length > 0) {
      this.saveIndex(index.filter((m) => m.timestamp >= cutoff));
      log.info('cleaned up old annotations', { count: toDelete.length });
    }
  }

  saveIndex(index: AnnotationMeta[]): void {
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), {
      mode: 0o600
    });
  }
}
