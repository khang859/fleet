import { useRef, useState, useEffect } from 'react';
import { useTerminal } from '../hooks/use-terminal';
import { useTerminalDrop } from '../hooks/use-terminal-drop';
import type { SlideshowFrame } from '../hooks/use-slideshow';
import { resolveBackgroundSrc } from '../lib/pane-background';
import { paneGround, paneBackdrop, PANE_GLASS } from '../lib/theme';
import { PaneToolbar } from './PaneToolbar';
import { PaneHeader } from './PaneHeader';
import { SearchBar } from './SearchBar';
import { openAnnotateModal } from '../lib/annotate-modal-bridge';
import { useCwdStore } from '../store/cwd-store';
import { useWorkspaceStore, getPaneContextById } from '../store/workspace-store';
import type { TerminalThemeId } from '../../../shared/theme-presets';
import type { TerminalBackground } from '../../../shared/types';
import { resolveTerminalTheme } from '../lib/theme';

type TerminalPaneProps = {
  paneId: string;
  cwd: string;
  isActive: boolean;
  /** Shown in the pane's own title bar, which every pane now carries. */
  label?: string;
  labelIsCustom?: boolean;
  onFocus: () => void;
  serializedContent?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollbackSize?: number;
  terminalTheme?: TerminalThemeId;
  terminalBackground?: TerminalBackground;
  slideshowFrame?: SlideshowFrame;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onClose?: () => void;
  shellProfileId?: string;
  cmd?: string;
};

export function TerminalPane({
  paneId,
  cwd,
  isActive,
  label,
  labelIsCustom,
  onFocus,
  serializedContent,
  fontFamily,
  fontSize,
  scrollbackSize,
  terminalTheme,
  terminalBackground,
  slideshowFrame,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  shellProfileId,
  cmd
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const workspaceId = useWorkspaceStore((s) => s.workspace.id);
  // Keeps xterm transparent whenever a layer is visible.
  const hasBackgroundImage = resolveBackgroundSrc(terminalBackground, slideshowFrame) !== null;
  const { focus, scrollToBottom, search, searchPrevious, clearSearch } = useTerminal(containerRef, {
    paneId,
    cwd,
    serializedContent,
    isActive,
    fontFamily,
    fontSize,
    scrollback: scrollbackSize,
    terminalTheme,
    backgroundImageActive: hasBackgroundImage,
    workspaceId,
    shellProfileId,
    ...(cmd !== undefined ? { cmd, exitOnComplete: false } : {}),
    onScrollStateChange: setIsScrolledUp
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const currentCwd = useCwdStore((s) => s.cwds.get(paneId));
  const gitCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isDragOver, handlers: dragHandlers } = useTerminalDrop(paneId, focus);
  const terminalThemeDef = resolveTerminalTheme(terminalTheme);

  // Seed the CWD store with the pane's initial cwd on mount so that
  // git-changes and other CWD-dependent tools work immediately after
  // workspace restore, before OSC 7 or CWD polling has fired.
  useEffect(() => {
    if (cwd && !useCwdStore.getState().cwds.has(paneId)) {
      useCwdStore.getState().setCwd(paneId, cwd);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!currentCwd) {
      setIsGitRepo(false);
      return;
    }

    if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
    gitCheckTimerRef.current = setTimeout(() => {
      void window.fleet.git.isRepo(currentCwd, getPaneContextById(paneId)).then((result) => {
        setIsGitRepo(result.isRepo);
      });
    }, 500);

    return () => {
      if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
    };
  }, [currentCwd, paneId]);
  // Listen for search toggle events targeted at this pane
  useEffect(() => {
    const handler = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const detail = e.detail as { paneId?: string } | undefined;
      if (detail?.paneId === paneId) {
        setSearchOpen((prev) => !prev);
      }
    };
    document.addEventListener('fleet:toggle-search', handler);
    return () => document.removeEventListener('fleet:toggle-search', handler);
  }, [paneId]);

  // Listen for refocus events (e.g. after overlay paste)
  useEffect(() => {
    const handler = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const detail = e.detail as { paneId?: string } | undefined;
      if (detail?.paneId === paneId) {
        focus();
      }
    };
    document.addEventListener('fleet:refocus-pane', handler);
    return () => document.removeEventListener('fleet:refocus-pane', handler);
  }, [paneId, focus]);

  // The actions belong to the title bar, so they are built here and handed to
  // it rather than floated over the terminal - which is what used to put them
  // on top of the first line of output.
  const toolbar = (
    <PaneToolbar
      visible={hovered}
      isGitRepo={isGitRepo}
      onSplitHorizontal={() => onSplitHorizontal?.()}
      onSplitVertical={() => onSplitVertical?.()}
      onClose={() => onClose?.()}
      onSearch={() => setSearchOpen(true)}
      onGitChanges={() => document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'))}
      onFileSearch={() => document.dispatchEvent(new CustomEvent('fleet:toggle-file-search'))}
      onClipboardHistory={() =>
        document.dispatchEvent(new CustomEvent('fleet:toggle-clipboard-history'))
      }
      onAnnotate={() => openAnnotateModal()}
      onTelescope={() => document.dispatchEvent(new CustomEvent('fleet:toggle-telescope'))}
      onNotes={() => document.dispatchEvent(new CustomEvent('fleet:toggle-notes'))}
      onEnvSync={() => document.dispatchEvent(new CustomEvent('fleet:toggle-env-sync'))}
      onEnvEditor={() => document.dispatchEvent(new CustomEvent('fleet:toggle-env-editor'))}
    />
  );

  return (
    <div
      className="flex h-full w-full flex-col"
      style={{
        // Glass over the app canvas: the terminal keeps only a tint of its own
        // theme colour so the picture behind the window reads straight through
        // it. With no image it stays fully opaque.
        backgroundColor: paneGround(
          isActive ? terminalThemeDef.background : terminalThemeDef.inactiveBackground,
          hasBackgroundImage,
          terminalBackground?.paneTint ?? PANE_GLASS
        ),
        backdropFilter: paneBackdrop(
          hasBackgroundImage,
          terminalBackground?.paneFrost ?? 0,
          terminalBackground?.paneSaturation ?? 1
        )
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={onFocus}
      onClick={() => {
        onFocus();
        focus();
      }}
      {...dragHandlers}
    >
      <PaneHeader paneId={paneId} label={label} labelIsCustom={labelIsCustom} actions={toolbar} />
      <div className="relative min-h-0 flex-1 overflow-hidden p-4">
        <SearchBar
          isOpen={searchOpen}
          onClose={() => {
            setSearchOpen(false);
            clearSearch();
            focus();
          }}
          onSearch={(q) => search(q)}
          onSearchPrevious={(q) => searchPrevious(q)}
        />
        <div ref={containerRef} className="relative z-10 h-full w-full" />
        {isScrolledUp && (
          <button
            className="absolute bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-md bg-fleet-surface-2/90 px-2.5 py-1.5 text-xs text-fleet-text-secondary shadow-lg backdrop-blur-sm hover:bg-fleet-surface-3 transition-colors active:scale-[0.97]"
            onClick={(e) => {
              e.stopPropagation();
              scrollToBottom();
              focus();
            }}
            tabIndex={-1}
            aria-label="Scroll to bottom"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M2 4l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>Bottom</span>
          </button>
        )}
        {isDragOver && (
          <div className="absolute inset-0 z-50 flex items-center justify-center fleet-accent-bg-soft border-2 border-dashed fleet-accent-border rounded pointer-events-none">
            <span className="fleet-accent-text text-sm font-medium">Drop to paste file path</span>
          </div>
        )}
      </div>
    </div>
  );
}
