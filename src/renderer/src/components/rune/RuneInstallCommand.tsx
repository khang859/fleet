import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { RUNE_INSTALL_COMMAND } from '../../../../shared/rune';

/**
 * The Rune install one-liner with a Copy button. Shared by the Settings status row and the
 * Kanban pre-flight banner so both surfaces present the exact same install command (NN/g:
 * constructive recovery — give the user the fix, not just the problem).
 */
export function RuneInstallCommand(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(RUNE_INSTALL_COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-neutral-950 px-2 py-1.5 text-xs text-neutral-300 border border-neutral-800">
        {RUNE_INSTALL_COMMAND}
      </code>
      <button
        onClick={copy}
        aria-label="Copy install command"
        className="flex shrink-0 items-center gap-1 rounded border border-neutral-700 px-2 py-1.5 text-xs hover:bg-neutral-800"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-400" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
