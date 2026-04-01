import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import type { AnnotationResult } from '../../shared/annotate-types';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  session: { fromPartition: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() }
}));

const { writeResultFile, cropRect } = await import('../annotate-service');

describe('cropRect', () => {
  it('crops element rect with padding, clamped to viewport', () => {
    const result = cropRect({ x: 100, y: 200, width: 120, height: 40 }, 20, {
      width: 1440,
      height: 900
    });
    expect(result).toEqual({ x: 80, y: 180, width: 160, height: 80 });
  });

  it('clamps to viewport boundaries', () => {
    const result = cropRect({ x: 5, y: 5, width: 100, height: 100 }, 20, {
      width: 200,
      height: 200
    });
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.width).toBeLessThanOrEqual(200);
    expect(result.height).toBeLessThanOrEqual(200);
  });

  it('handles element at viewport edge', () => {
    const result = cropRect({ x: 1420, y: 880, width: 20, height: 20 }, 20, {
      width: 1440,
      height: 900
    });
    expect(result.x + result.width).toBeLessThanOrEqual(1440);
    expect(result.y + result.height).toBeLessThanOrEqual(900);
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
          margin: { top: 0, right: 0, bottom: 0, left: 0 }
        },
        accessibility: {
          role: 'button',
          name: 'Click me',
          description: null,
          focusable: true,
          disabled: false
        },
        keyStyles: { display: 'flex' }
      }
    ]
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

  it('handles empty elements', async () => {
    const emptyResult: AnnotationResult = { success: true, elements: [] };
    resultPath = await writeResultFile(emptyResult, []);
    const content = JSON.parse(readFileSync(resultPath, 'utf-8'));
    expect(content.elements).toEqual([]);
  });
});
