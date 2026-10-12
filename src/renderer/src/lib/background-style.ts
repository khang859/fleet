import type { CSSProperties } from 'react';
import type { TerminalBackground, TerminalBackgroundFit } from '../../../shared/types';
import { backgroundMediaKind } from '../../../shared/background-media';
import { toFleetImageUrl } from '../../../shared/path-platform';

/**
 * How a background is laid out, for everything that draws one.
 *
 * The window's layer and the settings preview are the same picture at two
 * sizes, so they take their styles from here rather than each keeping a copy
 * that the other can drift away from.
 */

const FIT_STYLES: Record<TerminalBackgroundFit, { size: string; repeat: string }> = {
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

/**
 * The box one background is drawn in: where it sits, its blur, its feathered
 * edges - and, for an image, the image itself. A video is an element of its own
 * inside this box, so the blur and the mask fall on it exactly as they do on a
 * picture. Opacity is left to the caller, which may be fading the box in or out.
 */
export function backgroundLayerStyle(
  background: Pick<TerminalBackground, 'blur' | 'fit' | 'edgeFadeX' | 'edgeFadeY'>,
  src: string
): CSSProperties {
  return {
    // Over-extend when blurred so the blur's soft edge doesn't reveal the pane border.
    inset: background.blur > 0 ? -background.blur * 2 : 0,
    filter: background.blur > 0 ? `blur(${background.blur}px)` : undefined,
    ...edgeFadeStyle(background.edgeFadeX, background.edgeFadeY),
    ...(backgroundMediaKind(src) === 'video'
      ? {}
      : {
          // toFleetImageUrl percent-encodes so paths with spaces/special chars survive the CSS url() parser.
          backgroundImage: `url("${toFleetImageUrl(src)}")`,
          backgroundSize: FIT_STYLES[background.fit].size,
          backgroundRepeat: FIT_STYLES[background.fit].repeat,
          backgroundPosition: 'center'
        })
  };
}

/** The same fit, for a `<video>`. Nothing tiles a video, so tile fills instead. */
export function videoObjectFit(fit: TerminalBackgroundFit): 'cover' | 'contain' | 'none' {
  if (fit === 'contain') return 'contain';
  if (fit === 'center') return 'none';
  return 'cover';
}
