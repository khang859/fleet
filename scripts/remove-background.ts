#!/usr/bin/env npx tsx
/**
 * Removes backgrounds from all images in sprites-staging/
 * and writes the result to sprites-raw/ preserving the same
 * subdir/filename so assemble-sprites.ts can pick them up directly.
 *
 * Usage:
 *   npx tsx scripts/remove-background.ts
 *   (FAL_KEY loaded from .env)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, extname, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

config({ path: join(__dirname, '../.env') });

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error('Error: FAL_KEY environment variable is required');
  process.exit(1);
}

const SPRITES_STAGING = join(__dirname, '../sprites-staging');
const SPRITES_RAW = join(__dirname, '../sprites-raw');

function toDataUri(filepath: string): string {
  const data = readFileSync(filepath);
  const ext = extname(filepath).slice(1).toLowerCase();
  const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

async function removeBackground(imageUrl: string): Promise<string> {
  const response = await fetch('https://fal.run/fal-ai/bria/background/remove', {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ image_url: imageUrl, sync_mode: true })
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  const result: unknown = await response.json();
  if (
    typeof result !== 'object' ||
    result === null ||
    !('image' in result) ||
    typeof result.image !== 'object' ||
    result.image === null ||
    !('url' in result.image) ||
    typeof result.image.url !== 'string'
  ) {
    throw new Error('Unexpected response format from background removal API');
  }
  return result.image.url;
}

async function downloadImage(url: string, filepath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  writeFileSync(filepath, Buffer.from(await response.arrayBuffer()));
}

function collectImages(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectImages(full));
    } else if (/\.(png|jpg|jpeg|webp)$/i.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

async function main(): Promise<void> {
  if (!existsSync(SPRITES_STAGING)) {
    console.error('sprites-staging/ not found — run generate-image.ts first');
    process.exit(1);
  }

  const files = collectImages(SPRITES_STAGING);
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No images found in sprites-staging/');
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Found ${files.length} image(s) in sprites-staging/\n`);

  for (const file of files) {
    const rel = relative(SPRITES_STAGING, file);
    // Always save as .png to sprites-raw/ (preserving subdir + filename, no suffix)
    const outputName = basename(file, extname(file)) + '.png';
    const outputPath = join(SPRITES_RAW, dirname(rel), outputName);

    if (existsSync(outputPath)) {
      // eslint-disable-next-line no-console
      console.log(`Skipping (already in sprites-raw): ${rel}`);
      continue;
    }

    mkdirSync(dirname(outputPath), { recursive: true });

    // eslint-disable-next-line no-console
    console.log(`Processing: ${rel}`);
    const dataUri = toDataUri(file);
    const resultUrl = await removeBackground(dataUri);
    await downloadImage(resultUrl, outputPath);
    // eslint-disable-next-line no-console
    console.log(`  → sprites-raw/${dirname(rel)}/${outputName}`);
  }

  // eslint-disable-next-line no-console
  console.log('\nDone. Run: npx tsx scripts/assemble-sprites.ts');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Error:', message);
  process.exit(1);
});
