import type { CopilotChatMessage, CopilotMessageBlock } from '../../../../shared/types';
import { useCopilotStore } from '../store/copilot-store';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

function TextBlock({ text }: { text: string }): React.JSX.Element {
  return <div className="text-[11px] text-neutral-200 whitespace-pre-wrap break-words">{text}</div>;
}

const MODE_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree']);

function ToolUseBlock({
  name,
  inputPreview,
}: {
  name: string;
  inputPreview: string;
}): React.JSX.Element {
  if (MODE_TOOLS.has(name)) {
    return (
      <div className="flex items-center gap-1 text-[10px] text-neutral-500 italic px-1">
        <span className="text-purple-400">⟡</span>
        <span>{inputPreview || name}</span>
      </div>
    );
  }

  const displayName = name.startsWith('mcp__')
    ? name.replace(/^mcp__/, '').replace(/__/g, '/')
    : name;

  return (
    <div className="flex items-center gap-1 text-[10px] text-neutral-400 bg-neutral-800/50 rounded px-1.5 py-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-blue-400 font-medium truncate max-w-[120px]">{displayName}</span>
        </TooltipTrigger>
        <TooltipContent>{displayName}</TooltipContent>
      </Tooltip>
      {inputPreview && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate opacity-70 max-w-[140px]">{inputPreview}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{inputPreview}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function AskUserQuestionBlock({ input }: { input: Record<string, unknown> }): React.JSX.Element {
  const selectedSessionId = useCopilotStore((s) => s.selectedSessionId);
  const sendMessage = useCopilotStore((s) => s.sendMessage);
  const question = (input['question'] as string) ?? 'Claude needs your input';
  const options = (input['options'] as Array<Record<string, unknown>>) ?? [];

  const handleSelect = (index: number): void => {
    if (!selectedSessionId) return;
    sendMessage(selectedSessionId, String(index + 1));
  };

  const handleGoToTerminal = (): void => {
    if (selectedSessionId) {
      window.copilot.focusTerminal(selectedSessionId);
    }
  };

  return (
    <Card className="border-amber-500/20 bg-amber-500/10">
      <CardContent className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-medium text-amber-400">Question</div>
          <Button variant="outline" size="sm" onClick={handleGoToTerminal}>
            Terminal →
          </Button>
        </div>
        <div className="text-[11px] text-neutral-200">{question}</div>
        {options.length > 0 && (
          <div className="space-y-1 mt-1">
            {options.map((opt, i) => (
              <Button
                key={i}
                variant="outline"
                className="w-full justify-start text-left hover:border-amber-500/30"
                onClick={() => handleSelect(i)}
              >
                <span className="text-[10px] text-amber-400 font-medium mr-1.5">{i + 1}.</span>
                <span className="text-[11px] text-neutral-200">{(opt['label'] as string) ?? ''}</span>
                {typeof opt['description'] === 'string' && (
                  <span className="text-[10px] text-neutral-500 ml-1">{opt['description']}</span>
                )}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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

function renderToolUse(block: Extract<CopilotMessageBlock, { type: 'tool_use' }>, key: string): React.JSX.Element {
  if (block.name === 'AskUserQuestion' && block.input) {
    return (
      <div key={key} className="max-w-[95%]">
        <AskUserQuestionBlock input={block.input} />
      </div>
    );
  }
  return (
    <div key={key} className="max-w-[90%]">
      <ToolUseBlock name={block.name} inputPreview={block.inputPreview} />
    </div>
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
              <Card
                key={key}
                className={`max-w-[90%] ${
                  isUser
                    ? 'bg-blue-600/30 border-blue-600/20 text-blue-100'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-200'
                }`}
              >
                <CardContent className="px-2 py-1">
                  <TextBlock text={block.text} />
                </CardContent>
              </Card>
            );
          case 'tool_use':
            return renderToolUse(block, key);
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
