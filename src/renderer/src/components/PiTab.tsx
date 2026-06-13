import { useRef, useState, useEffect } from 'react';
import { z } from 'zod';
import { useTerminal } from '../hooks/use-terminal';
import { useWorkspaceStore, getPaneContextById } from '../store/workspace-store';
import { PaneToolbar } from './PaneToolbar';
import { SearchBar } from './SearchBar';
import { openAnnotateModal } from '../lib/annotate-modal-bridge';
import { getFleetSkillContentInput } from '../lib/fleet-skill-prompt';
import type { Tab } from '../../../shared/types';
import type { TerminalThemeId } from '../../../shared/theme-presets';
import { resolveTerminalTheme } from '../lib/theme';

type PiTabProps = {
  tab: Tab;
  isActive: boolean;
  fontFamily?: string;
  fontSize?: number;
  terminalTheme?: TerminalThemeId;
};

export function PiTab({
  tab,
  isActive,
  fontFamily,
  fontSize,
  terminalTheme
}: PiTabProps): React.JSX.Element {
  const paneId = tab.splitRoot.type === 'leaf' ? tab.splitRoot.id : '';
  const terminalThemeDef = resolveTerminalTheme(terminalTheme);
  const [piReady, setPiReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launchConfigRef = useRef<{ cmd: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.fleet.pi
      .getLaunchConfig(paneId)
      .then((config) => {
        if (cancelled) return;
        launchConfigRef.current = config;
        setPiReady(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [paneId]);

  if (error) {
    return (
      <div
        className="h-full w-full flex items-center justify-center text-red-400 text-sm p-4"
        style={{ backgroundColor: terminalThemeDef.background }}
      >
        <div className="max-w-md text-center">
          <p className="font-medium mb-2">Failed to launch Pi agent</p>
          <p className="text-neutral-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!piReady) {
    return (
      <div
        className="h-full w-full flex items-center justify-center text-neutral-400 text-sm"
        style={{ backgroundColor: terminalThemeDef.background }}
      >
        Installing Pi agent...
      </div>
    );
  }

  return (
    <PiTerminal
      key={paneId}
      tabId={tab.id}
      paneId={paneId}
      cwd={tab.cwd}
      isActive={isActive}
      fontFamily={fontFamily}
      fontSize={fontSize}
      terminalTheme={terminalTheme}
      launchConfig={launchConfigRef.current!}
    />
  );
}

const PaneEventDetailSchema = z.object({ paneId: z.string() });

function PiTerminal({
  tabId,
  paneId,
  cwd,
  isActive,
  fontFamily,
  fontSize,
  terminalTheme,
  launchConfig
}: {
  tabId: string;
  paneId: string;
  cwd: string;
  isActive: boolean;
  fontFamily?: string;
  fontSize?: number;
  terminalTheme?: TerminalThemeId;
  launchConfig: { cmd: string };
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const gitCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const terminalThemeDef = resolveTerminalTheme(terminalTheme);

  const { focus, scrollToBottom, search, searchPrevious, clearSearch } = useTerminal(containerRef, {
    paneId,
    cwd,
    cmd: launchConfig.cmd,
    exitOnComplete: true,
    isActive,
    fontFamily,
    fontSize,
    terminalTheme,
    cursorHidden: true,
    onScrollStateChange: setIsScrolledUp
  });

  useEffect(() => {
    if (!cwd) {
      setIsGitRepo(false);
      return;
    }
    if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
    gitCheckTimerRef.current = setTimeout(() => {
      void window.fleet.git.isRepo(cwd, getPaneContextById(paneId)).then((result) => {
        setIsGitRepo(result.isRepo);
      });
    }, 500);
    return () => {
      if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
    };
  }, [cwd, paneId]);

  useEffect(() => {
    const handler = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const parsed = PaneEventDetailSchema.safeParse(e.detail);
      if (parsed.success && parsed.data.paneId === paneId) {
        setSearchOpen((prev) => !prev);
      }
    };
    document.addEventListener('fleet:toggle-search', handler);
    return () => document.removeEventListener('fleet:toggle-search', handler);
  }, [paneId]);

  return (
    <div
      className="relative h-full w-full overflow-hidden p-3"
      style={{ backgroundColor: terminalThemeDef.background }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => focus()}
    >
      <PaneToolbar
        visible={hovered}
        isGitRepo={isGitRepo}
        onClose={() => closeTab(tabId)}
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
        onEnvEditor={() => document.dispatchEvent(new CustomEvent('fleet:toggle-env-editor'))}
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
      <div ref={containerRef} className="h-full w-full" />
      {isScrolledUp && (
        <button
          className="absolute bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-md bg-neutral-800/90 px-2.5 py-1.5 text-xs text-neutral-300 shadow-lg backdrop-blur-sm hover:bg-neutral-700 transition-colors active:scale-[0.97]"
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
    </div>
  );
}
