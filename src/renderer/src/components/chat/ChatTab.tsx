import { useState } from 'react';
import { MessageSquare, Settings } from 'lucide-react';
import { ChatView } from './ChatView';
import { ChatSettingsView } from './ChatSettingsView';

type View = 'chat' | 'settings';

export function ChatTab(): React.JSX.Element {
  const [view, setView] = useState<View>('chat');

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-fleet-border px-3 py-1.5">
        <button
          onClick={() => setView('chat')}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm ${
            view === 'chat'
              ? 'bg-fleet-surface-2 text-fleet-text'
              : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
          }`}
        >
          <MessageSquare size={14} /> Chat
        </button>
        <button
          onClick={() => setView('settings')}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm ${
            view === 'settings'
              ? 'bg-fleet-surface-2 text-fleet-text'
              : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
          }`}
        >
          <Settings size={14} /> Settings
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'chat' ? (
          <ChatView onOpenSettings={() => setView('settings')} />
        ) : (
          <ChatSettingsView />
        )}
      </div>
    </div>
  );
}
