import { useState } from 'react';
import { MessageSquare, Settings, ScrollText } from 'lucide-react';
import { ChatView } from './ChatView';
import { ChatSettingsView } from './ChatSettingsView';
import { AuditLogView } from './AuditLogView';

type View = 'chat' | 'activity' | 'settings';

export function ChatTab(): React.JSX.Element {
  const [view, setView] = useState<View>('chat');

  const tabClass = (active: boolean): string =>
    `flex items-center gap-1.5 rounded px-2 py-1 text-sm ${
      active
        ? 'bg-fleet-surface-2 text-fleet-text'
        : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-fleet-border px-3 py-1.5">
        <button onClick={() => setView('chat')} className={tabClass(view === 'chat')}>
          <MessageSquare size={14} /> Chat
        </button>
        <button onClick={() => setView('activity')} className={tabClass(view === 'activity')}>
          <ScrollText size={14} /> Activity
        </button>
        <button onClick={() => setView('settings')} className={tabClass(view === 'settings')}>
          <Settings size={14} /> Settings
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'chat' && <ChatView onOpenSettings={() => setView('settings')} />}
        {view === 'activity' && <AuditLogView />}
        {view === 'settings' && <ChatSettingsView />}
      </div>
    </div>
  );
}
