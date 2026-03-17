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
};

// Track which panes already have PTYs created (survives StrictMode remounts)
const createdPtys = new Set<string>();

// Registry for serializing terminal content before close
const serializeRegistry = new Map<string, SerializeAddon>();

export function clearCreatedPty(paneId: string): void {
  createdPtys.delete(paneId);
}

export function serializePane(paneId: string): string | undefined {
  return serializeRegistry.get(paneId)?.serialize();
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
} {
  const term = new Terminal({
    fontSize: options.fontSize ?? 14,
    fontFamily: options.fontFamily ?? 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace',
    scrollback: options.scrollback ?? 10_000,
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

  // Use canvas renderer (WebGL can cause _isDisposed errors on StrictMode remount)
  try {
    term.loadAddon(new CanvasAddon());
  } catch {
    // Canvas addon failed, terminal will use default renderer
  }

  // Restore serialized content after open + canvas addon
  if (options.serializedContent) {
    term.write(options.serializedContent);
  }

  // Wire IPC data flow
  const ipcCleanup = window.fleet.pty.onData(({ paneId, data }) => {
    if (paneId === options.paneId) {
      term.write(data);
    }
  });

  term.onData((data) => {
    window.fleet.pty.input({ paneId: options.paneId, data });
  });

  // Create PTY only once per pane (survives StrictMode double-mount)
  if (!createdPtys.has(options.paneId)) {
    createdPtys.add(options.paneId);
    window.fleet.pty.create({
      paneId: options.paneId,
      cwd: options.cwd,
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

  // Defer initial fit to next frame — xterm's render service needs a
  // layout pass before dimensions are available.
  requestAnimationFrame(() => {
    try {
      fitPreservingScroll();
      // Always send resize to PTY — on reconnect (undo) this triggers
      // SIGWINCH so the shell redraws its prompt.
      debouncedPtyResize();
    } catch {
      // Render service may not be ready yet; ResizeObserver will retry
    }
  });

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
  resizeObserver.observe(container);

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

  return { term, fitAddon, fitPreservingScroll, scrollToBottom, searchAddon, serializeAddon, ipcCleanup, scrollCleanup, resizeObserver, cleanupResizeTimer };
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

    const { term, fitAddon, fitPreservingScroll, scrollToBottom, searchAddon, serializeAddon, ipcCleanup, scrollCleanup, resizeObserver, cleanupResizeTimer } =
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
