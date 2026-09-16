import type { ILink, ILinkProvider } from '@xterm/xterm';
import type { PathContext } from '../../../shared/shell-profiles';
import { findCandidatePaths } from '../../../shared/terminal-path-detect';
import { expandHome, resolveAgainstCwd } from '../../../shared/path-platform';
import { isBinaryBlockedFilePath } from '../../../shared/file-open';
import type { FileOpenTarget } from '../../../shared/types';
import { mapOffsetToCell, stitchWrappedLine, type BufferReader } from './terminal-buffer-text';

/**
 * Turning path-shaped text in a terminal into something clickable.
 *
 * The shape of the work is set by xterm: it asks for the links on one buffer row
 * whenever the mouse moves onto that row, and takes the answer through a
 * callback, so the existence check can be asynchronous. That matters, because
 * whether a candidate is a real file is the only reliable way to tell a path
 * from a word that happens to contain a slash - the detector is deliberately
 * generous and this is what makes it precise.
 *
 * Everything that varies is injected. The provider never reaches into a store or
 * `window.fleet`, which is what lets the tests drive it with a plain object and
 * keeps the per-pane state honest: one provider per terminal, disposed with it.
 */

export type DetectedPath = {
  /** Absolute, in the pane's own coordinate system. */
  resolvedPath: string;
  pathContext: PathContext;
  isDirectory: boolean;
  /** 1-based, as printed, when the text carried a position. */
  line?: number;
  col?: number;
};

export type StatResult = { exists: boolean; isDirectory: boolean };

/** The entry names of one directory, in the order-free form the matching wants. */
export type DirListing = { names: string[]; dirNames: string[] };

/**
 * Cap on the directory a pane will read to match bare names.
 *
 * Above this the pane is sitting in something like `node_modules` or
 * `/usr/bin`, where reading the whole listing every few seconds is real work and
 * a bare token matching one of ten thousand names is mostly noise. Paths that
 * carry a separator are unaffected there.
 */
export const MAX_DIR_ENTRIES = 5_000;

export type PathLinkDeps = {
  /** The pane's live working directory, which relative paths resolve against. */
  getCwd(): string;
  getPathContext(): PathContext;
  getHomes(): { homeDir: string; wslHomeByDistro: Record<string, string> };
  /** True while the pane's foreground process is ssh or mosh. */
  isRemote(): boolean;
  statPath(path: string, ctx: PathContext): Promise<StatResult>;
  /**
   * Entry names of one directory, single level. `null` turns bare-name matching
   * off for that directory: unreadable, or too large to be worth listing.
   */
  listDir(dir: string, ctx: PathContext): Promise<DirListing | null>;
  /** Cmd/Ctrl+click. Plain clicks never reach this. */
  onActivate(detected: DetectedPath): void;
};

/**
 * How long a `stat` answer is trusted.
 *
 * Short, because the interesting direction is a file that did not exist when it
 * was first printed and does now - an agent naming a file a beat before writing
 * it. Caching that "missing" for the life of the pane would leave it permanently
 * dead. Hovering is rare enough that re-checking costs nothing noticeable.
 */
const STAT_TTL_MS = 3_000;

/**
 * Cap on remembered paths. Entries are keyed by resolved absolute path, so a
 * chatty agent reprinting the same handful of files stays far below this; the
 * cap is only here so a pane running for days cannot grow without limit.
 */
const CACHE_CAP = 500;

/**
 * An answer held for {@link STAT_TTL_MS}, with one request in flight per key.
 *
 * Two things are cached against this - whether a path exists, and what a
 * directory holds - and they want exactly the same treatment, so the treatment
 * lives here once rather than twice inside the provider.
 *
 * `fetch` is expected to have swallowed its own failures: a rejection would be
 * remembered as nothing and retried on every hover.
 */
class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private closed = false;

  async get(key: string, fetch: () => Promise<T>): Promise<T> {
    const fresh = this.entries.get(key);
    if (fresh && Date.now() - fresh.at < STAT_TTL_MS) return fresh.value;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const request = fetch().then((value) => {
      this.inFlight.delete(key);
      // A pane closed while its answer was in flight has nothing to remember.
      if (this.closed) return value;
      // Re-inserting moves the key to the end of the Map's order, which is what
      // makes the eviction below oldest-first.
      this.entries.delete(key);
      this.entries.set(key, { value, at: Date.now() });
      if (this.entries.size > CACHE_CAP) {
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
      return value;
    });

    this.inFlight.set(key, request);
    return request;
  }

  dispose(): void {
    this.closed = true;
    this.entries.clear();
    this.inFlight.clear();
  }
}

