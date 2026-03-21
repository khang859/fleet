export type Star = {
  x: number;
  y: number;
  size: number;
  brightness: number;
  r: number;
  g: number;
  b: number;
  twinklePhase: number;
  twinkleSpeed: number;
  cachedFillStyle?: string;
};

export type StarLayer = {
  stars: Star[];
  speed: number;
  brightness: number;
  size: number;
};

const LAYER_CONFIGS = [
  { speed: 5, brightness: 0.3, size: 1, density: 10 },
  { speed: 15, brightness: 0.6, size: 1.5, density: 20 },
  { speed: 30, brightness: 0.9, size: 2, density: 30 },
];

const STAR_COLORS: [number, number, number, number][] = [
  [0.70, 255, 255, 255], // white
  [0.80, 170, 221, 255], // pale blue
  [0.90, 255, 238, 170], // pale yellow
  [0.95, 255, 187, 187], // pale red
  [1.00, 255, 221, 187], // pale orange
];

function randomStarColor(): { r: number; g: number; b: number } {
  const roll = Math.random();
  for (const [threshold, r, g, b] of STAR_COLORS) {
    if (roll < threshold) return { r, g, b };
  }
  return { r: 255, g: 255, b: 255 };
}

function randomTwinkle(): { twinklePhase: number; twinkleSpeed: number } {
  if (Math.random() < 0.7) return { twinklePhase: 0, twinkleSpeed: 0 };
  return { twinklePhase: Math.random() * Math.PI * 2, twinkleSpeed: 0.5 + Math.random() * 1.5 };
}

const REF_AREA = 200 * 100;

// Task 3: LUT for pre-computed fillStyle strings at 20 alpha levels (0.00..1.00, step 0.05)
const ALPHA_LEVELS = 20;
const fillStyleLUT = new Map<string, string[]>();

function buildFillStyleEntry(r: number, g: number, b: number): string[] {
  const key = `${r},${g},${b}`;
  let entry = fillStyleLUT.get(key);
  if (!entry) {
    entry = [];
    for (let i = 0; i <= ALPHA_LEVELS; i++) {
      const alpha = (i / ALPHA_LEVELS).toFixed(2);
      entry.push(`rgba(${r}, ${g}, ${b}, ${alpha})`);
    }
    fillStyleLUT.set(key, entry);
  }
  return entry;
}

function getTwinkleFillStyle(r: number, g: number, b: number, alpha: number): string {
  const entry = buildFillStyleEntry(r, g, b);
  const idx = Math.round(Math.max(0, Math.min(1, alpha)) * ALPHA_LEVELS);
  return entry[idx];
}

function makeCachedFillStyle(star: Star): string {
  const alpha = Math.max(0, Math.min(1, star.brightness));
  return getTwinkleFillStyle(star.r, star.g, star.b, alpha);
}

function makeStar(
  x: number,
  y: number,
  config: { size: number; brightness: number },
  color: { r: number; g: number; b: number },
  twinkle: { twinklePhase: number; twinkleSpeed: number },
): Star {
  const star: Star = {
    x,
    y,
    size: config.size + (Math.random() - 0.5) * 0.5,
    brightness: config.brightness + (Math.random() - 0.5) * 0.15,
    ...color,
    ...twinkle,
  };
  if (star.twinkleSpeed === 0) {
    star.cachedFillStyle = makeCachedFillStyle(star);
  }
  return star;
}

export class Starfield {
  private layers: StarLayer[] = [];
  private width: number;
  private height: number;

  // Task 1: Far-layer OffscreenCanvas cache
  private farCache: OffscreenCanvas | null = null;
  private farCacheDirty = true;

