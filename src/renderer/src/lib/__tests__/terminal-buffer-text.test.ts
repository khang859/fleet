import { describe, it, expect } from 'vitest';
import {
  stitchWrappedLine,
  mapOffsetToCell,
  readLogicalLine,
  mapLogicalOffsetToCell,
  type BufferReader
} from '../terminal-buffer-text';
import { buffer } from './fake-buffer';

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

/** Rows of a pane `cols` wide: each is padded out, as a real buffer row is. */
function pane(cols: number, rows: string[]): ReturnType<typeof buffer> {
  return buffer(
    rows.map((row) => (row.startsWith('|') ? '|' + row.slice(1).padEnd(cols) : row.padEnd(cols)))
  );
}

describe('readLogicalLine', () => {
  it('returns a lone row as-is', () => {
    const b = pane(20, ['hello world']);
    expect(readLogicalLine(b, 0)?.text).toBe('hello world');
  });

  it('returns null for a row that does not exist', () => {
    expect(readLogicalLine(pane(10, ['a']), 3)).toBeNull();
  });

  it('joins soft-wrapped rows from any of them', () => {
    const b = pane(10, ['see abcdef', '|ghijklmnop', '|qrs tail']);
    for (const row of [0, 1, 2]) {
      expect(readLogicalLine(b, row)?.text).toBe('see abcdefghijklmnopqrs tail');
    }
  });

  it('joins a hard-wrapped row that ran to the edge, dropping the indent', () => {
    const b = pane(10, ['go abcdefg', '  hijklmno', '  pq', 'next']);
    for (const row of [0, 1, 2]) {
      expect(readLogicalLine(b, row)?.text).toBe('go abcdefghijklmnopq');
    }
    expect(readLogicalLine(b, 3)?.text).toBe('next');
  });

  it('joins rows a TUI padded out with real spaces', () => {
    const b = pane(10, ['go abcdefg', '  hijklmn', '  op']);
    // xterm trims only cells that were never written, so painted padding stays.
    const painted: BufferReader = {
      ...b,
      getLine: (i) => {
        const line = b.getLine(i);
        return line && { ...line, translateToString: () => line.translateToString(false) };
      }
    };
    expect(readLogicalLine(painted, 1)?.text).toBe('go abcdefghijklmnop');
  });

  it('allows a row to stop a couple of cells short of the edge when the next is indented', () => {
    const b = pane(10, ['abcdefgh', '  ijk']);
    expect(readLogicalLine(b, 0)?.text).toBe('abcdefghijk');
  });

  it('needs a full row to join a next row that is not indented', () => {
    expect(readLogicalLine(pane(10, ['abcdefghi', 'jkl']), 0)?.text).toBe('abcdefghi');
    expect(readLogicalLine(pane(10, ['abcdefghij', 'klm']), 0)?.text).toBe('abcdefghijklm');
  });

  it('does not join a row that stopped well short of the edge', () => {
    const b = pane(10, ['abcdefg', 'hij']);
    expect(readLogicalLine(b, 0)?.text).toBe('abcdefg');
    expect(readLogicalLine(b, 1)?.text).toBe('hij');
  });

  it('does not join across a blank row', () => {
    const b = pane(10, ['abcdefghij', '', 'klm']);
    expect(readLogicalLine(b, 0)?.text).toBe('abcdefghij');
  });

  it('stops one row past whitespace in each direction', () => {
    const b = pane(10, ['aaaaaaaaaa', 'bbbb ccccc', 'dddddddddd', 'eeee fffff', 'gggggggggg']);
    expect(readLogicalLine(b, 2)?.text).toBe('bbbb cccccddddddddddeeee fffff');
  });

  it('reads a token longer than the stitch cap', () => {
    const rows = Array.from({ length: 60 }, () => 'x'.repeat(100));
    expect(readLogicalLine(pane(100, rows), 0)?.text).toHaveLength(6000);
  });
});

describe('mapLogicalOffsetToCell', () => {
  it('skips the indentation of a hard-wrapped row', () => {
    const b = pane(10, ['go abcdefg', '  hijklmno', '  pq']);
    const logical = readLogicalLine(b, 0)!;
    expect(mapLogicalOffsetToCell(b, logical, 3)).toEqual({ x: 3, y: 0 });
    expect(mapLogicalOffsetToCell(b, logical, 10)).toEqual({ x: 2, y: 1 });
    expect(mapLogicalOffsetToCell(b, logical, 19)).toEqual({ x: 3, y: 2 });
  });

  it('returns null past the end of the text', () => {
    const b = pane(10, ['abc']);
    expect(mapLogicalOffsetToCell(b, readLogicalLine(b, 0)!, 3)).toBeNull();
  });
});
