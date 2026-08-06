import { useEffect, useState, type RefObject } from 'react';

/**
 * How wide an element is, kept up to date as it changes.
 *
 * A pane in this app is not laid out by the window: it is one cell of a split
 * the user drags, so the same window can hold a pane wide enough for two
 * columns and a pane too narrow for one. A media query answers a question about
 * the window and would get both of them wrong at once, which is why this
 * measures the element instead.
 *
 * `null` until the first measurement, which is the one state a caller must
 * handle rather than guess at: rendering the wide layout before anything has
 * been measured would flash a column into a pane that has no room for it.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const observer = new ResizeObserver(([entry]) => {
      // The content box, so padding and a scrollbar do not read as room for
      // content that would then have nowhere to go.
      const measured = entry.contentRect.width;
      // Zero means the element is not being rendered - a pane on an inactive
      // tab or in a background workspace, both of which stay mounted under
      // `display: none`. That is not a width any caller can use, and taking it
      // would collapse the layout while nobody is looking, then flash it back
      // on return. Keeping the last real measurement means the pane comes back
      // already correct.
      if (measured === 0) return;
      setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
