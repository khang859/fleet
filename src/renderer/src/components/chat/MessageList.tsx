import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useChatStore } from '../../store/chat-store';

function Bubble({ role, content }: { role: string; content: string }): React.JSX.Element {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-4 py-2`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-fleet-accent/20 text-fleet-text' : 'bg-fleet-surface-2 text-fleet-text'
        }`}
      >
        <div className="prose prose-invert max-w-none prose-pre:bg-fleet-surface-3">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true }]]}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

export function MessageList(): React.JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const streamingText = useChatStore((s) => s.streamingText);
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-2">
      {messages.map((m) => (
        <Bubble key={m.id} role={m.role} content={m.content} />
      ))}
      {streamingText !== null && <Bubble role="assistant" content={streamingText || '…'} />}
      {status === 'error' && <div className="px-4 py-2 text-sm text-red-400">Error: {error}</div>}
      <div ref={bottomRef} />
    </div>
  );
}
