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
    // The viewer panes' title bar. Same bar as `PaneHeader`, so it carries the
    // same focus cue - lit when the pane has focus, grey when it does not.
    <div className="flex-shrink-0 flex items-center gap-2 px-3 h-7 bg-fleet-glass-surface group-data-[pane-active=true]/pane:bg-fleet-glass-surface-3 border-b border-fleet-border text-xs transition-colors">
      <span
        className="flex-1 min-w-0 truncate font-mono text-fleet-text-subtle group-data-[pane-active=true]/pane:text-fleet-text-secondary transition-colors"
        title={filePath}
      >
        {filePath}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 p-1 rounded hover:bg-fleet-surface-3 text-fleet-text-subtle hover:text-fleet-text transition-colors active:scale-90"
        title={copied ? 'Copied!' : 'Copy path'}
        aria-label="Copy path"
      >
        {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      </button>
    </div>
  );
}
