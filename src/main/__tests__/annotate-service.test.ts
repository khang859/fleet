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

describe('DPI-scaled crop rect', () => {
  // Replicates the scaling logic from handleSubmit
  function scaleCropRect(
    cssRect: { x: number; y: number; width: number; height: number },
    dpr: number,
    imgSize: { width: number; height: number }
  ): { x: number; y: number; width: number; height: number } | null {
    const scaled = {
      x: Math.round(cssRect.x * dpr),
      y: Math.round(cssRect.y * dpr),
      width: Math.round(cssRect.width * dpr),
      height: Math.round(cssRect.height * dpr)
    };
    scaled.width = Math.min(scaled.width, imgSize.width - scaled.x);
    scaled.height = Math.min(scaled.height, imgSize.height - scaled.y);
    if (scaled.width <= 0 || scaled.height <= 0) return null;
    return scaled;
  }

  it('scales CSS crop rect by 2x for Retina displays', () => {
    const cssCrop = cropRect({ x: 100, y: 200, width: 120, height: 40 }, 20, {
      width: 1440,
      height: 900
    });
    // CSS crop: { x: 80, y: 180, width: 160, height: 80 }
    const scaled = scaleCropRect(cssCrop, 2, { width: 2880, height: 1800 });
    expect(scaled).toEqual({ x: 160, y: 360, width: 320, height: 160 });
  });

  it('leaves crop rect unchanged at 1x DPI', () => {
    const cssCrop = cropRect({ x: 100, y: 200, width: 120, height: 40 }, 20, {
      width: 1440,
      height: 900
    });
    const scaled = scaleCropRect(cssCrop, 1, { width: 1440, height: 900 });
    expect(scaled).toEqual(cssCrop);
  });

  it('clamps to actual image bounds when crop exceeds image', () => {
    // Element at the very edge of viewport
    const cssCrop = cropRect({ x: 1420, y: 880, width: 20, height: 20 }, 20, {
      width: 1440,
      height: 900
    });
    // At 2x, crop extends beyond image: image is 2880x1800
    const scaled = scaleCropRect(cssCrop, 2, { width: 2880, height: 1800 });
    expect(scaled).not.toBeNull();
    expect(scaled!.x + scaled!.width).toBeLessThanOrEqual(2880);
    expect(scaled!.y + scaled!.height).toBeLessThanOrEqual(1800);
  });

  it('returns null when crop is entirely outside image bounds', () => {
    // Simulate a rect that after scaling falls outside a smaller-than-expected image
    const cssCrop = { x: 800, y: 500, width: 100, height: 100 };
    // Image is only 400x300 (smaller than the crop start)
    const scaled = scaleCropRect(cssCrop, 1, { width: 400, height: 300 });
    expect(scaled).toBeNull();
  });

  it('handles fractional DPI values (e.g. 1.5x)', () => {
    const cssCrop = cropRect({ x: 100, y: 100, width: 200, height: 100 }, 20, {
      width: 1440,
      height: 900
    });
    const scaled = scaleCropRect(cssCrop, 1.5, { width: 2160, height: 1350 });
    expect(scaled).not.toBeNull();
    expect(scaled!.x).toBe(Math.round(cssCrop.x * 1.5));
    expect(scaled!.y).toBe(Math.round(cssCrop.y * 1.5));
    expect(scaled!.width).toBe(Math.round(cssCrop.width * 1.5));
    expect(scaled!.height).toBe(Math.round(cssCrop.height * 1.5));
  });
});

describe('cropRect uses fresh viewport-relative coordinates', () => {
  it('produces different crops for same element at different scroll positions', () => {
    // Before scroll: element at y=2000 (off-screen for 900px viewport)
    // cropRect clamps to viewport, so height would be 0 or negative
    const offScreen = cropRect({ x: 100, y: 2000, width: 200, height: 50 }, 20, {
      width: 1440,
      height: 900
    });
    // After scroll: element scrolled to center, now at y=400
    const onScreen = cropRect({ x: 100, y: 400, width: 200, height: 50 }, 20, {
      width: 1440,
      height: 900
    });

    // Off-screen crop is clamped to viewport bottom (900), giving tiny or zero height
    expect(offScreen.y).toBe(1980);
    expect(offScreen.height).toBeLessThanOrEqual(0);

    // On-screen crop has proper dimensions
    expect(onScreen.y).toBe(380);
    expect(onScreen.height).toBe(90);
    expect(onScreen.width).toBe(240);
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
