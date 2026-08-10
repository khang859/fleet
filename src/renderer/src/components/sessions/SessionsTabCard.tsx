import { useEffect } from 'react';
import { History } from 'lucide-react';
import { useSessionsStore } from '../../store/sessions-store';

export function SessionsTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { sessions, isLoaded, load } = useSessionsStore();

  useEffect(() => {
    if (!isLoaded) void load();
  }, [isLoaded, load]);

  useEffect(() => {
    const cleanup = window.fleet.sessions.onChanged(() => void load());
    return cleanup;
  }, [load]);

  return (
    // Theme tokens rather than the hardcoded near-black purple this used to
    // paint itself: on the canvas a card that ignores the theme reads as a
    // sticker rather than as part of the app.
    <div
      onClick={onClick}
      className={`cursor-pointer rounded-md overflow-hidden relative border transition-colors ${
        isActive
          ? 'bg-fleet-glass-surface-2 border-fleet-border-strong'
          : 'bg-fleet-glass-surface border-fleet-border hover:bg-fleet-glass-surface-2'
      }`}
    >
      <div className="relative z-20 flex items-center gap-2.5 px-2.5 py-2">
        <div className="flex-shrink-0 w-8 h-8 rounded-md overflow-hidden bg-fleet-surface-2/50 flex items-center justify-center">
          <History size={16} className={isActive ? 'text-blue-400' : 'text-blue-400/60'} />
        </div>
        <div className="flex-1 min-w-0">
          <div
            className={`text-xs font-medium leading-tight ${
              isActive ? 'text-fleet-text' : 'text-fleet-text-secondary'
            }`}
          >
            Sessions
          </div>
          <span className="text-[11px] leading-tight text-fleet-text-muted tabular-nums">
            {sessions.length > 0 ? `${sessions.length} saved` : 'none yet'}
          </span>
        </div>
      </div>
    </div>
  );
}
