import { useRef } from 'react';
import { useTerminal } from '../hooks/use-terminal';

type TerminalPaneProps = {
  paneId: string;
  cwd: string;
  isActive: boolean;
  onFocus: () => void;
};

export function TerminalPane({ paneId, cwd, isActive, onFocus }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { fit } = useTerminal(containerRef, { paneId, cwd });

  return (
    <div
      className={`h-full w-full overflow-hidden p-3 transition-[box-shadow] duration-0 ${isActive ? 'ring-2 ring-blue-500/70 bg-[#0c0c0c]' : 'ring-1 ring-neutral-800/50 bg-[#0a0a0a]'}`}
      onFocus={onFocus}
      onClick={() => {
        onFocus();
        fit();
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
