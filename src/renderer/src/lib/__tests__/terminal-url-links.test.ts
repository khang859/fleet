import { describe, it, expect } from 'vitest';
import type { ILink } from '@xterm/xterm';
import { clickOpensUrl, createUrlLinkProvider } from '../terminal-url-links';
import { buffer } from './fake-buffer';

/** The links on one 0-based row of a pane `cols` wide, and what activating opened. */
function links(cols: number, rows: string[], row: number): { links: ILink[]; opened: string[] } {
  const opened: string[] = [];
  const padded = rows.map((r) =>
    r.startsWith('|') ? '|' + r.slice(1).padEnd(cols) : r.padEnd(cols)
  );
  const provider = createUrlLinkProvider(() => buffer(padded), {
    activate: (_event, url) => opened.push(url),
    hover: () => {},
    leave: () => {}
  });
  let found: ILink[] = [];
  provider.provideLinks(row + 1, (result) => {
    found = result ?? [];
  });
  return { links: found, opened };
}

const range = (sx: number, sy: number, ex: number, ey: number): ILink['range'] => ({
  start: { x: sx, y: sy },
  end: { x: ex, y: ey }
});

describe('createUrlLinkProvider', () => {
  it('links a URL on one row, without its trailing full stop', () => {
    const { links: found } = links(40, ['see https://example.com/a.'], 0);
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe('https://example.com/a');
    expect(found[0].range).toEqual(range(5, 1, 25, 1));
  });

  it('finds nothing on a row with no URL', () => {
    expect(links(40, ['nothing to see'], 0).links).toEqual([]);
  });

  it('links a soft-wrapped URL as one range', () => {
    const rows = ['go https://example.c', '|om/path/that/wraps/a', '|gain done'];
    for (const row of [0, 1, 2]) {
      const { links: found } = links(20, rows, row);
      expect(found).toHaveLength(1);
      expect(found[0].text).toBe('https://example.com/path/that/wraps/again');
      expect(found[0].range).toEqual(range(4, 1, 4, 3));
    }
  });

  it('links every row of a hard-wrapped URL, leaving the indent out', () => {
    const rows = ['go https://example.c', '  om/path/that/wraps', '  /again', 'next line'];
    const ranges = [range(4, 1, 20, 1), range(3, 2, 20, 2), range(3, 3, 8, 3)];
    for (const row of [0, 1, 2]) {
      // One link, on the row asked about: xterm would discard the others as
      // overlapping it.
      const { links: found } = links(20, rows, row);
      expect(found.map((l) => l.text)).toEqual(['https://example.com/path/that/wraps/again']);
      expect(found.map((l) => l.range)).toEqual([ranges[row]]);
    }
  });

  it('covers both cells of a full-width last character', () => {
    const { links: found } = links(40, ['https://example.com/日本'], 0);
    expect(found[0].text).toBe('https://example.com/日本');
    expect(found[0].range).toEqual(range(1, 1, 24, 1));
  });

  it('does not glue the next line onto a URL that stopped short of the edge', () => {
    const { links: found } = links(40, ['https://example.com/a', 'word'], 0);
    expect(found.map((l) => l.text)).toEqual(['https://example.com/a']);
  });

  it('opens the whole URL from any stretch', () => {
    const rows = ['go https://example.c', '  om/x?token=abc.def'];
    const { links: found, opened } = links(20, rows, 1);
    found[0].activate({} as MouseEvent, found[0].text);
    expect(opened).toEqual(['https://example.com/x?token=abc.def']);
  });
});

describe('clickOpensUrl', () => {
  const plain = { metaKey: false, ctrlKey: false };
  const on = { plainClickOpens: true, hasSelection: false };
  const off = { plainClickOpens: false, hasSelection: false };

  it('opens on Cmd+click and Ctrl+click whatever the setting', () => {
    expect(clickOpensUrl({ metaKey: true, ctrlKey: false }, off)).toBe(true);
    expect(clickOpensUrl({ metaKey: false, ctrlKey: true }, off)).toBe(true);
  });

  it('ignores a plain click until the setting is on', () => {
    expect(clickOpensUrl(plain, off)).toBe(false);
    expect(clickOpensUrl(plain, on)).toBe(true);
  });

  it('ignores the plain click that ends a drag selection', () => {
    expect(clickOpensUrl(plain, { plainClickOpens: true, hasSelection: true })).toBe(false);
  });

  it('still opens on a modifier click made with text selected', () => {
    const selected = { plainClickOpens: false, hasSelection: true };
    expect(clickOpensUrl({ metaKey: false, ctrlKey: true }, selected)).toBe(true);
  });
});
