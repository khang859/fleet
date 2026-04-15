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
    <div className="flex-shrink-0 flex items-center gap-2 px-3 h-7 bg-neutral-950/80 border-b border-neutral-800 text-xs">
      <span className="flex-1 min-w-0 truncate text-neutral-300 font-mono" title={filePath}>
        {filePath}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
        title={copied ? 'Copied!' : 'Copy path'}
        aria-label="Copy path"
      >
        {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      </button>
    </div>
  );
}
