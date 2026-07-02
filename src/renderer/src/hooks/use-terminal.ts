import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';

import { FitAddon } from '@xterm/addon-fit';
import { createLogger } from '../logger';

const log = createLogger('terminal:lifecycle');
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalThemeId } from '../../../shared/theme-presets';
import { resolveXtermTheme } from '../lib/theme';

export type UseTerminalOptions = {
  paneId: string;
  cwd: string;
  fontSize?: number;
  fontFamily?: string;
  terminalTheme?: TerminalThemeId;
  scrollback?: number;
  /** Shell command to run instead of default shell (e.g. pi agent binary). */
  cmd?: string;
  /** If true, PTY exits when cmd finishes instead of falling back to shell. */
  exitOnComplete?: boolean;
  serializedContent?: string;
  onScrollStateChange?: (isScrolledUp: boolean) => void;
  /** If true, skip PTY creation (attach to an already-running PTY, e.g. Admiral). */
  attachOnly?: boolean;
  /** If true, hide xterm's hardware cursor (for TUIs like Claude Code that draw their own). */
  cursorHidden?: boolean;
  /** Workspace ID for resolving per-workspace Claude config. */
  workspaceId?: string;
  /** ShellProfile id used to spawn the PTY. Read from PaneLeaf by callers. */
  shellProfileId?: string;
  /** When true, render xterm's background transparently so a background image shows through. */
  backgroundImageActive?: boolean;
};

export const RUNE_READY_MARKER = '\x1b]777;fleet.rune.ready\x07';

export type RuneReadyMarkerState = {
  pending: string;
};

const MAX_RUNE_READY_MARKER_PENDING = RUNE_READY_MARKER.length - 1;
const RUNE_READY_MARKER_FLUSH_DELAY_MS = 100;

// While a pane is hidden (display:none background/inactive tab), coalesce PTY
// output and write it to xterm at most this often instead of on every ~16ms PTY
// flush. Cuts xterm parse+render work for terminals nobody is looking at.
const HIDDEN_FLUSH_INTERVAL_MS = 250;

// Track which panes already have PTYs created (survives StrictMode remounts)
const createdPtys = new Set<string>();

// Registry for serializing terminal content before close
const serializeRegistry = new Map<string, SerializeAddon>();

// Registry of live xterm Terminal instances (for clearing buffers on restart)
const terminalRegistry = new Map<string, Terminal>();

/** Panes currently being restarted — onExit handler should skip tab close for these. */
export const restartingPanes = new Set<string>();

export function clearCreatedPty(paneId: string): void {
  createdPtys.delete(paneId);
}

/** Pre-mark a pane as having a PTY (created by main process, e.g. crew deployments). */
export function markPtyCreated(paneId: string): void {
  createdPtys.add(paneId);
}

/**
 * Restart a terminal pane: kill its PTY, clear the xterm buffer, and spawn a
 * new PTY at the given cwd with fresh env (picks up updated config).
 */
export async function restartPane(
  paneId: string,
  cwd: string,
  workspaceId?: string,
  shellProfileId?: string
): Promise<void> {
  restartingPanes.add(paneId);
  window.fleet.pty.kill(paneId);
  createdPtys.delete(paneId);

  // Clear xterm buffer so the user sees a fresh terminal
  const term = terminalRegistry.get(paneId);
  if (term) {
    term.clear();
    term.reset();
  }

  // Small delay to let the kill propagate before recreating
  await new Promise((r) => setTimeout(r, 100));

  createdPtys.add(paneId);
  await window.fleet.pty.create({ paneId, cwd, workspaceId, shellProfileId });
  // Don't delete from restartingPanes here — the onExit handler consumes it
  // when the kill's async IPC event arrives (may be after this point).
}

export function serializePane(paneId: string, scrollback?: number): string | undefined {
  return serializeRegistry.get(paneId)?.serialize(scrollback != null ? { scrollback } : undefined);
}

