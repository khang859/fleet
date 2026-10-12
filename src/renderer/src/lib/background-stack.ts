/**
 * Which backgrounds are mounted, and which of them can be seen.
 *
 * A picture can be decoded before it is shown, so swapping one for the next is
 * a matter of timing two fades. A video cannot: its first frame arrives when it
 * arrives, and a fade started on a clock would spend its first moments fading
 * in nothing while the old background faded out - the wallpaper dipping to the
 * bare theme colour in between. So the layer waits to be told. The new
 * background is mounted unseen over the old one, the old one stays exactly as
 * it was until the new one says it has a frame, and only then do the two cross.
 */
export type BackgroundStack = {
  /** Mounted on top: unseen until `ready`, then fading in over `under` - or
   *  simply shown, when there is nothing beneath it. */
  top: { src: string; ready: boolean } | null;
  /** Still on screen beneath it: untouched until `top` is ready, fading out after. */
  under: string | null;
};

export type BackgroundStackEvent =
  /** The background to show changed. `ready` says it needs no waiting for
   *  (an image); `fade` whether the swap is a crossfade or a cut. */
  | { type: 'show'; src: string | null; ready: boolean; fade: boolean }
  /** A background that was being waited for has its first frame. */
  | { type: 'ready'; src: string; fade: boolean }
  /** The fade-in finished, so what was underneath can go. */
  | { type: 'settled'; src: string }
  /** A background could not be played. */
  | { type: 'failed'; src: string };

export const EMPTY_BACKGROUND_STACK: BackgroundStack = { top: null, under: null };

export function backgroundStackReducer(
  stack: BackgroundStack,
  event: BackgroundStackEvent
): BackgroundStack {
  const { top, under } = stack;

  switch (event.type) {
    case 'show': {
      if (event.src === null) return EMPTY_BACKGROUND_STACK;
      if (top?.src === event.src) return stack;
      // What the user is actually looking at. A top that never became ready was
      // never seen, so it is dropped rather than kept underneath.
      const visible = top?.ready ? top.src : under;
      const cut = event.ready && !event.fade;
      if (visible === null || visible === event.src || cut) {
        return {
          top: { src: event.src, ready: visible === event.src || event.ready },
          under: null
        };
      }
      return { top: { src: event.src, ready: event.ready }, under: visible };
    }

    case 'ready':
      // Late news from a background that has since been replaced changes nothing.
      if (top?.src !== event.src || top.ready) return stack;
      return { top: { src: top.src, ready: true }, under: event.fade ? under : null };

    case 'settled':
      if (top?.src !== event.src || !top.ready || under === null) return stack;
      return { top, under: null };

    case 'failed':
      if (top?.src === event.src) {
        // Whatever was showing carries on showing, rather than the window going
        // blank for a file that would not play.
        return under === null
          ? EMPTY_BACKGROUND_STACK
          : { top: { src: under, ready: true }, under: null };
      }
      if (under === event.src) return { top, under: null };
      return stack;
  }
}
