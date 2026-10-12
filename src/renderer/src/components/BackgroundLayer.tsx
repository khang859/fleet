import { useEffect, useReducer, type CSSProperties } from 'react';
import type { TerminalBackground } from '../../../shared/types';
import type { SlideshowFrame } from '../hooks/use-slideshow';
import { backgroundMediaKind } from '../../../shared/background-media';
import { resolveBackgroundSrc } from '../lib/pane-background';
import { backgroundLayerStyle } from '../lib/background-style';
import { EMPTY_BACKGROUND_STACK, backgroundStackReducer } from '../lib/background-stack';
import { BackgroundVideo } from './BackgroundVideo';

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

type BackgroundLayerProps = {
  background: TerminalBackground;
  /** Shared slideshow frame from the global useSlideshow clock in App. */
  frame?: SlideshowFrame;
  /** A background could not be played, so whatever chose it should choose again. */
  onUnplayable?: (path: string) => void;
};

/**
 * The image or video layer(s) behind the window. Static mode renders one layer;
 * during a slideshow transition the outgoing background fades out under the
 * incoming one - see `background-stack` for when. CSS animations (not
 * transitions) are used because they start reliably from the first keyframe
 * the moment they are applied - a `transition` would not animate on the
 * element's mount frame.
 *
 * Layers are keyed by what they show, so the one fading out is the same element
 * that was showing: a video carries on from the frame it was on instead of
 * starting over as it leaves.
 */
export function BackgroundLayer({
  background,
  frame,
  onUnplayable
}: BackgroundLayerProps): React.JSX.Element | null {
  const src = resolveBackgroundSrc(background, frame);
  const fadeMs =
    background.slideshow.enabled && !reducedMotionQuery.matches
      ? background.slideshow.transitionMs
      : 0;
  const fade = fadeMs > 0;

  const [stack, dispatch] = useReducer(backgroundStackReducer, EMPTY_BACKGROUND_STACK);
  useEffect(() => {
    const ready = src !== null && backgroundMediaKind(src) !== 'video';
    dispatch({ type: 'show', src, ready, fade });
    // `fade` is read when the background changes, not watched: moving the
    // transition slider is not a new background.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const { top, under } = stack;
  if (!top) return null;

  const crossing = top.ready && under !== null;
  const fading = (name: string): CSSProperties => ({
    ['--fleet-bg-opacity' as string]: background.opacity,
    animation: `${name} ${fadeMs}ms ease-in-out both`
  });

  const layer = (layerSrc: string, style: CSSProperties, isTop: boolean): React.JSX.Element => (
    <div
      key={layerSrc}
      aria-hidden
      className="absolute z-0 pointer-events-none"
      style={{ ...backgroundLayerStyle(background, layerSrc), ...style }}
      onAnimationEnd={isTop ? () => dispatch({ type: 'settled', src: layerSrc }) : undefined}
    >
      {backgroundMediaKind(layerSrc) === 'video' && (
        <BackgroundVideo
          path={layerSrc}
          fit={background.fit}
          onReady={() => dispatch({ type: 'ready', src: layerSrc, fade })}
          onError={() => {
            dispatch({ type: 'failed', src: layerSrc });
            onUnplayable?.(layerSrc);
          }}
        />
      )}
    </div>
  );

  return (
    <>
      {under !== null &&
        layer(
          under,
          crossing ? fading('fleet-bg-fade-out') : { opacity: background.opacity },
          false
        )}
      {layer(
        top.src,
        crossing ? fading('fleet-bg-fade-in') : { opacity: top.ready ? background.opacity : 0 },
        true
      )}
    </>
  );
}
