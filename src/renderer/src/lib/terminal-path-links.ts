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

export type PathLinkDeps = {
  /** The pane's live working directory, which relative paths resolve against. */
  getCwd(): string;
  getPathContext(): PathContext;
  getHomes(): { homeDir: string; wslHomeByDistro: Record<string, string> };
  /** True while the pane's foreground process is ssh or mosh. */
  isRemote(): boolean;
  statPath(path: string, ctx: PathContext): Promise<StatResult>;
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

type CacheEntry = { result: StatResult; at: number };

export class PathLinkProvider implements ILinkProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<StatResult>>();
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
    // A path printed inside an ssh session names a file on the far machine. The
    // local filesystem may well have something at the same place, and opening
    // that instead would be wrong in the quiet way that is worst: a real file,
    // just not the one on screen.
    if (this.disposed || this.deps.isRemote()) {
      callback(undefined);
      return;
    }

    const buffer = this.getBuffer();
    const stitched = stitchWrappedLine(buffer, bufferLineNumber - 1);
    if (!stitched) {
      callback(undefined);
      return;
    }

    const candidates = findCandidatePaths(stitched.text);
    if (candidates.length === 0) {
      callback(undefined);
      return;
    }

    const cwd = this.deps.getCwd();
    const ctx = this.deps.getPathContext();
    const homes = this.deps.getHomes();

    // Everything that reads the buffer happens here, before the first `await`.
    // The buffer is live: once the scrollback is full, each new line trims one
    // off the front and every absolute row index shifts down beneath us. Mapping
    // offsets to cells after waiting on a `stat` would measure whatever text had
    // scrolled into those cells in the meantime, and underline that instead.
    const located = candidates.flatMap((candidate) => {
      const resolved = resolveAgainstCwd(expandHome(candidate.text, ctx, homes), cwd, ctx);
      if (!resolved) return [];
      const range = this.rangeFor(buffer, stitched.startRow, candidate.index, candidate.text);
      if (!range) return [];
      return [{ candidate, resolved, range }];
    });

    if (located.length === 0) {
      callback(undefined);
      return;
    }

    const pending = located.map(async ({ candidate, resolved, range }) => {
      const stat = await this.statCached(resolved, ctx);
      if (!stat.exists) return null;

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
      return link;
    });

    void Promise.all(pending).then((links) => {
      if (this.disposed) {
        callback(undefined);
        return;
      }

      // The geometry was settled before the `stat`, but that only makes the
      // ranges faithful to the text as it was read - it cannot make them still
      // true. A TUI redrawing in place (which is most of what Claude Code does)
      // can replace this row while the `stat` is in flight, leaving cells that
      // hold different text at coordinates xterm will happily underline, and a
      // click that opens a file no longer on screen. Re-reading the row and
      // insisting it is unchanged is the only honest check.
      //
      // Scrolling is caught downstream too, because xterm recomputes the mouse
      // row against the current `ydisp` and drops a link that no longer sits
      // under the pointer - but relying on that leaves the in-place case open,
      // and depends on internals this provider should not have to know.
      const current = stitchWrappedLine(this.getBuffer(), bufferLineNumber - 1);
      if (current?.text !== stitched.text || current.startRow !== stitched.startRow) {
        callback(undefined);
        return;
      }

      const found = links.filter((l): l is ILink => l !== null);
      callback(found.length > 0 ? found : undefined);
    });
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

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.inFlight.clear();
    this.hovered = null;
  }

  /**
   * Existence, remembered. Concurrent lookups of the same path share one
   * request, so a line naming the same file three times costs one `stat`.
   */
  private async statCached(path: string, ctx: PathContext): Promise<StatResult> {
    const fresh = this.cache.get(path);
    if (fresh && Date.now() - fresh.at < STAT_TTL_MS) return fresh.result;

    const existing = this.inFlight.get(path);
    if (existing) return existing;

    const request = this.deps
      .statPath(path, ctx)
      .catch(() => ({ exists: false, isDirectory: false }))
      .then((result) => {
        this.inFlight.delete(path);
        // A pane closed while its answer was in flight has nothing to remember.
        if (this.disposed) return result;
        // Re-inserting moves the key to the end of the Map's order, which is
        // what makes the eviction below oldest-first.
        this.cache.delete(path);
        this.cache.set(path, { result, at: Date.now() });
        if (this.cache.size > CACHE_CAP) {
          const oldest = this.cache.keys().next();
          if (!oldest.done) this.cache.delete(oldest.value);
        }
        return result;
      });

    this.inFlight.set(path, request);
    return request;
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
