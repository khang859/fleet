import sharp from 'sharp';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = resolve(root, 'sprites-raw/star-command/chrome');
const dest = resolve(root, 'src/renderer/copilot/src/assets/crt');

if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

interface CropSpec {
  file: string;
  // Content bounds from analysis: { left, top, width, height }
  extract: { left: number; top: number; width: number; height: number };
  resize: { width: number; height: number };
}

const corners: CropSpec[] = [
  {
    file: 'crt-corner-tl.png',
    extract: { left: 45, top: 45, width: 467, height: 467 },
    resize: { width: 32, height: 32 },
  },
  {
    file: 'crt-corner-tr.png',
    extract: { left: 0, top: 45, width: 467, height: 467 },
    resize: { width: 32, height: 32 },
  },
  {
    file: 'crt-corner-bl.png',
    extract: { left: 45, top: 0, width: 467, height: 467 },
    resize: { width: 32, height: 32 },
  },
  {
    file: 'crt-corner-br.png',
    extract: { left: 0, top: 0, width: 467, height: 467 },
    resize: { width: 32, height: 32 },
  },
];

const edges: CropSpec[] = [
  {
    file: 'crt-edge-v.png',
    extract: { left: 127, top: 0, width: 258, height: 512 },
    resize: { width: 16, height: 64 },
  },
  {
    file: 'crt-edge-h.png',
    extract: { left: 0, top: 163, width: 512, height: 145 },
    resize: { width: 64, height: 16 },
  },
];

async function cropAndScale(spec: CropSpec): Promise<void> {
  const input = resolve(src, spec.file);
  const output = resolve(dest, spec.file);
  await sharp(input)
    .extract(spec.extract)
    .resize(spec.resize.width, spec.resize.height, {
      kernel: sharp.kernel.nearest, // Preserve pixel art
    })
    .toFile(output);
  console.log(`✓ ${spec.file} → ${spec.resize.width}x${spec.resize.height}`);
}

async function main(): Promise<void> {
  console.log('Cropping CRT sprites...');
  console.log(`Source: ${src}`);
  console.log(`Destination: ${dest}\n`);

  for (const spec of [...corners, ...edges]) {
    await cropAndScale(spec);
  }

  // Scanline is already 32x32, just copy
  const scanSrc = resolve(src, 'crt-scanline.png');
  const scanDest = resolve(dest, 'crt-scanline.png');
  await sharp(scanSrc).toFile(scanDest);
  console.log('✓ crt-scanline.png → 32x32 (copied)');

  console.log('\nDone! 7 assets written.');
}

main().catch(console.error);
