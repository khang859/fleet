import type { CopilotChatMessage } from '../../../../shared/types';

function TextBlock({ text }: { text: string }): React.JSX.Element {
  return <div className="text-[11px] text-neutral-200 whitespace-pre-wrap break-words">{text}</div>;
}

function ToolUseBlock({
  name,
  inputPreview,
}: {
  name: string;
  inputPreview: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 text-[10px] text-neutral-400 bg-neutral-800/50 rounded px-1.5 py-0.5">
      <span className="text-blue-400 font-medium">{name}</span>
      {inputPreview && (
        <span className="truncate opacity-70">{inputPreview}</span>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  return (
    <details className="text-[10px] text-neutral-500">
      <summary className="cursor-pointer hover:text-neutral-400">Thinking...</summary>
      <div className="mt-1 whitespace-pre-wrap break-words pl-2 border-l border-neutral-700">
        {text.slice(0, 500)}{text.length > 500 ? '...' : ''}
      </div>
    </details>
  );
}

export function ChatMessageItem({ message }: { message: CopilotChatMessage }): React.JSX.Element {
  const isUser = message.role === 'user';

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}>
      {message.blocks.map((block, i) => {
        const key = `${message.id}-${i}`;
        switch (block.type) {
          case 'text':
            return (
              <div
                key={key}
                className={`max-w-[90%] rounded-lg px-2 py-1 ${
                  isUser
                    ? 'bg-blue-600/30 text-blue-100'
                    : 'bg-neutral-800 text-neutral-200'
                }`}
              >
                <TextBlock text={block.text} />
              </div>
            );
          case 'tool_use':
            return (
              <div key={key} className="max-w-[90%]">
                <ToolUseBlock name={block.name} inputPreview={block.inputPreview} />
              </div>
            );
          case 'thinking':
            return (
              <div key={key} className="max-w-[90%]">
                <ThinkingBlock text={block.text} />
              </div>
            );
          case 'interrupted':
            return (
              <div key={key} className="text-[10px] text-amber-500 italic">
                Interrupted by user
              </div>
            );
        }
      })}
    </div>
  );
}
