import type { IBufferCell, IBufferLine } from '@xterm/xterm';
import type { BufferReader } from '../terminal-buffer-text';

/**
 * A buffer built from strings, one per row, a leading `|` marking a row as a
 * continuation of the one above - not `~`, which begins a real path. Cells are one character wide unless the string carries a
 * full-width character, which is modelled the way xterm does it: the glyph in
 * the first cell, a zero-width cell after it.
 */
export function buffer(rows: string[]): BufferReader {
  const parsed = rows.map((row) => ({
    wrapped: row.startsWith('|'),
    text: row.startsWith('|') ? row.slice(1) : row
  }));

  function cells(text: string): string[] {
    const out: string[] = [];
    for (const ch of text) {
      out.push(ch);
      // Anything above the BMP-ish CJK start is treated as double width here,
      // which is all these tests need from wcwidth.
      if (ch.codePointAt(0)! >= 0x1100) out.push('');
    }
    return out;
  }

  function line(index: number): IBufferLine | undefined {
    // `at` would wrap a negative index round to the last row; xterm has no row there.
    const row = index < 0 ? undefined : parsed.at(index);
    if (!row) return undefined;
    const rowCells = cells(row.text);
    return {
      isWrapped: row.wrapped,
      length: rowCells.length,
      translateToString: (trimRight?: boolean) =>
        trimRight === true ? row.text.replace(/\s+$/, '') : row.text,
      getCell: (x: number, cell?: IBufferCell) => {
        const chars = rowCells.at(x);
        if (chars === undefined) return undefined;
        const target = cell as unknown as { _chars: string };
        target._chars = chars;
        return cell;
      }
    } as unknown as IBufferLine;
  }

  return {
    getLine: line,
    getNullCell: () => {
      const cell = {
        _chars: '',
        getChars: () => cell._chars,
        // Zero-width marks the trailing half of a full-width glyph; everything
        // else is one cell wide, matching `cells` above.
        getWidth: () => (cell._chars === '' ? 0 : cell._chars.codePointAt(0)! >= 0x1100 ? 2 : 1)
      };
      return cell as unknown as IBufferCell;
    }
  };
}
