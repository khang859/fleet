import sharp from 'sharp';
import { readdir, access, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SPRITES_RAW = join(__dirname, '..', 'sprites-raw');
const OUTPUT_SHEET = join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'sprites.png');
const OUTPUT_ATLAS = join(
  __dirname,
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'visualizer',
  'sprite-atlas.ts'
);

const SHEET_SIZE = 512;

// Hull names for parent ships
const PARENT_HULLS = ['arrow', 'dart', 'wedge', 'fighter', 'shuttle', 'phantom'] as const;
const SUBAGENT_HULLS = ['drone', 'scout'] as const;

// Animation sequences with frame counts
const SHIP_ANIMS = [
  { name: 'idle', frames: 2 },
  { name: 'thrust', frames: 3 },
  { name: 'warp-in', frames: 4 },
  { name: 'warp-out', frames: 4 }
] as const;

const ASTEROID_VARIANTS = ['chunky', 'smooth', 'jagged'] as const;

const CELESTIAL_SPRITES = [
  { name: 'gas-giant', w: 32, h: 32 },
  { name: 'rocky-world', w: 32, h: 32 },
  { name: 'moon', w: 16, h: 16 },
  { name: 'space-station', w: 48, h: 48 }
] as const;

const PARTICLE_SPRITES = [
  { name: 'engine-puff', frames: 3, w: 4, h: 4 },
  { name: 'warp-streak', frames: 2, w: 8, h: 2 },
  { name: 'spawn-burst', frames: 4, w: 8, h: 8 }
] as const;

const EFFECT_SPRITES = [
  { name: 'shooting-star', w: 16, h: 4 },
  { name: 'bloom-glow', w: 16, h: 16 }
] as const;

// Frame durations in ms
const FRAME_DURATIONS: Record<string, number> = {
  idle: 500,
  thrust: 100,
  'warp-in': 125,
  'warp-out': 125,
  asteroid: 500,
  'engine-puff': 166,
  'warp-streak': 150,
  'spawn-burst': 100
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpriteEntry {
  /** Path to raw PNG */
  src: string;
  /** Target width in the sheet */
  w: number;
  /** Target height in the sheet */
  h: number;
  /** X position in the sheet */
  x: number;
  /** Y position in the sheet */
  y: number;
  /** Atlas key group (e.g. "parent-1-idle") */
  atlasGroup: string;
  /** Frame index within the group */
  frameIndex: number;
}

interface AtlasEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  frames: number;
  frameDuration: number;
}

// ---------------------------------------------------------------------------
// Build sprite manifest
// ---------------------------------------------------------------------------

