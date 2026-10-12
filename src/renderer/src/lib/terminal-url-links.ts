import type { ILink, ILinkProvider } from '@xterm/xterm';
import { findUrls } from '../../../shared/terminal-url-detect';
import {
  mapLogicalOffsetToCell,
  readLogicalLine,
  type BufferReader,
  type LogicalLine
} from './terminal-buffer-text';

/**
 * Turning URLs in a terminal into something clickable.
 *
 * A URL is read from the logical line it sits on, so one that Claude Code or
 * another TUI wrapped by hand is a link on every row it covers, and clicking any
 * of them opens the whole address rather than the part on that row.
 */

/**
 * The stretches of a URL that xterm can underline as one range each.
 *
 * A range is contiguous, so a URL the terminal soft-wrapped is one stretch. A
 * hard-wrapped one has to be split at every break, or the indentation of each
 * continuation row would be underlined along with it.
 */
function urlStretches(logical: LogicalLine, start: number, end: number): Array<[number, number]> {
  const stretches: Array<[number, number]> = [];
  for (const segment of logical.segments) {
    const from = Math.max(start, segment.offset);
    const to = Math.min(end, segment.offset + segment.length);
    if (from >= to) continue;
    const last = stretches.at(-1);
    if (segment.soft && last?.[1] === from) last[1] = to;
    else stretches.push([from, to]);
  }
  return stretches;
}

/**
 * Whether a click on a URL should open it.
 *
 * Cmd/Ctrl+click always does. A plain click does once the user has asked for
 * that, except the click that ends a drag: xterm reports a selection finishing
 * over a link as a click on it, and selecting must stay selecting.
 */
export function clickOpensUrl(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>,
  pane: { plainClickOpens: boolean; hasSelection: boolean }
): boolean {
  return event.metaKey || event.ctrlKey || (pane.plainClickOpens && !pane.hasSelection);
}

/** What a pane does with its URL links, shared with its OSC 8 hyperlinks. */
export type UrlLinkEvents = {
  activate: (event: MouseEvent, url: string) => void;
  hover: () => void;
  leave: () => void;
};

export function createUrlLinkProvider(
  getBuffer: () => BufferReader,
  events: UrlLinkEvents
): ILinkProvider {
  return {
    /** xterm asks per row, 1-based. The stretch on that row opens the whole URL. */
    provideLinks(bufferLineNumber, callback) {
      const buffer = getBuffer();
      const logical = readLogicalLine(buffer, bufferLineNumber - 1);
      if (!logical) {
        callback(undefined);
        return;
      }

      const links = findUrls(logical.text).flatMap((url) =>
        urlStretches(logical, url.index, url.index + url.text.length).flatMap(([from, to]) => {
          const start = mapLogicalOffsetToCell(buffer, logical, from);
          // Taken from the last character rather than one past it, so a stretch
          // ending at a row boundary cannot run off the end of the row.
          const last = mapLogicalOffsetToCell(buffer, logical, to - 1);
          if (!start || !last) return [];
          // Only the stretch on the row asked about. xterm drops links whose
          // columns overlap, and works that out as if every link it was given
          // sat on this row - so the stretches of one URL, stacked on the rows
          // above and below, would knock each other out.
          const y = bufferLineNumber - 1;
          if (start.y > y || last.y < y) return [];
          // The end is inclusive, so a full-width last character needs both of
          // its cells or its right half is not part of the link.
          const lastCell = buffer.getNullCell();
          buffer.getLine(last.y)?.getCell(last.x, lastCell);
          const link: ILink = {
            range: {
              start: { x: start.x + 1, y: start.y + 1 },
              end: { x: last.x + lastCell.getWidth(), y: last.y + 1 }
            },
            text: url.text,
            activate: (event) => {
              events.activate(event, url.text);
            },
            hover: events.hover,
            leave: events.leave
          };
          return [link];
        })
      );

      callback(links.length > 0 ? links : undefined);
    }
  };
}
