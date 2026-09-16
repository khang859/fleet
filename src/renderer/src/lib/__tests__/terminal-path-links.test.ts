import { describe, it, expect, vi } from 'vitest';
import type { ILink, IBufferCell, IBufferLine } from '@xterm/xterm';
import type { PathContext } from '../../../../shared/shell-profiles';
import {
  PathLinkProvider,
  actionForDetectedPath,
  type DetectedPath,
  type DirListing,
  type PathLinkDeps,
  type StatResult
} from '../terminal-path-links';
import type { BufferReader } from '../terminal-buffer-text';

/**
 * Single-width ASCII rows; a leading `|` marks a continuation. Enough for these
 * tests. The marker is deliberately not `~`, which begins a real path.
 *
 * Every row is read at the moment it is asked for, never snapshotted, because
 * that is how xterm's buffer behaves - and a test that snapshots cannot catch
 * code that reads the buffer later than it should.
 */
function buffer(rows: string[]): BufferReader {
  return {
    getLine: (i) => {
      const raw = rows.at(i);
      if (raw === undefined) return undefined;
      const row = { wrapped: raw.startsWith('|'), text: raw.startsWith('|') ? raw.slice(1) : raw };
      return {
        isWrapped: row.wrapped,
        length: row.text.length,
        translateToString: () => row.text,
        getCell: (x: number, cell?: IBufferCell) => {
          if (x >= row.text.length) return undefined;
          (cell as unknown as { _chars: string })._chars = row.text[x];
          return cell;
        }
      } as unknown as IBufferLine;
    },
    getNullCell: () => {
      const cell = {
        _chars: '',
        getChars: () => cell._chars,
        getWidth: () => (cell._chars === '' ? 0 : 1)
      };
      return cell as unknown as IBufferCell;
    }
  };
}

type Harness = {
  provider: PathLinkProvider;
  stat: ReturnType<typeof vi.fn>;
  listDir: ReturnType<typeof vi.fn>;
  activated: DetectedPath[];
  links: (row: number) => Promise<ILink[] | undefined>;
};

function harness(
  rows: string[],
  overrides: Partial<PathLinkDeps> & {
    statResult?: StatResult;
    /** Entry names of the pane's cwd. A name ending in `/` is listed as a folder. */
    entries?: string[];
  } = {}
): Harness {
  const activated: DetectedPath[] = [];
  const entries = overrides.entries;
  const listDir = vi.fn(async (): Promise<DirListing | null> => {
    await Promise.resolve();
    if (!entries) return null;
    return {
      names: entries.map((name) => name.replace(/\/$/, '')),
      dirNames: entries.filter((name) => name.endsWith('/')).map((name) => name.slice(0, -1))
    };
  });
  const statResult = overrides.statResult ?? { exists: true, isDirectory: false };
  // A tick of latency, the way the real `stat` crosses IPC - so the provider is
  // exercised against a promise that genuinely settles later.
  const stat = vi.fn(async (): Promise<StatResult> => {
    await Promise.resolve();
    return statResult;
  });

  const deps: PathLinkDeps = {
    getCwd: () => '/home/k/fleet',
    getPathContext: (): PathContext => 'posix',
    getHomes: () => ({ homeDir: '/home/k', wslHomeByDistro: {} }),
    isRemote: () => false,
    statPath: stat as unknown as PathLinkDeps['statPath'],
    // Nothing listed unless a test says so, which is the old behaviour: only
    // tokens carrying a separator can become links.
    listDir: listDir as unknown as PathLinkDeps['listDir'],
    onActivate: (d) => activated.push(d),
    ...overrides
  };

  const provider = new PathLinkProvider(() => buffer(rows), deps);
  return {
    provider,
    stat,
    listDir,
    activated,
    links: async (row) =>
      new Promise((resolve) => {
        provider.provideLinks(row, resolve);
      })
  };
}

function click(link: ILink, mods: Partial<MouseEvent> = { metaKey: true }): void {
  link.activate({ preventDefault() {}, ...mods } as MouseEvent, link.text);
}

