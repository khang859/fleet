import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FolderOpen,
  Images,
  ImagePlus,
  RotateCcw,
  Wallpaper,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import {
  TransformComponent,
  TransformWrapper,
  useControls,
  useTransformEffect
} from 'react-zoom-pan-pinch';
import { Overlay } from '../Overlay';
import { addToSlideshow, setAsBackground } from '../../lib/background-actions';
import {
  copyImageToClipboard,
  revealImage,
  saveImageAs,
  startImageDrag
} from '../../lib/image-export-actions';

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
          picture parked in the left of it. The wrapper is what the hover
          actions hang off: they cannot live inside the button that opens the
          picture, because a button inside a button is not a thing a browser
          will render, and clicking one would open the viewer as well. */}
      <div className="group relative w-fit max-w-full">
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={`View full size: ${alt}`}
          className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-fleet-border focus-ring"
        >
          {/* Draggable, so the picture can go straight into a folder or another
              app the way one from a browser would. `preventDefault` hands the
              gesture to Electron: the OS drags the real file off disk, rather
              than Chromium dragging a `file://` URL that most drop targets
              refuse. */}
          <img
            src={src}
            alt={alt}
            draggable={path !== undefined}
            onDragStart={(e) => {
              if (path === undefined) return;
              e.preventDefault();
              void startImageDrag(path);
            }}
            className="block max-h-80 w-auto max-w-full object-contain"
          />
        </button>
        {path !== undefined && (
          <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-md border border-white/10 bg-black/60 p-0.5 opacity-0 backdrop-blur-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <ExportActions path={path} />
            <span aria-hidden className="mx-0.5 h-4 w-px bg-white/15" />
            <BackgroundActions path={path} />
          </div>
        )}
      </div>

      <AgentImageOverlay
        open={zoomed}
        src={src}
        alt={alt}
        path={path}
        onClose={() => setZoomed(false)}
      />
    </>
  );
}

/**
 * One picture, opened over everything, with its controls.
 *
 * Its own export because the gallery opens the same thing from a grid rather
 * than from a transcript row, and a second viewer would be a second set of
 * answers to what zooming, saving and closing mean.
 *
 * `caption` is what the opener knows about the picture and the viewer cannot:
 * the transcript has the prompt on the row underneath already, the gallery has
 * to go and read it. Nothing is drawn when there is none.
 */
export function AgentImageOverlay({
  open,
  src,
  alt,
  path,
  caption,
  extraActions,
  onClose
}: {
  open: boolean;
  src: string;
  alt: string;
  path?: string;
  caption?: React.ReactNode;
  /** Buttons only one opener has, drawn ahead of the shared ones. */
  extraActions?: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Overlay open={open} onClose={onClose} panelClassName="relative">
      <TransformWrapper maxScale={MAX_SCALE} doubleClick={{ mode: 'toggle', step: 1 }}>
        <Viewer
          src={src}
          alt={alt}
          path={path}
          caption={caption}
          extraActions={extraActions}
          onClose={onClose}
        />
      </TransformWrapper>
    </Overlay>
  );
}

/**
 * Getting the picture out of Fleet.
 *
 * First in the bar, ahead of the background actions, because these are what
 * someone wants from an image far more often than a desktop wallpaper: a
 * generated picture lives inside the conversation that made it and is deleted
 * with it, so leaving without saving is losing it.
 *
 * Three rather than one because they are three different destinations, and
 * making the other two reachable only through the first would mean a file
 * dialog stands between the user and pasting a picture into a chat window.
 */
function ExportActions({ path }: { path: string }): React.JSX.Element {
  return (
    <>
      <Tool label="Save image as..." onClick={() => void saveImageAs(path)}>
        <Download size={15} />
      </Tool>
      <Tool label="Copy image" onClick={() => void copyImageToClipboard(path)}>
        <ImagePlus size={15} />
      </Tool>
      <Tool label="Show in folder" onClick={() => void revealImage(path)}>
        <FolderOpen size={15} />
      </Tool>
    </>
  );
}

/**
 * Send this picture to the window behind everything.
 *
 * Both actions are here rather than only in the settings pane because this is
 * where the user is when they decide: they have just looked at what came back,
 * and the alternative is copying a path, opening Settings and browsing back to
 * a folder full of uuids to find the one they were already looking at.
 *
 * Drawn twice - over the thumbnail on hover, and in the viewer's toolbar - for
 * the same reason. Whether a picture is worth looking at all day is not a
 * judgement anyone makes from a thumbnail, so the actions have to survive
 * opening it.
 */
function BackgroundActions({ path }: { path: string }): React.JSX.Element {
  return (
    <>
      <Tool label="Set as background" onClick={() => void setAsBackground(path)}>
        <Wallpaper size={15} />
      </Tool>
      <Tool label="Add to slideshow" onClick={() => void addToSlideshow(path)}>
        <Images size={15} />
      </Tool>
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
  caption,
  extraActions,
  onClose
}: {
  src: string;
  alt: string;
  path?: string;
  caption?: React.ReactNode;
  extraActions?: React.ReactNode;
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
        {extraActions !== undefined && (
          <>
            {extraActions}
            <span aria-hidden className="mx-0.5 h-4 w-px bg-white/15" />
          </>
        )}
        {path !== undefined && (
          <>
            <ExportActions path={path} />
            <span aria-hidden className="mx-0.5 h-4 w-px bg-white/15" />
            <BackgroundActions path={path} />
            <CopyPath path={path} />
            <span aria-hidden className="mx-0.5 h-4 w-px bg-white/15" />
          </>
        )}
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

      {/* Over the picture rather than under it: the panel is sized to the image,
          so a bar below would push a tall one off the screen to make room for
          text about it. Pointer-events off so it cannot swallow a drag that
          started on the picture behind it. */}
      {caption !== undefined && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-lg bg-gradient-to-t from-black/80 to-transparent px-4 pt-8 pb-3">
          {caption}
        </div>
      )}
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
