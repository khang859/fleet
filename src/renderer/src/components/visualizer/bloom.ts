/**
 * BloomPass — a simple post-processing glow effect.
 *
 * Renders a downscaled, blurred copy of the canvas back on top using
 * the "screen" blend mode at low opacity to simulate bloom/glow.
 */
export class BloomPass {
  private offCanvas: OffscreenCanvas;
  private offCtx: OffscreenCanvasRenderingContext2D;

  constructor(width: number, height: number) {
    // Half resolution for performance
    this.offCanvas = new OffscreenCanvas(Math.ceil(width / 2), Math.ceil(height / 2));
    this.offCtx = this.offCanvas.getContext('2d')!;
  }

  resize(width: number, height: number): void {
    this.offCanvas.width = Math.ceil(width / 2);
    this.offCanvas.height = Math.ceil(height / 2);
  }

  render(sourceCtx: CanvasRenderingContext2D): void {
    const hw = this.offCanvas.width;
    const hh = this.offCanvas.height;

    // 1. Scale down source onto offscreen canvas with blur + brightness
    this.offCtx.clearRect(0, 0, hw, hh);
    this.offCtx.filter = 'blur(4px) brightness(1.5)';
    this.offCtx.drawImage(sourceCtx.canvas, 0, 0, hw, hh);
    this.offCtx.filter = 'none';

    // 2. Composite back in screen space (ignore camera/zoom transforms)
    sourceCtx.save();
    sourceCtx.setTransform(1, 0, 0, 1, 0, 0); // reset to pixel space
    sourceCtx.globalCompositeOperation = 'screen';
    sourceCtx.globalAlpha = 0.3;
    const canvasW = sourceCtx.canvas.width;
    const canvasH = sourceCtx.canvas.height;
    sourceCtx.drawImage(this.offCanvas, 0, 0, canvasW, canvasH);
    sourceCtx.restore();
  }
}
