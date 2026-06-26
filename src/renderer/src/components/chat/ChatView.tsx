import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { ConversationList } from './ConversationList';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { UsageMeter } from './UsageMeter';
import { ArtifactPanel } from './ArtifactPanel';
import { DEFAULT_CHAT_USAGE, type ChatUsageConfig } from '../../../../shared/chat-types';

type Props = { onOpenSettings: () => void };

export function ChatView({ onOpenSettings }: Props): React.JSX.Element {
  const init = useChatStore((s) => s.init);
  const keyPresent = useChatStore((s) => s.keyPresent);
  const activeId = useChatStore((s) => s.activeId);
  const artifact = useChatStore((s) => s.activeArtifact);
  const [defaultModel, setDefaultModel] = useState('deepseek/deepseek-v4-flash');
  const [usage, setUsage] = useState<ChatUsageConfig>(DEFAULT_CHAT_USAGE);

  useEffect(() => {
    void init();
    void window.fleet.chat.getSettings().then((s) => {
      setDefaultModel(s.defaultModel);
      setUsage(s.usage);
    });
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
            <MessageList defaultModel={defaultModel} showUsage={usage.showMeter} />
            {usage.showMeter && <UsageMeter budgetWarnUsd={usage.budgetWarnUsd} />}
            <Composer defaultModel={defaultModel} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-fleet-text-muted">
            Start a new chat from the left.
          </div>
        )}
      </div>
      {artifact && <ArtifactPanel key={`${artifact.messageId}:${artifact.index}`} />}
    </div>
  );
}
