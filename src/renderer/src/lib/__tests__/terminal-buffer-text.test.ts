import { describe, it, expect } from 'vitest';
import type { IBufferCell, IBufferLine } from '@xterm/xterm';
import { stitchWrappedLine, mapOffsetToCell, type BufferReader } from '../terminal-buffer-text';

/**
 * A buffer built from strings, one per row, a leading `|` marking a row as a
 * continuation of the one above - not `~`, which begins a real path. Cells are one character wide unless the string carries a
 * full-width character, which is modelled the way xterm does it: the glyph in
 * the first cell, a zero-width cell after it.
 */
function buffer(rows: string[]): BufferReader {
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
    const row = parsed.at(index);
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

describe('stitchWrappedLine', () => {
  it('returns a single unwrapped row as-is', () => {
    const b = buffer(['hello world']);
    expect(stitchWrappedLine(b, 0)).toEqual({ text: 'hello world', startRow: 0 });
  });

  it('returns null for a row that does not exist', () => {
    expect(stitchWrappedLine(buffer(['a']), 5)).toBeNull();
  });

  it('joins a continuation row onto the row above when asked for the first row', () => {
    const b = buffer(['/home/knguyen/Development/fl', '|eet/src/preload/copilot.ts']);
    expect(stitchWrappedLine(b, 0)).toEqual({
      text: '/home/knguyen/Development/fleet/src/preload/copilot.ts',
      startRow: 0
    });
  });

  it('joins the same group when asked for the continuation row', () => {
    const b = buffer(['/home/knguyen/Development/fl', '|eet/src/preload/copilot.ts']);
    expect(stitchWrappedLine(b, 1)).toEqual({
      text: '/home/knguyen/Development/fleet/src/preload/copilot.ts',
      startRow: 0
    });
  });

  it('joins three rows and reports the topmost as the start', () => {
    const b = buffer(['aaa', '|bbb', '|ccc']);
    expect(stitchWrappedLine(b, 2)).toEqual({ text: 'aaabbbccc', startRow: 0 });
  });

  it('does not reach above an unwrapped row', () => {
    const b = buffer(['unrelated', 'aaa', '|bbb']);
    expect(stitchWrappedLine(b, 2)).toEqual({ text: 'aaabbb', startRow: 1 });
  });

  it('does not reach below into a row that is not a continuation', () => {
    const b = buffer(['aaa', 'unrelated']);
    expect(stitchWrappedLine(b, 0)).toEqual({ text: 'aaa', startRow: 0 });
  });

  it('stops expanding upward at a row containing a space', () => {
    // The space ends the token, so nothing above it can belong to this path.
    const b = buffer(['x /start', '|middle', '|end']);
    const result = stitchWrappedLine(b, 2);
    expect(result?.text).toBe('x /startmiddleend');
    expect(result?.startRow).toBe(0);
  });

  it('does not expand upward when the current row starts with a space', () => {
    const b = buffer(['aaa', '| bbb']);
    expect(stitchWrappedLine(b, 1)).toEqual({ text: ' bbb', startRow: 1 });
  });

  it('stops expanding downward after a continuation row containing a space', () => {
    const b = buffer(['aaa', '|bbb ccc', '|ddd']);
    expect(stitchWrappedLine(b, 0)).toEqual({ text: 'aaabbb ccc', startRow: 0 });
  });
});

describe('mapOffsetToCell', () => {
  it('maps an offset within a single row', () => {
    const b = buffer(['/etc/hosts']);
    expect(mapOffsetToCell(b, 0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(mapOffsetToCell(b, 0, 0, 5)).toEqual({ x: 5, y: 0 });
  });

  it('maps an offset that falls on a later row of a wrapped group', () => {
    const b = buffer(['abcde', '|fghij']);
    // Offset 7 is 'h': third character of the second row.
    expect(mapOffsetToCell(b, 0, 0, 7)).toEqual({ x: 2, y: 1 });
  });

  it('maps the first character of a continuation row', () => {
    const b = buffer(['abcde', '|fghij']);
    expect(mapOffsetToCell(b, 0, 0, 5)).toEqual({ x: 0, y: 1 });
  });

  it('accounts for a full-width character occupying two cells', () => {
    // '漢' takes two cells, so the 'b' after it sits at cell 3, not 2.
    const b = buffer(['a漢b']);
    expect(mapOffsetToCell(b, 0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(mapOffsetToCell(b, 0, 0, 1)).toEqual({ x: 1, y: 0 });
    expect(mapOffsetToCell(b, 0, 0, 2)).toEqual({ x: 3, y: 0 });
  });

  it('returns null when the offset runs past the end of the buffer', () => {
    expect(mapOffsetToCell(buffer(['abc']), 0, 0, 99)).toBeNull();
  });

  it('can start from a non-zero column', () => {
    const b = buffer(['abcdef']);
    expect(mapOffsetToCell(b, 0, 2, 0)).toEqual({ x: 2, y: 0 });
    expect(mapOffsetToCell(b, 0, 2, 3)).toEqual({ x: 5, y: 0 });
  });

  it('round-trips every offset of a wrapped path back to a distinct cell', () => {
    const b = buffer(['/home/kng/Devel', '|opment/fleet/a.ts']);
    const { text } = stitchWrappedLine(b, 0)!;
    const seen = new Set<string>();
    for (let i = 0; i < text.length; i++) {
      const cell = mapOffsetToCell(b, 0, 0, i);
      expect(cell).not.toBeNull();
      const key = `${cell!.y}:${cell!.x}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
