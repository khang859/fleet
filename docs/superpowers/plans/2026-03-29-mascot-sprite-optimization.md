# Mascot Sprite Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace base64-encoded mascot sprite `.ts` files with static `.webp` files served via a custom Electron protocol, reducing bundle size, git noise, and simplifying the DX for adding new mascots.

**Architecture:** Static `.webp` sprite sheets live in `resources/mascots/`. A `fleet-asset://` custom Electron protocol serves them to the renderer. The sprite loader constructs URLs instead of importing base64 modules. The assembly script outputs `.webp` directly.

**Tech Stack:** Electron custom protocol, sharp (WebP lossless), electron-builder extraResources

---

### Task 1: Convert existing base64 sprites to WebP files

**Files:**
- Create: `resources/mascots/officer.webp`
- Create: `resources/mascots/robot.webp`
- Create: `resources/mascots/cat.webp`
- Create: `resources/mascots/bear.webp`
- Create: `resources/mascots/kraken.webp`
- Create: `scripts/convert-sprites-to-webp.ts` (one-time migration script)

- [ ] **Step 1: Write the migration script**

This script reads each existing base64 `.ts` file, decodes the PNG data, and converts it to lossless WebP.

```ts
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
```

- [ ] **Step 2: Run the migration script**

Run: `npx tsx scripts/convert-sprites-to-webp.ts`
Expected: 5 `.webp` files created in `resources/mascots/`, with console output showing size savings for each mascot.

- [ ] **Step 3: Verify the WebP files were created**

Run: `ls -la resources/mascots/`
Expected: `officer.webp`, `robot.webp`, `cat.webp`, `bear.webp`, `kraken.webp` — each should be noticeably smaller than the base64-encoded originals.

- [ ] **Step 4: Commit**

```bash
git add resources/mascots/ scripts/convert-sprites-to-webp.ts
git commit -m "feat: convert mascot sprites from base64 PNG to static WebP files"
```

---

### Task 2: Register `fleet-asset://` protocol in the main process

**Files:**
- Modify: `src/main/index.ts:177-185` (protocol registration area)

- [ ] **Step 1: Add `fleet-asset` to the privileged schemes list**

The existing code at `src/main/index.ts:177-179` registers `fleet-image`. Add `fleet-asset` to the same call:

```ts
// Register fleet-image:// protocol to serve local images without base64 IPC overhead
protocol.registerSchemesAsPrivileged([
  { scheme: 'fleet-image', privileges: { supportFetchAPI: true, stream: true } },
  { scheme: 'fleet-asset', privileges: { supportFetchAPI: true, stream: true } }
]);
```

- [ ] **Step 2: Add the `fleet-asset` protocol handler**

After the existing `protocol.handle('fleet-image', ...)` block at line 182-185, add the `fleet-asset` handler:

```ts
  // Serve static assets from resources/ directory (mascot sprites, etc.)
  protocol.handle('fleet-asset', async (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.hostname + url.pathname);

    // Prevent path traversal
    if (relativePath.includes('..')) {
      return new Response('Forbidden', { status: 403 });
    }

    const resourcesDir = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources');

    const filePath = join(resourcesDir, relativePath);
    return net.fetch(`file://${filePath}`);
  });
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new type errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: register fleet-asset:// protocol for serving static resources"
```

---

### Task 3: Add `resources/mascots` to electron-builder extraResources

**Files:**
- Modify: `electron-builder.yml:15-17`

- [ ] **Step 1: Add mascots to extraResources**

Update the `extraResources` section in `electron-builder.yml`:

```yml
extraResources:
  - from: hooks/bin/
    to: hooks/
  - from: resources/mascots/
    to: resources/mascots/
```

- [ ] **Step 2: Commit**

```bash
git add electron-builder.yml
git commit -m "build: ship mascot WebP sprites via extraResources"
```

---

### Task 4: Update sprite-loader to use protocol URLs

**Files:**
- Modify: `src/renderer/copilot/src/assets/sprite-loader.ts`

- [ ] **Step 1: Replace the sprite loader**

Replace the entire contents of `sprite-loader.ts` with:

```ts
import { MASCOT_REGISTRY } from '../../../../shared/mascots';

const validIds = new Set(MASCOT_REGISTRY.map((m) => m.id));

