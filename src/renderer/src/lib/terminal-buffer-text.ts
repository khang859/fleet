import type { IBufferLine, IBufferCell } from '@xterm/xterm';

/**
 * Reading a logical line of text out of a terminal buffer, and finding the way
 * back from an offset in that text to the cell it came from.
 *
 * xterm hands a link provider one buffer row at a time, but a path long enough
 * to wrap occupies several, so a provider that reads a single row sees half a
 * path and matches nothing. Stitching the wrapped rows back together is the job
 * here, and mapping an offset in the stitched string back to a `{x, y}` cell is
 * the other half - get that wrong and the underline lands on the wrong
 * characters.
 *
 * Both algorithms are adapted from `LinkComputer` in `@xterm/addon-web-links`
 * (MIT).
 *
 * {@link readLogicalLine} is the second reader, for URLs: it also joins rows a
 * program wrapped by hand, which takes a guess that paths are not put through.
 *
 * The buffer is reached through a narrow `BufferReader` rather than xterm's
 * `Terminal`, which is what lets the tests drive this with a plain object.
 */

export type BufferReader = {
  getLine(index: number): IBufferLine | undefined;
  getNullCell(): IBufferCell;
};

/** Cap on how far to expand in each direction. */
const MAX_STITCH_CHARS = 2048;

export type StitchedLine = {
  /** The wrapped rows joined into one logical line. */
  text: string;
  /** Buffer index of the first row, which offsets in `text` are measured from. */
  startRow: number;
};

/**
 * Join the wrapped rows around `row` into one logical line.
 *
 * Expansion upward only happens when the row is itself a continuation, and stops
 * at the first row that is not wrapped or that contains a space - a space means
 * the token ended there, so nothing beyond it can be part of this path. Rows are
 * read with `trimRight`, which is what lets a path wrapped right at the edge of
 * a wide character still match; the cost is that offsets in the joined string no
 * longer line up cell-for-cell, which is why {@link mapOffsetToCell} walks cells
 * rather than doing arithmetic.
 */
export function stitchWrappedLine(buffer: BufferReader, row: number): StitchedLine | null {
  const current = buffer.getLine(row);
  if (!current) return null;

  const currentText = current.translateToString(true);
  const lines: string[] = [];
  let topRow = row;

  if (current.isWrapped && !currentText.startsWith(' ')) {
    let length = 0;
    let cursor = row;
    let line = buffer.getLine(--cursor);
    while (line && length < MAX_STITCH_CHARS) {
      const content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      topRow = cursor;
      if (!line.isWrapped || content.includes(' ')) break;
      line = buffer.getLine(--cursor);
    }
    lines.reverse();
  }

  lines.push(currentText);

  let length = 0;
  let cursor = row;
  let line = buffer.getLine(++cursor);
  while (line?.isWrapped && length < MAX_STITCH_CHARS) {
    const content = line.translateToString(true);
    length += content.length;
    lines.push(content);
    if (content.includes(' ')) break;
    line = buffer.getLine(++cursor);
  }

  return { text: lines.join(''), startRow: topRow };
}

/**
 * Find the cell holding the character at `offset` in a stitched line.
 *
 * Walks cells accumulating their character counts, because a cell is not a
 * character: a wide glyph occupies two cells, a combining mark makes one cell
 * several characters, and `trimRight` above dropped trailing blanks entirely.
 * Returns null when the walk runs off the end of the buffer.
 *
 * The `x`/`y` returned are 0-based buffer coordinates.
 */
export function mapOffsetToCell(
  buffer: BufferReader,
  startRow: number,
  startCol: number,
  offset: number
): { x: number; y: number } | null {
  const cell = buffer.getNullCell();
  let remaining = offset;
  let row = startRow;
  let col = startCol;

  while (remaining >= 0) {
    const line = buffer.getLine(row);
    if (!line) return null;

    for (let i = col; i < line.length; i++) {
      line.getCell(i, cell);
      const width = cell.getWidth();
      if (width !== 0) {
        if (remaining === 0) return { x: i, y: row };
        remaining -= cell.getChars().length || 1;

        // A wide character that did not fit at the end of a row is pushed whole
        // onto the next one, leaving this last cell blank with width 1. The
        // blank is not in the trimmed string, so the count has to be given back.
        if (i === line.length - 1 && cell.getChars() === '') {
          const next = buffer.getLine(row + 1);
          if (next?.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) remaining += 1;
          }
        }

        if (remaining < 0) return { x: i, y: row };
      }
    }

    row++;
    col = 0;
  }

  return null;
}

/**
 * Cap on how far {@link readLogicalLine} reads in each direction. Far above the
 * stitch cap, because the text this exists for is a URL carrying a token, and
 * those run to several thousand characters.
 */
const MAX_LOGICAL_CHARS = 8192;

/**
 * How many cells short of the right edge a row may stop and still count as
 * having been wrapped there. Programs that wrap their own output keep a cell or
 * two of margin rather than writing into the last column.
 *
 * Only granted when the next row is indented, which is how those programs mark
 * a continuation. Without that sign the row has to fill the last column, or a
 * line of shell output that merely ended near the edge would swallow the start
 * of the line after it.
 */
