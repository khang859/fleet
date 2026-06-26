import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useChatStore } from '../../store/chat-store';
import type { ChatImageRef } from '../../../../shared/chat-types';
import { ChatImage } from './ChatImage';
import { GeneratingSkeleton } from './GeneratingSkeleton';
import { CodeBlock } from '../markdown/CodeBlock';

function Bubble({
  role,
  content,
  images
}: {
  role: string;
  content: string;
  images?: ChatImageRef[];
}): React.JSX.Element {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-4 py-2`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-fleet-accent/20 text-fleet-text' : 'bg-fleet-surface-2 text-fleet-text'
        }`}
      >
        <div className="prose prose-invert max-w-[70ch] prose-pre:bg-fleet-surface-3">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true }]]}
            components={{ pre: CodeBlock }}
          >
            {content}
          </ReactMarkdown>
        </div>
        {images !== undefined && images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <ChatImage key={img.ref} image={img} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageList(): React.JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const streamingText = useChatStore((s) => s.streamingText);
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const toolStatus = useChatStore((s) => s.toolStatus);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, atBottom]);

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto py-2">
      {messages.map((m) => (
        <Bubble key={m.id} role={m.role} content={m.content} images={m.images} />
      ))}
      {streamingText !== null && <Bubble role="assistant" content={streamingText || '…'} />}
      {status === 'streaming' && toolStatus?.state === 'generating' && (
        <GeneratingSkeleton label={toolStatus.label} />
      )}
      {toolStatus?.state === 'error' && (
        <div className="px-4 py-2 text-sm text-red-400">
          Image error: {toolStatus.error ?? toolStatus.label}
        </div>
      )}
      {status === 'error' && <div className="px-4 py-2 text-sm text-red-400">Error: {error}</div>}
      {!atBottom && (
        <button
          type="button"
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
          className="fixed bottom-24 right-6 rounded-full bg-fleet-surface-3 px-3 py-1.5 text-xs text-fleet-text shadow hover:bg-fleet-surface-2"
        >
          Jump to latest ↓
        </button>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