/** Plain-text (no ANSI) tail of a pane's terminal buffer, for read-only glance UI. */
export function getPaneTailText(paneId: string, lines = 40): string | undefined {
  const term = terminalRegistry.get(paneId);
  if (!term) return undefined;
  const buf = term.buffer.active;
  const end = buf.baseY + term.rows;
  const start = Math.max(0, end - lines);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    if (line) out.push(line.translateToString(true));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

export type RuneReadyMarkerResult = {
  output: string;
  readySeen: boolean;
};

export function stripRuneReadyMarker(
  state: RuneReadyMarkerState,
  chunk: string,
  flush = false
): RuneReadyMarkerResult {
  const input = state.pending + chunk;
  state.pending = '';

  let output = '';
  let readySeen = false;
  let index = 0;

  while (index < input.length) {
    if (input.startsWith(RUNE_READY_MARKER, index)) {
      readySeen = true;
      index += RUNE_READY_MARKER.length;
      continue;
    }

    if (!flush) {
      const remaining = input.slice(index);
      if (RUNE_READY_MARKER.startsWith(remaining)) {
        state.pending = remaining;
        break;
      }
    }

    output += input[index];
    index += 1;
  }

  if (!flush && state.pending.length > MAX_RUNE_READY_MARKER_PENDING) {
    output += state.pending.slice(0, -MAX_RUNE_READY_MARKER_PENDING);
    state.pending = state.pending.slice(-MAX_RUNE_READY_MARKER_PENDING);
  }

  return { output, readySeen };
}

function createTerminal(
  container: HTMLElement,
  options: UseTerminalOptions
): {
  term: Terminal;
  fitAddon: FitAddon;
  fitPreservingScroll: () => boolean;
  scrollToBottom: () => void;
  searchAddon: SearchAddon;
  serializeAddon: SerializeAddon;
  ipcCleanup: () => void;
  scrollCleanup: () => void;
  resizeObserver: ResizeObserver;
  cleanupResizeTimer: () => void;
  cursorSuppressor: { dispose(): void };
  flushPendingRuneReadyMarker: () => void;
} {
  log.debug('createTerminal', { paneId: options.paneId, cwd: options.cwd });

  const term = new Terminal({
    fontSize: options.fontSize ?? 14,
    fontFamily: options.fontFamily ?? 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace',
    scrollback: options.scrollback ?? 3000,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'outline',
    allowProposedApi: true,
    // Always allow transparency (negligible cost on the DOM renderer) so a
    // background image can be toggled on/off live without recreating the term.
    allowTransparency: true,
    theme: resolveXtermTheme(options.terminalTheme, options.backgroundImageActive)
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

  // Cmd+click (macOS) or Ctrl+click (Windows/Linux) to open URLs in default browser.
  // The custom handler suppresses plain clicks so text selection still works normally.
  const webLinksAddon = new WebLinksAddon(
    (event, uri) => {
      if (event.metaKey || event.ctrlKey) {
        void window.fleet.shell.openExternal(uri);
      }
    },
    { urlRegex: /https?:\/\/[^\s"'<>()[\]{}]+/i }
  );
  term.loadAddon(webLinksAddon);

  term.open(container);
  log.debug('xterm mounted', { paneId: options.paneId });

  // Let the app-level Cmd/Ctrl+K command-palette shortcut win even when a
  // terminal is focused. Returning false tells xterm to ignore the key (and
  // crucially NOT send it to the PTY - Ctrl+K is readline kill-line on
  // Linux/Windows). The window keydown listener then opens the palette.
  term.attachCustomKeyEventHandler((event) => {
    if (
      event.type === 'keydown' &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'k'
    ) {
      return false;
    }
    return true;
  });

  // Restore serialized content after open (before canvas addon — content is buffer-level)
  if (options.serializedContent) {
    term.write(options.serializedContent);
  }

  // Cursor suppression for terminals that always run a TUI which draws its own
  // cursor glyph (e.g. Claude Code via PiTab). In this mode xterm's native cursor
  // is permanently hidden so it doesn't double up with the TUI-drawn one.
  // Regular terminal panes pass all cursor sequences through to xterm unchanged —
  // apps like nvim, htop, and less rely on the terminal's native DECTCEM cursor.
  let cursorHidden = false;
  if (options.cursorHidden) {
    cursorHidden = true;
    term.options.cursorBlink = false;
    term.options.cursorInactiveStyle = 'none';
    term.write('\x1b[?25l');
  }

  // Suppress DECTCEM show-cursor in static cursorHidden mode only.
  const decsetSuppressor = options.cursorHidden
    ? term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (params[0] === 25) {
          return true; // suppress show-cursor — TUI draws its own
        }
        return false;
      })
    : null;

  // Re-suppress xterm's hardware cursor after window focus restore.
  // When the Electron window regains focus xterm internally re-enables its
  // hardware cursor — bypassing the CSI parser suppressor.
  const onWindowFocus = (): void => {
    if (cursorHidden && term.element) {
      term.write('\x1b[?25l');
    }
  };
  if (options.cursorHidden) {
    window.addEventListener('focus', onWindowFocus);
  }

  const cursorSuppressor: { dispose(): void } = {
    dispose(): void {
      cursorHidden = false;
      window.removeEventListener('focus', onWindowFocus);
      decsetSuppressor?.dispose();
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

  const runeReadyMarkerState: RuneReadyMarkerState = { pending: '' };
  let runeReadyMarkerFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRuneReadyMarkerFlushTimer = (): void => {
    if (runeReadyMarkerFlushTimer !== null) {
      clearTimeout(runeReadyMarkerFlushTimer);
      runeReadyMarkerFlushTimer = null;
    }
  };

  const writeToTerm = (data: string, flushRuneReadyMarker = false): void => {
    clearRuneReadyMarkerFlushTimer();
    // Strip Rune's ready marker (an OSC handshake) from terminal output so it never displays.
    const processed = stripRuneReadyMarker(runeReadyMarkerState, data, flushRuneReadyMarker);

    if (runeReadyMarkerState.pending) {
      runeReadyMarkerFlushTimer = setTimeout(() => {
        runeReadyMarkerFlushTimer = null;
        writeToTerm('', true);
      }, RUNE_READY_MARKER_FLUSH_DELAY_MS);
    }

    if (!processed.output) {
      window.fleet.ptyDrain(options.paneId);
      return;
    }

    term.write(processed.output, () => {
      if (pinnedToBottom) {
        term.scrollToBottom();
      }
      window.fleet.ptyDrain(options.paneId);
    });
  };

  const flushPendingRuneReadyMarker = (): void => {
    clearRuneReadyMarkerFlushTimer();
    if (runeReadyMarkerState.pending) {
      writeToTerm('', true);
    }
  };

  // Hidden-pane write coalescing. Background-workspace (and inactive) tabs stay
  // mounted but display:none so their PTYs remain warm. Feeding xterm on every
  // ~16ms PTY flush forces escape-sequence parsing and rAF rendering for a
  // redraw-heavy TUI nobody is looking at — the dominant renderer CPU cost when
  // many background Claude sessions stream at once. While hidden we buffer output
  // and write it in one batch at most every HIDDEN_FLUSH_INTERVAL_MS (keeping the
  // buffer current and bounded), then flush immediately when the pane becomes
  // visible. Permission/notification detection is unaffected — it runs in the
  // main process before IPC.
  let hiddenBuffer = '';
  let hiddenFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushHiddenBuffer = (): void => {
    if (hiddenFlushTimer !== null) {
      clearTimeout(hiddenFlushTimer);
      hiddenFlushTimer = null;
    }
    if (hiddenBuffer) {
      const data = hiddenBuffer;
      hiddenBuffer = '';
      writeToTerm(data);
    }
  };

  log.debug('registerPaneData', { paneId: options.paneId });
  const ipcUnsubscribe = window.fleet.pty.registerPaneData(options.paneId, (data) => {
    if (!attachResolved) {
      pendingLiveData.push(data);
      return;
    }
    // offsetParent is null inside a display:none subtree — the idiom used
    // throughout this file to detect a hidden pane.
    if (container.offsetParent === null) {
      // Take the data off the IPC path now (resumes the PTY if backpressure
      // paused it) but defer the costly xterm write to the slow flush.
      window.fleet.ptyDrain(options.paneId);
      hiddenBuffer += data;
      hiddenFlushTimer ??= setTimeout(flushHiddenBuffer, HIDDEN_FLUSH_INTERVAL_MS);
      return;
    }
    // Visible: drain anything buffered while hidden first to preserve order.
    if (hiddenBuffer) flushHiddenBuffer();
    writeToTerm(data);
  });

  // Flush buffered output the instant a hidden pane becomes visible (e.g. tab or
  // workspace switch), so it shows current content without waiting for new PTY
  // output or the slow timer.
  const visibilityObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) flushHiddenBuffer();
  });
  visibilityObserver.observe(container);

  const ipcCleanup = (): void => {
    visibilityObserver.disconnect();
    if (hiddenFlushTimer !== null) clearTimeout(hiddenFlushTimer);
    ipcUnsubscribe();
  };

  term.onData((data) => {
    window.fleet.pty.input({ paneId: options.paneId, data });
  });

  // Shift+Enter → Meta+Enter (\x1b\r). Terminals can't natively distinguish
  // Shift+Enter from Enter (both are \r), but TUIs like Claude Code treat
  // Meta+Enter as "insert newline" vs. plain \r as "submit". Mirror the
  // behavior users get from Opt+Enter on macOS.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    if (
      event.key === 'Enter' &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      window.fleet.pty.input({ paneId: options.paneId, data: '\x1b\r' });
      event.preventDefault();
      return false;
    }

    // Ctrl+Shift+C / Ctrl+Shift+V on Windows/Linux for copy/paste.
    // macOS users use Cmd+C/V via Electron's default Edit menu; we don't
    // intercept those here so the native menu role continues to handle them.
    if (
      event.ctrlKey &&
      event.shiftKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'c'
    ) {
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
    }

    if (
      event.ctrlKey &&
      event.shiftKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'v'
    ) {
      void navigator.clipboard.readText().then((text) => {
        // Normalize CRLF — Windows clipboard uses \r\n, and a bare \r in
        // bash/zsh submits the line before the rest of the paste arrives.
        term.paste(text.replace(/\r\n/g, '\n'));
      });
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    return true;
  });

  // Right-click: show native context menu (Copy / Paste / Select All / Clear).
  // Note: "Cut" and "Replace highlighted" are intentionally omitted — terminal
  // output is not an editable text field, so there's no buffer position for the
  // shell to delete-then-insert. Copy + Paste is the only coherent mapping.
  const contextMenuHandler = (e: MouseEvent): void => {
    e.preventDefault();
    const hasSelection = term.hasSelection();
    void window.fleet.terminal.showContextMenu({ hasSelection }).then(({ action }) => {
      if (!action) return;
      switch (action) {
        case 'copy':
          if (term.hasSelection()) {
            void navigator.clipboard.writeText(term.getSelection());
          }
          break;
        case 'paste':
          void navigator.clipboard.readText().then((text) => {
            term.paste(text.replace(/\r\n/g, '\n'));
          });
          break;
        case 'selectAll':
          term.selectAll();
          break;
        case 'clear':
          term.clear();
          break;
      }
    });
  };
  container.addEventListener('contextmenu', contextMenuHandler);

  if (options.attachOnly) {
    // attachOnly mode: always call attach to drain any buffered output and resume a paused PTY.
    // This is critical after hard refresh where the PTY may have accumulated
    // output (and been paused due to buffer overflow) while the renderer was reloading.
    void window.fleet.pty.attach(options.paneId).then(({ data }) => {
      if (!term.element) return;
      log.debug('pty.attach', { paneId: options.paneId, bufferedBytes: data.length });
      if (data) writeToTerm(data);

      // Force TUI redraw via the "resize trick" (same technique tmux/dtach use).
      // The kernel suppresses SIGWINCH when ioctl(TIOCSWINSZ) is called with
      // dimensions identical to the PTY's current size. After a hard refresh the
      // xterm instance is new but the PTY retains its old size, so a same-size
      // resize is silently ignored. Momentarily shrinking by one column guarantees
      // two real SIGWINCH signals reach the child process, forcing Ink (Claude
      // Code's TUI framework) to query the new dimensions and fully redraw.
      const cols = term.cols;
      const rows = term.rows;
      window.fleet.pty.resize({ paneId: options.paneId, cols: Math.max(1, cols - 1), rows });
      setTimeout(() => {
        window.fleet.pty.resize({ paneId: options.paneId, cols, rows });
      }, 50);
    });
  } else if (!isPreCreated) {
    createdPtys.add(options.paneId);
    log.debug('pty.create', { paneId: options.paneId, cwd: options.cwd });
    void window.fleet.pty
      .create({
        paneId: options.paneId,
        cwd: options.cwd,
        cmd: options.cmd,
        exitOnComplete: options.exitOnComplete,
        workspaceId: options.workspaceId,
        shellProfileId: options.shellProfileId
      })
      .then(() => {
        // After hard refresh, createdPtys is reset so we hit this path even
        // though the PTY already exists in main (idempotent create). Apply the
        // resize trick to force any running TUI to redraw, same as attachOnly.
        // Harmless on genuinely new PTYs since the shell hasn't drawn yet.
        if (!term.element) return;
        const cols = term.cols;
        const rows = term.rows;
        if (cols > 1) {
          window.fleet.pty.resize({ paneId: options.paneId, cols: cols - 1, rows });
          setTimeout(() => {
            window.fleet.pty.resize({ paneId: options.paneId, cols, rows });
          }, 50);
        }
      });
  } else {
    // For pre-created PTYs (crew deployments), attach to get buffered output
    // and transition to live streaming. This closes the race where PTY data
    // arrives before the renderer mounts the terminal.
    void window.fleet.pty.attach(options.paneId).then(({ data }) => {
      if (!term.element) return; // terminal disposed during round-trip
      log.debug('pty.attach', { paneId: options.paneId, bufferedBytes: data.length });
      if (data) writeToTerm(data);
      attachResolved = true;
      for (const chunk of pendingLiveData) writeToTerm(chunk);
      pendingLiveData.length = 0;

      // Resize trick for pre-created PTYs (crew deployments) that may
      // have been running a TUI before the renderer remounted.
      const cols = term.cols;
      const rows = term.rows;
      if (cols > 1) {
        window.fleet.pty.resize({ paneId: options.paneId, cols: cols - 1, rows });
        setTimeout(() => {
          window.fleet.pty.resize({ paneId: options.paneId, cols, rows });
        }, 50);
      }
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
  const fitPreservingScroll = (): boolean => {
    // Skip while hidden — viewportY is stale and fit() can't measure correctly
    if (container.offsetParent === null) return false;

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
    return true;
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
    container.removeEventListener('contextmenu', contextMenuHandler);
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
      log.debug('pty.resize', { paneId: options.paneId, cols: term.cols, rows: term.rows });
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
        if (fitPreservingScroll()) {
          debouncedPtyResize();
        }
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
      if (fitPreservingScroll()) {
        debouncedPtyResize();
      }
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
    cursorSuppressor,
    flushPendingRuneReadyMarker
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
  const fitPreservingScrollRef = useRef<(() => boolean) | null>(null);
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
      cursorSuppressor,
      flushPendingRuneReadyMarker
    } = createTerminal(container, options);

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    fitPreservingScrollRef.current = fitPreservingScroll;
    scrollToBottomRef.current = scrollToBottom;
    searchAddonRef.current = searchAddon;
    serializeAddonRef.current = serializeAddon;
    serializeRegistry.set(options.paneId, serializeAddon);
    terminalRegistry.set(options.paneId, term);

    return () => {
      log.debug('terminal dispose', { paneId: options.paneId });
      termRef.current = null;
      scrollToBottomRef.current = null;
      serializeRegistry.delete(options.paneId);
      terminalRegistry.delete(options.paneId);
      flushPendingRuneReadyMarker();
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

  // Update terminal colors without re-creating the xterm instance or PTY.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolveXtermTheme(options.terminalTheme, options.backgroundImageActive);
    term.refresh(0, term.rows - 1);
  }, [options.terminalTheme, options.backgroundImageActive]);

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
    fit: () => void fitPreservingScrollRef.current?.(),
    scrollToBottom: () => scrollToBottomRef.current?.(),
    search: (query: string) => searchAddonRef.current?.findNext(query),
    searchPrevious: (query: string) => searchAddonRef.current?.findPrevious(query),
    clearSearch: () => searchAddonRef.current?.clearDecorations(),
    serialize: () => serializeAddonRef.current?.serialize()
  };
}
