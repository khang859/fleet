type NebulaCloud = {
  x: number;
  y: number;
  speed: number;
  opacity: number;
  canvas: OffscreenCanvas;
  width: number;
  height: number;
};

const NEBULA_COLORS = ['#3a1a5e', '#1a3a4a', '#1a2a5e', '#4a1a3a'];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function createCloudCanvas(color: string): OffscreenCanvas {
  const w = 200;
  const h = 120;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const { r, g, b } = hexToRgb(color);

  const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.5)`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  return canvas;
}

function randomCloud(canvasWidth: number, canvasHeight: number, startOnScreen: boolean): NebulaCloud {
  const color = NEBULA_COLORS[Math.floor(Math.random() * NEBULA_COLORS.length)];
  const cloud = createCloudCanvas(color);
  const w = 200;
  const h = 120;

  return {
    x: startOnScreen ? Math.random() * canvasWidth : canvasWidth + Math.random() * 200,
    y: Math.random() * (canvasHeight - h),
    speed: 2 + Math.random() * 3,
    opacity: 0.03 + Math.random() * 0.03,
    canvas: cloud,
    width: w,
    height: h,
  };
}

export class NebulaSystem {
  private clouds: NebulaCloud[] = [];
  private initialized = false;

  update(deltaMs: number, canvasWidth: number, canvasHeight: number): void {
    if (!this.initialized) {
      const count = 3 + Math.floor(Math.random() * 3); // 3-5
      for (let i = 0; i < count; i++) {
        this.clouds.push(randomCloud(canvasWidth, canvasHeight, true));
      }
      this.initialized = true;
    }

    const dt = deltaMs / 1000;

    for (const cloud of this.clouds) {
      cloud.x -= cloud.speed * dt;

      // Respawn when fully off-screen left
      if (cloud.x + cloud.width < 0) {
        cloud.x = canvasWidth + Math.random() * 100;
        cloud.y = Math.random() * (canvasHeight - cloud.height);
        cloud.opacity = 0.03 + Math.random() * 0.03;
        const color = NEBULA_COLORS[Math.floor(Math.random() * NEBULA_COLORS.length)];
        cloud.canvas = createCloudCanvas(color);
      }
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const cloud of this.clouds) {
      ctx.globalAlpha = cloud.opacity;
      ctx.drawImage(cloud.canvas, Math.round(cloud.x), Math.round(cloud.y));
    }
    ctx.globalAlpha = 1;
  }
}
