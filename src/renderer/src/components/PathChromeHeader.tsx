import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

type Props = {
  filePath: string;
};

export function PathChromeHeader({ filePath }: Props): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(filePath);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [filePath]);

  return (
    // The viewer panes' title bar. Same treatment as `PaneHeader`, down to the
    // pill height, so a window of mixed panes has one kind of title on it: a
    // label floating on the pane rather than a strip of chrome above it. It
    // carries the same focus cue - lit when the pane has focus, grey when it
    // does not. Still in flow, so it can never sit over the content below.
    <div className="flex-shrink-0 flex items-center h-7 px-1.5 text-xs">
      <div className="flex h-[22px] min-w-0 items-center gap-1.5 rounded-full px-2 bg-fleet-glass-surface group-data-[pane-active=true]/pane:bg-fleet-glass-surface-3 transition-colors">
        <span
          className="min-w-0 truncate font-mono text-fleet-text-subtle group-data-[pane-active=true]/pane:text-fleet-text-secondary transition-colors"
          title={filePath}
        >
          {filePath}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 p-0.5 rounded hover:bg-fleet-surface-3 text-fleet-text-subtle hover:text-fleet-text transition-colors active:scale-90"
          title={copied ? 'Copied!' : 'Copy path'}
          aria-label="Copy path"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
        </button>
      </div>
      <div className="min-w-0 flex-1" />
    </div>
  );
}
