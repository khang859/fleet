import { useRef, useEffect } from 'react';
import { useStarCommandStore } from '../../store/star-command-store';
import { mapSectors, mapCrew, computeSectorPositions } from './scene-utils';
import type { SectorState, PodState } from './scene-utils';
import { loadScSpriteSheet, isScSpriteReady, drawScSprite } from './sc-sprite-loader';

// --- Sector Outpost Renderer ---
class SectorOutpostRenderer {
  render(
    ctx: CanvasRenderingContext2D,
    sectors: SectorState[],
    positions: Map<string, { x: number; y: number }>,
    elapsed: number
  ): void {
    if (sectors.length === 0) return;
    if (!isScSpriteReady()) return;

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    for (const sector of sectors) {
      const pos = positions.get(sector.id);
      if (!pos) continue;
      const { x, y } = pos;

      // Active glow
      if (sector.active) {
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 24);
        grad.addColorStop(0, 'rgba(20,184,166,0.25)');
        grad.addColorStop(1, 'rgba(20,184,166,0)');
        ctx.beginPath();
        ctx.arc(x, y, 24, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.globalAlpha = 1;
        ctx.fill();
      }

      // Beacon sprite (12×12 centered)
      ctx.globalAlpha = sector.active ? 1 : 0.4;
      drawScSprite(ctx, 'beacon', elapsed, x - 6, y - 6, 12, 12);

      // Label — 14px below bottom of beacon
      ctx.globalAlpha = sector.active ? 1 : 0.4;
      ctx.fillStyle = '#ffffff';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(sector.name, x, y + 20); // 6 (half beacon) + 14 (gap)
    }

    ctx.restore();
  }
}

// --- Signal Pulse Renderer ---
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

class SignalPulseRenderer {
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

// --- Shuttle Renderer ---
type ShuttleState = 'orbiting' | 'flying-to-hub' | 'returning' | 'docking' | 'drifting' | 'docked';

type ShuttleEntry = {
  crewId: string;
  sectorId: string;
  state: ShuttleState;
  x: number;
  y: number;
  vx: number; // velocity used for sprite rotation
  vy: number;
  orbitPhase: number; // accumulates each frame
  orbitSpeed: number; // rad/s (0.6–1.0), deterministic from crewId
  alpha: number; // 1.0 normally; fades in drifting
  returnTargetX: number; // snapshot of outpost at time of returning-state entry
  returnTargetY: number;
  dockElapsed: number; // ms elapsed in docking animation
  driftElapsed: number; // ms elapsed while drifting
};

const ORBIT_RADIUS = 35;
const SHUTTLE_TRAVEL_SPEED = 80; // px/s
const ARRIVAL_THRESHOLD = 20; // px
const DOCK_DURATION = 450; // ms (3 frames × 150ms)
const DRIFT_DURATION = 3000; // ms
const DOCK_RADIUS = 20; // px — docked shuttle distance from hub center

function crewHash(id: string): number {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  return sum;
}

function makeDockedEntry(
  crewId: string,
  sectorId: string,
  hubX: number,
  hubY: number
): ShuttleEntry {
  const hash = crewHash(crewId);
  const angle = hash % (2 * Math.PI);
  return {
    crewId,
    sectorId,
    state: 'docked',
    x: hubX + Math.cos(angle) * DOCK_RADIUS,
    y: hubY + Math.sin(angle) * DOCK_RADIUS,
    vx: 0,
    vy: 0,
    orbitPhase: angle,
    orbitSpeed: 0.6 + (0.4 * (hash % 100)) / 100,
    alpha: 1,
    returnTargetX: 0,
    returnTargetY: 0,
    dockElapsed: 0,
    driftElapsed: 0
  };
}

class ShuttleRenderer {
  private entries = new Map<string, ShuttleEntry>();
  private lastStatus = new Map<string, PodState['status']>();

