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
 * Both algorithms follow `LinkComputer` in `@xterm/addon-web-links` (MIT), which
 * is the reference implementation. It cannot be imported: the package exports
 * only `WebLinksAddon`, and its `computeLink` filters every match through a URL
 * check, so a file path would never survive it.
 *
 * The buffer is reached through a narrow `BufferReader` rather than xterm's
 * `Terminal`, which is what lets the tests drive this with a plain object.
 */

export type BufferReader = {
  getLine(index: number): IBufferLine | undefined;
  getNullCell(): IBufferCell;
};

/** Matches the cap `@xterm/addon-web-links` uses when expanding in each direction. */
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
