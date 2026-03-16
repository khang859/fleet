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

export class Starfield {
  private layers: StarLayer[] = [];
  private width: number;
  private height: number;

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
        stars.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          size: config.size + (Math.random() - 0.5) * 0.5,
          brightness: config.brightness + (Math.random() - 0.5) * 0.15,
          ...color,
          ...twinkle,
        });
      }

      return {
        stars,
        speed: config.speed,
        brightness: config.brightness,
        size: config.size,
      };
    });
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const layer of this.layers) {
      for (const star of layer.stars) {
        star.x -= layer.speed * dt;
        if (star.x < -5) {
          star.x = this.width + Math.random() * 10;
          star.y = Math.random() * this.height;
        }
        if (star.twinkleSpeed > 0) {
          star.twinklePhase += star.twinkleSpeed * dt;
        }
      }
    }
  }

  resize(width: number, height: number): void {
    const oldWidth = this.width;
    const oldHeight = this.height;
    this.width = width;
    this.height = height;

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
        layer.stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: config.size + (Math.random() - 0.5) * 0.5,
          brightness: config.brightness + (Math.random() - 0.5) * 0.15,
          ...color,
          ...twinkle,
        });
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

  render(ctx: CanvasRenderingContext2D): void {
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];

      if (li === 0) {
        // Far layer: render with depth-of-field blur
        ctx.save();
        ctx.filter = 'blur(1px)';
        for (const star of layer.stars) {
          const twinkleMod = star.twinkleSpeed > 0 ? 0.15 * Math.sin(star.twinklePhase) : 0;
          const alpha = Math.max(0, Math.min(1, star.brightness + twinkleMod));
          ctx.fillStyle = `rgba(${star.r}, ${star.g}, ${star.b}, ${alpha})`;
          ctx.fillRect(Math.round(star.x), Math.round(star.y), Math.round(star.size), Math.round(star.size));
        }
        ctx.restore();
      } else {
        for (const star of layer.stars) {
          const twinkleMod = star.twinkleSpeed > 0 ? 0.15 * Math.sin(star.twinklePhase) : 0;
          const alpha = Math.max(0, Math.min(1, star.brightness + twinkleMod));
          ctx.fillStyle = `rgba(${star.r}, ${star.g}, ${star.b}, ${alpha})`;
          ctx.fillRect(Math.round(star.x), Math.round(star.y), Math.round(star.size), Math.round(star.size));
        }
      }
    }

    this.renderConstellations(ctx);
  }

  renderConstellations(ctx: CanvasRenderingContext2D): void {
    const midLayer = this.layers[1];
    if (!midLayer) return;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 0.5;

    const stars = midLayer.stars;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 40) {
          ctx.beginPath();
          ctx.moveTo(Math.round(stars[i].x), Math.round(stars[i].y));
          ctx.lineTo(Math.round(stars[j].x), Math.round(stars[j].y));
          ctx.stroke();
        }
      }
    }
  }
}
