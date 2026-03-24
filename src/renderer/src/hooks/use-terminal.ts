import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export type UseTerminalOptions = {
  paneId: string;
  cwd: string;
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
  serializedContent?: string;
  onScrollStateChange?: (isScrolledUp: boolean) => void;
  /** If true, skip PTY creation (attach to an already-running PTY, e.g. Admiral). */
  attachOnly?: boolean;
  /** If true, hide xterm's hardware cursor (for TUIs like Claude Code that draw their own). */
  cursorHidden?: boolean;
};

// Track which panes already have PTYs created (survives StrictMode remounts)
const createdPtys = new Set<string>();

// Registry for serializing terminal content before close
const serializeRegistry = new Map<string, SerializeAddon>();

export function clearCreatedPty(paneId: string): void {
  createdPtys.delete(paneId);
}

/** Pre-mark a pane as having a PTY (created by main process, e.g. crew deployments). */
export function markPtyCreated(paneId: string): void {
  createdPtys.add(paneId);
}

export function serializePane(paneId: string, scrollback?: number): string | undefined {
  return serializeRegistry.get(paneId)?.serialize(scrollback != null ? { scrollback } : undefined);
}

function createTerminal(
  container: HTMLElement,
  options: UseTerminalOptions
): {
  term: Terminal;
  fitAddon: FitAddon;
  fitPreservingScroll: () => void;
  scrollToBottom: () => void;
  searchAddon: SearchAddon;
  serializeAddon: SerializeAddon;
  ipcCleanup: () => void;
  scrollCleanup: () => void;
  resizeObserver: ResizeObserver;
  cleanupResizeTimer: () => void;
  cursorSuppressor: { dispose(): void };
} {
  const term = new Terminal({
    fontSize: options.fontSize ?? 14,
    fontFamily: options.fontFamily ?? 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace',
    scrollback: options.scrollback ?? 3000,
    cursorBlink: true,
    cursorInactiveStyle: 'none',
    allowProposedApi: true,
    theme: {
      background: '#151515',
      foreground: '#e4e4e4',
      cursor: '#e4e4e4',
      cursorAccent: '#0a0a0a',
      selectionBackground: '#3a3d41',
      black: '#0a0a0a',
      red: '#ff5c57',
      green: '#5af78e',
      yellow: '#f3f99d',
      blue: '#57c7ff',
      magenta: '#ff6ac1',
      cyan: '#9aedfe',
      white: '#f1f1f0',
      brightBlack: '#686868',
      brightRed: '#ff5c57',
      brightGreen: '#5af78e',
      brightYellow: '#f3f99d',
      brightBlue: '#57c7ff',
      brightMagenta: '#ff6ac1',
      brightCyan: '#9aedfe',
      brightWhite: '#f1f1f0'
    }
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const serializeAddon = new SerializeAddon();
  const unicodeAddon = new Unicode11Addon();

  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(serializeAddon);
  term.loadAddon(unicodeAddon);
  term.unicode.activeVersion = '11';

  // Shift+click to open http/https URLs in the default browser.
  // The custom handler suppresses plain clicks so text selection still works normally.
  const webLinksAddon = new WebLinksAddon(
    (event, uri) => {
      if (event.shiftKey) {
        void window.fleet.shell.openExternal(uri);
      }
    },
    { urlRegex: /https?:\/\/[^\s"'<>()[\]{}]+/i }
  );
  term.loadAddon(webLinksAddon);

  term.open(container);

  // Restore serialized content after open (before canvas addon — content is buffer-level)
  if (options.serializedContent) {
    term.write(options.serializedContent);
  }

  // Cursor suppression for TUI apps that render their own cursor glyphs.
  // Two modes:
  // - Static (cursorHidden: true): always hide xterm's cursor. Used for terminals
  //   that always run a TUI (e.g. Star Command Admiral terminal).
  // - Dynamic (default): auto-activate suppression when an app enters the alternate
  //   screen (\x1b[?1049h) and deactivate on exit (\x1b[?1049l). Prevents double
  //   cursors (xterm's native cursor + TUI-drawn cursor glyph) in regular panes
  //   without breaking normal shell cursor behavior.
  let tuiMode = false;
  if (options.cursorHidden) {
    tuiMode = true;
    term.options.cursorBlink = false;
    term.options.cursorInactiveStyle = 'none';
    term.write('\x1b[?25l');
  }

  // DECSET handler (CSI ? ... h): detect alt-screen entry and suppress cursor show.
  const decsetSuppressor = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params[0] === 1049 && !options.cursorHidden) {
      tuiMode = true; // TUI entered alternate screen — activate cursor suppression
    }
    if (params[0] === 25 && tuiMode) {
      return true; // suppress DECTCEM show-cursor while TUI is active
    }
    return false; // pass through to xterm's default handler
  });

  // DECRST handler (CSI ? ... l): deactivate suppression when TUI exits alt-screen.
  // Not needed in static mode (cursorHidden) since suppression is permanent there.
  const decrstSuppressor = options.cursorHidden
    ? null
    : term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (params[0] === 1049) {
          tuiMode = false;
          // Restore cursor visibility after TUI exits. Deferred to avoid re-entrant
          // parsing; guard re-checks tuiMode in case a new TUI started immediately.
          setTimeout(() => {
            if (!tuiMode && term.element) {
              term.write('\x1b[?25h');
            }
          }, 0);
        }
        return false; // always pass through to xterm's default handler
      });

  // Re-suppress xterm's hardware cursor after window focus restore.
  // When the Electron window regains focus (e.g. after switching macOS workspaces),
  // xterm internally re-enables its hardware cursor — bypassing the CSI parser suppressor.
  // Re-hiding it here ensures the TUI-drawn cursor glyph is the only cursor visible.
  const onWindowFocus = (): void => {
    if (tuiMode && term.element) {
      term.write('\x1b[?25l');
    }
  };
  window.addEventListener('focus', onWindowFocus);

  const cursorSuppressor: { dispose(): void } = {
    dispose(): void {
      tuiMode = false;
      window.removeEventListener('focus', onWindowFocus);
      decsetSuppressor.dispose();
      decrstSuppressor?.dispose();
    }
  };

  // Wire IPC data flow.
  // xterm.js auto-scrolls via its rendering pipeline (requestAnimationFrame),
  // which Chromium pauses in unfocused windows. Without this callback, data is
  // written to the buffer (baseY advances) but the viewport DOM scrollTop stays
  // stale, making the terminal appear stuck at an old scroll position.
  // By scrolling in the write callback, we ensure the DOM scroll position stays
  // correct regardless of whether rAF is running.

  // Create PTY only once per pane (survives StrictMode double-mount).
  // Skip creation when attachOnly=true (e.g. Admiral PTY pre-created by main process).
  const isPreCreated = createdPtys.has(options.paneId);

  // For pre-created PTYs (crew deployments), gate live data until attach()
  // resolves to prevent out-of-order writes. Data that arrives via PTY_DATA
  // before the attach round-trip completes is queued and flushed in order.
  let attachResolved = !isPreCreated || options.attachOnly;
  const pendingLiveData: string[] = [];

  const writeToTerm = (data: string): void => {
    term.write(data, () => {
      if (pinnedToBottom) {
        term.scrollToBottom();
      }
      window.fleet.ptyDrain(options.paneId);
    });
  };

  const ipcCleanup = window.fleet.pty.onData(({ paneId, data }) => {
    if (paneId === options.paneId) {
      if (!attachResolved) {
        pendingLiveData.push(data);
        return;
      }
      writeToTerm(data);
    }
  });

  term.onData((data) => {
    window.fleet.pty.input({ paneId: options.paneId, data });
  });

  if (!options.attachOnly && !isPreCreated) {
    createdPtys.add(options.paneId);
    void window.fleet.pty.create({
      paneId: options.paneId,
      cwd: options.cwd
    });
  }

  // For pre-created PTYs (crew deployments), attach to get buffered output
  // and transition to live streaming. This closes the race where PTY data
  // arrives before the renderer mounts the terminal.
  if (isPreCreated && !options.attachOnly) {
    void window.fleet.pty.attach(options.paneId).then(({ data }) => {
      if (!term.element) return; // terminal disposed during round-trip
      if (data) writeToTerm(data);
      attachResolved = true;
      for (const chunk of pendingLiveData) writeToTerm(chunk);
      pendingLiveData.length = 0;
    });
  }

  // Track whether the user intends to follow live output (pinned to bottom).
  // We track this explicitly rather than checking viewportY >= baseY because
  // xterm doesn't keep the viewport pinned when the terminal is display:none
  // (e.g. during tab switches), causing the instantaneous check to be wrong.
  let pinnedToBottom = true;

  const isAtBottom = (): boolean => {
    const buf = term.buffer.active;
    return buf.viewportY >= buf.baseY - 2;
  };

  const updatePinnedState = (): void => {
    // Don't read buffer state while hidden (display:none) — viewportY is stale
    // and would incorrectly flip pinnedToBottom to false.
    if (container.offsetParent === null) return;
    pinnedToBottom = isAtBottom();
    options.onScrollStateChange?.(!pinnedToBottom);
  };

  // Helper: fit the terminal while preserving viewport scroll position.
  // Without this, fitAddon.fit() can reset the viewport to the top when
  // the container is resized (e.g. adding splits, switching tabs).
  const fitPreservingScroll = (): void => {
    // Skip while hidden — viewportY is stale and fit() can't measure correctly
    if (container.offsetParent === null) return;

    // Reconcile: if flag says unpinned but viewport is actually at bottom,
    // correct it before acting. Catches any edge case that falsely unpinned.
    if (!pinnedToBottom && isAtBottom()) {
      pinnedToBottom = true;
      options.onScrollStateChange?.(false);
    }

    const savedPinned = pinnedToBottom;
    const savedViewportY = term.buffer.active.viewportY;

    fitAddon.fit();

    // If user had scrolled up, restore their position; otherwise ensure we're at bottom
    if (!savedPinned) {
      const targetY = Math.min(savedViewportY, term.buffer.active.baseY);
      term.scrollToLine(targetY);
    } else {
      term.scrollToBottom();
    }
  };

  // Re-pin when content scrolls us to bottom (e.g. new output while following).
  // IMPORTANT: onScroll only fires for content-driven scroll (new lines added),
  // NOT for user wheel/keyboard scroll. During fast output, viewportY can briefly
  // lag behind baseY, so we must NOT unpin here — only re-pin when at bottom.
  // Unpinning is handled exclusively by the wheel event listener below.
  term.onScroll(() => {
    if (container.offsetParent === null) return;
    if (isAtBottom()) {
      pinnedToBottom = true;
      options.onScrollStateChange?.(false);
    }
  });

  // User-initiated scroll detection: wheel (trackpad/mouse) and keyboard (PageUp/PageDown).
  // These are the ONLY events that should unpin — onScroll is content-driven only.
  const wheelHandler = (): void => {
    requestAnimationFrame(() => updatePinnedState());
  };
  container.addEventListener('wheel', wheelHandler, { passive: true });

  const keyScrollHandler = (e: KeyboardEvent): void => {
    if (
      e.key === 'PageUp' ||
      e.key === 'PageDown' ||
      ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))
    ) {
      requestAnimationFrame(() => updatePinnedState());
    }
  };
  container.addEventListener('keydown', keyScrollHandler);

  // Re-pin when the user scrolls the viewport back to the bottom.
  // term.onScroll only fires on content-driven buffer scroll (new lines added),
  // NOT on user viewport scroll. On macOS trackpad momentum scrolling, wheel events
  // stop firing before the scroll actually settles — the wheelHandler's rAF may read
  // a stale position slightly above baseY, leaving pinnedToBottom=false indefinitely.
  // The DOM 'scroll' event on .xterm-viewport fires on every scrollTop change
  // including the final resting position, giving reliable bottom detection.
  const xtermViewport = container.querySelector('.xterm-viewport');
  const viewportScrollHandler = (): void => {
    if (container.offsetParent === null) return;
    if (isAtBottom()) {
      pinnedToBottom = true;
      options.onScrollStateChange?.(false);
    }
  };
  xtermViewport?.addEventListener('scroll', viewportScrollHandler, { passive: true });

  const scrollCleanup = (): void => {
    container.removeEventListener('wheel', wheelHandler);
    container.removeEventListener('keydown', keyScrollHandler);
    xtermViewport?.removeEventListener('scroll', viewportScrollHandler);
  };

  // Debounced PTY resize — sends SIGWINCH once after resizing settles,
  // preventing rapid-fire signals that corrupt TUI cursor positions
  // (e.g. Claude Code) during drag resize.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedPtyResize = (): void => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      window.fleet.pty.resize({
        paneId: options.paneId,
        cols: term.cols,
        rows: term.rows
      });
    }, 100);
  };

  // Defer initial fit and ResizeObserver to next frame.
  // xterm's render service needs a full layout pass before dimensions are
  // available. Swapping renderers too early has previously triggered
  // internal xterm events before dimensions were initialized, causing:
  //   "Cannot read properties of undefined (reading 'dimensions')"
  const resizeObserver = new ResizeObserver(() => {
    if (term.element) {
      try {
        fitPreservingScroll();
        debouncedPtyResize();
      } catch {
        // Terminal may be initializing or disposed; ignore
      }
    }
  });

  const hasRenderableSize = (): boolean => {
    const rect = container.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const startTerminalWhenReady = (attempt = 0): void => {
    if (!term.element) return;

    if (!hasRenderableSize()) {
      if (attempt < 10) {
        requestAnimationFrame(() => startTerminalWhenReady(attempt + 1));
      } else {
        resizeObserver.observe(container);
      }
      return;
    }

    try {
      fitPreservingScroll();
      debouncedPtyResize();
    } catch {
      if (attempt < 10) {
        requestAnimationFrame(() => startTerminalWhenReady(attempt + 1));
        return;
      }
    }

    resizeObserver.observe(container);
  };

  requestAnimationFrame(() => startTerminalWhenReady());

  const scrollToBottom = (): void => {
    term.scrollToBottom();
    pinnedToBottom = true;
    options.onScrollStateChange?.(false);
  };

  const cleanupResizeTimer = (): void => {
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
  };

  return {
    term,
    fitAddon,
    fitPreservingScroll,
    scrollToBottom,
    searchAddon,
    serializeAddon,
    ipcCleanup,
    scrollCleanup,
    resizeObserver,
    cleanupResizeTimer,
    cursorSuppressor
  };
}

