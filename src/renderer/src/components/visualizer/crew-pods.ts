/**
 * CrewPodRenderer — Small circles attached to their sector's ring arc.
 * Each pod represents a crewmate with status-driven color and animation.
 */

import type { StationRing } from './station-ring';

export type PodState = {
  crewId: string;
  sectorId: string;
  status: 'active' | 'hailing' | 'error' | 'complete' | 'lost' | 'idle';
};

const POD_RADIUS = 6;
const POD_OFFSET = 4; // pixels inside the ring

const STATUS_COLORS: Record<PodState['status'], string> = {
  active: '#14b8a6',
  hailing: '#fbbf24',
  error: '#ef4444',
  complete: '#22c55e',
  lost: '#6b7280',
  idle: '#0d9488',
};

export class CrewPodRenderer {
  private pods: PodState[] = [];
  private elapsed = 0;

  update(pods: PodState[], deltaMs: number): void {
    this.pods = pods;
    this.elapsed += deltaMs;
  }

  render(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    ring: StationRing,
  ): void {
    if (this.pods.length === 0) return;

    const ringRadius = ring.getRadius();

    // Group pods by sector
    const bySector = new Map<string, PodState[]>();
    for (const pod of this.pods) {
      let list = bySector.get(pod.sectorId);
      if (!list) {
        list = [];
        bySector.set(pod.sectorId, list);
      }
      list.push(pod);
    }

    ctx.save();

    for (const [sectorId, sectorPods] of bySector) {
      const sectorIdx = ring.getSectorIndex(sectorId);
      if (sectorIdx < 0) continue;

      const { start, end } = ring.getSectorArc(sectorIdx);
      const arcSpan = end - start;
      const count = sectorPods.length;

      for (let i = 0; i < count; i++) {
        const pod = sectorPods[i];
        // Distribute pods evenly within the sector arc
        const t = count === 1 ? 0.5 : i / (count - 1);
        const angle = start + arcSpan * (0.15 + t * 0.7); // 15% padding on each side
        const podRadius = ringRadius - POD_OFFSET;

        const px = centerX + Math.cos(angle) * podRadius;
        const py = centerY + Math.sin(angle) * podRadius;

        const color = STATUS_COLORS[pod.status] ?? STATUS_COLORS.idle;

        // Animated effects based on status
        let alpha = 0.9;
        let glowRadius = 0;

        if (pod.status === 'active') {
          // Pulse glow
          alpha = 0.7 + 0.3 * Math.sin(this.elapsed * 0.004);
          glowRadius = 3;
        } else if (pod.status === 'hailing') {
          alpha = 0.6 + 0.4 * Math.sin(this.elapsed * 0.008);
          glowRadius = 4;
        } else if (pod.status === 'error') {
          // Flicker
          alpha = Math.random() > 0.15 ? 0.9 : 0.3;
          glowRadius = 2;
        } else if (pod.status === 'complete') {
          // Brief flash then steady
          alpha = 0.9;
          glowRadius = 2;
        } else if (pod.status === 'lost') {
          alpha = 0.4;
        }

        // Glow
        if (glowRadius > 0) {
          ctx.beginPath();
          ctx.arc(px, py, POD_RADIUS + glowRadius, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.globalAlpha = alpha * 0.25;
          ctx.fill();
        }

        // Pod circle
        ctx.beginPath();
        ctx.arc(px, py, POD_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.fill();
      }
    }

    ctx.restore();
  }
}
