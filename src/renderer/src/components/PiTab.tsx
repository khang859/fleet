import { useRef, useState, useEffect } from 'react';
import { useTerminal } from '../hooks/use-terminal';
import type { Tab } from '../../../shared/types';

type PiTabProps = {
  tab: Tab;
  isActive: boolean;
  fontFamily?: string;
  fontSize?: number;
};

export function PiTab({ tab, isActive, fontFamily, fontSize }: PiTabProps): React.JSX.Element {
  const paneId = tab.splitRoot.type === 'leaf' ? tab.splitRoot.id : '';
  const [piReady, setPiReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launchConfigRef = useRef<{ cmd: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.fleet.pi.getLaunchConfig(paneId).then((config) => {
      if (cancelled) return;
      launchConfigRef.current = config;
      setPiReady(true);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [paneId]);

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#151515] text-red-400 text-sm p-4">
        <div className="max-w-md text-center">
          <p className="font-medium mb-2">Failed to launch Pi agent</p>
          <p className="text-neutral-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!piReady) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#151515] text-neutral-400 text-sm">
        Installing Pi agent...
      </div>
    );
  }

  return (
    <PiTerminal
      key={paneId}
      paneId={paneId}
      cwd={tab.cwd}
      isActive={isActive}
      fontFamily={fontFamily}
      fontSize={fontSize}
      launchConfig={launchConfigRef.current!}
    />
  );
}

function PiTerminal({
  paneId,
  cwd,
  isActive,
  fontFamily,
  fontSize,
  launchConfig,
}: {
  paneId: string;
  cwd: string;
  isActive: boolean;
  fontFamily?: string;
  fontSize?: number;
  launchConfig: { cmd: string };
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  const { focus, scrollToBottom } = useTerminal(containerRef, {
    paneId,
    cwd,
    cmd: launchConfig.cmd,
    isActive,
    fontFamily,
    fontSize,
    cursorHidden: true,
    onScrollStateChange: setIsScrolledUp,
  });

  return (
    <div
      className="relative h-full w-full overflow-hidden p-3 bg-[#151515]"
      onClick={() => focus()}
    >
      <div ref={containerRef} className="h-full w-full" />
      {isScrolledUp && (
        <button
          className="absolute bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-md bg-neutral-800/90 px-2.5 py-1.5 text-xs text-neutral-300 shadow-lg backdrop-blur-sm hover:bg-neutral-700 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            scrollToBottom();
            focus();
          }}
          tabIndex={-1}
          aria-label="Scroll to bottom"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Bottom</span>
        </button>
      )}
    </div>
  );
}