type UseTerminalReturn = {
  focus: () => void;
  fit: () => void;
  scrollToBottom: () => void;
  search: (query: string) => boolean | undefined;
  searchPrevious: (query: string) => boolean | undefined;
  clearSearch: () => void;
  serialize: () => string | undefined;
};

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions & { isActive?: boolean }
): UseTerminalReturn {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitPreservingScrollRef = useRef<(() => void) | null>(null);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const {
      term,
      fitAddon,
      fitPreservingScroll,
      scrollToBottom,
      searchAddon,
      serializeAddon,
      ipcCleanup,
      scrollCleanup,
      resizeObserver,
      cleanupResizeTimer,
      cursorSuppressor
    } = createTerminal(container, options);

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    fitPreservingScrollRef.current = fitPreservingScroll;
    scrollToBottomRef.current = scrollToBottom;
    searchAddonRef.current = searchAddon;
    serializeAddonRef.current = serializeAddon;
    serializeRegistry.set(options.paneId, serializeAddon);

    return () => {
      termRef.current = null;
      scrollToBottomRef.current = null;
      serializeRegistry.delete(options.paneId);
      cleanupResizeTimer();
      cursorSuppressor.dispose();
      ipcCleanup();
      scrollCleanup();
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [options.paneId]);

  // Update font settings on existing terminal without re-creating it.
  // We force-load the new font via document.fonts.load() before applying it,
  // then clear the canvas renderer's glyph cache so it rebuilds with the new font.
  // See xterm.js #1164 — canvas renderer has no automatic font swap detection.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const newFamily =
      options.fontFamily ?? 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace';
    const newSize = options.fontSize ?? 14;
    if (term.options.fontFamily !== newFamily || term.options.fontSize !== newSize) {
      const primaryFamily = newFamily.split(',')[0].trim();
      const fontLoads = [
        document.fonts.load(`16px "${primaryFamily}"`),
        document.fonts.load(`bold 16px "${primaryFamily}"`),
        document.fonts.load(`italic 16px "${primaryFamily}"`),
        document.fonts.load(`bold italic 16px "${primaryFamily}"`)
      ];
      void Promise.allSettled(fontLoads).then(() => {
        // Guard against terminal being disposed while fonts were loading
        if (!termRef.current) return;
        term.options.fontFamily = newFamily;
        term.options.fontSize = newSize;
        term.clearTextureAtlas();
        fitPreservingScrollRef.current?.();
      });
    }
  }, [options.fontFamily, options.fontSize]);

  // Focus and refresh the xterm instance when this pane becomes active.
  // The refresh call is needed when the terminal was hidden with display:none and
  // then shown again — the canvas may not repaint automatically.
  useEffect(() => {
    if (options.isActive && termRef.current) {
      termRef.current.focus();
      termRef.current.refresh(0, termRef.current.rows - 1);
    }
  }, [options.isActive]);

  return {
    focus: () => termRef.current?.focus(),
    fit: () => fitPreservingScrollRef.current?.(),
    scrollToBottom: () => scrollToBottomRef.current?.(),
    search: (query: string) => searchAddonRef.current?.findNext(query),
    searchPrevious: (query: string) => searchAddonRef.current?.findPrevious(query),
    clearSearch: () => searchAddonRef.current?.clearDecorations(),
    serialize: () => serializeAddonRef.current?.serialize()
  };
}
