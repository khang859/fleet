import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ImageService } from '../image-service';

// Store original homedir and temporarily replace it
const FLEET_IMAGES_DIR = join(homedir(), '.fleet', 'images');
const GENERATIONS_DIR = join(FLEET_IMAGES_DIR, 'generations');

let imageService: ImageService;

beforeEach(() => {
  mkdirSync(GENERATIONS_DIR, { recursive: true });
  imageService = new ImageService();
});

afterEach(() => {
  imageService.shutdown();
});

describe('ImageService', () => {
  describe('edit with local file paths', () => {
    it('converts local file paths to data URIs before submitting to provider', async () => {
      // Setup: Create a test image file
      const testImagePath = join(GENERATIONS_DIR, 'test-image.png');
      const testImageBuffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes
      writeFileSync(testImagePath, testImageBuffer);

      // Spy on provider.submit to capture what gets passed
      const provider = imageService['getProvider']();
      const submitSpy = vi.spyOn(provider, 'submit');
      submitSpy.mockResolvedValueOnce({ requestId: 'test-request-id' });

      // Call edit with local file path
      const result = imageService.edit({
        prompt: 'Test prompt',
        images: [testImagePath],
        provider: 'fal-ai'
      });

      expect(result.id).toBeDefined();

      // Wait a bit for async submit to be called
      await new Promise((r) => setTimeout(r, 100));

      // Verify that provider.submit was called with data URI, not local path
      expect(submitSpy).toHaveBeenCalled();
      const callArgs = submitSpy.mock.calls[0];
      const editOpts = callArgs[0] as { imageUrls?: string[] };

      expect(editOpts.imageUrls).toHaveLength(1);
      expect(editOpts.imageUrls![0]).toMatch(/^data:image\//);
      expect(editOpts.imageUrls![0]).not.toEqual(testImagePath);
    });

    it('preserves HTTP URLs when passed as image sources', async () => {
      const provider = imageService['getProvider']();
      const submitSpy = vi.spyOn(provider, 'submit');
      submitSpy.mockResolvedValueOnce({ requestId: 'test-request-id' });

      const httpUrl = 'https://example.com/image.png';
      const result = imageService.edit({
        prompt: 'Test prompt',
        images: [httpUrl],
        provider: 'fal-ai'
      });

      expect(result.id).toBeDefined();

      await new Promise((r) => setTimeout(r, 100));

      expect(submitSpy).toHaveBeenCalled();
      const callArgs = submitSpy.mock.calls[0];
      const editOpts = callArgs[0] as { imageUrls?: string[] };

      expect(editOpts.imageUrls).toHaveLength(1);
      expect(editOpts.imageUrls![0]).toBe(httpUrl);
    });

    it('handles multiple image paths correctly', async () => {
      // Setup: Create multiple test image files
      const testImageBuffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes

      const paths = [
        join(GENERATIONS_DIR, 'test-image-1.png'),
        join(GENERATIONS_DIR, 'test-image-2.png')
      ];

      for (const path of paths) {
        writeFileSync(path, testImageBuffer);
      }

      const provider = imageService['getProvider']();
      const submitSpy = vi.spyOn(provider, 'submit');
      submitSpy.mockResolvedValueOnce({ requestId: 'test-request-id' });

      const result = imageService.edit({
        prompt: 'Test prompt',
        images: paths,
        provider: 'fal-ai'
      });

      expect(result.id).toBeDefined();

      await new Promise((r) => setTimeout(r, 100));

      expect(submitSpy).toHaveBeenCalled();
      const callArgs = submitSpy.mock.calls[0];
      const editOpts = callArgs[0] as { imageUrls?: string[] };

      expect(editOpts.imageUrls).toHaveLength(2);
      for (const url of editOpts.imageUrls!) {
        expect(url).toMatch(/^data:image\//);
      }
    });
  });
});
