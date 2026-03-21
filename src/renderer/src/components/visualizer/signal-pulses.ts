import { drawScSprite, isScSpriteReady } from '../star-command/sc-sprite-loader';

type PulsePhase = 'outbound' | 'arriving' | 'return';

type PulseEntry = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  phase: PulsePhase;
  elapsed: number; // ms elapsed within current phase
};

const TRAVEL_MS = 1200;
const ARRIVE_MS = 600; // spark: 2 frames × 300ms

export class SignalPulseRenderer {
  private pulses: PulseEntry[] = [];

  addPulse(fromX: number, fromY: number, toX: number, toY: number): void {
    this.pulses.push({ fromX, fromY, toX, toY, phase: 'outbound', elapsed: 0 });
  }

  update(deltaMs: number): void {
    const surviving: PulseEntry[] = [];
    for (const pulse of this.pulses) {
      pulse.elapsed += deltaMs;
      if (pulse.phase === 'outbound' && pulse.elapsed >= TRAVEL_MS) {
        pulse.phase = 'arriving';
        pulse.elapsed = 0;
      } else if (pulse.phase === 'arriving' && pulse.elapsed >= ARRIVE_MS) {
        pulse.phase = 'return';
        pulse.elapsed = 0;
      } else if (pulse.phase === 'return' && pulse.elapsed >= TRAVEL_MS) {
        continue; // done — drop it
      }
      surviving.push(pulse);
    }
    this.pulses = surviving;
  }

  render(ctx: CanvasRenderingContext2D, elapsed: number): void {
    if (!isScSpriteReady()) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;

    for (const pulse of this.pulses) {
      let x: number, y: number, spriteKey: string, half: number;

      if (pulse.phase === 'outbound') {
        const t = Math.min(pulse.elapsed / TRAVEL_MS, 1);
        x = pulse.fromX + (pulse.toX - pulse.fromX) * t;
        y = pulse.fromY + (pulse.toY - pulse.fromY) * t;
        spriteKey = 'orb-teal';
        half = 6;
      } else if (pulse.phase === 'arriving') {
        x = pulse.toX;
        y = pulse.toY;
        spriteKey = 'spark';
        half = 4;
      } else {
        const t = Math.min(pulse.elapsed / TRAVEL_MS, 1);
        x = pulse.toX + (pulse.fromX - pulse.toX) * t;
        y = pulse.toY + (pulse.fromY - pulse.toY) * t;
        spriteKey = 'orb-amber';
        half = 6;
      }

      drawScSprite(ctx, spriteKey, elapsed, x - half, y - half, half * 2, half * 2);
    }

    ctx.restore();
  }

  hasActivePulses(): boolean {
    return this.pulses.length > 0;
  }
}
