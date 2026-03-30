import sharp from 'sharp';
import { writeFile, readdir, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Assemble Copilot Mascot Sprite Sheet
// ---------------------------------------------------------------------------
//
// Takes input images (any size, transparent or not) and assembles them into
// a single horizontal sprite strip at 128x128px per frame. Outputs a lossless
// WebP file to resources/mascots/.
//
// Usage:
//   npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <image1> <image2> ...
//   npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <directory>
//
// Images must be in sprite sheet order matching the mascot's animation config.
//
// Output:
//   resources/mascots/<mascot-id>.webp

const __dirname = dirname(fileURLToPath(import.meta.url));

const FRAME_SIZE = 128;
const MASCOTS_DIR = join(__dirname, '..', 'resources', 'mascots');

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      'Usage: npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <img1> ... <img9>'
    );
    console.error('   or: npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <directory>');
    process.exit(1);
  }

  const mascotId = args[0];
  let imagePaths: string[];

  if (args.length === 2) {
    // Single arg after mascot-id: treat as directory, read PNGs sorted by name
    const dir = args[1];
    const files = (await readdir(dir)).filter((f) => /\.(png|webp|jpg|jpeg)$/i.test(f)).sort();
    if (files.length === 0) {
      console.error(`Directory ${dir} has no images`);
      process.exit(1);
    }
    imagePaths = files.map((f) => join(dir, f));
  } else if (args.length > 2) {
    // Explicit image paths
    imagePaths = args.slice(1);
  } else {
    console.error('Provide image paths or a directory of images');
    process.exit(1);
  }

  // Verify all images exist
  for (const p of imagePaths) {
    try {
      await access(p);
    } catch {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
  }

  const totalFrames = imagePaths.length;
  console.log(`Assembling ${totalFrames} frames for mascot "${mascotId}"...`);

  // Resize each frame to FRAME_SIZE x FRAME_SIZE
  const resizedBuffers: Buffer[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const buf = await sharp(imagePaths[i])
      .resize(FRAME_SIZE, FRAME_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();
    resizedBuffers.push(buf);
    console.log(`  Frame ${i}: ${imagePaths[i]}`);
  }

  // Compose into horizontal strip
  const composites = resizedBuffers.map((buf, i) => ({
    input: buf,
    left: i * FRAME_SIZE,
    top: 0
  }));

  const sheet = await sharp({
    create: {
      width: FRAME_SIZE * totalFrames,
      height: FRAME_SIZE,
      channels: 4 as const,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .webp({ lossless: true })
    .toBuffer();

  // Write WebP
  await mkdir(MASCOTS_DIR, { recursive: true });
  const webpPath = join(MASCOTS_DIR, `${mascotId}.webp`);
  await writeFile(webpPath, sheet);
  console.log(
    `\nSprite sheet: ${webpPath} (${FRAME_SIZE * totalFrames}x${FRAME_SIZE}px, ${Math.round(sheet.length / 1024)}KB)`
  );
  console.log('\nDone! Remember to add an entry to MASCOT_REGISTRY in src/shared/mascots.ts');
}

void main();