export function getSpriteSheet(id: string): string {
  const mascotId = validIds.has(id) ? id : 'officer';
  return `fleet-asset://mascots/${mascotId}.webp`;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new type errors. The return type is still `string`, so `SpaceshipSprite.tsx` and `MascotPicker.tsx` need no changes.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/assets/sprite-loader.ts
git commit -m "refactor: sprite-loader uses fleet-asset:// URLs instead of base64 imports"
```

---

### Task 5: Delete old base64 sprite files

**Files:**
- Delete: `src/renderer/copilot/src/assets/sprites-officer.ts`
- Delete: `src/renderer/copilot/src/assets/sprites-robot.ts`
- Delete: `src/renderer/copilot/src/assets/sprites-cat.ts`
- Delete: `src/renderer/copilot/src/assets/sprites-bear.ts`
- Delete: `src/renderer/copilot/src/assets/sprites-kraken.ts`
- Delete: `src/renderer/copilot/src/assets/copilot-sprites.ts`
- Delete: `src/renderer/copilot/src/assets/copilot-sprites.png`

- [ ] **Step 1: Delete the base64 sprite files**

```bash
rm src/renderer/copilot/src/assets/sprites-officer.ts \
   src/renderer/copilot/src/assets/sprites-robot.ts \
   src/renderer/copilot/src/assets/sprites-cat.ts \
   src/renderer/copilot/src/assets/sprites-bear.ts \
   src/renderer/copilot/src/assets/sprites-kraken.ts \
   src/renderer/copilot/src/assets/copilot-sprites.ts \
   src/renderer/copilot/src/assets/copilot-sprites.png
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors. The only consumer of these files was `sprite-loader.ts`, which was already updated in Task 4.

- [ ] **Step 3: Verify lint passes**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add -u src/renderer/copilot/src/assets/
git commit -m "chore: delete base64 sprite files replaced by static WebP assets"
```

---

### Task 6: Update assembly script to output WebP

**Files:**
- Modify: `scripts/assemble-copilot-sprites.ts`

- [ ] **Step 1: Update the assembly script**

Replace the entire contents of `scripts/assemble-copilot-sprites.ts` with:

```ts
import sharp from 'sharp';
import { writeFile, readdir, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Assemble Copilot Mascot Sprite Sheet
// ---------------------------------------------------------------------------
//
// Takes 9 input images (any size, transparent or not) and assembles them into
// a single horizontal sprite strip at 128x128px per frame. Outputs a lossless
// WebP file to resources/mascots/.
//
// Usage:
//   npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <image1> <image2> ... <image9>
//   npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> <directory>
//
// The 9 images must be in sprite sheet order:
//   idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)
//
// Output:
//   resources/mascots/<mascot-id>.webp

const __dirname = dirname(fileURLToPath(import.meta.url));

const FRAME_SIZE = 128;
const TOTAL_FRAMES = 9;
const MASCOTS_DIR = join(__dirname, '..', 'resources', 'mascots');

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
    const files = (await readdir(dir)).filter((f) => /\.(png|webp|jpg|jpeg)$/i.test(f)).sort();
    if (files.length < TOTAL_FRAMES) {
      console.error(`Directory ${dir} has ${files.length} images, need ${TOTAL_FRAMES}`);
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
      channels: 4 as const,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .webp({ lossless: true })
    .toBuffer();

  // Write WebP
  await mkdir(MASCOTS_DIR, { recursive: true });
  const webpPath = join(MASCOTS_DIR, `${mascotId}.webp`);
  await writeFile(webpPath, sheet);
  console.log(`\nSprite sheet: ${webpPath} (${FRAME_SIZE * TOTAL_FRAMES}x${FRAME_SIZE}px, ${Math.round(sheet.length / 1024)}KB)`);
  console.log('\nDone! Remember to add an entry to MASCOT_REGISTRY in src/shared/mascots.ts');
}

main();
```

- [ ] **Step 2: Verify the script compiles**

Run: `npx tsx scripts/assemble-copilot-sprites.ts`
Expected: Shows usage message (no error/crash), confirming the script parses correctly.

- [ ] **Step 3: Commit**

```bash
git add scripts/assemble-copilot-sprites.ts
git commit -m "refactor: assembly script outputs WebP to resources/mascots/ instead of base64 .ts"
```

---

### Task 7: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Copilot Mascot Sprites section**

Replace the `## Copilot Mascot Sprites` section in `CLAUDE.md` with:

```markdown
## Copilot Mascot Sprites

The copilot supports multiple selectable mascots. Each mascot is a 9-frame horizontal WebP sprite sheet (1152×128px) stored in `resources/mascots/`. Frame layout: `idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)`.

To add or update a mascot sprite sheet from 9 source images:

\`\`\`bash
npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> img0.png img1.png ... img8.png
# or from a directory of 9+ images (sorted by name):
npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> path/to/frames/
\`\`\`

This outputs `resources/mascots/<mascot-id>.webp`. Then register the mascot in `src/shared/mascots.ts`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for WebP mascot sprite workflow"
```

---

### Task 8: Delete the one-time migration script

**Files:**
- Delete: `scripts/convert-sprites-to-webp.ts`

- [ ] **Step 1: Delete the migration script**

```bash
rm scripts/convert-sprites-to-webp.ts
```

- [ ] **Step 2: Commit**

```bash
git add -u scripts/convert-sprites-to-webp.ts
git commit -m "chore: remove one-time sprite migration script"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds. The bundle should be noticeably smaller without ~1 MB of base64 sprite data.

- [ ] **Step 4: Manual smoke test**

Launch the app with `npm run dev`. Verify:
1. The copilot mascot renders correctly (not a broken image)
2. Switching mascots in the mascot picker works
3. Animation states (idle, processing) display correctly
4. The selected mascot persists after restarting the app
