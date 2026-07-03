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
    <div
      onClick={onClick}
      className="cursor-pointer rounded-md overflow-hidden relative transition-all"
      style={{
        background: isActive ? '#0d0a1a' : 'rgba(13,10,26,0.4)',
        border: isActive ? '1px solid rgba(96,165,250,0.35)' : '1px solid rgba(255,255,255,0.05)'
      }}
    >
      <div className="relative z-20 flex items-center gap-2.5 px-2.5 py-2">
        <div className="flex-shrink-0 w-8 h-8 rounded-sm overflow-hidden bg-fleet-surface-2/50 flex items-center justify-center">
          <History size={16} className={isActive ? 'text-blue-400' : 'text-blue-400/50'} />
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="font-mono uppercase tracking-widest leading-none mb-1"
            style={{
              fontSize: '9px',
              color: isActive ? 'rgb(96,165,250)' : 'rgba(96,165,250,0.5)'
            }}
          >
            Sessions
          </div>
          <span className="text-[9px] font-mono text-fleet-text-subtle">
            {sessions.length > 0 ? (
              <span className="text-blue-300/70">{sessions.length} saved</span>
            ) : (
              <span>none yet</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