const WRAP_EDGE_TOLERANCE = 2;

/** One row's share of a {@link LogicalLine}. */
type LogicalSegment = {
  row: number;
  /** Leading characters of the row left out of the text: its indentation. */
  skip: number;
  /** Where this row's text starts in the logical line. */
  offset: number;
  length: number;
  /** True when the terminal itself wrapped the row above into this one. */
  soft: boolean;
};

export type LogicalLine = {
  text: string;
  segments: LogicalSegment[];
};

type RowJoin = 'soft' | 'hard';

function reachesWrapEdge(buffer: BufferReader, line: IBufferLine, tolerance: number): boolean {
  const cell = buffer.getNullCell();
  for (let i = line.length - 1; i >= 0 && i >= line.length - 1 - tolerance; i--) {
    line.getCell(i, cell);
    // Width 0 is the trailing half of a full-width glyph, which is content.
    if (cell.getWidth() === 0 || cell.getChars().trim() !== '') return true;
  }
  return false;
}

/**
 * Whether `lower` carries on the text of `upper`, the row directly above it.
 *
 * `soft` is the terminal's own wrap. `hard` is a guess about a program that
 * wraps its output itself, as Claude Code and most TUIs do: it writes a real
 * newline and usually an indent, so the terminal sees two unrelated rows. A row
 * that runs to the right edge and is followed by more text is read as one of
 * those. The guess is wrong when a token happens to end exactly at the edge,
 * which glues the first word of the next row onto it.
 */
function rowJoin(buffer: BufferReader, upper: IBufferLine, lower: IBufferLine): RowJoin | null {
  if (lower.isWrapped) return 'soft';
  const lowerText = lower.translateToString(true);
  if (lowerText.trim() === '') return null;
  const tolerance = /^\s/.test(lowerText) ? WRAP_EDGE_TOLERANCE : 0;
  return reachesWrapEdge(buffer, upper, tolerance) ? 'hard' : null;
}

/**
 * Join the rows around `row` into the line of text they were before anything
 * wrapped it, whether the terminal did the wrapping or the program did.
 *
 * Like {@link stitchWrappedLine}, reading stops one row past the first
 * whitespace in each direction, since no token reaches across it. Unlike it,
 * the rows cannot be mapped back with one walk from the top - a hard-wrapped
 * row has indentation that is not in the text - so each row's share is recorded
 * and {@link mapLogicalOffsetToCell} goes through that.
 *
 * Paths stay on the strict soft-wrap join: a guessed-at path would be checked
 * against the filesystem, and a wrong guess there opens the wrong file.
 */
export function readLogicalLine(buffer: BufferReader, row: number): LogicalLine | null {
  if (!buffer.getLine(row)) return null;

  // The join between each row and the one above it, keyed by the lower row.
  const joins = new Map<number, RowJoin>();

  const extend = (from: number, step: -1 | 1): number => {
    let edge = from;
    let length = 0;
    while (length < MAX_LOGICAL_CHARS) {
      const next = edge + step;
      const upper = buffer.getLine(Math.min(edge, next));
      const lower = buffer.getLine(Math.max(edge, next));
      if (!upper || !lower) break;
      const join = rowJoin(buffer, upper, lower);
      if (!join) break;
      joins.set(Math.max(edge, next), join);
      edge = next;
      const added = (step === -1 ? upper : lower).translateToString(true).trim();
      length += added.length;
      if (/\s/.test(added)) break;
    }
    return edge;
  };

  const top = extend(row, -1);
  const bottom = extend(row, 1);

  const segments: LogicalSegment[] = [];
  let text = '';
  for (let r = top; r <= bottom; r++) {
    const raw = buffer.getLine(r)?.translateToString(true) ?? '';
    // `trimRight` only drops cells nothing was written to. A TUI that paints a
    // panel pads each row out with real spaces, and those would otherwise sit
    // in the middle of whatever it hard-wrapped. A soft wrap keeps them: there
    // a space at the edge is one the program printed between two words.
    const rowText = joins.get(r + 1) === 'soft' ? raw : raw.trimEnd();
    const join = joins.get(r);
    const skip = join === 'hard' ? rowText.length - rowText.trimStart().length : 0;
    segments.push({
      row: r,
      skip,
      offset: text.length,
      length: rowText.length - skip,
      soft: join === 'soft'
    });
    text += rowText.slice(skip);
  }

  return { text, segments };
}

/** Find the cell holding the character at `offset` in a logical line. */
export function mapLogicalOffsetToCell(
  buffer: BufferReader,
  logical: LogicalLine,
  offset: number
): { x: number; y: number } | null {
  const segment = logical.segments.find((s) => offset >= s.offset && offset < s.offset + s.length);
  if (!segment) return null;
  return mapOffsetToCell(buffer, segment.row, 0, segment.skip + offset - segment.offset);
}