  update(
    pods: PodState[],
    positions: Map<string, { x: number; y: number }>,
    hubX: number,
    hubY: number,
    deltaMs: number
  ): void {
    const dt = deltaMs / 1000;
    const activeCrew = new Set(pods.map((p) => p.crewId));

    // Remove entries for crew no longer in the list
    for (const [id] of this.entries) {
      if (!activeCrew.has(id)) {
        this.entries.delete(id);
        this.lastStatus.delete(id);
      }
    }

    for (const pod of pods) {
      const prevStatus = this.lastStatus.get(pod.crewId);
      const statusChanged = prevStatus !== undefined && prevStatus !== pod.status;
      const sectorPos = positions.get(pod.sectorId);
      let entry = this.entries.get(pod.crewId);

      // Inactive crew (idle/complete): dock at station hub
      if (pod.status === 'idle' || pod.status === 'complete') {
        if (!entry) {
          entry = makeDockedEntry(pod.crewId, pod.sectorId, hubX, hubY);
          this.entries.set(pod.crewId, entry);
        } else if (
          statusChanged &&
          pod.status === 'complete' &&
          entry.state !== 'docking' &&
          entry.state !== 'docked'
        ) {
          // Play dock-sparkle at hub on completion, then settle to docked
          entry.state = 'docking';
          entry.dockElapsed = 0;
          entry.x = hubX;
          entry.y = hubY;
          entry.vx = 0;
          entry.vy = 0;
        } else if (
          pod.status === 'idle' &&
          entry.state !== 'docked' &&
          entry.state !== 'drifting'
        ) {
          // Idle transition: snap to docked
          entry.state = 'docked';
          entry.vx = 0;
          entry.vy = 0;
        }
        this.lastStatus.set(pod.crewId, pod.status);
      }

      // Lost crew: drift away from current position
      if (pod.status === 'lost') {
        if (!entry) {
          this.lastStatus.set(pod.crewId, pod.status);
          continue;
        }
        if (statusChanged && entry.state !== 'drifting') {
          entry.state = 'drifting';
          entry.driftElapsed = 0;
          entry.alpha = 1;
          const dx = entry.x - hubX;
          const dy = entry.y - hubY;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          entry.vx = (dx / dist) * 15;
          entry.vy = (dy / dist) * 15;
        }
        this.lastStatus.set(pod.crewId, pod.status);
      }

      // Active crew (active/hailing/error): need sector position
      if (pod.status === 'active' || pod.status === 'hailing' || pod.status === 'error') {
        if (!sectorPos) {
          this.lastStatus.set(pod.crewId, pod.status);
          continue;
        }
        const { x: sx, y: sy } = sectorPos;

        if (!entry) {
          const hash = crewHash(pod.crewId);
          const initPhase = hash % (2 * Math.PI);
          const speed = 0.6 + (0.4 * (hash % 100)) / 100;
          entry = {
            crewId: pod.crewId,
            sectorId: pod.sectorId,
            state: pod.status === 'hailing' ? 'flying-to-hub' : 'orbiting',
            x: sx + Math.cos(initPhase) * ORBIT_RADIUS,
            y: sy + Math.sin(initPhase) * ORBIT_RADIUS,
            vx: 0,
            vy: 0,
            orbitPhase: initPhase,
            orbitSpeed: speed,
            alpha: 1,
            returnTargetX: sx,
            returnTargetY: sy,
            dockElapsed: 0,
            driftElapsed: 0
          };
          this.entries.set(pod.crewId, entry);
        }

        // Transition from docked to active: jump to orbit position
        if (entry.state === 'docked') {
          const hash = crewHash(pod.crewId);
          const initPhase = hash % (2 * Math.PI);
          entry.state = pod.status === 'hailing' ? 'flying-to-hub' : 'orbiting';
          entry.orbitPhase = initPhase;
          entry.x = sx + Math.cos(initPhase) * ORBIT_RADIUS;
          entry.y = sy + Math.sin(initPhase) * ORBIT_RADIUS;
          entry.vx = 0;
          entry.vy = 0;
        }

        // Re-trigger flying-to-hub whenever hailing and back to orbiting
        if (pod.status === 'hailing' && entry.state === 'orbiting') {
          entry.state = 'flying-to-hub';
        }

        this.lastStatus.set(pod.crewId, pod.status);
      }

      // Safety net — skip if entry still absent (e.g. lost with no prior entry)
      if (!entry) continue;

      const sx = sectorPos?.x ?? 0;
      const sy = sectorPos?.y ?? 0;

      // Physics update
      switch (entry.state) {
        case 'docked': {
          const angle = crewHash(entry.crewId) % (2 * Math.PI);
          entry.x = hubX + Math.cos(angle) * DOCK_RADIUS;
          entry.y = hubY + Math.sin(angle) * DOCK_RADIUS;
          entry.vx = 0;
          entry.vy = 0;
          break;
        }
        case 'orbiting': {
          let speed = entry.orbitSpeed;
          if (pod.status === 'error') speed *= Math.random() * 0.5 + 0.75;
          entry.orbitPhase += speed * dt;
          if (entry.orbitPhase > Math.PI * 2) entry.orbitPhase -= Math.PI * 2;
          const newX = sx + Math.cos(entry.orbitPhase) * ORBIT_RADIUS;
          const newY = sy + Math.sin(entry.orbitPhase) * ORBIT_RADIUS;
          entry.vx = (newX - entry.x) / Math.max(dt, 0.001);
          entry.vy = (newY - entry.y) / Math.max(dt, 0.001);
          entry.x = newX;
          entry.y = newY;
          break;
        }
        case 'flying-to-hub': {
          const dx = hubX - entry.x;
          const dy = hubY - entry.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= ARRIVAL_THRESHOLD) {
            const sp = positions.get(entry.sectorId);
            entry.returnTargetX = sp ? sp.x : sx;
            entry.returnTargetY = sp ? sp.y : sy;
            entry.state = 'returning';
          } else {
            const step = Math.min(SHUTTLE_TRAVEL_SPEED * dt, dist);
            entry.vx = (dx / dist) * SHUTTLE_TRAVEL_SPEED;
            entry.vy = (dy / dist) * SHUTTLE_TRAVEL_SPEED;
            entry.x += (dx / dist) * step;
            entry.y += (dy / dist) * step;
          }
          break;
        }
        case 'returning': {
          const dx = entry.returnTargetX - entry.x;
          const dy = entry.returnTargetY - entry.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= ARRIVAL_THRESHOLD) {
            entry.state = 'orbiting';
          } else {
            const step = Math.min(SHUTTLE_TRAVEL_SPEED * dt, dist);
            entry.vx = (dx / dist) * SHUTTLE_TRAVEL_SPEED;
            entry.vy = (dy / dist) * SHUTTLE_TRAVEL_SPEED;
            entry.x += (dx / dist) * step;
            entry.y += (dy / dist) * step;
          }
          break;
        }
        case 'docking': {
          entry.dockElapsed += deltaMs;
          if (entry.dockElapsed >= DOCK_DURATION) {
            // Sparkle done — settle to docked
            entry.state = 'docked';
            entry.vx = 0;
            entry.vy = 0;
          }
          break;
        }
        case 'drifting': {
          entry.driftElapsed += deltaMs;
          entry.x += entry.vx * dt;
          entry.y += entry.vy * dt;
          entry.alpha = Math.max(0, 1 - entry.driftElapsed / DRIFT_DURATION);
          if (entry.driftElapsed >= DRIFT_DURATION) {
            this.entries.delete(pod.crewId);
          }
          break;
        }
      }
    }
  }

  render(ctx: CanvasRenderingContext2D, elapsed: number): void {
    if (!isScSpriteReady()) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;

    for (const entry of this.entries.values()) {
      if (entry.state === 'docking') {
        // dock-sparkle at hub
        ctx.globalAlpha = 1;
        drawScSprite(ctx, 'dock-sparkle', entry.dockElapsed, entry.x - 4, entry.y - 4, 8, 8);
        continue;
      }

      ctx.globalAlpha = entry.state === 'drifting' ? entry.alpha : 1;

      const angle = Math.atan2(entry.vy, entry.vx);
      const spriteKey =
        entry.state === 'drifting' || entry.state === 'docked' ? 'shuttle-idle' : 'shuttle-thrust';

      ctx.save();
      ctx.translate(entry.x, entry.y);
      ctx.rotate(angle);
      drawScSprite(ctx, spriteKey, elapsed, -12, -12, 24, 24);
      ctx.restore();
    }

    ctx.restore();
  }

  getShuttlePosition(crewId: string): { x: number; y: number } | null {
    const entry = this.entries.get(crewId);
    return entry ? { x: entry.x, y: entry.y } : null;
  }

  hasActiveShuttles(): boolean {
    for (const entry of this.entries.values()) {
      if (
        entry.state === 'flying-to-hub' ||
        entry.state === 'returning' ||
        entry.state === 'docking' ||
        entry.state === 'drifting'
      )
        return true;
    }
    return false;
  }
}

