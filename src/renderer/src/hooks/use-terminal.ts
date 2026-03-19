import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';

import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
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

function createTerminal(container: HTMLElement, options: UseTerminalOptions): {
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
  cursorSuppressor: { dispose(): void } | null;
} {
  const term = new Terminal({
    fontSize: options.fontSize ?? 14,
    fontFamily: options.fontFamily ?? 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace',
    scrollback: options.scrollback ?? 3000,
    cursorBlink: true,
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
      brightWhite: '#f1f1f0',
    },
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

  term.open(container);

  // Restore serialized content after open (before canvas addon — content is buffer-level)
  if (options.serializedContent) {
    term.write(options.serializedContent);
  }

  // Hide xterm's hardware cursor for TUIs that draw their own (e.g. Claude Code).
  // Claude Code (Ink/cli-cursor) renders its own cursor glyph and uses DECTCEM
  // (\x1b[?25h / \x1b[?25l) to toggle the real cursor. This creates a duplicate:
  // xterm's native cursor + the TUI-drawn cursor character. We suppress xterm's
  // cursor entirely by hiding it at init and intercepting any DECSET 25 (show
  // cursor) sequences from the PTY.
  let cursorSuppressor: { dispose(): void } | null = null;
  if (options.cursorHidden) {
    term.options.cursorBlink = false;
    term.options.cursorInactiveStyle = 'none';
    term.write('\x1b[?25l');
    // Intercept CSI ? 25 h (DECSET 25 = show cursor) and suppress it
    cursorSuppressor = term.parser.registerCsiHandler(
      { prefix: '?', final: 'h' },
      (params) => {
        // Only intercept DECTCEM (param 25); let other DECSET sequences through
        if (params[0] === 25) return true; // swallow — keep cursor hidden
        return false; // pass to default handler
      }
    );
  }

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
    window.fleet.pty.create({
      paneId: options.paneId,
      cwd: options.cwd,
    });
  }

  // For pre-created PTYs (crew deployments), attach to get buffered output
  // and transition to live streaming. This closes the race where PTY data
  // arrives before the renderer mounts the terminal.
  if (isPreCreated && !options.attachOnly) {
    window.fleet.pty.attach(options.paneId).then(({ data }) => {
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
    if (e.key === 'PageUp' || e.key === 'PageDown' ||
        ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) {
      requestAnimationFrame(() => updatePinnedState());
    }
  };
  container.addEventListener('keydown', keyScrollHandler);

  const scrollCleanup = (): void => {
    container.removeEventListener('wheel', wheelHandler);
    container.removeEventListener('keydown', keyScrollHandler);
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
        rows: term.rows,
      });
    }, 100);
  };

  // Defer canvas addon, initial fit, and ResizeObserver to next frame.
  // xterm's render service needs a full layout pass before dimensions are
  // available. Loading CanvasAddon synchronously after open() triggers
  // internal xterm events (Viewport.syncScrollArea) before the new
  // renderer's dimensions are initialized, causing:
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

  requestAnimationFrame(() => {
    // Load canvas renderer after layout pass — avoids dimensions race
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      // Canvas addon failed, terminal will use default renderer
    }

    try {
      fitPreservingScroll();
      // Always send resize to PTY — on reconnect (undo) this triggers
      // SIGWINCH so the shell redraws its prompt.
      debouncedPtyResize();
    } catch {
      // Render service may not be ready yet; ResizeObserver will retry
    }

    // Start observing resizes only after initial setup is complete
    resizeObserver.observe(container);
  });

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

  return { term, fitAddon, fitPreservingScroll, scrollToBottom, searchAddon, serializeAddon, ipcCleanup, scrollCleanup, resizeObserver, cleanupResizeTimer, cursorSuppressor };
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions & { isActive?: boolean },
) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitPreservingScrollRef = useRef<(() => void) | null>(null);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { term, fitAddon, fitPreservingScroll, scrollToBottom, searchAddon, serializeAddon, ipcCleanup, scrollCleanup, resizeObserver, cleanupResizeTimer, cursorSuppressor } =
      createTerminal(container, options);

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
      cursorSuppressor?.dispose();
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
    const newFamily = options.fontFamily ?? 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace';
    const newSize = options.fontSize ?? 14;
    if (term.options.fontFamily !== newFamily || term.options.fontSize !== newSize) {
      const primaryFamily = newFamily.split(',')[0].trim();
      const fontLoads = [
        document.fonts.load(`16px "${primaryFamily}"`),
        document.fonts.load(`bold 16px "${primaryFamily}"`),
        document.fonts.load(`italic 16px "${primaryFamily}"`),
        document.fonts.load(`bold italic 16px "${primaryFamily}"`),
      ];
      Promise.allSettled(fontLoads).then(() => {
        // Guard against terminal being disposed while fonts were loading
        if (!termRef.current) return;
        term.options.fontFamily = newFamily;
        term.options.fontSize = newSize;
        term.clearTextureAtlas();
        fitPreservingScrollRef.current?.();
      });
    }
  }, [options.fontFamily, options.fontSize]);

  // Focus the xterm instance when this pane becomes active
  useEffect(() => {
    if (options.isActive && termRef.current) {
      termRef.current.focus();
    }
  }, [options.isActive]);

  return {
    focus: () => termRef.current?.focus(),
    fit: () => fitPreservingScrollRef.current?.(),
    scrollToBottom: () => scrollToBottomRef.current?.(),
    search: (query: string) => searchAddonRef.current?.findNext(query),
    searchPrevious: (query: string) => searchAddonRef.current?.findPrevious(query),
    clearSearch: () => searchAddonRef.current?.clearDecorations(),
    serialize: () => serializeAddonRef.current?.serialize(),
  };
}
