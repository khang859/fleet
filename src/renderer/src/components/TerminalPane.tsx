import { useRef } from 'react';
import { useTerminal } from '../hooks/use-terminal';

type TerminalPaneProps = {
  paneId: string;
  cwd: string;
  isActive: boolean;
  onFocus: () => void;
  serializedContent?: string;
};

export function TerminalPane({ paneId, cwd, isActive, onFocus, serializedContent }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { fit } = useTerminal(containerRef, { paneId, cwd, serializedContent });

  return (
    <div
      className={`h-full w-full overflow-hidden p-3 transition-[box-shadow] duration-0 ${isActive ? 'ring-2 ring-blue-500/70 bg-[#151515]' : 'ring-1 ring-neutral-800/50 bg-[#131313]'}`}
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