/** The listing, as the matching wants it: two sets, built once per read. */
type ListingSets = { names: Set<string>; dirNames: Set<string> } | null;

export class PathLinkProvider implements ILinkProvider {
  private readonly stats = new TtlCache<StatResult>();
  private readonly listings = new TtlCache<ListingSets>();
  private hovered: DetectedPath | null = null;
  private disposed = false;

  constructor(
    private readonly getBuffer: () => BufferReader,
    private readonly deps: PathLinkDeps
  ) {}

  /**
   * xterm asks per row, 1-based. A path long enough to wrap spans several rows,
   * so the row is first stitched back into one logical line - otherwise half a
   * path is all that is ever seen, and half a path matches nothing.
   */
  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    void this.computeLinks(bufferLineNumber).then(callback);
  }

  /** The work behind {@link provideLinks}, in a form that can simply await. */
  private async computeLinks(bufferLineNumber: number): Promise<ILink[] | undefined> {
    // A path printed inside an ssh session names a file on the far machine. The
    // local filesystem may well have something at the same place, and opening
    // that instead would be wrong in the quiet way that is worst: a real file,
    // just not the one on screen.
    if (this.disposed || this.deps.isRemote()) return undefined;

    const stitched = stitchWrappedLine(this.getBuffer(), bufferLineNumber - 1);
    if (!stitched) return undefined;

    const cwd = this.deps.getCwd();
    const ctx = this.deps.getPathContext();
    const homes = this.deps.getHomes();

    // Asked for before the line is even scanned, because whether a bare token
    // like `package.json` is a filename is a question only the listing can
    // answer. Cached, so a pointer crossing a screen of `ls` output costs one
    // directory read rather than one per row.
    const listing = await this.listingCached(cwd, ctx);
    if (this.isDisposed()) return undefined;

    const candidates = findCandidatePaths(stitched.text, listing?.names);
    if (candidates.length === 0) return undefined;

    // Resolving a candidate touches no buffer, so it is safe to do now: the
    // filesystem question is asked for every viable path at once.
    const located = candidates.flatMap((candidate) => {
      const resolved = resolveAgainstCwd(expandHome(candidate.text, ctx, homes), cwd, ctx);
      if (!resolved) return [];
      return [{ candidate, resolved }];
    });

    if (located.length === 0) return undefined;

    const results = await Promise.all(
      located.map(async ({ candidate, resolved }) => {
        // A bare candidate was matched against the listing, which is a stronger
        // answer than a `stat` would be and already says what kind of thing it
        // is. Asking the filesystem again would be the probe per token this
        // whole approach exists to avoid.
        if (candidate.bare) {
          const isDirectory = listing?.dirNames.has(candidate.text) ?? false;
          return { candidate, resolved, stat: { exists: true, isDirectory } };
        }
        const stat = await this.statCached(resolved, ctx);
        if (!stat.exists) return null;
        return { candidate, resolved, stat };
      })
    );

    if (this.isDisposed()) return undefined;

    // The buffer is live, and nothing read before the `stat` can be assumed to
    // still be true. Two different things can have happened while it was in
    // flight:
    //
    //   - the row was rewritten, by a TUI repainting in place (most of what
    //     Claude Code does) or by the scrollback trimming and shifting every
    //     absolute index down. The text that was matched is simply not there.
    //   - the pane was resized, reflowing a wrapped path across a different
    //     number of rows. The text is unchanged and so is its start row, but
    //     every cell it occupies has moved.
    //
    // So the row is re-read and required to be identical, and the ranges are
    // then measured against that re-read buffer rather than the one scanned
    // earlier. Checking the text alone would let the resize case through with
    // stale coordinates; measuring without checking would put ranges on text
    // that is no longer the path.
    const buffer = this.getBuffer();
    const current = stitchWrappedLine(buffer, bufferLineNumber - 1);
    if (current?.text !== stitched.text || current.startRow !== stitched.startRow) {
      return undefined;
    }

    const links = results.flatMap((result) => {
      if (!result) return [];
      const { candidate, resolved, stat } = result;
      const range = this.rangeFor(buffer, current.startRow, candidate.index, candidate.text);
      if (!range) return [];

      const detected: DetectedPath = {
        resolvedPath: resolved,
        pathContext: ctx,
        isDirectory: stat.isDirectory,
        ...(candidate.line !== undefined ? { line: candidate.line } : {}),
        ...(candidate.col !== undefined ? { col: candidate.col } : {})
      };

      const link: ILink = {
        range,
        text: candidate.text,
        decorations: { pointerCursor: true, underline: true },
        // Gated the way the URL links already are, so a plain click still
        // places the cursor and drags still select.
        activate: (event) => {
          if (!event.metaKey && !event.ctrlKey) return;
          this.deps.onActivate(detected);
        },
        hover: () => {
          this.hovered = detected;
        },
        leave: () => {
          if (this.hovered === detected) this.hovered = null;
        }
      };
      return [link];
    });

    return links.length > 0 ? links : undefined;
  }

  /**
   * The path the mouse is currently over, for the right-click menu.
   *
   * xterm offers no way to ask what link sits at a pixel, and its hover callback
   * is the intended substitute. A right-click is preceded by a move to that
   * spot, so this is current when the menu opens; a right-click somewhere the
   * mouse never travelled simply finds nothing, and the menu omits the path
   * items rather than guessing.
   */
  getHovered(): DetectedPath | null {
    return this.hovered;
  }

  /** Read through a call, so a check after an `await` is not narrowed to dead code. */
  private isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.stats.dispose();
    this.listings.dispose();
    this.hovered = null;
  }

  /**
   * Existence, remembered. Concurrent lookups of the same path share one
   * request, so a line naming the same file three times costs one `stat`.
   */
  private async statCached(path: string, ctx: PathContext): Promise<StatResult> {
    return this.stats.get(path, async () =>
      this.deps.statPath(path, ctx).catch(() => ({ exists: false, isDirectory: false }))
    );
  }

  /**
   * What a directory holds, remembered on the same terms.
   *
   * Built into sets once per read rather than per row, because the caller asks
   * this question on every hover and answers it with `has`.
   */
  private async listingCached(dir: string, ctx: PathContext): Promise<ListingSets> {
    return this.listings.get(dir, async () =>
      this.deps
        .listDir(dir, ctx)
        .catch(() => null)
        .then((listing) =>
          listing === null
            ? null
            : { names: new Set(listing.names), dirNames: new Set(listing.dirNames) }
        )
    );
  }

  /**
   * The buffer range xterm underlines, in its 1-based coordinates whose end is
   * inclusive.
   *
   * The end is taken from the last character of the match rather than from one
   * past it, so a match ending exactly at a row boundary cannot run off the end
   * of the buffer. A path finishing on a full-width glyph is underlined one cell
   * short, which no real path does.
   */
  private rangeFor(
    buffer: BufferReader,
    startRow: number,
    offset: number,
    text: string
  ): ILink['range'] | null {
    const start = mapOffsetToCell(buffer, startRow, 0, offset);
    if (!start) return null;
    const last = mapOffsetToCell(buffer, start.y, start.x, text.length - 1);
    if (!last) return null;
    return {
      start: { x: start.x + 1, y: start.y + 1 },
      end: { x: last.x + 1, y: last.y + 1 }
    };
  }
}

/**
 * What activating a detected path should do.
 *
 * A folder and a `.zip` have nothing to show in an editor pane, and revealing
 * them in the file manager is what the user meant by clicking anyway. Separated
 * from the doing of it so the rule can be read, and tested, on its own.
 */
export type PathAction = { kind: 'open'; target?: FileOpenTarget } | { kind: 'reveal' };

export function actionForDetectedPath(detected: DetectedPath): PathAction {
  if (detected.isDirectory || isBinaryBlockedFilePath(detected.resolvedPath)) {
    return { kind: 'reveal' };
  }
  return {
    kind: 'open',
    ...(detected.line !== undefined
      ? {
          target: {
            line: detected.line,
            ...(detected.col !== undefined ? { col: detected.col } : {})
          }
        }
      : {})
  };
}
