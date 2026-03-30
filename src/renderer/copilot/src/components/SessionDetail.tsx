import { useEffect, useRef, useState } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { ChatMessageItem } from './ChatMessage';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Card, CardContent } from './ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Badge } from './ui/badge';
import { ChevronLeft, ArrowUp } from 'lucide-react';

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

  const session = sessions.find((s) => s.sessionId === selectedSessionId);

  useEffect(() => {
    if (session) {
      loadChatHistory(session.sessionId, session.cwd);
    }
  }, [session?.sessionId, session?.cwd, loadChatHistory]);

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

  const canSendMessage = session.phase === 'waitingForInput';
  const status = session.pendingPermissions.length > 0
    ? 'permission' as const
    : session.phase === 'processing' || session.phase === 'compacting'
      ? 'running' as const
      : session.phase === 'ended'
        ? 'complete' as const
        : 'idle' as const;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
          <Button variant="ghost" size="sm" onClick={backToList}>
            <ChevronLeft size={14} />
          </Button>
          <Badge status={status} />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm font-medium text-neutral-200 truncate">
                {session.projectName}
              </span>
            </TooltipTrigger>
            <TooltipContent>{session.projectName}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-neutral-500 ml-auto">{session.phase}</span>
            </TooltipTrigger>
            <TooltipContent>Current phase: {session.phase}</TooltipContent>
          </Tooltip>
        </div>

        {/* Pending permissions */}
        {session.pendingPermissions.length > 0 && (
          <div className="px-3 py-2 border-b border-neutral-800">
            <div className="text-xs font-medium text-amber-400 mb-1">
              Pending Permissions
            </div>
            {session.pendingPermissions.map((perm) => (
              <Card key={perm.toolUseId} className="mb-2 border-amber-500/20">
                <CardContent>
                  <div className="text-sm text-neutral-200 font-medium">
                    {perm.tool.toolName}
                  </div>
                  {Object.keys(perm.tool.toolInput).length > 0 && (
                    <pre className="mt-1 text-xs text-neutral-400 overflow-x-auto max-h-24 overflow-y-auto">
                      {JSON.stringify(perm.tool.toolInput, null, 2)}
                    </pre>
                  )}
                  <div className="flex gap-1 mt-2">
                    <Button
                      variant="success"
                      size="sm"
                      onClick={() => respondPermission(perm.toolUseId, 'allow')}
                    >
                      Allow
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => respondPermission(perm.toolUseId, 'deny')}
                    >
                      Deny
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
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
                  ? 'Message Claude...'
                  : session.tty
                    ? `Claude is ${session.phase}...`
                    : 'No TTY — cannot send messages'
              }
            />
            <Button
              size="sm"
              onClick={handleSend}
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
