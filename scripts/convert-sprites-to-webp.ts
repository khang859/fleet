// scripts/convert-sprites-to-webp.ts
import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MASCOTS_DIR = join(__dirname, '..', 'resources', 'mascots');
const ASSETS_DIR = join(__dirname, '..', 'src', 'renderer', 'copilot', 'src', 'assets');

const MASCOT_IDS = ['officer', 'robot', 'cat', 'bear', 'kraken'];

async function main(): Promise<void> {
  await mkdir(MASCOTS_DIR, { recursive: true });

  for (const id of MASCOT_IDS) {
    // sprites-officer.ts re-exports from copilot-sprites.ts, handle specially
    let mod: { default: string };
    if (id === 'officer') {
      mod = await import(join(ASSETS_DIR, 'copilot-sprites.ts'));
    } else {
      mod = await import(join(ASSETS_DIR, `sprites-${id}.ts`));
    }

    const dataUri: string = mod.default;
    const base64 = dataUri.replace(/^data:image\/png;base64,/, '');
    const pngBuffer = Buffer.from(base64, 'base64');

    const webpBuffer = await sharp(pngBuffer)
      .webp({ lossless: true })
      .toBuffer();

    const outPath = join(MASCOTS_DIR, `${id}.webp`);
    await writeFile(outPath, webpBuffer);
    const savings = Math.round((1 - webpBuffer.length / pngBuffer.length) * 100);
    console.log(`${id}: ${pngBuffer.length} bytes PNG -> ${webpBuffer.length} bytes WebP (${savings}% smaller)`);
  }

  console.log('\nDone! WebP files written to resources/mascots/');
}

main();