  // Task 2: Constellation edge caching
  private constellationEdges: [number, number][] = [];
  private constellationTimer = 500; // start at interval so first update() triggers a recompute
  private readonly CONSTELLATION_INTERVAL = 500;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.initLayers();
  }

  private initLayers(): void {
    this.layers = LAYER_CONFIGS.map((config) => {
      const areaScale = Math.max(1, Math.sqrt((this.width * this.height) / REF_AREA));
      const count = Math.round(config.density * areaScale);
      const stars: Star[] = [];

      for (let i = 0; i < count; i++) {
        const color = randomStarColor();
        const twinkle = randomTwinkle();
        stars.push(makeStar(
          Math.random() * this.width,
          Math.random() * this.height,
          config,
          color,
          twinkle,
        ));
      }

      return {
        stars,
        speed: config.speed,
        brightness: config.brightness,
        size: config.size,
      };
    });
  }

  // Task 1: Public accessor — builds cache on first call
  getFarLayerCache(): OffscreenCanvas | null {
    if (this.farCacheDirty) {
      this.rebuildFarCache();
    }
    return this.farCache;
  }

  // Task 2: Public accessor
  getConstellationEdges(): [number, number][] {
    return this.constellationEdges;
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];
      for (const star of layer.stars) {
        star.x -= layer.speed * dt;
        if (star.x < -5) {
          star.x = this.width + Math.random() * 10;
          star.y = Math.random() * this.height;
          // Task 1: mark far-layer cache dirty when a far star wraps
          if (li === 0) {
            this.farCacheDirty = true;
          }
        }
        if (star.twinkleSpeed > 0) {
          star.twinklePhase += star.twinkleSpeed * dt;
        }
      }
    }

    // Task 2: Recompute constellation edges on 500ms timer
    this.constellationTimer += deltaMs;
    if (this.constellationTimer >= this.CONSTELLATION_INTERVAL) {
      this.recomputeConstellationEdges();
      this.constellationTimer = 0;
    }
  }

  resize(width: number, height: number): void {
    const oldWidth = this.width;
    const oldHeight = this.height;
    this.width = width;
    this.height = height;

    // Task 1: invalidate far-layer cache on resize
    this.farCacheDirty = true;

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      const config = LAYER_CONFIGS[i];

      for (const star of layer.stars) {
        star.x = (star.x / oldWidth) * width;
        star.y = (star.y / oldHeight) * height;
      }

      const areaScale = Math.max(1, Math.sqrt((width * height) / REF_AREA));
      const targetCount = Math.round(config.density * areaScale);

      while (layer.stars.length < targetCount) {
        const color = randomStarColor();
        const twinkle = randomTwinkle();
        layer.stars.push(makeStar(
          Math.random() * width,
          Math.random() * height,
          config,
          color,
          twinkle,
        ));
      }

      if (layer.stars.length > targetCount) {
        layer.stars.length = targetCount;
      }
    }
  }

  getWidth(): number { return this.width; }
  getHeight(): number { return this.height; }

  getLayers(): StarLayer[] {
    return this.layers;
  }

  // Task 1: Rebuild far-layer OffscreenCanvas cache.
  // Always allocates a new canvas so callers can detect a rebuild via object identity.
  private rebuildFarCache(): void {
    this.farCache = new OffscreenCanvas(this.width, this.height);
    const offCtx = this.farCache.getContext('2d');
    if (!offCtx) return;
    offCtx.clearRect(0, 0, this.width, this.height);
    offCtx.filter = 'blur(1px)';

    for (const star of this.layers[0].stars) {
      const twinkleMod = star.twinkleSpeed > 0 ? 0.15 * Math.sin(star.twinklePhase) : 0;
      const alpha = Math.max(0, Math.min(1, star.brightness + twinkleMod));
      offCtx.fillStyle = star.cachedFillStyle ?? getTwinkleFillStyle(star.r, star.g, star.b, alpha);
      offCtx.fillRect(Math.round(star.x), Math.round(star.y), Math.round(star.size), Math.round(star.size));
    }

    offCtx.filter = 'none';
    this.farCacheDirty = false;
  }

  // Task 2: O(n²) constellation edge computation, called every 500ms
  private recomputeConstellationEdges(): void {
    const midLayer = this.layers[1];
    if (!midLayer) {
      this.constellationEdges = [];
      return;
    }

    const stars = midLayer.stars;
    const newEdges: [number, number][] = [];
    const distSqThreshold = 40 * 40; // 1600

    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        if (dx * dx + dy * dy < distSqThreshold) {
          newEdges.push([i, j]);
        }
      }
    }

    this.constellationEdges = newEdges;
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];

      if (li === 0) {
        // Task 1: Blit pre-rendered far-layer cache (avoids per-frame blur filter)
        if (this.farCacheDirty) {
          this.rebuildFarCache();
        }
        if (this.farCache) {
          ctx.drawImage(this.farCache, 0, 0);
        }
      } else {
        // Task 3: Use cachedFillStyle for non-twinkling stars
        for (const star of layer.stars) {
          const twinkleMod = star.twinkleSpeed > 0 ? 0.15 * Math.sin(star.twinklePhase) : 0;
          const alpha = Math.max(0, Math.min(1, star.brightness + twinkleMod));
          ctx.fillStyle = star.cachedFillStyle ?? getTwinkleFillStyle(star.r, star.g, star.b, alpha);
          ctx.fillRect(Math.round(star.x), Math.round(star.y), Math.round(star.size), Math.round(star.size));
        }
      }
    }

    this.renderConstellations(ctx);
  }

  renderConstellations(ctx: CanvasRenderingContext2D): void {
    const midLayer = this.layers[1];
    if (!midLayer) return;

    // Task 2: Draw cached edges with single beginPath/stroke
    const edges = this.constellationEdges;
    if (edges.length === 0) return;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 0.5;

    const stars = midLayer.stars;
    ctx.beginPath();
    for (const [i, j] of edges) {
      ctx.moveTo(Math.round(stars[i].x), Math.round(stars[i].y));
      ctx.lineTo(Math.round(stars[j].x), Math.round(stars[j].y));
    }
    ctx.stroke();
  }
}
