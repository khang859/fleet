import { useEffect, useRef, useState } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { ChatMessageItem } from './ChatMessage';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Badge } from './ui/badge';
import { ChevronLeft, ArrowUp } from 'lucide-react';
import { PermissionRequest } from './PermissionRequest';
import { GoToTerminalButton } from './GoToTerminalButton';
import { ModeLabel } from './ModeLabel';
import { sessionStatus, statusLabel } from '../lib/sessions';
import { RUNTIMES } from '../../../../shared/session-runtimes';

export function SessionDetail(): React.JSX.Element | null {
  const selectedSessionId = useCopilotStore((s) => s.selectedSessionId);
  const sessions = useCopilotStore((s) => s.sessions);
  const backToList = useCopilotStore((s) => s.backToList);
  const chatMessages = useCopilotStore((s) => s.chatMessages);
  const chatLoading = useCopilotStore((s) => s.chatLoading);
  const loadChatHistory = useCopilotStore((s) => s.loadChatHistory);
  const sendMessage = useCopilotStore((s) => s.sendMessage);

  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Follow new messages only while the end is in view, so reading back is not interrupted.
  const atBottomRef = useRef(true);

  const session = sessions.find((s) => s.sessionId === selectedSessionId);
  // Depend on the identity fields, not the object: `sessions` is rebuilt on every store
  // update, so keying the effect on `session` itself would refetch the history constantly.
  const sessionId = session?.sessionId;
  const sessionCwd = session?.cwd;

  useEffect(() => {
    if (sessionId !== undefined && sessionCwd !== undefined) {
      void loadChatHistory(sessionId, sessionCwd);
    }
  }, [sessionId, sessionCwd, loadChatHistory]);

  useEffect(() => {
    const end = messagesEndRef.current;
    if (!end) return;
    const observer = new IntersectionObserver(([entry]) => {
      atBottomRef.current = entry.isIntersecting;
    });
    observer.observe(end);
    return () => observer.disconnect();
  }, [sessionId]);

  useEffect(() => {
    // Instant, not smooth: a smooth scroll still in flight reads as "scrolled up" to the observer.
    if (atBottomRef.current) messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [chatMessages.length]);

  const handleSend = async (): Promise<void> => {
    const text = inputText.trim();
    if (!text || !session) return;
    setInputText('');
    // Refused while the user has text in the terminal or is typing there: keep it.
    if (!(await sendMessage(session.sessionId, text))) setInputText(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  if (!session) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex flex-col h-full overflow-hidden">
          <div className="flex items-center px-3 py-2 border-b border-neutral-700">
            <Button variant="ghost" size="sm" onClick={backToList}>
              <ChevronLeft size={14} /> Back
            </Button>
          </div>
          <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
            Session not found
          </div>
        </div>
      </TooltipProvider>
    );
  }

  // A question dialog is answered from its options in the chat, never with free text.
  const canSendMessage = session.phase === 'waitingForInput' && session.waitingKind !== 'question';
  const status = sessionStatus(session);
  const label = statusLabel(session);
  const agent = RUNTIMES[session.runtime].label;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
          <Button variant="ghost" size="sm" onClick={backToList}>
            <ChevronLeft size={14} />
          </Button>
          <Badge status={status} aria-label={label} />
          <div className="min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-sm font-medium text-neutral-200 truncate block">
                  {session.projectName}
                </span>
              </TooltipTrigger>
              <TooltipContent>{session.projectName}</TooltipContent>
            </Tooltip>
            <span className="text-xs text-neutral-500 truncate block">
              {session.workspaceName ?? 'Unknown'}
            </span>
          </div>
          <ModeLabel mode={session.permissionMode} />
          <span className="text-xs text-neutral-500 shrink-0">{label}</span>
          <GoToTerminalButton sessionId={session.sessionId} />
        </div>

        {/* Pending permissions */}
        {session.pendingPermissions.length > 0 && (
          <div className="px-3 py-2 border-b border-neutral-800">
            <div className="text-xs font-medium text-amber-400 mb-1.5">Needs permission</div>
            <div className="flex flex-col gap-3">
              {session.pendingPermissions.map((perm) => (
                <PermissionRequest
                  key={perm.toolUseId}
                  sessionId={session.sessionId}
                  permission={perm}
                />
              ))}
            </div>
          </div>
        )}

        {/* Chat messages */}
        <ScrollArea className="flex-1">
          <div className="px-3 py-2 space-y-2">
            {chatLoading && chatMessages.length === 0 && (
              <div className="text-xs text-neutral-500 text-center mt-4">Loading...</div>
            )}
            {!chatLoading && chatMessages.length === 0 && (
              <div className="text-xs text-neutral-500 text-center mt-4">No messages yet</div>
            )}
            {chatMessages.map((msg) => (
              <ChatMessageItem key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input bar */}
        <div className="px-3 py-2 border-t border-neutral-800">
          <div className="flex gap-1.5 items-end">
            <Input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!canSendMessage}
              placeholder={
                canSendMessage
                  ? `Message ${agent}...`
                  : `${label} - you can send a message when ${agent} is ready`
              }
            />
            <Button
              size="sm"
              onClick={() => void handleSend()}
              disabled={!canSendMessage || !inputText.trim()}
            >
              <ArrowUp size={14} />
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
