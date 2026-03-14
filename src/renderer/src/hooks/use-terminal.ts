import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

export type UseTerminalOptions = {
  paneId: string;
  cwd: string;
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
};

// Track which panes already have PTYs created (survives StrictMode remounts)
const createdPtys = new Set<string>();

function createTerminal(container: HTMLElement, options: UseTerminalOptions): {
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  ipcCleanup: () => void;
  resizeObserver: ResizeObserver;
} {
  const term = new Terminal({
    fontSize: options.fontSize ?? 14,
    fontFamily: options.fontFamily ?? 'monospace',
    scrollback: options.scrollback ?? 10_000,
    cursorBlink: true,
    allowProposedApi: true,
    theme: {
      background: '#0c0c0c',
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
  const unicodeAddon = new Unicode11Addon();

  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(unicodeAddon);
  term.unicode.activeVersion = '11';

  term.open(container);

  // Use canvas renderer (WebGL can cause _isDisposed errors on StrictMode remount)
  try {
    term.loadAddon(new CanvasAddon());
  } catch {
    // Canvas addon failed, terminal will use default renderer
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

  try {
    fitAddon.fit();
  } catch {
    // Render service may not be ready yet; ResizeObserver will retry
  }

  const resizeObserver = new ResizeObserver(() => {
    if (term.element) {
      try {
        fitAddon.fit();
        window.fleet.pty.resize({
          paneId: options.paneId,
          cols: term.cols,
          rows: term.rows,
        });
      } catch {
        // Terminal may be initializing or disposed; ignore
      }
    }
  });
  resizeObserver.observe(container);

  return { term, fitAddon, searchAddon, ipcCleanup, resizeObserver };
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions,
) {
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { term, fitAddon, searchAddon, ipcCleanup, resizeObserver } =
      createTerminal(container, options);

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    return () => {
      ipcCleanup();
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [options.paneId]);

  return {
    fit: () => fitAddonRef.current?.fit(),
    search: (query: string) => searchAddonRef.current?.findNext(query),
    searchPrevious: (query: string) => searchAddonRef.current?.findPrevious(query),
  };
}