export function StarCommandScene({
  className,
  isActive = true
}: {
  className?: string;
  isActive?: boolean;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const pendingResizeRef = useRef(false);
  const stoppedRef = useRef(false);
  const frameRef = useRef<(now: number) => void>(() => {});

  const sectorStatesRef = useRef<SectorState[]>([]);
  const podStatesRef = useRef<PodState[]>([]);

  const { sectors, crewList } = useStarCommandStore();
  useEffect(() => {
    sectorStatesRef.current = mapSectors(sectors, crewList);
    podStatesRef.current = mapCrew(crewList);
  }, [sectors, crewList]);

  useEffect(() => {
    loadScSpriteSheet();

    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    // --- Starfield ---
    type Star = { x: number; y: number; radius: number; phase: number; speed: number };
    const STAR_COUNT = 150;
    let stars: Star[] = [];

    const scatterStars = (w: number, h: number): void => {
      stars = Array.from({ length: STAR_COUNT }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        radius: Math.random() * 1.2 + 0.3,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.0008 + 0.0002
      }));
    };

    let starOffscreen = new OffscreenCanvas(canvas.width, canvas.height);
    let starCtx = starOffscreen.getContext('2d')!;
    let lastStarRedraw = 0;
    let elapsed = 0;

    const redrawStars = (): void => {
      starCtx.clearRect(0, 0, starOffscreen.width, starOffscreen.height);
      for (const star of stars) {
        const brightness = 0.4 + 0.6 * Math.abs(Math.sin(elapsed * star.speed + star.phase));
        starCtx.beginPath();
        starCtx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        starCtx.fillStyle = `rgba(255,255,255,${brightness.toFixed(2)})`;
        starCtx.fill();
      }
    };

    const applyResize = (): void => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      pendingResizeRef.current = false;
      starOffscreen = new OffscreenCanvas(canvas.width, canvas.height);
      starCtx = starOffscreen.getContext('2d')!;
      scatterStars(canvas.width, canvas.height);
      redrawStars();
    };
    applyResize();

    const ro = new ResizeObserver(() => {
      pendingResizeRef.current = true;
    });
    ro.observe(container);

    // --- Renderers ---
    const sectorOutposts = new SectorOutpostRenderer();
    const shuttleRenderer = new ShuttleRenderer();
    const signalPulses = new SignalPulseRenderer();
    let lastPulseSpawn = 0;

    function frame(now: number): void {
      if (stoppedRef.current) return;
      if (pendingResizeRef.current) applyResize();

      // Adaptive FPS throttle
      const hasActiveCrew = podStatesRef.current.some(
        (p) => p.status === 'active' || p.status === 'hailing' || p.status === 'error'
      );
      const hasActiveAnimation =
        hasActiveCrew || shuttleRenderer.hasActiveShuttles() || signalPulses.hasActivePulses();
      const frameBudget = hasActiveAnimation ? 33 : 100;

      if (now - lastFrameRef.current < frameBudget) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      const deltaMs = lastFrameRef.current ? now - lastFrameRef.current : 16;
      lastFrameRef.current = now;
      elapsed += deltaMs;

      const w = canvas!.width;
      const h = canvas!.height;

      // Background
      ctx!.fillStyle = '#0a0a1a';
      ctx!.fillRect(0, 0, w, h);

      // Starfield
      if (now - lastStarRedraw >= 200) {
        redrawStars();
        lastStarRedraw = now;
      }
      ctx!.drawImage(starOffscreen, 0, 0);

      const cx = w / 2;
      const cy = h / 2;
      const scale = Math.min(w, h) / 600;
      const outpostRadius = Math.min(w, h) * 0.42;

      const currentSectors = sectorStatesRef.current;
      const currentPods = podStatesRef.current;
      const sectorPositions = computeSectorPositions(currentSectors, cx, cy, outpostRadius);

      // Update renderers
      shuttleRenderer.update(currentPods, sectorPositions, cx, cy, deltaMs);
      signalPulses.update(deltaMs);

      // Spawn signal pulses every 3s for hailing crew
      if (elapsed - lastPulseSpawn >= 3000) {
        for (const pod of currentPods) {
          if (pod.status === 'hailing') {
            const pos = shuttleRenderer.getShuttlePosition(pod.crewId);
            if (pos) signalPulses.addPulse(pos.x, pos.y, cx, cy);
          }
        }
        lastPulseSpawn = elapsed;
      }

      // Render layers (back to front)
      sectorOutposts.render(ctx!, currentSectors, sectorPositions, elapsed);
      signalPulses.render(ctx!, elapsed);
      shuttleRenderer.render(ctx!, elapsed);

      // Hub sprite on top
      if (isScSpriteReady()) {
        const hubSize = 128 * scale;
        ctx!.imageSmoothingEnabled = false;
        drawScSprite(
          ctx!,
          'station-hub',
          elapsed,
          cx - hubSize / 2,
          cy - hubSize / 2,
          hubSize,
          hubSize
        );
      }

      rafRef.current = requestAnimationFrame(frame);
    }
    frameRef.current = frame;

    const handleVisibility = (): void => {
      if (document.hidden) {
        stoppedRef.current = true;
        cancelAnimationFrame(rafRef.current);
      } else {
        stoppedRef.current = false;
        lastFrameRef.current = 0;
        rafRef.current = requestAnimationFrame(frame);
      }
    };
    const handleBlur = (): void => {
      stoppedRef.current = true;
      cancelAnimationFrame(rafRef.current);
    };
    const handleFocus = (): void => {
      if (!stoppedRef.current) return;
      stoppedRef.current = false;
      lastFrameRef.current = 0;
      rafRef.current = requestAnimationFrame(frame);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    rafRef.current = requestAnimationFrame(frame);

    return () => {
      stoppedRef.current = true;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  useEffect(() => {
    if (!isActive) {
      stoppedRef.current = true;
      cancelAnimationFrame(rafRef.current);
    } else if (stoppedRef.current) {
      stoppedRef.current = false;
      lastFrameRef.current = 0;
      rafRef.current = requestAnimationFrame(frameRef.current);
    }
  }, [isActive]);

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className ?? ''}`}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
