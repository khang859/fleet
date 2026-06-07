import { useRef, useState, useEffect, type CSSProperties } from 'react';
import { useTerminal } from '../hooks/use-terminal';
import { useTerminalDrop } from '../hooks/use-terminal-drop';
import { PaneToolbar } from './PaneToolbar';
import { SearchBar } from './SearchBar';
import { openAnnotateModal } from '../lib/annotate-modal-bridge';
import { useCwdStore } from '../store/cwd-store';
import { useWorkspaceStore } from '../store/workspace-store';
import { getFleetSkillContentInput } from '../lib/fleet-skill-prompt';
import type { TerminalThemeId } from '../../../shared/theme-presets';
import type { TerminalBackground } from '../../../shared/types';
import { resolveTerminalTheme } from '../lib/theme';

type TerminalPaneProps = {
  paneId: string;
  cwd: string;
  isActive: boolean;
  onFocus: () => void;
  serializedContent?: string;
  fontFamily?: string;
  fontSize?: number;
  terminalTheme?: TerminalThemeId;
  terminalBackground?: TerminalBackground;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onClose?: () => void;
  shellProfileId?: string;
};

const FIT_STYLES: Record<TerminalBackground['fit'], { size: string; repeat: string }> = {
  cover: { size: 'cover', repeat: 'no-repeat' },
  contain: { size: 'contain', repeat: 'no-repeat' },
  center: { size: 'auto', repeat: 'no-repeat' },
  tile: { size: 'auto', repeat: 'repeat' }
};

// Feather the pane edges to transparent so an image smaller than the pane blends
// into the terminal background instead of ending at a hard border. `fadeX` fades
// the left/right edges, `fadeY` the top/bottom (each a fraction of the pane). When
// both are active the gradients are intersected so the corners fade too.
function edgeFadeStyle(fadeX: number, fadeY: number): CSSProperties {
  if (!fadeX && !fadeY) return {};
  const ramp = (dir: string, fade: number): string => {
    const start = `${(fade * 100).toFixed(1)}%`;
    const end = `${(100 - fade * 100).toFixed(1)}%`;
    return `linear-gradient(to ${dir}, transparent, #000 ${start}, #000 ${end}, transparent)`;
  };
  const layers: string[] = [];
  if (fadeX) layers.push(ramp('right', fadeX));
  if (fadeY) layers.push(ramp('bottom', fadeY));
  return {
    maskImage: layers.join(', '),
    ...(layers.length > 1 ? { maskComposite: 'intersect' } : {})
  };
}

export function TerminalPane({
  paneId,
  cwd,
  isActive,
  onFocus,
  serializedContent,
  fontFamily,
  fontSize,
  terminalTheme,
  terminalBackground,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  shellProfileId
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const workspaceId = useWorkspaceStore((s) => s.workspace.id);
  const hasBackgroundImage = !!terminalBackground?.imagePath;
  const { focus, scrollToBottom, search, searchPrevious, clearSearch } = useTerminal(containerRef, {
    paneId,
    cwd,
    serializedContent,
    isActive,
    fontFamily,
    fontSize,
    terminalTheme,
    backgroundImageActive: hasBackgroundImage,
    workspaceId,
    shellProfileId,
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
      void window.fleet.git.isRepo(currentCwd).then((result) => {
        setIsGitRepo(result.isRepo);
      });
    }, 500);

    return () => {
      if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
    };
  }, [currentCwd]);
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

  return (
    <div
      className="relative h-full w-full overflow-hidden p-3 transition-[box-shadow] duration-0"
      style={{
        backgroundColor: isActive
          ? terminalThemeDef.background
          : terminalThemeDef.inactiveBackground
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
      {terminalBackground?.imagePath && (
        <div
          aria-hidden
          className="absolute z-0 pointer-events-none"
          style={{
            // Over-extend when blurred so the blur's soft edge doesn't reveal the pane border.
            inset: terminalBackground.blur > 0 ? -terminalBackground.blur * 2 : 0,
            // encodeURI so paths with spaces/special chars survive the CSS url() parser.
            backgroundImage: `url("${encodeURI(`fleet-image://${terminalBackground.imagePath}`)}")`,
            backgroundSize: FIT_STYLES[terminalBackground.fit].size,
            backgroundRepeat: FIT_STYLES[terminalBackground.fit].repeat,
            backgroundPosition: 'center',
            opacity: terminalBackground.opacity,
            filter: terminalBackground.blur > 0 ? `blur(${terminalBackground.blur}px)` : undefined,
            ...edgeFadeStyle(terminalBackground.edgeFadeX, terminalBackground.edgeFadeY)
          }}
        />
      )}
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
        onInjectSkills={() => {
          void getFleetSkillContentInput().then((data) => {
            window.fleet.pty.input({ paneId, data });
          });
          focus();
        }}
        onAnnotate={() => openAnnotateModal()}
        onTelescope={() => document.dispatchEvent(new CustomEvent('fleet:toggle-telescope'))}
        onEnvSync={() => document.dispatchEvent(new CustomEvent('fleet:toggle-env-sync'))}
      />
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
          className="absolute bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-md bg-fleet-surface-2/90 px-2.5 py-1.5 text-xs text-fleet-text-secondary shadow-lg backdrop-blur-sm hover:bg-fleet-surface-3 transition-colors"
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
  );
}
