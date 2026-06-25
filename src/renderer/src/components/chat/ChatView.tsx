import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { ConversationList } from './ConversationList';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

type Props = { onOpenSettings: () => void };

export function ChatView({ onOpenSettings }: Props): React.JSX.Element {
  const init = useChatStore((s) => s.init);
  const keyPresent = useChatStore((s) => s.keyPresent);
  const activeId = useChatStore((s) => s.activeId);
  const [defaultModel, setDefaultModel] = useState('deepseek/deepseek-v4-flash');

  useEffect(() => {
    void init();
    void window.fleet.chat.getSettings().then((s) => setDefaultModel(s.defaultModel));
  }, [init]);

  return (
    <div className="flex h-full">
      <ConversationList />
      <div className="flex min-w-0 flex-1 flex-col">
        {!keyPresent && (
          <div className="flex items-center justify-between gap-3 border-b border-fleet-border bg-fleet-surface-2 px-4 py-2 text-sm text-fleet-text-secondary">
            <span>Add your OpenRouter API key to start chatting.</span>
            <button
              onClick={onOpenSettings}
              className="rounded bg-fleet-accent/80 px-3 py-1 text-white"
            >
              Open Settings
            </button>
          </div>
        )}
        {activeId ? (
          <>
            <MessageList />
            <Composer defaultModel={defaultModel} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-fleet-text-muted">
            Start a new chat from the left.
          </div>
        )}
      </div>
    </div>
  );
}