describe('PathLinkProvider: what becomes a link', () => {
  it('offers a link for a path that exists', async () => {
    const h = harness(['Read src/main/index.ts']);
    const links = await h.links(1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe('src/main/index.ts');
  });

  it('offers nothing for a path that does not exist', async () => {
    const h = harness(['Read src/nope.ts'], {
      statResult: { exists: false, isDirectory: false }
    });
    expect(await h.links(1)).toBeUndefined();
  });

  it('offers nothing when the line holds no candidate', async () => {
    const h = harness(['all tests passed']);
    expect(await h.links(1)).toBeUndefined();
    expect(h.stat).not.toHaveBeenCalled();
  });

  it('offers nothing for a row that does not exist', async () => {
    const h = harness(['a']);
    expect(await h.links(99)).toBeUndefined();
  });

  it('decorates links with a pointer and an underline', async () => {
    const links = await harness(['src/main/index.ts']).links(1);
    expect(links![0].decorations).toEqual({ pointerCursor: true, underline: true });
  });

  it('finds two links on one line', async () => {
    const links = await harness(['see src/a.ts and src/b.ts here']).links(1);
    expect(links?.map((l) => l.text)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('PathLinkProvider: resolution', () => {
  it('resolves a relative path against the cwd', async () => {
    const h = harness(['src/main/index.ts']);
    const links = await h.links(1);
    click(links![0]);
    expect(h.activated[0].resolvedPath).toBe('/home/k/fleet/src/main/index.ts');
  });

  it('leaves an absolute path alone', async () => {
    const h = harness(['/etc/hosts']);
    click((await h.links(1))![0]);
    expect(h.activated[0].resolvedPath).toBe('/etc/hosts');
  });

  it('expands a home-relative path', async () => {
    const h = harness(['~/notes/todo.md']);
    click((await h.links(1))![0]);
    expect(h.activated[0].resolvedPath).toBe('/home/k/notes/todo.md');
  });

  it('carries the line and column through to the activation', async () => {
    const h = harness(['src/a.ts:42:7']);
    click((await h.links(1))![0]);
    expect(h.activated[0]).toMatchObject({ line: 42, col: 7 });
  });

  it('reports a directory as one', async () => {
    const h = harness(['src/renderer/'], { statResult: { exists: true, isDirectory: true } });
    click((await h.links(1))![0]);
    expect(h.activated[0].isDirectory).toBe(true);
  });

  it('offers nothing for a relative path when the pane has no cwd yet', async () => {
    const h = harness(['src/a.ts'], { getCwd: () => '' });
    expect(await h.links(1)).toBeUndefined();
    expect(h.stat).not.toHaveBeenCalled();
  });
});

describe('PathLinkProvider: activation is gated', () => {
  it('opens on a meta click', async () => {
    const h = harness(['src/a.ts']);
    click((await h.links(1))![0], { metaKey: true });
    expect(h.activated).toHaveLength(1);
  });

  it('opens on a ctrl click', async () => {
    const h = harness(['src/a.ts']);
    click((await h.links(1))![0], { ctrlKey: true });
    expect(h.activated).toHaveLength(1);
  });

  it('ignores a plain click so selection still works', async () => {
    const h = harness(['src/a.ts']);
    click((await h.links(1))![0], {});
    expect(h.activated).toHaveLength(0);
  });
});

describe('PathLinkProvider: remote panes', () => {
  it('offers nothing and never stats while the pane is remote', async () => {
    const h = harness(['/etc/hosts'], { isRemote: () => true });
    expect(await h.links(1)).toBeUndefined();
    expect(h.stat).not.toHaveBeenCalled();
  });

  it('starts working once the ssh session ends', async () => {
    let remote = true;
    const h = harness(['/etc/hosts'], { isRemote: () => remote });
    expect(await h.links(1)).toBeUndefined();
    remote = false;
    expect(await h.links(1)).toHaveLength(1);
  });
});

describe('PathLinkProvider: the existence cache', () => {
  it('stats a path once across repeated lookups', async () => {
    const h = harness(['src/a.ts']);
    await h.links(1);
    await h.links(1);
    await h.links(1);
    expect(h.stat).toHaveBeenCalledTimes(1);
  });

  it('shares one request between two mentions of the same path on a line', async () => {
    const h = harness(['src/a.ts and src/a.ts again']);
    const links = await h.links(1);
    expect(links).toHaveLength(2);
    expect(h.stat).toHaveBeenCalledTimes(1);
  });

  it('stats each distinct path', async () => {
    const h = harness(['src/a.ts src/b.ts']);
    await h.links(1);
    expect(h.stat).toHaveBeenCalledTimes(2);
  });

  it('re-stats once the entry has gone stale', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(['src/a.ts']);
      await h.links(1);
      expect(h.stat).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      await h.links(1);
      expect(h.stat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a failing stat as a path that does not exist', async () => {
    const h = harness(['src/a.ts'], {
      statPath: async () => {
        await Promise.resolve();
        throw new Error('EACCES');
      }
    });
    expect(await h.links(1)).toBeUndefined();
  });
});

describe('PathLinkProvider: hover tracking for the context menu', () => {
  it('reports nothing before anything is hovered', () => {
    expect(harness(['src/a.ts']).provider.getHovered()).toBeNull();
  });

  it('reports the hovered path', async () => {
    const h = harness(['src/a.ts']);
    const link = (await h.links(1))![0];
    link.hover?.({} as MouseEvent, link.text);
    expect(h.provider.getHovered()?.resolvedPath).toBe('/home/k/fleet/src/a.ts');
  });

  it('clears on leave', async () => {
    const h = harness(['src/a.ts']);
    const link = (await h.links(1))![0];
    link.hover?.({} as MouseEvent, link.text);
    link.leave?.({} as MouseEvent, link.text);
    expect(h.provider.getHovered()).toBeNull();
  });

  it('a stale leave does not clear a newer hover', async () => {
    const h = harness(['src/a.ts src/b.ts']);
    const [first, second] = (await h.links(1))!;
    first.hover?.({} as MouseEvent, first.text);
    second.hover?.({} as MouseEvent, second.text);
    first.leave?.({} as MouseEvent, first.text);
    expect(h.provider.getHovered()?.resolvedPath).toBe('/home/k/fleet/src/b.ts');
  });
});

describe('PathLinkProvider: ranges', () => {
  it('covers exactly the path, not the words around it', async () => {
    // 'Read ' is 5 characters, so the path occupies 1-based columns 6 to 22.
    const links = await harness(['Read src/main/index.ts']).links(1);
    expect(links![0].range).toEqual({ start: { x: 6, y: 1 }, end: { x: 22, y: 1 } });
  });

  it('spans rows for a path broken across a wrap', async () => {
    const h = harness(['/home/k/fleet/src/ma', '|in/index.ts']);
    const links = await h.links(1);
    expect(links).toHaveLength(1);
    expect(links![0].range.start).toEqual({ x: 1, y: 1 });
    expect(links![0].range.end).toEqual({ x: 11, y: 2 });
  });

  it('finds the same wrapped link from either row', async () => {
    const h = harness(['/home/k/fleet/src/ma', '|in/index.ts']);
    const fromFirst = await h.links(1);
    const fromSecond = await h.links(2);
    expect(fromSecond![0].text).toBe(fromFirst![0].text);
    expect(fromSecond![0].range).toEqual(fromFirst![0].range);
  });
});

describe('PathLinkProvider: the buffer moving underfoot', () => {
  /** A `stat` that hangs until the test lets it finish. */
  function heldStat(): { deps: Partial<PathLinkDeps>; settle: () => Promise<void> } {
    let release: (() => void) | undefined;
    return {
      deps: {
        statPath: async () =>
          new Promise<StatResult>((resolve) => {
            release = () => {
              resolve({ exists: true, isDirectory: false });
            };
          })
      },
      // Yields until the provider has actually asked, rather than guessing at a
      // number of microtasks: the work before the `stat` - reading the pane's
      // directory - is itself asynchronous, and how many ticks it takes is not
      // this test's business.
      settle: async () => {
        while (!release) await Promise.resolve();
        release();
      }
    };
  }

  it('offers nothing when the row it scanned was rewritten during the stat', async () => {
    // The case a TUI produces constantly: Claude Code repaints its frame in
    // place, so the cells are still at the same coordinates and still under the
    // pointer - they just hold different text now. Returning the link anyway
    // would underline the replacement and open a file that is no longer on
    // screen.
    const rows = ['ls src/main/index.ts'];
    const { deps, settle } = heldStat();
    const h = harness(rows, deps);

    const pending = h.links(1);
    await Promise.resolve();
    rows[0] = 'ls src/other/thing.ts';
    await settle();

    expect(await pending).toBeUndefined();
  });

  it('offers nothing when the pane scrolled the row away during the stat', async () => {
    // xterm's buffer trims from the front once the scrollback fills, so every
    // absolute row index shifts down while a `stat` is in flight. Whatever now
    // sits at the index that was scanned is not what was measured.
    const rows = ['ls src/main/index.ts'];
    const { deps, settle } = heldStat();
    const h = harness(rows, deps);

    const pending = h.links(1);
    await Promise.resolve();
    rows[0] = 'gone';
    await settle();

    expect(await pending).toBeUndefined();
  });

  it('re-measures the range when a resize reflowed the row during the stat', async () => {
    // The nastiest of the three, because the two cheap checks both pass: a
    // widened pane puts the whole path on one row, so the stitched text is
    // character-for-character what was matched and its start row has not moved.
    // Only the cells it occupies changed. Measuring against the re-read buffer
    // is what catches it - the old range ended on row 2.
    const rows = ['/home/k/fleet/src/ma', '|in/index.ts'];
    const { deps, settle } = heldStat();
    const h = harness(rows, deps);

    const pending = h.links(1);
    await Promise.resolve();
    // Wider pane: the path fits on one row and the continuation is gone.
    rows[0] = '/home/k/fleet/src/main/index.ts';
    rows[1] = 'next command';
    await settle();

    const links = await pending;
    expect(links).toHaveLength(1);
    expect(links![0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 31, y: 1 } });
  });

  it('keeps the range it scanned when the row is untouched', async () => {
    // The other half of the rule, and the reason the geometry is settled before
    // the `stat` rather than after: a quiet pane must still produce a link, with
    // the range measured against the text that was read.
    const rows = ['ls src/main/index.ts'];
    const { deps, settle } = heldStat();
    const h = harness(rows, deps);

    const pending = h.links(1);
    await Promise.resolve();
    await settle();

    const links = await pending;
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe('src/main/index.ts');
    expect(links![0].range).toEqual({ start: { x: 4, y: 1 }, end: { x: 20, y: 1 } });
  });
});

describe('PathLinkProvider: disposal', () => {
  it('offers nothing after being disposed', async () => {
    const h = harness(['src/a.ts']);
    h.provider.dispose();
    expect(await h.links(1)).toBeUndefined();
  });

  it('forgets the hovered path when disposed', async () => {
    const h = harness(['src/a.ts']);
    const link = (await h.links(1))![0];
    link.hover?.({} as MouseEvent, link.text);
    h.provider.dispose();
    expect(h.provider.getHovered()).toBeNull();
  });
});

describe('actionForDetectedPath', () => {
  const detected = (over: Partial<DetectedPath> = {}): DetectedPath => ({
    resolvedPath: '/home/k/fleet/src/a.ts',
    pathContext: 'posix',
    isDirectory: false,
    ...over
  });

  it('opens an ordinary file', () => {
    expect(actionForDetectedPath(detected())).toEqual({ kind: 'open' });
  });

  it('carries a line and column into the open', () => {
    expect(actionForDetectedPath(detected({ line: 42, col: 7 }))).toEqual({
      kind: 'open',
      target: { line: 42, col: 7 }
    });
  });

  it('carries a line without a column', () => {
    expect(actionForDetectedPath(detected({ line: 42 }))).toEqual({
      kind: 'open',
      target: { line: 42 }
    });
  });

  it('reveals a directory rather than opening an empty editor', () => {
    expect(actionForDetectedPath(detected({ isDirectory: true }))).toEqual({ kind: 'reveal' });
  });

  it('reveals a file Fleet refuses to preview', () => {
    expect(actionForDetectedPath(detected({ resolvedPath: '/tmp/build.zip' }))).toEqual({
      kind: 'reveal'
    });
  });
});

describe('PathLinkProvider: bare filenames from the pane directory', () => {
  it('links a name printed by `ls`', async () => {
    const h = harness(['package.json  README.md  src'], { entries: ['package.json', 'src/'] });
    const links = await h.links(1);

    expect(links?.map((l) => l.text)).toEqual(['package.json', 'src']);
    // README.md is not in the listing, so it is not a file here.
    expect(links?.some((l) => l.text === 'README.md')).toBe(false);
  });

  it('costs no stat, because the listing already answered', async () => {
    const h = harness(['package.json  src'], { entries: ['package.json', 'src/'] });
    await h.links(1);

    expect(h.stat).not.toHaveBeenCalled();
  });

  it('takes isDirectory from the listing, so a folder reveals', async () => {
    const h = harness(['src'], { entries: ['src/'] });
    const links = await h.links(1);
    click(links![0]);

    expect(actionForDetectedPath(h.activated[0])).toEqual({ kind: 'reveal' });
    expect(h.activated[0].resolvedPath).toBe('/home/k/fleet/src');
  });

  it('leaves the classify suffix of `ls -F` out of the link', async () => {
    const h = harness(['build.sh*  docs@'], { entries: ['build.sh', 'docs'] });
    const links = await h.links(1);

    expect(links?.map((l) => l.text)).toEqual(['build.sh', 'docs']);
    expect(links?.[0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 8, y: 1 } });
  });

  it('honours a position suffix on a bare name', async () => {
    const h = harness(['README.md:12:5'], { entries: ['README.md'] });
    const links = await h.links(1);
    click(links![0]);

    expect(h.activated[0]).toMatchObject({ line: 12, col: 5 });
    expect(links?.[0].text).toBe('README.md');
  });

  it('matches nothing when the directory is unreadable or too large', async () => {
    const h = harness(['package.json  src/main/index.ts'], { entries: undefined });
    const links = await h.links(1);

    expect(links?.map((l) => l.text)).toEqual(['src/main/index.ts']);
  });

  it('reads the directory once for a screen of output', async () => {
    const h = harness(['package.json', 'package.json', 'package.json'], {
      entries: ['package.json']
    });
    await h.links(1);
    await h.links(2);
    await h.links(3);

    expect(h.listDir).toHaveBeenCalledTimes(1);
  });

  it('stays silent in a remote pane, where the names are the far machine’s', async () => {
    const h = harness(['package.json'], { entries: ['package.json'], isRemote: () => true });

    expect(await h.links(1)).toBeUndefined();
  });
});
