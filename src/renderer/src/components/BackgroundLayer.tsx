import type { CSSProperties } from 'react';
import type { TerminalBackground } from '../../../shared/types';
import type { SlideshowFrame } from '../hooks/use-slideshow';

const FIT_STYLES: Record<TerminalBackground['fit'], { size: string; repeat: string }> = {
  cover: { size: 'cover', repeat: 'no-repeat' },
  contain: { size: 'contain', repeat: 'no-repeat' },
  center: { size: 'auto', repeat: 'no-repeat' },
  tile: { size: 'auto', repeat: 'repeat' }
};

// Feather the pane edges to transparent so an image smaller than the pane blends
// into the terminal background instead of ending at a hard border. `fadeX` fades
// the left/right edges, `fadeY` the top/bottom (each a fraction of the pane). When
// both are active the gradients are intersected so the corners fade too.
function edgeFadeStyle(fadeX: number, fadeY: number): CSSProperties {
  if (!fadeX && !fadeY) return {};
  const ramp = (dir: string, fade: number): string => {
    const start = `${(fade * 100).toFixed(1)}%`;
    const end = `${(100 - fade * 100).toFixed(1)}%`;
    return `linear-gradient(to ${dir}, transparent, #000 ${start}, #000 ${end}, transparent)`;
  };
  const layers: string[] = [];
  if (fadeX) layers.push(ramp('right', fadeX));
  if (fadeY) layers.push(ramp('bottom', fadeY));
  return {
    maskImage: layers.join(', '),
    ...(layers.length > 1 ? { maskComposite: 'intersect' } : {})
  };
}

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

type BackgroundLayerProps = {
  background: TerminalBackground;
  /** Shared slideshow frame from the global useSlideshow clock in App. */
  frame?: SlideshowFrame;
};

/**
 * The image layer(s) behind a terminal pane. Static mode renders one layer;
 * during a slideshow transition the outgoing image fades out under the
 * incoming one. CSS animations (not transitions) are used because keyed
 * remounts restart them reliably from the first keyframe — a `transition`
 * would not animate on the element's mount frame.
 */
export function BackgroundLayer({
  background,
  frame
}: BackgroundLayerProps): React.JSX.Element | null {
  const slideshowOn = background.slideshow.enabled;
  const currentSrc = slideshowOn && frame?.currentPath ? frame.currentPath : background.imagePath;
  if (!currentSrc) return null;

  const fadeMs = reducedMotionQuery.matches ? 0 : background.slideshow.transitionMs;
  const previousSrc =
    slideshowOn && fadeMs > 0 && frame?.previousPath !== currentSrc
      ? (frame?.previousPath ?? null)
      : null;

  const layerStyle = (src: string): CSSProperties => ({
    // Over-extend when blurred so the blur's soft edge doesn't reveal the pane border.
    inset: background.blur > 0 ? -background.blur * 2 : 0,
    // encodeURI so paths with spaces/special chars survive the CSS url() parser.
    backgroundImage: `url("${encodeURI(`fleet-image://${src}`)}")`,
    backgroundSize: FIT_STYLES[background.fit].size,
    backgroundRepeat: FIT_STYLES[background.fit].repeat,
    backgroundPosition: 'center',
    filter: background.blur > 0 ? `blur(${background.blur}px)` : undefined,
    ...edgeFadeStyle(background.edgeFadeX, background.edgeFadeY)
  });

  return (
    <>
      {previousSrc && (
        <div
          key={`out-${previousSrc}`}
          aria-hidden
          className="absolute z-0 pointer-events-none"
          style={{
            ...layerStyle(previousSrc),
            ['--fleet-bg-opacity' as string]: background.opacity,
            animation: `fleet-bg-fade-out ${fadeMs}ms ease-in-out both`
          }}
        />
      )}
      <div
        key={`in-${currentSrc}`}
        aria-hidden
        className="absolute z-0 pointer-events-none"
        style={{
          ...layerStyle(currentSrc),
          opacity: background.opacity,
          ...(previousSrc
            ? {
                ['--fleet-bg-opacity' as string]: background.opacity,
                animation: `fleet-bg-fade-in ${fadeMs}ms ease-in-out both`
              }
            : {})
        }}
      />
    </>
  );
}
