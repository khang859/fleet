import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import {
  TransformComponent,
  TransformWrapper,
  useControls,
  useTransformEffect
} from 'react-zoom-pan-pinch';
import { Overlay } from '../Overlay';

/** How far in the viewer will go. Past this a generated image is only pixels. */
const MAX_SCALE = 8;

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
export function AgentImage({
  src,
  alt,
  path
}: {
  src: string;
  alt: string;
  /**
   * Where the file is, when the viewer should offer to copy it. Opened full
   * size is where a picture is actually judged, and it is also the moment the
   * user decides to do something with it - so the path has to be reachable
   * from in here and not only from the row underneath, which is by then
   * covered up.
   */
  path?: string;
}): React.JSX.Element {
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

      <Overlay open={zoomed} onClose={() => setZoomed(false)} panelClassName="relative">
        <TransformWrapper maxScale={MAX_SCALE} doubleClick={{ mode: 'toggle', step: 1 }}>
          <Viewer src={src} alt={alt} path={path} onClose={() => setZoomed(false)} />
        </TransformWrapper>
      </Overlay>
    </>
  );
}

/**
 * The opened image and its controls.
 *
 * Separate from {@link AgentImage} only because the zoom hooks have to run
 * under the wrapper that owns the transform.
 */
function Viewer({
  src,
  alt,
  path,
  onClose
}: {
  src: string;
  alt: string;
  path?: string;
  onClose: () => void;
}): React.JSX.Element {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  const [magnified, setMagnified] = useState(false);
  // Fires on every frame of a pan, but only ever hands React the same boolean,
  // which it bails out of - so the cursor and the disabled buttons stay honest
  // without a render per frame.
  useTransformEffect(({ state }) => setMagnified(state.scale > 1.01));

  return (
    <>
      <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-white/10 bg-black/60 p-0.5 backdrop-blur-sm">
        {path !== undefined && <CopyPath path={path} />}
        <Tool label="Zoom out" onClick={() => zoomOut()} disabled={!magnified}>
          <ZoomOut size={15} />
        </Tool>
        <Tool label="Zoom in" onClick={() => zoomIn()}>
          <ZoomIn size={15} />
        </Tool>
        <Tool label="Reset zoom" onClick={() => resetTransform()} disabled={!magnified}>
          <RotateCcw size={15} />
        </Tool>
        <Tool label="Close" onClick={onClose}>
          <X size={15} />
        </Tool>
      </div>

      {/* Capped to the viewport rather than shown at native size: a 4K render
          would otherwise open larger than the window and be scrolled to look
          at, which is worse than the row it came from. Zooming past that is
          what the controls are for. */}
      <TransformComponent
        wrapperClass={`rounded-lg ${magnified ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        <img src={src} alt={alt} className="block max-h-[88vh] max-w-[92vw] object-contain" />
      </TransformComponent>
    </>
  );
}

/**
 * The path, onto the clipboard, from inside the viewer.
 *
 * Says so with a tick rather than a toast: a toast is drawn by the app behind
 * this overlay, and an answer that appears somewhere the user is not looking is
 * no answer. The tick is also the truth - it is set once the write has actually
 * happened, so a clipboard that refuses says nothing rather than lying.
 */
function CopyPath({ path }: { path: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return (
    <Tool
      label={copied ? 'Path copied' : 'Copy path'}
      onClick={() => {
        void navigator.clipboard.writeText(path).then(() => {
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
    </Tool>
  );
}

function Tool({
  label,
  onClick,
  disabled = false,
  children
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-35 focus-ring"
    >
      {children}
    </button>
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
