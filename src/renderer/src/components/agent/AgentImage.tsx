import { useState } from 'react';
import { Overlay } from '../Overlay';

/**
 * A picture the agent made.
 *
 * Bounded in the transcript, because the row it sits in is one item in a
 * conversation and a full-size render would be the whole pane. Clicking opens
 * it over everything at its own size, which is the only way to actually judge
 * what came back - and judging it is the entire point of showing it.
 *
 * The image is never cropped to fit its box. A generated image is a
 * composition, and a thumbnail that trims the edges off is showing something
 * the model did not make.
 */
export function AgentImage({ src, alt }: { src: string; alt: string }): React.JSX.Element {
  const [zoomed, setZoomed] = useState(false);

  return (
    <>
      {/* `w-fit`, or the border draws a box the width of the transcript with the
          picture parked in the left of it. */}
      <button
        type="button"
        onClick={() => setZoomed(true)}
        aria-label={`View full size: ${alt}`}
        className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-fleet-border focus-ring"
      >
        <img src={src} alt={alt} className="block max-h-80 w-auto max-w-full object-contain" />
      </button>

      <Overlay
        open={zoomed}
        onClose={() => setZoomed(false)}
        panelClassName="rounded-lg overflow-hidden"
      >
        {/* Capped to the viewport rather than shown at native size: a 4K render
            would otherwise open larger than the window and be scrolled to look
            at, which is worse than the row it came from. */}
        <img src={src} alt={alt} className="block max-h-[88vh] max-w-[92vw] object-contain" />
      </Overlay>
    </>
  );
}

/**
 * A render on the way to the finished image.
 *
 * Deliberately not the same component: it is not a picture the user can act on,
 * it is what waiting looks like. So it does not open, it does not claim to be
 * the result, and it pulses to say it is still moving. What it does buy is the
 * one thing a spinner cannot - the composition, twenty seconds before the file
 * exists, which is long enough to know it is going wrong.
 */
export function AgentImagePreview({ src }: { src: string }): React.JSX.Element {
  return (
    <div className="w-fit max-w-full overflow-hidden rounded-lg border border-fleet-border">
      <img
        src={src}
        alt="Partly generated image"
        className="block max-h-80 w-auto max-w-full animate-pulse object-contain opacity-80"
      />
    </div>
  );
}
