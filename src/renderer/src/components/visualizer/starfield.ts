export type Star = {
  x: number;
  y: number;
  size: number;
  brightness: number;
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
        stars.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          size: config.size + (Math.random() - 0.5) * 0.5,
          brightness: config.brightness + (Math.random() - 0.5) * 0.15,
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
        layer.stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: config.size + (Math.random() - 0.5) * 0.5,
          brightness: config.brightness + (Math.random() - 0.5) * 0.15,
        });
      }

      if (layer.stars.length > targetCount) {
        layer.stars.length = targetCount;
      }
    }
  }

  getLayers(): StarLayer[] {
    return this.layers;
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const layer of this.layers) {
      for (const star of layer.stars) {
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, Math.min(1, star.brightness))})`;
        ctx.fillRect(
          Math.round(star.x),
          Math.round(star.y),
          Math.round(star.size),
          Math.round(star.size),
        );
      }
    }
  }
}
