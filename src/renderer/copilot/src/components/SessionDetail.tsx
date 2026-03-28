import { useEffect, useRef, useState } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { ChatMessageItem } from './ChatMessage';

export function SessionDetail(): React.JSX.Element | null {
  const selectedSessionId = useCopilotStore((s) => s.selectedSessionId);
  const sessions = useCopilotStore((s) => s.sessions);
  const backToList = useCopilotStore((s) => s.backToList);
  const respondPermission = useCopilotStore((s) => s.respondPermission);
  const chatMessages = useCopilotStore((s) => s.chatMessages);
  const chatLoading = useCopilotStore((s) => s.chatLoading);
  const loadChatHistory = useCopilotStore((s) => s.loadChatHistory);
  const sendMessage = useCopilotStore((s) => s.sendMessage);

  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const session = sessions.find((s) => s.sessionId === selectedSessionId);

  // Load chat history when session is selected
  useEffect(() => {
    if (session) {
      loadChatHistory(session.sessionId, session.cwd);
    }
  }, [session?.sessionId, session?.cwd, loadChatHistory]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages.length]);

  const handleSend = async (): Promise<void> => {
    const text = inputText.trim();
    if (!text || !session) return;
    setInputText('');
    await sendMessage(session.sessionId, text);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!session) {
    return (
      <div className="flex flex-col h-full bg-neutral-900 rounded-lg border border-neutral-700">
        <div className="flex items-center px-3 py-2 border-b border-neutral-700">
          <button onClick={backToList} className="text-xs text-neutral-400 hover:text-neutral-200">
            ← Back
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-xs">
          Session not found
        </div>
      </div>
    );
  }

  const canSendMessage = session.phase === 'waitingForInput';

  return (
    <div className="flex flex-col h-full bg-neutral-900 rounded-lg border border-neutral-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <button onClick={backToList} className="text-xs text-neutral-400 hover:text-neutral-200">
          ←
        </button>
        <span className="text-xs font-medium text-neutral-200 truncate">
          {session.projectName}
        </span>
        <span className="text-[9px] text-neutral-500 ml-auto">{session.phase}</span>
      </div>

      {/* Pending permissions */}
      {session.pendingPermissions.length > 0 && (
        <div className="px-3 py-2 border-b border-neutral-800">
          <div className="text-[10px] font-medium text-amber-400 mb-1">
            Pending Permissions
          </div>
          {session.pendingPermissions.map((perm) => (
            <div key={perm.toolUseId} className="mb-2 p-2 bg-neutral-800/50 rounded border border-amber-500/20">
              <div className="text-xs text-neutral-200 font-medium">
                {perm.tool.toolName}
              </div>
              {Object.keys(perm.tool.toolInput).length > 0 && (
                <pre className="mt-1 text-[10px] text-neutral-400 overflow-x-auto max-h-24 overflow-y-auto">
                  {JSON.stringify(perm.tool.toolInput, null, 2)}
                </pre>
              )}
              <div className="flex gap-1 mt-2">
                <button
                  onClick={() => respondPermission(perm.toolUseId, 'allow')}
                  className="px-2 py-1 text-[10px] bg-green-600/30 text-green-400 rounded hover:bg-green-600/50"
                >
                  Allow
                </button>
                <button
                  onClick={() => respondPermission(perm.toolUseId, 'deny')}
                  className="px-2 py-1 text-[10px] bg-red-600/30 text-red-400 rounded hover:bg-red-600/50"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chat messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {chatLoading && chatMessages.length === 0 && (
          <div className="text-[10px] text-neutral-500 text-center mt-4">Loading...</div>
        )}
        {!chatLoading && chatMessages.length === 0 && (
          <div className="text-[10px] text-neutral-500 text-center mt-4">No messages yet</div>
        )}
        {chatMessages.map((msg) => (
          <ChatMessageItem key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="px-3 py-2 border-t border-neutral-800">
        <div className="flex gap-1.5 items-end">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!canSendMessage}
            placeholder={
              canSendMessage
                ? 'Message Claude...'
                : session.tty
                  ? `Claude is ${session.phase}...`
                  : 'No TTY — cannot send messages'
            }
            className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-500 outline-none focus:border-blue-500/50 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!canSendMessage || !inputText.trim()}
            className="px-2 py-1 text-[10px] bg-blue-600/30 text-blue-400 rounded hover:bg-blue-600/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
