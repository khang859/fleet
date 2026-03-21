import sharp from 'sharp';
import { access, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SPRITES_RAW = join(__dirname, '..', 'sprites-raw', 'star-command');
const OUTPUT_SHEET = join(
  __dirname,
  '..',
  'src',
  'renderer',
  'src',
  'assets',
  'star-command-sprites.png'
);
const OUTPUT_ATLAS = join(
  __dirname,
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'star-command',
  'sc-sprite-atlas.ts'
);

const SHEET_SIZE = 576;

// ---------------------------------------------------------------------------
// Sprite layout — pixel-level positions for every asset
//
// Row 0: y=0,   h=64  | Admiral avatars (5x 64x64) + First Officer avatars (4x 64x64)
// Row 1: y=64,  h=64  | Crew avatars (5x 64x64)
// Row 2: y=128, h=32  | CRT frame pieces (mixed sizes)
// Row 3: y=160, h=24  | Status bar + chip sprites
// Row 4: y=184, h=24  | Shuttle + spark + gas-puff
// Row 5: y=208, h=16  | Explosion + dock-sparkle + thruster-flame + checkmark + orbs + beacon
// Row 6: y=224, h=64  | Station hub rotation (32x 64x64 in 4 rows of 8)
//   Row 6a: y=224 frames 0-7
//   Row 6b: y=288 frames 8-15
//   Row 6c: y=352 frames 16-23
//   Row 6d: y=416 frames 24-31
// ---------------------------------------------------------------------------

const STATION_FRAMES = 32;
const STATION_FRAMES_PER_ROW = 8;

// Frame durations in ms
const FRAME_DURATIONS: Record<string, number> = {
  'shuttle-thrust': 100,
  spark: 300,
  'gas-puff': 200,
  explosion: 100,
  'dock-sparkle': 150,
  'thruster-flame': 100,
  beacon: 500,
  'station-hub': 625
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpriteEntry {
  src?: string;
  buffer?: Buffer;
  w: number;
  h: number;
  x: number;
  y: number;
  atlasGroup: string;
  frameIndex: number;
  framesPerRow?: number;
}

interface AtlasEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  frames: number;
  frameDuration: number;
  framesPerRow?: number;
}

// ---------------------------------------------------------------------------
// Generate station hub rotation frames from a single source image
// ---------------------------------------------------------------------------

async function generateStationFrames(sourcePath: string, count: number): Promise<Buffer[]> {
  // Rotate at source resolution for best quality, then downscale to 64x64
  const source = await sharp(sourcePath).ensureAlpha().png().toBuffer();
  const sourceMeta = await sharp(source).metadata();
  const srcSize = sourceMeta.width; // assume square
  const frames: Buffer[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (360 / count) * i;

    if (angle === 0) {
      const frame = await sharp(source)
        .resize(64, 64, { kernel: 'nearest', fit: 'fill' })
        .ensureAlpha()
        .png()
        .toBuffer();
      frames.push(frame);
      continue;
    }

    // Rotate at full resolution (canvas expands to contain rotated image)
    const rotated = await sharp(source)
      .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();

    // Center-crop back to srcSize x srcSize, then resize to 64x64
    const rotMeta = await sharp(rotated).metadata();
    const left = Math.floor((rotMeta.width - srcSize) / 2);
    const top = Math.floor((rotMeta.height - srcSize) / 2);

    const frame = await sharp(rotated)
      .extract({ left, top, width: srcSize, height: srcSize })
      .resize(64, 64, { kernel: 'nearest', fit: 'fill' })
      .ensureAlpha()
      .png()
      .toBuffer();

    frames.push(frame);
  }

  return frames;
}

// ---------------------------------------------------------------------------
// Build sprite manifest
// ---------------------------------------------------------------------------

async function buildManifest(): Promise<SpriteEntry[]> {
  const entries: SpriteEntry[] = [];

  // ---- Rows 6a-6d: Station hub rotation (y=224+, h=64) ----
  // 32 frames auto-generated from station-hub-1.png, 8 per row across 4 rows
  const stationFrameBuffers = await generateStationFrames(
    join(SPRITES_RAW, 'station', 'station-hub-1.png'),
    STATION_FRAMES
  );
  for (let f = 0; f < STATION_FRAMES; f++) {
    const row = Math.floor(f / STATION_FRAMES_PER_ROW);
    const col = f % STATION_FRAMES_PER_ROW;
    entries.push({
      buffer: stationFrameBuffers[f],
      w: 64,
      h: 64,
      x: col * 64,
      y: 224 + row * 64,
      atlasGroup: 'station-hub',
      frameIndex: f,
      framesPerRow: f === 0 ? STATION_FRAMES_PER_ROW : undefined
    });
  }

  // ---- Row 0: Admiral avatars (y=0, 64x64 each) ----
  const admiralVariants = ['default', 'speaking', 'thinking', 'alert', 'standby'];
  admiralVariants.forEach((variant, i) => {
    entries.push({
      src: join(SPRITES_RAW, 'avatars', `admiral-${variant}.png`),
      w: 64,
      h: 64,
      x: i * 64,
      y: 0,
      atlasGroup: `admiral-${variant}`,
      frameIndex: 0
    });
  });

  // ---- Row 0 continued: First Officer avatars (y=0, 64x64, after admiral) ----
  const firstOfficerVariants = ['default', 'working', 'escalation', 'idle'];
  firstOfficerVariants.forEach((variant, i) => {
    entries.push({
      src: join(SPRITES_RAW, 'avatars', `first-officer-${variant}.png`),
      w: 64,
      h: 64,
      x: (admiralVariants.length + i) * 64,
      y: 0,
      atlasGroup: `first-officer-${variant}`,
      frameIndex: 0
    });
  });

  // ---- Row 1: Crew avatars (y=64, 64x64 each) ----
  const crewVariants = ['hoodie', 'headphones', 'robot', 'cap', 'glasses'];
  crewVariants.forEach((variant, i) => {
    entries.push({
      src: join(SPRITES_RAW, 'avatars', `crew-${variant}.png`),
      w: 64,
      h: 64,
      x: i * 64,
      y: 64,
      atlasGroup: `crew-${variant}`,
      frameIndex: 0
    });
  });

  // ---- Row 2: CRT frame pieces (y=128, h=32) ----
  let crtX = 0;

  // Corners: 32x32 each
  const corners = ['crt-corner-tl', 'crt-corner-tr', 'crt-corner-bl', 'crt-corner-br'];
  for (const corner of corners) {
    entries.push({
      src: join(SPRITES_RAW, 'chrome', `${corner}.png`),
      w: 32,
      h: 32,
      x: crtX,
      y: 128,
      atlasGroup: corner,
      frameIndex: 0
    });
    crtX += 32;
  }

  // Horizontal edge tile: 32x8
  entries.push({
    src: join(SPRITES_RAW, 'chrome', 'crt-edge-h.png'),
    w: 32,
    h: 8,
    x: crtX,
    y: 128,
    atlasGroup: 'crt-edge-h',
    frameIndex: 0
  });
  crtX += 32;

  // Vertical edge tile: 8x32
  entries.push({
    src: join(SPRITES_RAW, 'chrome', 'crt-edge-v.png'),
    w: 8,
    h: 32,
    x: crtX,
    y: 128,
    atlasGroup: 'crt-edge-v',
    frameIndex: 0
  });
  crtX += 8;

  // Scanline tile: 32x32
  entries.push({
    src: join(SPRITES_RAW, 'chrome', 'crt-scanline.png'),
    w: 32,
    h: 32,
    x: crtX,
    y: 128,
    atlasGroup: 'crt-scanline',
    frameIndex: 0
  });

  // ---- Row 3: Status bar + chips (y=160, h=24) ----
  let row3X = 0;

  // Statusbar tile: 64x24
  entries.push({
    src: join(SPRITES_RAW, 'chrome', 'statusbar-tile.png'),
    w: 64,
    h: 24,
    x: row3X,
    y: 160,
    atlasGroup: 'statusbar-tile',
    frameIndex: 0
  });
  row3X += 64;

  // Statusbar rivet: 8x8
  entries.push({
    src: join(SPRITES_RAW, 'chrome', 'statusbar-rivet.png'),
    w: 8,
    h: 8,
    x: row3X,
    y: 160,
    atlasGroup: 'statusbar-rivet',
    frameIndex: 0
  });
  row3X += 8;

  // Statusbar divider: 4x24
  entries.push({
    src: join(SPRITES_RAW, 'chrome', 'statusbar-divider.png'),
    w: 4,
    h: 24,
    x: row3X,
    y: 160,
    atlasGroup: 'statusbar-divider',
    frameIndex: 0
  });
  row3X += 4;

  // Chip frame: 48x20
  entries.push({
    src: join(SPRITES_RAW, 'chrome', 'chip-frame.png'),
    w: 48,
    h: 20,
    x: row3X,
    y: 160,
    atlasGroup: 'chip-frame',
    frameIndex: 0
  });
  row3X += 48;

  // Chip dots: 8x8 each
  const chipDots = ['active', 'hailing', 'error', 'complete', 'idle', 'lost'];
  for (const dot of chipDots) {
    entries.push({
      src: join(SPRITES_RAW, 'chrome', `chip-dot-${dot}.png`),
      w: 8,
      h: 8,
      x: row3X,
      y: 160,
      atlasGroup: `chip-dot-${dot}`,
      frameIndex: 0
    });
    row3X += 8;
  }

  // ---- Row 4: Shuttle + spark + gas-puff (y=184, h=24) ----
  let row4X = 0;

  // Shuttle idle: 24x24
  entries.push({
    src: join(SPRITES_RAW, 'shuttle', 'shuttle-idle.png'),
    w: 24,
    h: 24,
    x: row4X,
    y: 184,
    atlasGroup: 'shuttle-idle',
    frameIndex: 0
  });
  row4X += 24;

  // Shuttle thrust: 3 frames, 24x24 each
  for (let f = 0; f < 3; f++) {
    entries.push({
      src: join(SPRITES_RAW, 'shuttle', `shuttle-thrust-${f + 1}.png`),
      w: 24,
      h: 24,
      x: row4X,
      y: 184,
      atlasGroup: 'shuttle-thrust',
      frameIndex: f
    });
    row4X += 24;
  }

  // Spark: 2 frames, 8x8 each
  for (let f = 0; f < 2; f++) {
    entries.push({
      src: join(SPRITES_RAW, 'particles', `spark-${f + 1}.png`),
      w: 8,
      h: 8,
      x: row4X,
      y: 184,
      atlasGroup: 'spark',
      frameIndex: f
    });
    row4X += 8;
  }

  // Gas-puff: 3 frames, 12x12 each
  for (let f = 0; f < 3; f++) {
    entries.push({
      src: join(SPRITES_RAW, 'particles', `gas-puff-${f + 1}.png`),
      w: 12,
      h: 12,
      x: row4X,
      y: 184,
      atlasGroup: 'gas-puff',
      frameIndex: f
    });
    row4X += 12;
  }

  // ---- Row 5: Explosion + dock-sparkle + thruster-flame + checkmark + orbs + beacon (y=208, h=16) ----
  let row5X = 0;

  // Explosion: 4 frames, 16x16 each
  for (let f = 0; f < 4; f++) {
    entries.push({
      src: join(SPRITES_RAW, 'particles', `explosion-${f + 1}.png`),
      w: 16,
      h: 16,
      x: row5X,
      y: 208,
      atlasGroup: 'explosion',
      frameIndex: f
    });
    row5X += 16;
  }

  // Dock-sparkle: 3 frames, 8x8 each
  for (let f = 0; f < 3; f++) {
    entries.push({
      src: join(SPRITES_RAW, 'particles', `dock-sparkle-${f + 1}.png`),
      w: 8,
      h: 8,
      x: row5X,
      y: 208,
      atlasGroup: 'dock-sparkle',
      frameIndex: f
    });
    row5X += 8;
  }

  // Thruster-flame: 3 frames, 8x12 each
  for (let f = 0; f < 3; f++) {
    entries.push({
      src: join(SPRITES_RAW, 'particles', `thruster-flame-${f + 1}.png`),
      w: 8,
      h: 12,
      x: row5X,
      y: 208,
      atlasGroup: 'thruster-flame',
      frameIndex: f
    });
    row5X += 8;
  }

  // Checkmark hologram: 16x16
  entries.push({
    src: join(SPRITES_RAW, 'particles', 'checkmark-holo.png'),
    w: 16,
    h: 16,
    x: row5X,
    y: 208,
    atlasGroup: 'checkmark-holo',
    frameIndex: 0
  });
  row5X += 16;

  // Orbs: teal 12x12, amber 12x12, cargo 16x16
  entries.push({
    src: join(SPRITES_RAW, 'orbs', 'orb-teal.png'),
    w: 12,
    h: 12,
    x: row5X,
    y: 208,
    atlasGroup: 'orb-teal',
    frameIndex: 0
  });
  row5X += 12;

  entries.push({
    src: join(SPRITES_RAW, 'orbs', 'orb-amber.png'),
    w: 12,
    h: 12,
    x: row5X,
    y: 208,
    atlasGroup: 'orb-amber',
    frameIndex: 0
  });
  row5X += 12;

  entries.push({
    src: join(SPRITES_RAW, 'orbs', 'orb-cargo.png'),
    w: 16,
    h: 16,
    x: row5X,
    y: 208,
    atlasGroup: 'orb-cargo',
    frameIndex: 0
  });
  row5X += 16;

  // Beacon: on 12x12, off 12x12
  entries.push({
    src: join(SPRITES_RAW, 'beacon', 'beacon-on.png'),
    w: 12,
    h: 12,
    x: row5X,
    y: 208,
    atlasGroup: 'beacon',
    frameIndex: 0
  });
  row5X += 12;

  entries.push({
    src: join(SPRITES_RAW, 'beacon', 'beacon-off.png'),
    w: 12,
    h: 12,
    x: row5X,
    y: 208,
    atlasGroup: 'beacon',
    frameIndex: 1
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Validate all source files exist
// ---------------------------------------------------------------------------

async function validateFiles(entries: SpriteEntry[]): Promise<string[]> {
  const missing: string[] = [];
  for (const entry of entries) {
    if (!entry.src) continue;
    try {
      await access(entry.src);
    } catch {
      missing.push(entry.src.replace(SPRITES_RAW + '/', ''));
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Check if image has alpha channel
// ---------------------------------------------------------------------------

async function checkTransparency(path: string): Promise<boolean> {
  try {
    const meta = await sharp(path).metadata();
    return meta.hasAlpha ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Assemble sprite sheet
// ---------------------------------------------------------------------------

async function assembleSheet(entries: SpriteEntry[]): Promise<void> {
  const base = sharp({
    create: {
      width: SHEET_SIZE,
      height: SHEET_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png();

  const composites: sharp.OverlayOptions[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    let inputBuffer: Buffer;

    if (entry.buffer) {
      inputBuffer = entry.buffer;
    } else {
      const hasAlpha = await checkTransparency(entry.src!);
      if (!hasAlpha) {
        warnings.push(
          `  WARNING: ${entry.src!.replace(SPRITES_RAW + '/', '')} has no alpha channel`
        );
      }
      inputBuffer = await sharp(entry.src).ensureAlpha().png().toBuffer();
    }

    const resized = await sharp(inputBuffer)
      .resize(entry.w, entry.h, {
        kernel: 'nearest',
        fit: 'fill'
      })
      .ensureAlpha()
      .toBuffer();

    composites.push({
      input: resized,
      left: entry.x,
      top: entry.y
    });
  }

  if (warnings.length > 0) {
    console.log('\nTransparency warnings:');
    warnings.forEach((w) => console.log(w));
    console.log('  These images may have solid backgrounds that need to be removed.\n');
  }

  const result = await base.composite(composites).toBuffer();

  await mkdir(join(OUTPUT_SHEET, '..'), { recursive: true });
  await sharp(result).png().toFile(OUTPUT_SHEET);

  console.log(`Sprite sheet written to: ${OUTPUT_SHEET}`);
}

// ---------------------------------------------------------------------------
// Generate atlas TypeScript file
// ---------------------------------------------------------------------------

function buildAtlas(entries: SpriteEntry[]): Record<string, AtlasEntry> {
  const atlas: Record<string, AtlasEntry> = {};

  const groups = new Map<string, SpriteEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.atlasGroup) ?? [];
    group.push(entry);
    groups.set(entry.atlasGroup, group);
  }

  for (const [key, groupEntries] of groups) {
    groupEntries.sort((a, b) => a.frameIndex - b.frameIndex);
    const first = groupEntries[0];

    let duration = 0;
    for (const [pattern, dur] of Object.entries(FRAME_DURATIONS)) {
      if (key === pattern || key.startsWith(pattern)) {
        duration = dur;
        break;
      }
    }

    atlas[key] = {
      x: first.x,
      y: first.y,
      w: first.w,
      h: first.h,
      frames: groupEntries.length,
      frameDuration: duration,
      framesPerRow: first.framesPerRow
    };
  }

  return atlas;
}

function generateAtlasCode(atlas: Record<string, AtlasEntry>): string {
  const lines: string[] = [
    '// AUTO-GENERATED by scripts/assemble-star-command-sprites.ts — do not edit manually',
    '',
    'export interface SpriteRegion {',
    '  /** X position in the sprite sheet */',
    '  x: number',
    '  /** Y position in the sprite sheet */',
    '  y: number',
    '  /** Width of a single frame */',
    '  w: number',
    '  /** Height of a single frame */',
    '  h: number',
    '  /** Number of animation frames (sequential, left to right) */',
    '  frames: number',
    '  /** Milliseconds per frame (0 = static) */',
    '  frameDuration: number',
    '  /** Frames per row for multi-row animations (defaults to frames if unset) */',
    '  framesPerRow?: number',
    '}',
    '',
    'export const SC_SPRITE_ATLAS: Record<string, SpriteRegion> = {'
  ];

  const sortedKeys = Object.keys(atlas).sort((a, b) => {
    const order = (k: string): number => {
      if (k.startsWith('admiral-')) return 0;
      if (k.startsWith('first-officer-')) return 0.5;
      if (k.startsWith('crew-')) return 1;
      if (k.startsWith('crt-')) return 2;
      if (k.startsWith('statusbar-')) return 3;
      if (k.startsWith('chip-')) return 4;
      if (k.startsWith('shuttle-')) return 5;
      if (
        k.startsWith('spark') ||
        k.startsWith('gas-') ||
        k.startsWith('explosion') ||
        k.startsWith('dock-') ||
        k.startsWith('thruster-') ||
        k.startsWith('checkmark')
      )
        return 6;
      if (k.startsWith('orb-')) return 7;
      if (k.startsWith('beacon')) return 8;
      if (k.startsWith('station-')) return 9;
      return 10;
    };
    const diff = order(a) - order(b);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    const e = atlas[key];
    lines.push(
      `  '${key}': { x: ${e.x}, y: ${e.y}, w: ${e.w}, h: ${e.h}, frames: ${e.frames}, frameDuration: ${e.frameDuration}${e.framesPerRow !== undefined ? `, framesPerRow: ${e.framesPerRow}` : ''} },`
    );
  }

  lines.push('}');
  lines.push('');

  // Helper constants
  lines.push(
    "export const ADMIRAL_VARIANTS = ['default', 'speaking', 'thinking', 'alert', 'standby'] as const"
  );
  lines.push(
    "export const FIRST_OFFICER_VARIANTS = ['default', 'working', 'escalation', 'idle'] as const"
  );
  lines.push(
    "export const CREW_VARIANTS = ['hoodie', 'headphones', 'robot', 'cap', 'glasses'] as const"
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Star Command Sprite Assembly');
  console.log('============================\n');

  console.log('Generating station rotation frames...');
  const entries = await buildManifest();
  console.log(`Expected sprites: ${entries.length}`);

  console.log('Validating source files...');
  const missing = await validateFiles(entries);

  if (missing.length > 0) {
    console.error(`\nMissing ${missing.length} sprite files:`);
    missing.forEach((f) => console.error(`  - sprites-raw/star-command/${f}`));
    console.error('\nPlease generate all sprites before running this script.');
    console.error('See docs/star-command-visual-prompts.md for prompts.');
    process.exit(1);
  }

  console.log('All files found!\n');

  console.log('Assembling sprite sheet...');
  await assembleSheet(entries);

  console.log('Generating sprite atlas...');
  const atlas = buildAtlas(entries);
  const code = generateAtlasCode(atlas);
  await mkdir(join(OUTPUT_ATLAS, '..'), { recursive: true });
  await writeFile(OUTPUT_ATLAS, code, 'utf-8');
  console.log(`Atlas written to: ${OUTPUT_ATLAS}`);

  console.log('\nDone! Star Command sprite sheet and atlas are ready.');
}

main().catch((err) => {
  console.error('Assembly failed:', err);
  process.exit(1);
});
