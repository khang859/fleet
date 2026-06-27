import { Check, Loader2 } from 'lucide-react';
import { useChatSettings } from './use-chat-settings';

/** Quiet, instant-apply feedback so users know changes took effect (NN/g: visibility of system status). */
export function SaveStatus(): React.JSX.Element {
  const { status } = useChatSettings();

  if (status === 'idle') return <span className="h-4" />;

  return (
    <span className="flex items-center gap-1.5 text-xs text-fleet-text-muted duration-150 animate-in fade-in">
      {status === 'saving' ? (
        <>
          <Loader2 size={12} className="animate-spin" /> Saving…
        </>
      ) : (
        <>
          <Check size={12} className="text-emerald-400" /> Saved
        </>
      )}
    </span>
  );
}