function buildManifest(): SpriteEntry[] {
  const entries: SpriteEntry[] = [];

  // Parent ships: rows 0-5, y = hullIndex * 32
  PARENT_HULLS.forEach((hull, hullIndex) => {
    let frameOffset = 0;
    for (const anim of SHIP_ANIMS) {
      for (let f = 0; f < anim.frames; f++) {
        entries.push({
          src: join(
            SPRITES_RAW,
            'ships',
            `parent-${hullIndex + 1}-${hull}-${anim.name}-${f + 1}.png`
          ),
          w: 32,
          h: 32,
          x: (frameOffset + f) * 32,
          y: hullIndex * 32,
          atlasGroup: `parent-${hullIndex + 1}-${anim.name}`,
          frameIndex: f
        });
      }
      frameOffset += anim.frames;
    }
  });

  // Subagent ships: rows 6-7, y = 192 + subIndex * 20
  SUBAGENT_HULLS.forEach((hull, subIndex) => {
    let frameOffset = 0;
    for (const anim of SHIP_ANIMS) {
      for (let f = 0; f < anim.frames; f++) {
        entries.push({
          src: join(
            SPRITES_RAW,
            'ships',
            `subagent-${subIndex + 1}-${hull}-${anim.name}-${f + 1}.png`
          ),
          w: 20,
          h: 20,
          x: (frameOffset + f) * 20,
          y: 192 + subIndex * 20,
          atlasGroup: `subagent-${subIndex + 1}-${anim.name}`,
          frameIndex: f
        });
      }
      frameOffset += anim.frames;
    }
  });

  // Asteroids: row 8, y = 232
  let asteroidX = 0;
  ASTEROID_VARIANTS.forEach((variant) => {
    for (let f = 0; f < 2; f++) {
      entries.push({
        src: join(SPRITES_RAW, 'asteroids', `${variant}-${f + 1}.png`),
        w: 16,
        h: 16,
        x: asteroidX,
        y: 232,
        atlasGroup: `asteroid-${variant}`,
        frameIndex: f
      });
      asteroidX += 16;
    }
  });

  // Celestials: row 9, y = 248
  let celestialX = 0;
  for (const cel of CELESTIAL_SPRITES) {
    entries.push({
      src: join(SPRITES_RAW, 'celestials', `${cel.name}.png`),
      w: cel.w,
      h: cel.h,
      x: celestialX,
      y: 248,
      atlasGroup: `celestial-${cel.name}`,
      frameIndex: 0
    });
    celestialX += cel.w;
  }

  // Particles: row 10, y = 296
  let particleX = 0;
  for (const p of PARTICLE_SPRITES) {
    for (let f = 0; f < p.frames; f++) {
      entries.push({
        src: join(SPRITES_RAW, 'particles', `${p.name}-${f + 1}.png`),
        w: p.w,
        h: p.h,
        x: particleX,
        y: 296,
        atlasGroup: `particle-${p.name}`,
        frameIndex: f
      });
      particleX += p.w;
    }
  }

  // Effects: continues on row 10 after particles
  for (const eff of EFFECT_SPRITES) {
    entries.push({
      src: join(SPRITES_RAW, 'effects', `${eff.name}.png`),
      w: eff.w,
      h: eff.h,
      x: particleX,
      y: 296,
      atlasGroup: `effect-${eff.name}`,
      frameIndex: 0
    });
    particleX += eff.w;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Validate all source files exist
// ---------------------------------------------------------------------------

async function validateFiles(entries: SpriteEntry[]): Promise<string[]> {
  const missing: string[] = [];
  for (const entry of entries) {
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
  // Create transparent base canvas
  const base = sharp({
    create: {
      width: SHEET_SIZE,
      height: SHEET_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png();

  // Resize all sprites and prepare composite inputs
  const composites: sharp.OverlayOptions[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    const hasAlpha = await checkTransparency(entry.src);
    if (!hasAlpha) {
      warnings.push(`  WARNING: ${entry.src.replace(SPRITES_RAW + '/', '')} has no alpha channel`);
    }

    // Sprites are generated with transparent backgrounds — just load directly
    const cleaned = await sharp(entry.src).ensureAlpha().png().toBuffer();

    const resized = await sharp(cleaned)
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

  // Composite all sprites onto the base
  const result = await base.composite(composites).toBuffer();

  // Ensure output directory exists
  await mkdir(join(OUTPUT_SHEET, '..'), { recursive: true });
  await sharp(result).png().toFile(OUTPUT_SHEET);

  console.log(`Sprite sheet written to: ${OUTPUT_SHEET}`);
}

// ---------------------------------------------------------------------------
// Generate atlas TypeScript file
// ---------------------------------------------------------------------------

function buildAtlas(entries: SpriteEntry[]): Record<string, AtlasEntry> {
  const atlas: Record<string, AtlasEntry> = {};

  // Group entries by atlasGroup
  const groups = new Map<string, SpriteEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.atlasGroup) ?? [];
    group.push(entry);
    groups.set(entry.atlasGroup, group);
  }

  for (const [key, groupEntries] of groups) {
    // Sort by frame index
    groupEntries.sort((a, b) => a.frameIndex - b.frameIndex);
    const first = groupEntries[0];

    // Determine frame duration from the animation name
    let duration = 0;
    if (key.includes('idle')) duration = FRAME_DURATIONS.idle;
    else if (key.includes('thrust')) duration = FRAME_DURATIONS.thrust;
    else if (key.includes('warp-in')) duration = FRAME_DURATIONS['warp-in'];
    else if (key.includes('warp-out')) duration = FRAME_DURATIONS['warp-out'];
    else if (key.includes('asteroid')) duration = FRAME_DURATIONS.asteroid;
    else if (key.includes('engine-puff')) duration = FRAME_DURATIONS['engine-puff'];
    else if (key.includes('warp-streak')) duration = FRAME_DURATIONS['warp-streak'];
    else if (key.includes('spawn-burst')) duration = FRAME_DURATIONS['spawn-burst'];

    atlas[key] = {
      x: first.x,
      y: first.y,
      w: first.w,
      h: first.h,
      frames: groupEntries.length,
      frameDuration: duration
    };
  }

  return atlas;
}

function generateAtlasCode(atlas: Record<string, AtlasEntry>): string {
  const lines: string[] = [
    '// AUTO-GENERATED by scripts/assemble-sprites.ts — do not edit manually',
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
    '}',
    '',
    'export const SPRITE_ATLAS: Record<string, SpriteRegion> = {'
  ];

  const sortedKeys = Object.keys(atlas).sort((a, b) => {
    // Sort: parents first, then subagents, then asteroids, celestials, particles, effects
    const order = (k: string): number => {
      if (k.startsWith('parent-')) return 0;
      if (k.startsWith('subagent-')) return 1;
      if (k.startsWith('asteroid-')) return 2;
      if (k.startsWith('celestial-')) return 3;
      if (k.startsWith('particle-')) return 4;
      if (k.startsWith('effect-')) return 5;
      return 6;
    };
    const diff = order(a) - order(b);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    const e = atlas[key];
    lines.push(
      `  '${key}': { x: ${e.x}, y: ${e.y}, w: ${e.w}, h: ${e.h}, frames: ${e.frames}, frameDuration: ${e.frameDuration} },`
    );
  }

  lines.push('}');
  lines.push('');

  // Helper constants for hull counts
  lines.push('export const PARENT_HULL_COUNT = 6');
  lines.push('export const SUBAGENT_HULL_COUNT = 2');
  lines.push('');

  // Helper to get sprite region for a ship by hull index and animation
  lines.push('/** Get sprite region for a parent ship hull (1-indexed) */');
  lines.push(
    "export function getParentSprite(hullIndex: number, anim: 'idle' | 'thrust' | 'warp-in' | 'warp-out'): SpriteRegion {"
  );
  lines.push('  return SPRITE_ATLAS[`parent-${hullIndex}-${anim}`]');
  lines.push('}');
  lines.push('');
  lines.push('/** Get sprite region for a subagent ship hull (1-indexed) */');
  lines.push(
    "export function getSubagentSprite(hullIndex: number, anim: 'idle' | 'thrust' | 'warp-in' | 'warp-out'): SpriteRegion {"
  );
  lines.push('  return SPRITE_ATLAS[`subagent-${hullIndex}-${anim}`]');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Sprite Assembly Script');
  console.log('======================\n');

  // Build manifest of all expected sprites
  const entries = buildManifest();
  console.log(`Expected sprites: ${entries.length}`);

  // Validate all files exist
  console.log('Validating source files...');
  const missing = await validateFiles(entries);

  if (missing.length > 0) {
    console.error(`\nMissing ${missing.length} sprite files:`);
    missing.forEach((f) => console.error(`  - sprites-raw/${f}`));
    console.error('\nPlease generate all sprites before running this script.');
    console.error('See docs/superpowers/specs/2026-03-16-pixel-art-sprite-prompts.md for prompts.');
    process.exit(1);
  }

  console.log('All files found!\n');

  // Assemble the sprite sheet
  console.log('Assembling sprite sheet...');
  await assembleSheet(entries);

  // Generate the atlas TypeScript file
  console.log('Generating sprite atlas...');
  const atlas = buildAtlas(entries);
  const code = generateAtlasCode(atlas);
  await mkdir(join(OUTPUT_ATLAS, '..'), { recursive: true });
  await writeFile(OUTPUT_ATLAS, code, 'utf-8');
  console.log(`Atlas written to: ${OUTPUT_ATLAS}`);

  console.log('\nDone! Your sprite sheet and atlas are ready.');
}

main().catch((err) => {
  console.error('Assembly failed:', err);
  process.exit(1);
});
