import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, Plus } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { ConversationList } from './ConversationList';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { PermissionBar } from './PermissionBar';
import { UsageMeter } from './UsageMeter';
import { ArtifactPanel } from './ArtifactPanel';
import { usePresence } from '../../hooks/use-presence';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { DEFAULT_CHAT_USAGE, type ChatUsageConfig } from '../../../../shared/chat-types';

type Props = { onOpenSettings: () => void };

export function ChatView({ onOpenSettings }: Props): React.JSX.Element {
  const init = useChatStore((s) => s.init);
  const keyPresent = useChatStore((s) => s.keyPresent);
  const activeId = useChatStore((s) => s.activeId);
  const newConversation = useChatStore((s) => s.newConversation);
  const artifact = useChatStore((s) => s.activeArtifact);
  const reduced = useReducedMotion();
  // Shared positioning host for the two bottom-anchored overlays (MessageList's
  // "Jump to latest" pill and the PermissionBar). The bar publishes its measured
  // height here as a CSS var so the pill can lift itself clear of the bar.
  const overlayHostRef = useRef<HTMLDivElement>(null);
  // Keep the panel mounted through its close animation; render the last shown
  // artifact during the exit so it slides shut instead of vanishing.
  const { mounted: panelMounted, state: panelState } = usePresence(!!artifact, reduced ? 0 : 220);
  const shownArtifact = useRef(artifact);
  if (artifact) shownArtifact.current = artifact;
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
            <div ref={overlayHostRef} className="relative flex min-h-0 flex-1 flex-col">
              <MessageList defaultModel={defaultModel} showUsage={usage.showMeter} />
              <PermissionBar hostRef={overlayHostRef} />
            </div>
            {usage.showMeter && <UsageMeter budgetWarnUsd={usage.budgetWarnUsd} />}
            {/* Key on activeId so the composer remounts on conversation switch —
                its draft/attachments/mentions are local state and must not bleed
                across conversations (a draft for A could otherwise send to B). */}
            <Composer key={activeId} defaultModel={defaultModel} />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <MessageSquarePlus size={32} className="text-fleet-text-subtle" strokeWidth={1.5} />
            <div className="space-y-1">
              <p className="text-sm font-medium text-fleet-text">No conversation selected</p>
              <p className="text-xs text-fleet-text-muted">
                Ask about your code, generate images, or fetch docs.
              </p>
            </div>
            <button
              onClick={() => void newConversation()}
              className="fleet-accent-bg fleet-accent-bg-hover flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium text-white transition-colors focus-ring"
            >
              <Plus size={15} /> New chat
            </button>
          </div>
        )}
      </div>
      {panelMounted && shownArtifact.current && (
        <ArtifactPanel
          key={`${shownArtifact.current.messageId}:${shownArtifact.current.index}`}
          artifact={shownArtifact.current}
          presenceOpen={panelState === 'open'}
        />
      )}
    </div>
  );
}
