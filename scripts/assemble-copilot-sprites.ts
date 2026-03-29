import sharp from 'sharp';
import { writeFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Assemble Copilot Mascot Sprite Sheet
// ---------------------------------------------------------------------------
//
// Takes 9 input images (any size, transparent or not) and assembles them into
// a single horizontal sprite strip at 128x128px per frame. Also generates the
// base64 data URI TypeScript file for the copilot renderer.
//
// Usage:
//   npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <image1> <image2> ... <image9>
//
// The 9 images must be in sprite sheet order:
//   idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)
//
// Example:
//   npx tsx scripts/assemble-copilot-sprites.ts bear \
//     idle1.png idle2.png proc1.png proc2.png proc3.png \
//     perm1.png perm2.png comp1.png comp2.png
//
// Output:
//   src/renderer/copilot/src/assets/copilot-sprites.png  (assembled sheet)
//   src/renderer/copilot/src/assets/sprites-<mascot-id>.ts  (base64 data URI)

const __dirname = dirname(fileURLToPath(import.meta.url));

const FRAME_SIZE = 128;
const TOTAL_FRAMES = 9;
const ASSETS_DIR = join(__dirname, '..', 'src', 'renderer', 'copilot', 'src', 'assets');

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <img1> ... <img9>');
    console.error('   or: npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <directory>');
    process.exit(1);
  }

  const mascotId = args[0];
  let imagePaths: string[];

  if (args.length === 2) {
    // Single arg after mascot-id: treat as directory, read PNGs sorted by name
    const dir = args[1];
    const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    if (files.length < TOTAL_FRAMES) {
      console.error(`Directory ${dir} has ${files.length} PNGs, need ${TOTAL_FRAMES}`);
      process.exit(1);
    }
    imagePaths = files.slice(0, TOTAL_FRAMES).map((f) => join(dir, f));
  } else if (args.length === TOTAL_FRAMES + 1) {
    // 9 explicit image paths
    imagePaths = args.slice(1);
  } else {
    console.error(`Expected ${TOTAL_FRAMES} images, got ${args.length - 1}`);
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

  console.log(`Assembling ${TOTAL_FRAMES} frames for mascot "${mascotId}"...`);

  // Resize each frame to FRAME_SIZE x FRAME_SIZE
  const resizedBuffers: Buffer[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const buf = await sharp(imagePaths[i])
      .resize(FRAME_SIZE, FRAME_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    resizedBuffers.push(buf);
    console.log(`  Frame ${i}: ${imagePaths[i]}`);
  }

  // Compose into horizontal strip
  const composites = resizedBuffers.map((buf, i) => ({
    input: buf,
    left: i * FRAME_SIZE,
    top: 0,
  }));

  const sheet = await sharp({
    create: {
      width: FRAME_SIZE * TOTAL_FRAMES,
      height: FRAME_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  // Write PNG
  const pngPath = join(ASSETS_DIR, 'copilot-sprites.png');
  await writeFile(pngPath, sheet);
  console.log(`\nSprite sheet: ${pngPath} (${FRAME_SIZE * TOTAL_FRAMES}x${FRAME_SIZE}px)`);

  // Write base64 TS file
  const b64 = sheet.toString('base64');
  const tsContent = `export default 'data:image/png;base64,${b64}';\n`;
  const tsPath = join(ASSETS_DIR, `sprites-${mascotId}.ts`);
  await writeFile(tsPath, tsContent);
  console.log(`TypeScript:   ${tsPath} (${Math.round(tsContent.length / 1024)}KB)`);

  console.log('\nDone!');
}

main();
