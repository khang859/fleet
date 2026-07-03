import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { isLikelyBlank } from '../verbs';

async function solidPng(): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .png()
    .toBuffer();
}

async function noisyPng(): Promise<Buffer> {
  const pixels = Buffer.alloc(32 * 32 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 97) % 256;
  return sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();
}

describe('isLikelyBlank', () => {
  it('flags a solid single-color image as blank', async () => {
    expect(await isLikelyBlank(await solidPng())).toBe(true);
  });

  it('does not flag a varied image as blank', async () => {
    expect(await isLikelyBlank(await noisyPng())).toBe(false);
  });
});
